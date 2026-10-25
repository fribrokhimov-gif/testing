import { test, expect, Page } from '@playwright/test';
import { getMerchant, getVendor, listEmployees, restoreMerchant, blockWrites, Merchant } from './pages/api';

// Merchant profile — /profile, "Действия профиля" → "Редактировать"
//   GET   vendors/me     — the profile card shows business_name from here
//   GET   merchants/me   — the real merchant name / logo_url
//   POST  uploads/presign → PUT <upload_url> — new photo
//   PATCH merchants/me { name, logo_url } — save
// Other people see this name, so every test puts the original merchants/me name + logo_url back
// (in the test and again in afterEach) and waits until vendors/me shows the original name again.
// Validation tests block the PATCH so nothing is saved at all.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test.describe.configure({ mode: 'serial' });

let original: Merchant;
let originalVendorName: string;

test.beforeEach(async ({ page, request }) => {
  original = await getMerchant(request);
  originalVendorName = (await getVendor(request)).name;
  await page.goto('/profile');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
});

test.afterEach(async ({ request }) => {
  await restoreMerchant(request, original, originalVendorName);
});

async function openEdit(page: Page) {
  await page.getByRole('button', { name: 'Действия профиля' }).click();
  await page.getByRole('menuitem', { name: 'Редактировать' }).click();
  const dialog = page.getByRole('dialog', { name: 'Редактирование' });
  await expect(dialog).toBeVisible();
  return { dialog, name: dialog.getByRole('textbox', { name: 'Название организации' }), save: dialog.getByRole('button', { name: 'Сохранить' }) };
}

/** Catches the save request, reads its body and aborts it — nothing reaches the backend. */
async function interceptSave(page: Page) {
  const bodies: { name: string; logo_url: string | null }[] = [];
  await page.route(/\/merchants\/me$/, (route) => {
    if (route.request().method() === 'GET') return route.continue();
    bodies.push(route.request().postDataJSON());
    return route.abort();
  });
  return bodies;
}

test.describe('Merchant profile — view', () => {
  test('card shows the organisation name and employee count from the API', async ({ page, request }) => {
    const vendor = await getVendor(request);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(vendor.business_name);
    const employees = await listEmployees(request);
    await expect(page.getByRole('link', { name: 'Перейти к сотрудникам' })).toContainText(String(employees.length));
  });

  test('profile actions menu lists its items', async ({ page }) => {
    await page.getByRole('button', { name: 'Действия профиля' }).click();
    const menu = page.getByRole('menu', { name: 'Действия профиля' });
    for (const item of ['Редактировать', 'Сменить аккаунт', 'Информация об интеграции', 'Сгенерировать токен']) {
      await expect(menu.getByRole('menuitem', { name: item })).toBeVisible();
    }
  });
});

test.describe('Merchant profile — edit form validation', () => {
  let writes: string[];
  test.beforeEach(async ({ page }) => {
    writes = await blockWrites(page, /\/merchants\/me$|uploads\/presign/);
  });
  test.afterEach(() => {
    expect(writes, 'nothing may be saved').toEqual([]);
  });

  test('Save is disabled until something changes and when the name is empty', async ({ page }) => {
    const { name, save } = await openEdit(page);
    await expect(save).toBeDisabled();
    await name.fill('');
    await expect(save).toBeDisabled();
    await name.fill('   ');
    await expect(save).toBeDisabled();
  });

  test('name is limited to 42 characters and the counter follows', async ({ page }) => {
    const { dialog, name } = await openEdit(page);
    await name.fill('');
    await expect(dialog.getByText('0/42')).toBeVisible();
    await name.pressSequentially('Q'.repeat(45));
    await expect(name).toHaveValue('Q'.repeat(42));
    await expect(dialog.getByText('42/42')).toBeVisible();
  });

  test('"Отмена" closes the form without saving', async ({ page }) => {
    const { dialog, name } = await openEdit(page);
    await name.fill('QA cancelled name');
    await dialog.getByRole('button', { name: 'Отмена' }).click();
    await expect(dialog).toBeHidden();

    const again = await openEdit(page);
    await expect(again.name).not.toHaveValue('QA cancelled name');
  });

  test('photo picker accepts png, jpeg and svg only', async ({ page }) => {
    const { dialog } = await openEdit(page);
    await expect(dialog.locator('input[type=file]')).toHaveAttribute('accept', 'image/png, image/jpeg, image/svg+xml');
  });
});

test.describe('Merchant profile — save (restored right after)', () => {
  test('change the name: PATCH merchants/me saves it, then the original is restored', async ({ page, request }) => {
    const newName = `${original.name}-qa-e2e`;
    const { name, save } = await openEdit(page);
    await name.fill(newName);
    const res = page.waitForResponse((r) => /\/merchants\/me$/.test(r.url()) && r.request().method() === 'PATCH');
    await save.click();
    expect((await res).status()).toBe(200);
    expect((await res).request().postDataJSON().name).toBe(newName);
    await expect(page.getByText('Профиль успешно обновлен')).toBeVisible();
    expect((await getMerchant(request)).name).toBe(newName);

    await restoreMerchant(request, original, originalVendorName);
    expect(await getMerchant(request)).toMatchObject({ name: original.name, logo_url: original.logo_url });
  });

  test('upload a new photo: logo_url becomes the uploaded file, then the original is restored', async ({ page, request }) => {
    const { dialog, save } = await openEdit(page);
    const presign = page.waitForResponse((r) => r.url().includes('uploads/presign'));
    const chooser = page.waitForEvent('filechooser');
    await dialog.getByRole('button', { name: 'Изменить фото' }).click();
    await (await chooser).setFiles({ name: 'qa-logo.png', mimeType: 'image/png', buffer: PNG });

    const patch = page.waitForResponse((r) => /\/merchants\/me$/.test(r.url()) && r.request().method() === 'PATCH');
    await save.click();
    const slot = (await (await presign).json()).list[0] as { key: string; public_url: string };
    expect((await patch).status()).toBe(200);
    expect((await patch).request().postDataJSON().logo_url).toBe(slot.key);
    expect((await getMerchant(request)).logo_url).toBe(slot.key);

    const img = await request.get(slot.public_url);
    expect(img.status()).toBe(200);
    expect((await img.body()).equals(PNG)).toBe(true);

    await restoreMerchant(request, original, originalVendorName);
    expect(await getMerchant(request)).toMatchObject({ name: original.name, logo_url: original.logo_url });
  });
});

test.describe('Merchant profile — known bugs', () => {
  test('saving only the name keeps the current logo', async ({ page }) => {
    test.fail(true, 'Known: name save sends logo_url = vendors/me.business_logo and replaces merchants/me.logo_url');
    const bodies = await interceptSave(page); // aborted — nothing is saved
    const { name, save } = await openEdit(page);
    await name.fill(`${original.name}-qa-e2e`);
    await save.click();
    await expect.poll(() => bodies.length).toBe(1);
    expect(bodies[0].logo_url).toBe(original.logo_url);
  });

  test('edit form opens with the merchant name', async ({ page }) => {
    test.fail(true, 'Known: form and heading show vendors/me.business_name, but saving writes merchants/me.name');
    await interceptSave(page);
    const { name } = await openEdit(page);
    await expect(name).toHaveValue(original.name, { timeout: 3000 });
  });

  test('heading shows the new name after saving', async ({ page, request }) => {
    test.fail(true, 'Known: heading reads vendors/me.business_name, which the save does not change');
    const newName = `${original.name}-qa-e2e`;
    try {
      const { name, save } = await openEdit(page);
      await name.fill(newName);
      await save.click();
      await expect(page.getByText('Профиль успешно обновлен')).toBeVisible();
      await page.reload();
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(newName, { timeout: 5000 });
    } finally {
      await restoreMerchant(request, original, originalVendorName);
    }
  });
});

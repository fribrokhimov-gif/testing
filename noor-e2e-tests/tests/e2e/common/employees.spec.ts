import { test, expect, Page } from '@playwright/test';
import { listEmployees, blockWrites, Employee } from './pages/api';

// Employees — /profile/users (profile card "Перейти к сотрудникам")
//   GET merchant-employees (eats API) — { list: Employee[] }
//   Tabs Все / Менеджеры / Кассиры, search, "Добавить" form (Фамилия, Имя, Номер телефона, Роль)
// Adding an employee sends a real SMS with a password, so EVERY write to merchant-employees
// (POST / PATCH / DELETE) is aborted in the browser and each test checks none was attempted.
// Only validation is exercised — a valid new employee is never submitted.
const roleLabel: Record<string, string> = { manager: 'Менеджер', cashier: 'Кассир' };
const fullName = (e: Employee) => [e.last_name.trim(), e.first_name.trim()].filter(Boolean).join(' ');
/** +998000000004 → +998 (00) 000 00 04 */
const phoneLabel = (p: string) => p.replace(/^\+998(\d{2})(\d{3})(\d{2})(\d{2})$/, '+998 ($1) $2 $3 $4');

let employees: Employee[];
let writes: string[];

test.beforeEach(async ({ page, request }) => {
  writes = await blockWrites(page, /merchant-employees/);
  employees = await listEmployees(request);
  await page.goto('/profile/users');
  await expect(page.getByRole('heading', { name: 'Сотрудники', level: 1 })).toBeVisible();
});

test.afterEach(() => {
  expect(writes, 'no employee may be added, edited or removed').toEqual([]);
});

const editButtons = (page: Page) => page.getByRole('button', { name: /^Редактировать / });

test.describe('Employees — list', () => {
  test('opens from the profile card', async ({ page }) => {
    await page.goto('/profile');
    await page.getByRole('link', { name: 'Перейти к сотрудникам' }).click();
    await expect(page).toHaveURL(/\/profile\/users/);
  });

  test('list matches the API: names, roles, phones', async ({ page }) => {
    test.skip(!employees.length, 'Merchant has no employees');
    await expect(editButtons(page)).toHaveCount(employees.length);
    const main = page.getByRole('main');
    for (const e of employees) {
      await expect(page.getByRole('button', { name: `Редактировать ${fullName(e)}`, exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: `Удалить ${fullName(e)}`, exact: true })).toBeVisible();
      await expect(main.getByText(phoneLabel(e.phone), { exact: true }).locator('visible=true')).toHaveCount(1);
    }
    for (const [role, label] of Object.entries(roleLabel)) {
      const n = employees.filter((e) => e.role === role).length;
      await expect(main.getByText(label, { exact: true }).locator('visible=true')).toHaveCount(n);
    }
  });

  test('tab counts match the API', async ({ page }) => {
    const count = (role: string) => employees.filter((e) => e.role === role).length;
    await expect(page.getByRole('tab', { name: `Все ${employees.length}` })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tab', { name: `Менеджеры ${count('manager')}` })).toBeVisible();
    await expect(page.getByRole('tab', { name: `Кассиры ${count('cashier')}` })).toBeVisible();
  });

  for (const [role, tab] of [['manager', 'Менеджеры'], ['cashier', 'Кассиры']]) {
    test(`"${tab}" tab shows only ${role}s`, async ({ page }) => {
      await page.getByRole('tab', { name: new RegExp(`^${tab}`) }).click();
      await expect(page).toHaveURL(/tab=/);
      const expected = employees.filter((e) => e.role === role);
      await expect(editButtons(page)).toHaveCount(expected.length);
      for (const e of expected) await expect(page.getByRole('button', { name: `Редактировать ${fullName(e)}`, exact: true })).toBeVisible();
    });
  }

  test('search finds an employee by name and clears', async ({ page }) => {
    test.skip(!employees.length, 'Merchant has no employees');
    const target = employees[0];
    const search = page.getByRole('textbox', { name: 'Поиск' });
    await search.fill(target.last_name);
    const matching = employees.filter((e) => fullName(e).toLowerCase().includes(target.last_name.toLowerCase()));
    await expect(editButtons(page)).toHaveCount(matching.length);
    await expect(page.getByRole('button', { name: `Редактировать ${fullName(target)}`, exact: true })).toBeVisible();
    await expect(page).toHaveURL(/search=/);

    await page.getByRole('button', { name: 'Поиск — clear' }).click();
    await expect(search).toHaveValue('');
    await expect(editButtons(page)).toHaveCount(employees.length);
  });

  test('search with no match shows the empty state', async ({ page }) => {
    await page.getByRole('textbox', { name: 'Поиск' }).fill('zzz-no-such-employee');
    await expect(editButtons(page)).toHaveCount(0);
    await expect(page.getByText('Попробуйте изменить роль или поисковый запрос.')).toBeVisible();
  });
});

test.describe('Employees — add form (validation only)', () => {
  async function openAdd(page: Page) {
    await page.getByRole('button', { name: 'Добавить' }).click();
    const dialog = page.getByRole('dialog', { name: 'Создание' });
    await expect(dialog).toBeVisible();
    return {
      dialog,
      last: dialog.getByRole('textbox', { name: 'Фамилия' }),
      first: dialog.getByRole('textbox', { name: 'Имя' }),
      phone: dialog.getByRole('textbox', { name: 'Номер телефона' }),
      save: dialog.getByRole('button', { name: 'Сохранить' }),
    };
  }

  test('empty form shows all required-field messages and sends nothing', async ({ page }) => {
    const f = await openAdd(page);
    await f.save.click();
    for (const msg of ['Укажите фамилию', 'Укажите имя', 'Укажите номер телефона']) {
      await expect(f.dialog.getByText(msg)).toBeVisible();
    }
    for (const field of [f.last, f.first, f.phone]) await expect(field).toHaveAttribute('aria-invalid', 'true');
    await expect(f.dialog).toBeVisible();
  });

  test('incomplete phone is refused', async ({ page }) => {
    const f = await openAdd(page);
    await f.last.fill('QA');
    await f.first.fill('Validation');
    await f.phone.click();
    await f.phone.pressSequentially('90123');
    await f.save.click();
    await expect(f.phone).toHaveAttribute('aria-invalid', 'true');
    await expect(f.dialog.getByText('Укажите номер телефона')).toBeVisible();
    await expect(f.last).not.toHaveAttribute('aria-invalid', 'true');
    await expect(f.dialog).toBeVisible();
  });

  test('phone mask keeps the +998 prefix and ignores letters', async ({ page }) => {
    const f = await openAdd(page);
    await expect(f.phone).toHaveValue('+998');
    await f.phone.click();
    await f.phone.pressSequentially('90ab123');
    await expect(f.phone).toHaveValue('+998 90 123');
  });

  test('role offers only Менеджер and Кассир, Менеджер by default', async ({ page }) => {
    const f = await openAdd(page);
    const role = f.dialog.getByRole('combobox', { name: 'Роль' });
    await expect(role).toHaveText('Менеджер');
    await role.click();
    await expect(page.getByRole('option')).toHaveText(['Менеджер', 'Кассир']);
    await page.getByRole('option', { name: 'Кассир' }).click();
    await expect(role).toHaveText('Кассир');
    // No empty choice exists, so "missing role" cannot be reached from the panel
  });

  test('closing the form discards the input', async ({ page }) => {
    let f = await openAdd(page);
    await f.last.fill('QA');
    await f.dialog.getByRole('button', { name: 'Close' }).click();
    await expect(f.dialog).toBeHidden();
    f = await openAdd(page);
    await expect(f.last).toHaveValue('');
  });
});

test.describe('Employees — edit form (opened, not saved)', () => {
  test('edit form is prefilled from the API; phone and role are read-only', async ({ page }) => {
    test.skip(!employees.length, 'Merchant has no employees');
    const e = employees[0];
    await page.getByRole('button', { name: `Редактировать ${fullName(e)}`, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Редактирование' });
    await expect(dialog.getByRole('textbox', { name: 'Фамилия' })).toHaveValue(e.last_name);
    await expect(dialog.getByRole('textbox', { name: 'Имя' })).toHaveValue(e.first_name);
    await expect(dialog.getByRole('textbox').nth(2)).toHaveValue(phoneLabel(e.phone));
    await expect(dialog.getByRole('textbox').nth(2)).not.toBeEditable();
    await expect(dialog.getByRole('textbox').nth(3)).toHaveValue(roleLabel[e.role]);
    await expect(dialog.getByRole('textbox').nth(3)).not.toBeEditable();
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toBeHidden();
  });
});

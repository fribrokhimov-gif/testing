import { test, expect, Page } from '@playwright/test';
import { urls } from '../../../api/eatsModeration';
import { apiHeaders, e2eNames, removeE2eCategories } from './pages/eatsApi';

// Eats → Мастер-меню → Категории (/eats/menu/categories), driven through the panel.
//   GET    merchant/product-categories       — the cards; created_at per category
//   POST   merchant/product-categories { names: [{ ru, uz, en }] }  — "Добавить" → Сохранить
//   GET    merchant/product-categories/{id}  — opens "Редактирование"
//   PATCH  merchant/product-categories/{id} { name: { ru, uz, en } }
//   DELETE merchant/product-categories/{id}  — "Удалить" → confirm dialog
// Categories stay drafts (never "Отправить на модерацию"). Every "QA-autotest e2e" category is removed in afterAll.
const categoriesApi = /\/merchant\/product-categories(\?|$)/;

test.afterAll(async ({ request }) => removeE2eCategories(request));

const card = (page: Page, name: string) => page.getByRole('heading', { level: 3, name, exact: true });
const actions = (page: Page, name: string) => page.getByRole('button', { name: `Действия для категории «${name}»` });

async function open(page: Page) {
  const list = page.waitForResponse((r) => categoriesApi.test(r.url()) && r.request().method() === 'GET');
  await page.goto('/eats/menu/categories');
  return (await (await list).json()) as { list: { id: string; name: string; created_at: string }[]; data: { counts: { all: number } } };
}

test.describe('Categories — create → edit → delete in the panel', () => {
  test.describe.configure({ mode: 'serial' });
  const names = e2eNames('cat');
  const renamed = `${names.ru} upd`;
  let id: string;

  test('create a category with names in three languages', async ({ page }) => {
    const before = await open(page);
    await expect(page.getByText(`${before.data.counts.all} категори`)).toBeVisible();

    await page.getByRole('button', { name: 'Добавить' }).click();
    const dialog = page.getByRole('dialog', { name: 'Создание' });
    await dialog.getByRole('textbox', { name: 'Название * (Ru)' }).fill(names.ru);
    await dialog.getByRole('textbox', { name: 'Название * (Uz)' }).fill(names.uz);
    await dialog.getByRole('textbox', { name: 'Название * (En)' }).fill(names.en);
    const post = page.waitForResponse((r) => categoriesApi.test(r.url()) && r.request().method() === 'POST');
    await dialog.getByRole('button', { name: 'Сохранить' }).click();

    const res = await post;
    expect(res.status()).toBe(200);
    expect(res.request().postDataJSON()).toEqual({ names: [names] });
    id = (await res.json()).list[0].id;

    await expect(page.getByText('Категория добавлена')).toBeVisible();
    await expect(dialog).toBeHidden();
    await expect(card(page, names.ru)).toBeVisible();
    await expect(page.getByText(`${before.data.counts.all + 1} категори`)).toBeVisible();
  });

  test('new category is a draft in the API', async ({ request }) => {
    test.skip(!id, 'Category was not created');
    const res = await request.get(`${urls.categories}/${id}`, { headers: await apiHeaders(request) });
    expect((await res.json()).data.category).toMatchObject({ name: names, moderation_state: 'MERCHANT_MODERATION_STATE_DRAFT' });
  });

  test('search finds the category by name', async ({ page }) => {
    test.skip(!id, 'Category was not created');
    await open(page);
    await page.getByRole('textbox', { name: 'Поиск' }).fill(names.ru);
    await expect(card(page, names.ru)).toBeVisible();
    await expect(card(page, 'Бургеры')).toBeHidden();

    await page.getByRole('textbox', { name: 'Поиск' }).fill('QA-autotest e2e no such category');
    await expect(card(page, names.ru)).toBeHidden();
  });

  test('edit the Russian name', async ({ page }) => {
    test.skip(!id, 'Category was not created');
    await open(page);
    await actions(page, names.ru).click();
    await page.getByRole('menuitem', { name: 'Редактировать' }).click();

    const dialog = page.getByRole('dialog', { name: 'Редактирование' });
    // The form is filled from GET merchant/product-categories/{id}
    await expect(dialog.getByRole('textbox', { name: 'Название * (Ru)' })).toHaveValue(names.ru);
    await expect(dialog.getByRole('textbox', { name: 'Название (Uz)' })).toHaveValue(names.uz);
    await expect(dialog.getByRole('textbox', { name: 'Название (En)' })).toHaveValue(names.en);

    await dialog.getByRole('textbox', { name: 'Название * (Ru)' }).fill(renamed);
    const patch = page.waitForResponse((r) => r.url().endsWith(`/merchant/product-categories/${id}`) && r.request().method() === 'PATCH');
    await dialog.getByRole('button', { name: 'Сохранить' }).click();

    const res = await patch;
    expect(res.status()).toBe(200);
    expect(res.request().postDataJSON()).toEqual({ name: { ...names, ru: renamed } });
    await expect(page.getByText('Категория переименована')).toBeVisible();
    await expect(card(page, renamed)).toBeVisible();
    await expect(card(page, names.ru)).toBeHidden();
  });

  test('delete the category', async ({ page }) => {
    test.skip(!id, 'Category was not created');
    const before = await open(page);
    await actions(page, renamed).click();
    await page.getByRole('menuitem', { name: 'Удалить' }).click();

    const dialog = page.getByRole('dialog', { name: 'Удалить категорию?' });
    await expect(dialog).toContainText(`Категория «${renamed}» и все её продукты будут удалены.`);
    const del = page.waitForResponse((r) => r.url().endsWith(`/merchant/product-categories/${id}`) && r.request().method() === 'DELETE');
    await dialog.getByRole('button', { name: 'Удалить' }).click();

    expect((await del).status()).toBe(200);
    await expect(card(page, renamed)).toBeHidden();
    await expect(page.getByText(`${before.data.counts.all - 1} категори`)).toBeVisible();
  });
});

test.describe('Categories — card details vs API', () => {
  test('cards show the same categories as the API, in the same order', async ({ page }) => {
    const body = await open(page);
    await expect(page.getByRole('heading', { level: 3 })).toHaveText(body.list.map((c) => c.name));
  });

  test('"Дата создания" shows each category\'s created_at', async ({ page }) => {
    test.fail(true, 'Known: every card shows 12.12.2026 regardless of created_at');
    const body = await open(page);
    const dates = page.getByRole('paragraph').filter({ hasText: /^Дата создан/ });
    const expected = body.list.map((c) =>
      new Date(c.created_at).toLocaleDateString('ru-RU', { timeZone: 'Asia/Tashkent', day: '2-digit', month: '2-digit', year: 'numeric' }),
    );
    await expect(dates).toHaveText(expected.map((d) => new RegExp(`${d.replace(/\./g, '\\.')}$`)));
  });

  test('date label reads "Дата создания"', async ({ page }) => {
    test.fail(true, 'Known: label typo "Дата создании"');
    await open(page);
    await expect(page.getByText(/^Дата создания:/).first()).toBeVisible({ timeout: 5_000 });
  });

  test('delete confirmation buttons are in Russian', async ({ page }) => {
    test.fail(true, 'Known (new): cancel button in the delete dialog reads "Cancel"');
    const body = await open(page);
    // Opens the dialog on a real category and only closes it — nothing is deleted
    await actions(page, body.list[0].name).click();
    await page.getByRole('menuitem', { name: 'Удалить' }).click();
    const dialog = page.getByRole('dialog', { name: 'Удалить категорию?' });
    await expect(dialog.getByRole('button', { name: 'Удалить' })).toBeVisible();
    try {
      await expect(dialog.getByRole('button', { name: 'Отмена' })).toBeVisible({ timeout: 5_000 });
    } finally {
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
    }
  });
});

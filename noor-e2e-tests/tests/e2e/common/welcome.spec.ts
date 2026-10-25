import { test, expect, Page } from '@playwright/test';

// Welcome page — /welcome (after login) and the header shared by every screen
//   Section cards: Доставка → /delivery, Еда → /eats, the others are "Скоро" (not links)
//   Account menu ("Аккаунт"): theme switch, language Ру / Uz / En, Профиль, Выйти
// Language and theme live only in localStorage (ui-prefs) of this test's own context — nothing on the backend.

const openAccount = async (page: Page, name = 'Аккаунт') => {
  await page.getByRole('button', { name }).click();
  return page.getByRole('dialog');
};

test.beforeEach(async ({ page }) => {
  await page.goto('/welcome');
  await expect(page.getByRole('heading', { name: 'Добро пожаловать', level: 1 })).toBeVisible();
});

test.describe('Welcome — sections', () => {
  test('Доставка opens /delivery', async ({ page }) => {
    await page.getByRole('link', { name: /^Доставка/ }).click();
    await expect(page).toHaveURL(/\/delivery/);
  });

  test('Еда opens /eats', async ({ page }) => {
    await page.getByRole('link', { name: /^Еда/ }).click();
    await expect(page).toHaveURL(/\/eats/);
  });

  test('sections marked "Скоро" are not links', async ({ page }) => {
    for (const name of ['Магазин', 'Подарки', 'Цветы', 'Электростанция', 'Лавка']) {
      await expect(page.getByRole('heading', { name, level: 2 })).toBeVisible();
      await expect(page.getByRole('link', { name: new RegExp(name) })).toHaveCount(0);
    }
    await expect(page.getByText('Скоро', { exact: true })).toHaveCount(5);
  });

  test('Noor logo leads back to /welcome', async ({ page }) => {
    await page.goto('/profile');
    await page.getByRole('link', { name: 'Noor' }).click();
    await expect(page).toHaveURL(/\/welcome/);
  });

  test('"Сменить приложение" menu switches between Доставка and Еда', async ({ page }) => {
    await page.goto('/profile');
    await page.getByRole('button', { name: 'Сменить приложение' }).click();
    const menu = page.getByRole('dialog');
    await expect(menu.getByRole('listitem').filter({ hasText: 'Скоро' })).toHaveCount(5);
    await menu.getByRole('link', { name: 'Еда' }).click();
    await expect(page).toHaveURL(/\/eats/);

    await page.getByRole('button', { name: 'Сменить приложение' }).click();
    await page.getByRole('dialog').getByRole('link', { name: 'Доставка' }).click();
    await expect(page).toHaveURL(/\/delivery/);
  });

  test('account menu "Профиль" opens /profile', async ({ page }) => {
    await (await openAccount(page)).getByRole('link', { name: 'Профиль' }).click();
    await expect(page).toHaveURL(/\/profile$/);
  });
});

test.describe('Welcome — language', () => {
  test('Ру is the default language', async ({ page }) => {
    const menu = await openAccount(page);
    await expect(menu.getByRole('button', { name: 'Русский' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
  });

  test('En and Uz change the texts and persist after reload', async ({ page }) => {
    await (await openAccount(page)).getByRole('button', { name: 'Английский' }).click();
    await expect(page.getByRole('heading', { name: 'Welcome', level: 1 })).toBeVisible();
    await expect(page.getByRole('link', { name: /^Delivery/ })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Welcome', level: 1 })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');

    await (await openAccount(page, 'Account')).getByRole('button', { name: 'Uzbek' }).click();
    await expect(page.getByRole('heading', { name: 'Xush kelibsiz', level: 1 })).toBeVisible();
    await expect(page.getByRole('link', { name: /^Yetkazib berish/ })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Xush kelibsiz', level: 1 })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'uz');

    // Language follows to other screens
    await page.goto('/profile');
    await expect(page.getByRole('link', { name: "Xodimlarga o'tish" })).toBeVisible();

    // And back to Russian
    await page.goto('/welcome');
    await (await openAccount(page, 'Hisob')).getByRole('button', { name: /Rus/ }).click();
    await expect(page.getByRole('heading', { name: 'Добро пожаловать', level: 1 })).toBeVisible();
  });
});

test.describe('Welcome — theme', () => {
  test('theme switch turns dark mode on, persists after reload, and back off', async ({ page }) => {
    const html = page.locator('html');
    await expect(html).not.toHaveClass(/dark/);
    const menu = await openAccount(page);
    await expect(menu.getByText('Светлая')).toBeVisible();
    await menu.getByRole('switch', { name: 'Тема' }).click();
    await expect(html).toHaveClass(/dark/);
    await expect(menu.getByRole('switch', { name: 'Тема' })).toBeChecked();

    await page.reload();
    await expect(html).toHaveClass(/dark/);

    await (await openAccount(page)).getByRole('switch', { name: 'Тема' }).click();
    await expect(html).not.toHaveClass(/dark/);
  });
});

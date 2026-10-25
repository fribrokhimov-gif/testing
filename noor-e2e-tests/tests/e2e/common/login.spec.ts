import { test, expect } from '@playwright/test';
import { LoginPage } from './pages/LoginPage';

// Login page — /login, no stored session (every test starts logged out)
//   POST auth/merchant { phone, password } — tokens go to localStorage (auth_token / refresh_token)
// A valid login only opens a new session; nothing is changed. "Забыли пароль?" is never used (sends an SMS).
test.use({ storageState: { cookies: [], origins: [] } });

let login: LoginPage;
test.beforeEach(async ({ page }) => {
  login = new LoginPage(page);
});

test.describe('Login — access', () => {
  for (const path of ['/welcome', '/profile', '/profile/users', '/delivery', '/eats']) {
    test(`${path} without a session redirects to /login`, async ({ page }) => {
      await page.goto(path);
      await expect(page).toHaveURL(/\/login/);
      await expect(login.submit).toBeVisible();
    });
  }
});

test.describe('Login — form', () => {
  test('valid phone and password open /welcome', async ({ page }) => {
    await login.open();
    const res = page.waitForResponse((r) => r.url().includes('/auth/merchant'));
    await login.login();
    expect((await res).status()).toBe(200);

    await expect(page).toHaveURL(/\/welcome/);
    await expect(page.getByRole('heading', { name: 'Добро пожаловать', level: 1 })).toBeVisible();
    const keys = await page.evaluate(() => Object.keys(localStorage));
    expect(keys).toEqual(expect.arrayContaining(['auth_token', 'refresh_token']));
  });

  test('wrong password shows an error and stays on /login', async ({ page }) => {
    await login.open();
    const res = page.waitForResponse((r) => r.url().includes('/auth/merchant'));
    await login.login(undefined, 'wrong-password-123');
    expect((await res).status()).toBe(401);

    await expect(page.getByRole('alert').filter({ hasText: 'Неверный номер телефона или пароль.' }).first()).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
    expect(await page.evaluate(() => localStorage.getItem('auth_token'))).toBeNull();
  });

  test('empty fields show validation and send nothing', async ({ page }) => {
    await login.open();
    let sent = false;
    page.on('request', (r) => { if (r.url().includes('/auth/merchant')) sent = true; });

    await login.submit.click();
    await expect(page.getByRole('alert').filter({ hasText: 'Введите номер телефона' })).toBeVisible();
    await expect(page.getByRole('alert').filter({ hasText: 'Введите пароль' })).toBeVisible();
    await expect(login.phone).toHaveAttribute('aria-invalid', 'true');
    await expect(login.password).toHaveAttribute('aria-invalid', 'true');
    expect(sent, 'login request').toBe(false);
  });

  test('incomplete phone asks for the full number', async ({ page }) => {
    await login.open();
    await login.typePhone('90123');
    await login.password.fill('any-password-1');
    await login.submit.click();
    await expect(page.getByRole('alert').filter({ hasText: 'Введите номер телефона полностью' })).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test('phone mask: +998 prefix, formatting, digits only, 9 digits max', async () => {
    await login.open();
    await expect(login.phone).toHaveValue('+998');
    await login.typePhone('90abc1234567 89');
    await expect(login.phone).toHaveValue('+998 90 123-45-67');
  });

  test('password can be shown and hidden', async ({ page }) => {
    await login.open();
    await login.password.fill('secret-123');
    await expect(login.password).toHaveAttribute('type', 'password');
    await page.getByRole('button', { name: 'Показать пароль' }).click();
    await expect(login.password).toHaveAttribute('type', 'text');
    await page.getByRole('button', { name: 'Скрыть пароль' }).click();
    await expect(login.password).toHaveAttribute('type', 'password');
  });

  test('"Забыли пароль?" leads to /reset-password', async ({ page }) => {
    await login.open();
    await expect(page.getByRole('link', { name: 'Забыли пароль?' })).toHaveAttribute('href', '/reset-password');
    // Not clicked through: the next step sends an SMS code
  });
});

test.describe('Login — remember me', () => {
  test('"Запомнить меня" is checked by default and can be unchecked', async () => {
    await login.open();
    await expect(login.remember).toBeChecked();
    await login.remember.click();
    await expect(login.remember).not.toBeChecked();
  });

  test('checked: session survives a browser restart', async ({ page, browser }) => {
    await login.open();
    await login.login();
    await expect(page).toHaveURL(/\/welcome/);

    const restarted = await browser.newContext({ storageState: await page.context().storageState() });
    const again = await restarted.newPage();
    await again.goto('/profile');
    await expect(again).toHaveURL(/\/profile$/);
    await restarted.close();
  });

  test('unchecked: session does not survive a browser restart', async ({ page, browser }) => {
    test.fail(true, 'Known: "Запомнить меня" has no effect — tokens always go to localStorage');
    await login.open();
    await login.remember.click();
    await login.login();
    await expect(page).toHaveURL(/\/welcome/);

    // A new context gets cookies + localStorage only (as after closing the browser)
    const restarted = await browser.newContext({ storageState: await page.context().storageState() });
    const again = await restarted.newPage();
    await again.goto('/profile');
    await expect(again).toHaveURL(/\/login/);
    await restarted.close();
  });
});

test.describe('Login — language and theme', () => {
  test('language menu switches the login page to English and back', async ({ page }) => {
    await login.open();
    await page.getByRole('button', { name: 'Язык' }).click();
    await page.getByRole('menuitem', { name: 'English (EN)' }).click();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByRole('checkbox', { name: 'Remember me' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');

    await page.reload();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();

    await page.getByRole('button', { name: 'Language' }).click();
    await page.getByRole('menuitem', { name: 'Русский (RU)' }).click();
    await expect(login.submit).toBeVisible();
  });

  test('theme button switches to dark and it persists after reload', async ({ page }) => {
    await login.open();
    await expect(page.locator('html')).not.toHaveClass(/dark/);
    await page.locator('button[aria-label^="theme"], button[aria-label*="тем" i]').first().click();
    await expect(page.locator('html')).toHaveClass(/dark/);
    await page.reload();
    await expect(page.locator('html')).toHaveClass(/dark/);
  });

  test('theme button has a readable label', async ({ page }) => {
    test.fail(true, 'Known: theme button aria-label is the raw i18n key "theme.toDark"');
    await login.open();
    const label = await page.locator('button[aria-label^="theme"], button[aria-label*="тем" i]').first().getAttribute('aria-label');
    expect(label).not.toMatch(/^theme\./);
  });
});

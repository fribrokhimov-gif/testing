import { test, expect } from '@playwright/test';
import { LoginPage } from './pages/LoginPage';
import { refreshUrl } from './pages/api';

// Logout — account menu (avatar) → "Выйти" → confirm dialog
//   POST auth/logout { refresh_token } — tokens are removed from localStorage
// Each test logs in by itself in a fresh context, so only that new session is ended —
// the shared stored session of the other tests is never touched.
test.use({ storageState: { cookies: [], origins: [] } });

test.beforeEach(async ({ page }) => {
  const login = new LoginPage(page);
  await login.open();
  await login.login();
  await expect(page).toHaveURL(/\/welcome/);
  await page.getByRole('button', { name: 'Аккаунт' }).click();
  await page.getByRole('button', { name: 'Выйти' }).click();
  await expect(page.getByRole('dialog', { name: 'Выйти из аккаунта?' })).toBeVisible();
});

test('"Отмена" in the confirm dialog keeps the session', async ({ page }) => {
  let loggedOut = false;
  page.on('request', (r) => { if (r.url().includes('/auth/logout')) loggedOut = true; });

  await page.getByRole('dialog').getByRole('button', { name: 'Отмена' }).click();
  await expect(page.getByRole('dialog', { name: 'Выйти из аккаунта?' })).toBeHidden();
  await expect(page).toHaveURL(/\/welcome/);
  expect(loggedOut, 'auth/logout sent').toBe(false);

  await page.goto('/profile');
  await expect(page).toHaveURL(/\/profile$/);
});

test('"Выйти" ends the session: /login, tokens removed, refresh token revoked', async ({ page, request }) => {
  const refresh = await page.evaluate(() => localStorage.getItem('refresh_token'));
  const res = page.waitForResponse((r) => r.url().includes('/auth/logout'));
  await page.getByRole('dialog').getByRole('button', { name: 'Выйти' }).click();
  expect((await res).status()).toBe(200);

  await expect(page).toHaveURL(/\/login/);
  const keys = await page.evaluate(() => Object.keys(localStorage));
  expect(keys).not.toContain('auth_token');
  expect(keys).not.toContain('refresh_token');

  // Back button and direct links lead to /login again
  await page.goBack();
  await expect(page).toHaveURL(/\/login/);
  await page.goto('/profile');
  await expect(page).toHaveURL(/\/login/);

  const again = await request.post(refreshUrl, { data: { refresh_token: refresh }, headers: { 'X-Platform': 'web' } });
  expect([400, 401, 403], 'revoked refresh token').toContain(again.status());
});

import { test as setup, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

// Logs in to the merchant panel through the real login page and saves the session
// (the panel keeps auth_token / refresh_token in localStorage) for one E2E area.
// Each area has its own file, so parallel E2E runs never overwrite each other's session.
setup('log in as merchant admin', async ({ page }, testInfo) => {
  const authFile = testInfo.project.metadata.authFile as string;
  const phone = process.env.MERCHANT_PHONE ?? '';
  const password = process.env.MERCHANT_PASSWORD ?? '';
  expect(phone && password, 'Set MERCHANT_PHONE / MERCHANT_PASSWORD in .env').toBeTruthy();

  await page.goto('/login');
  const phoneField = page.locator('input[name=login]');
  await phoneField.click();
  await phoneField.pressSequentially(phone.replace(/^\+998/, ''), { delay: 20 });
  await page.locator('input[name=password]').fill(password);
  await page.getByRole('button', { name: 'Войти' }).click();

  await expect(page).toHaveURL(/\/welcome/, { timeout: 20_000 });
  fs.mkdirSync(path.dirname(authFile), { recursive: true });
  await page.context().storageState({ path: authFile });
});

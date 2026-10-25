import { test, expect, Page } from '@playwright/test';

// Change password — /profile/change-password (Старый пароль / Новый пароль / Повторите новый пароль)
//   POST auth/change-password { old_password, new_password }
// A real change logs out every session of the admin (also the other E2E runs), so it is NEVER done here:
// the real password is never typed, and a guard aborts any request whose body contains it anyway.
// Form-level checks must not send anything; only "wrong old password" reaches the API, which refuses it.
const REAL = process.env.MERCHANT_PASSWORD ?? '';
const WRONG_OLD = 'Qa-wrong-old-1';

let sent: { old_password: string; new_password: string }[];
let blocked: number;

test.beforeEach(async ({ page }) => {
  expect(REAL, 'MERCHANT_PASSWORD').toBeTruthy();
  sent = [];
  blocked = 0;
  await page.route(/\/api\/v1\/auth\/change-password/, (route) => {
    const body = route.request().postData() ?? '';
    if (body.includes(REAL)) {
      blocked++;
      return route.abort();
    }
    sent.push(route.request().postDataJSON());
    return route.continue();
  });
  await page.goto('/profile/change-password');
  await expect(page.getByRole('heading', { name: 'Изменить пароль', level: 1 })).toBeVisible();
});

test.afterEach(() => {
  expect(blocked, 'request with the real password').toBe(0);
});

async function submit(page: Page, oldPw: string, newPw: string, repeat = newPw) {
  await page.getByRole('textbox', { name: 'Старый пароль' }).fill(oldPw);
  await page.getByRole('textbox', { name: 'Новый пароль', exact: true }).fill(newPw);
  await page.getByRole('textbox', { name: 'Повторите новый пароль' }).fill(repeat);
  await page.getByRole('button', { name: 'Сохранить' }).click();
}

const alert = (page: Page, text: string) => page.getByRole('alert').filter({ hasText: text });

test.describe('Change password — form validation (nothing is sent)', () => {
  test.afterEach(() => {
    expect(sent, 'change-password requests').toEqual([]);
  });

  test('empty form asks for all three fields', async ({ page }) => {
    await page.getByRole('button', { name: 'Сохранить' }).click();
    await expect(alert(page, 'Введите пароль')).toHaveCount(2);
    await expect(alert(page, 'Повторите новый пароль')).toBeVisible();
  });

  const cases: [string, string, string?][] = [
    ['new password shorter than 8 characters', 'Ab1'],
    ['new password without a digit', 'abcdefgh'],
    ['new password without a letter', '12345678'],
    ['new password longer than 128 characters', 'Aa1' + 'x'.repeat(126)],
  ];
  const messages = [
    'Пароль должен содержать минимум 8 символов',
    'Пароль должен содержать хотя бы одну цифру',
    'Пароль должен содержать хотя бы одну букву',
    'Пароль не должен превышать 128 символов',
  ];
  cases.forEach(([name, pw], i) => {
    test(`${name} is refused`, async ({ page }) => {
      await submit(page, WRONG_OLD, pw);
      await expect(alert(page, messages[i])).toBeVisible();
      await expect(page.getByRole('textbox', { name: 'Новый пароль', exact: true })).toHaveAttribute('aria-invalid', 'true');
    });
  });

  test('new password same as the old one is refused', async ({ page }) => {
    await submit(page, WRONG_OLD, WRONG_OLD);
    await expect(alert(page, 'Новый пароль должен отличаться от старого')).toBeVisible();
  });

  test('repeat that does not match is refused', async ({ page }) => {
    await submit(page, WRONG_OLD, 'Qa-new-pass-123', 'Qa-new-pass-124');
    await expect(alert(page, 'Пароли не совпадают')).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Повторите новый пароль' })).toHaveAttribute('aria-invalid', 'true');
  });
});

test.describe('Change password — API checks', () => {
  test('wrong old password: "Неверный старый пароль." and the session stays', async ({ page }) => {
    const res = page.waitForResponse((r) => r.url().includes('/auth/change-password'));
    await submit(page, WRONG_OLD, 'Qa-new-pass-123');
    expect((await res).status()).toBe(400);
    expect(sent).toEqual([{ old_password: WRONG_OLD, new_password: 'Qa-new-pass-123' }]);
    await expect(alert(page, 'Неверный старый пароль.')).toBeVisible();
    await expect(page).toHaveURL(/\/profile\/change-password/);

    // Still logged in
    await page.goto('/profile');
    await expect(page).toHaveURL(/\/profile$/);
  });
});

test.describe('Change password — page', () => {
  test('show password toggles each field', async ({ page }) => {
    const old = page.getByRole('textbox', { name: 'Старый пароль' });
    await old.fill('Qa-visible-1');
    await expect(old).toHaveAttribute('type', 'password');
    await page.getByRole('button', { name: 'Показать пароль' }).first().click();
    await expect(old).toHaveAttribute('type', 'text');
  });

  test('"Назад в профиль" returns to /profile', async ({ page }) => {
    await page.getByRole('link', { name: 'Назад в профиль' }).click();
    await expect(page).toHaveURL(/\/profile$/);
    expect(sent).toEqual([]);
  });
});

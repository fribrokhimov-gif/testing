import { Page, Locator } from '@playwright/test';

// /login — phone field has a +998 mask (type the 9 digits after it), "Запомнить меня" is checked by default
export class LoginPage {
  readonly phone: Locator;
  readonly password: Locator;
  readonly remember: Locator;
  readonly submit: Locator;

  constructor(readonly page: Page) {
    this.phone = page.locator('input[name=login]');
    this.password = page.locator('input[name=password]');
    this.remember = page.getByRole('checkbox', { name: 'Запомнить меня' });
    this.submit = page.getByRole('button', { name: 'Войти' });
  }

  async open() {
    await this.page.goto('/login');
    await this.phone.waitFor();
  }

  async typePhone(digits: string) {
    await this.phone.click();
    await this.phone.pressSequentially(digits.replace(/^\+998/, ''), { delay: 20 });
  }

  async login(phone = process.env.MERCHANT_PHONE ?? '', password = process.env.MERCHANT_PASSWORD ?? '') {
    await this.typePhone(phone);
    await this.password.fill(password);
    await this.submit.click();
  }
}

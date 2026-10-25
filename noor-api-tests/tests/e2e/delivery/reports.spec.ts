import { test, expect, Page } from '@playwright/test';

// Reports screen (/delivery/reports): list of created reports, "Новый отчет" → pick dates → "Применить"
//   GET orders/reports?limit=15&skip=0       — list the page shows
//   GET orders/export?from_date=&till_date=  — creates a report (till_date is exclusive)
// Reports cannot be deleted, so the create test intercepts orders/export in the browser:
// it checks what the panel sends, and the request never reaches the server. Nothing is created.

type Report = { id: number; from_date: string; till_date: string; path: string; created_at: string };
type ReportPage = { data: Report[] | null; count: number };

const dayMonth = (iso: string, plusDays = 0) =>
  new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: 'long', timeZone: 'UTC' }).format(
    new Date(Date.parse(iso) + plusDays * 86_400_000),
  );
const createdDate = (iso: string) =>
  new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Tashkent' }).format(new Date(iso));
const isoDay = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent' }).format(d);

/** Opens the reports page and returns the list response it loaded. */
async function openReports(page: Page) {
  const res = page.waitForResponse((r) => r.url().includes('/orders/reports?') && r.request().method() === 'GET');
  await page.goto('/delivery/reports');
  const body = (await (await res).json()) as ReportPage;
  await expect(page.getByRole('heading', { name: 'Отчеты', level: 1 })).toBeVisible();
  return { ...body, data: body.data ?? [] };
}

const rows = (page: Page) => page.getByRole('main').getByRole('list').getByRole('listitem');

test.describe('Reports — list', () => {
  test('list shows the reports the API returned', async ({ page }) => {
    const api = await openReports(page);
    test.skip(!api.data.length, 'No reports on this account');

    await expect(rows(page)).toHaveCount(api.data.length);
    await expect(page.getByText(`Показано 1 - ${api.data.length} из ${api.count} записей`)).toBeVisible();

    // Newest report first, with its creation date and download link
    const [first] = api.data;
    await expect(rows(page).first()).toContainText(createdDate(first.created_at));
    await expect(rows(page).first().getByRole('link', { name: 'Скачать' })).toHaveAttribute('href', new RegExp(`${first.path}$`));
  });

  test('period shows the last selected day, not the exclusive till_date', async ({ page }) => {
    test.fail(true, 'Known: period shows till_date as is, so a report for 16 Oct reads "16 октября - 17 октября"');
    const api = await openReports(page);
    test.skip(!api.data.length, 'No reports on this account');

    const [first] = api.data;
    await expect(rows(page).first()).toContainText(`${dayMonth(first.from_date)} - ${dayMonth(first.till_date, -1)}`);
  });
});

test.describe('Reports — new report dialog', () => {
  test('"Вчера" sends yesterday as a one-day range (request intercepted, nothing created)', async ({ page }) => {
    await openReports(page);

    // Abort export in the browser so no report is stored on the shared account
    const sent: URL[] = [];
    await page.route('**/orders/export**', (route) => {
      sent.push(new URL(route.request().url()));
      return route.abort();
    });

    await page.getByRole('button', { name: 'Новый отчет' }).click();
    const dialog = page.getByRole('dialog', { name: 'Новый отчет' });
    await expect(dialog).toBeVisible();

    const today = new Date();
    const yesterday = new Date(today.getTime() - 86_400_000);
    await dialog.getByRole('button', { name: /^Вчера/ }).click();
    const shown = yesterday.toLocaleDateString('ru-RU', { timeZone: 'Asia/Tashkent' });
    await expect(dialog.getByText(`${shown} — ${shown}`)).toBeVisible();

    await dialog.getByRole('button', { name: 'Применить' }).click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0].searchParams.get('from_date')).toBe(isoDay(yesterday));
    expect(sent[0].searchParams.get('till_date')).toBe(isoDay(today));
  });
});

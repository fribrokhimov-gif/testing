import { test, expect, APIRequestContext } from '@playwright/test';
import ExcelJS from 'exceljs';
import { getTokens, bearer, env, login, extractTokens } from '../../api/auth';

// Reports page: "Create report" → pick dates → "Create"
//   GET orders/export?from_date=&till_date=  — creates a report record, returns its .xlsx path
//   GET orders/reports?limit=&skip=          — list of created reports, newest first
// till_date is exclusive — the panel sends the day after the last selected date.
// There is no delete endpoint, so every successful create stays on the account: keep it to one per run.
// The file itself is served at FILES_URL/<path> (no token needed).
const exportUrl = `${env.deliveryUrl}/orders/export`;
const reportsUrl = `${env.deliveryUrl}/orders/reports`;
const ordersUrl = `${env.deliveryUrl}/orders/for-merchant`;

// Report column headers (Uzbek)
const COL = {
  displayId: "Ko'rsatilgan ID",
  vendorId: 'Sotuvchi ID',
  deliveryPrice: 'Umumiy yetkazib berish narxi',
  stage: 'Bosqich',
};

// Order stage → status text in the report
const STAGE_NAMES: Record<number, string> = {
  15: 'Yetkazib berish tugadi', // finished
  20: 'Qaytarish tugadi', // returned
  22: 'Bekor qilindi', // cancelled
  27: 'Kuryer topilmadi', // courier not found
};
// Stages where the report's delivery price equals the order's
const CHARGED_STAGES = [15, 20];

type Order = { id: number; display_id: number; vendor_order_id: string | null; stage: number; total_delivery_price: number; created_at: string };

type Report = {
  id: number;
  from_date: string;
  till_date: string;
  path: string;
  vendor_location_id: number | null;
  created_at: string;
};
type ReportPage = { data: Report[] | null; count: number; page_size: number; current_page: number; last_page: number };

const day = (plusDays = 0) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + plusDays);
  return d.toISOString().slice(0, 10);
};
const nextDay = (d: string) => new Date(Date.parse(d) + 86_400_000).toISOString().slice(0, 10);

// Access tokens live 60s, so each test logs in fresh
let headers: Record<string, string>;
test.beforeEach(async ({ request }) => {
  headers = bearer((await getTokens(request)).access_token);
});

async function listReports(request: APIRequestContext, params: Record<string, number> = {}) {
  const res = await request.get(reportsUrl, { headers, params });
  expect(res.status(), await res.text()).toBe(200);
  const body = (await res.json()) as ReportPage;
  return { ...body, data: body.data ?? [] };
}

/** All orders for a date range, as the orders page lists them. */
async function ordersFor(request: APIRequestContext, range: { from_date: string; till_date: string }) {
  const out: Order[] = [];
  for (let skip = 0; ; skip += 100) {
    const res = await request.get(ordersUrl, { headers, params: { ...range, limit: 100, skip } });
    expect(res.status(), await res.text()).toBe(200);
    const p = (await res.json()) as { data: Order[] | null; count: number };
    out.push(...(p.data ?? []));
    if (!p.data?.length || out.length >= p.count) return out;
  }
}

/** Downloads the report's .xlsx — retries while the file is still being generated. */
async function downloadReport(request: APIRequestContext, path: string) {
  let res = await request.get(`${env.filesUrl}/${path}`);
  for (let i = 0; i < 15 && res.status() !== 200; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    res = await request.get(`${env.filesUrl}/${path}`);
  }
  expect(res.status(), `download ${path}`).toBe(200);
  expect(res.headers()['content-type']).toContain('spreadsheetml');

  const book = new ExcelJS.Workbook();
  await book.xlsx.load(await res.body());
  const sheet = book.worksheets[0];
  const header = (sheet.getRow(1).values as unknown[]).map((v) => String(v ?? ''));
  const rows: Record<string, string>[] = [];
  sheet.eachRow((row, n) => {
    if (n === 1) return;
    const values = row.values as unknown[];
    rows.push(Object.fromEntries(header.map((h, i) => [h, String(values[i] ?? '')]).filter(([h]) => h)));
  });
  return { header, rows };
}

test.describe('Reports — create', () => {
  test.describe.configure({ mode: 'serial' });

  // The finished day with the most recent orders, picked in the calendar as a one-day range
  let range: { from_date: string; till_date: string };
  let expected: Order[];
  let created: Report;

  test.beforeAll(async ({ request }) => {
    headers = bearer((await getTokens(request)).access_token);
    const res = await request.get(ordersUrl, { headers, params: { limit: 100, skip: 0 } });
    const perDay = new Map<string, number>();
    for (const o of ((await res.json()).data ?? []) as Order[]) {
      const d = o.created_at.slice(0, 10);
      if (d < day()) perDay.set(d, (perDay.get(d) ?? 0) + 1);
    }
    const busiest = [...perDay].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!busiest) return;

    range = { from_date: busiest, till_date: nextDay(busiest) };
    expected = await ordersFor(request, range);
  });

  test('create report for a day with orders', async ({ request }) => {
    test.skip(!range, 'No orders before today on this account');
    expect(expected.length, `orders on ${range.from_date}`).toBeGreaterThan(0);
    test.info().annotations.push({ type: 'day', description: `${range.from_date}: ${expected.length} orders` });

    const startedAt = Date.now();
    const res = await request.get(exportUrl, { headers, params: range });
    expect(res.status(), await res.text()).toBe(200);

    created = await res.json();
    expect(typeof created.id).toBe('number');
    expect(created).toMatchObject(range);
    expect(created.path).toMatch(new RegExp(`^reports/.+_${range.from_date}_${range.till_date}\\.xlsx$`));
    expect(Math.abs(new Date(created.created_at).getTime() - startedAt)).toBeLessThan(5 * 60_000);
  });

  test('report file contains exactly the orders of that day', async ({ request }) => {
    test.skip(!created, 'Report was not created');
    const { header, rows } = await downloadReport(request, created.path);
    for (const col of [COL.displayId, COL.vendorId, COL.deliveryPrice]) expect(header, col).toContain(col);

    const inFile = rows.map((r) => r[COL.displayId]).sort();
    const inList = expected.map((o) => `#${o.display_id}`).sort();
    expect(inFile, `report ${created.id} vs orders on ${range.from_date}`).toEqual(inList);
  });

  test('report rows match the order details', async ({ request }) => {
    test.skip(!created, 'Report was not created');
    const { rows } = await downloadReport(request, created.path);
    const byId = new Map(rows.map((r) => [r[COL.displayId], r]));

    for (const o of expected) {
      const id = `#${o.display_id}`;
      const row = byId.get(id);
      expect(row, `${id} missing`).toBeDefined();
      expect(row![COL.vendorId], `${id} vendor ID`).toBe(o.vendor_order_id ?? '');
      if (STAGE_NAMES[o.stage]) expect(row![COL.stage], `${id} status`).toBe(STAGE_NAMES[o.stage]);
      // Cancelled / not found: the list shows the quoted price, the report shows what was charged
      if (CHARGED_STAGES.includes(o.stage)) {
        expect(Number(row![COL.deliveryPrice]), `${id} delivery price`).toBe(o.total_delivery_price);
      }
    }
  });

  test('new report appears first on the reports page', async ({ request }) => {
    test.skip(!created, 'Report was not created');
    // Same request the reports page makes
    const page = await listReports(request, { limit: 15, skip: 0 });
    expect(page.current_page).toBe(1);
    expect(page.data.length).toBeLessThanOrEqual(15);

    const [first] = page.data;
    expect(first, 'newest report on the page').toMatchObject({
      id: created.id,
      path: created.path,
      vendor_location_id: created.vendor_location_id,
      // List returns full timestamps, create returns plain dates
      from_date: `${range.from_date}T00:00:00Z`,
      till_date: `${range.till_date}T00:00:00Z`,
    });
    expect(Math.abs(Date.parse(first.created_at) - Date.parse(created.created_at))).toBeLessThan(1000);
    expect(page.data.filter((r) => r.id === created.id)).toHaveLength(1);
  });
});

test.describe('Reports — validation', () => {
  test('without dates is rejected', async ({ request }) => {
    const res = await request.get(exportUrl, { headers });
    expect(res.status()).toBe(400);
    expect(await res.json()).toEqual({ from_date: expect.any(String), till_date: expect.any(String) });
  });

  test('without end date is rejected', async ({ request }) => {
    const res = await request.get(exportUrl, { headers, params: { from_date: day(-6) } });
    expect(res.status()).toBe(400);
    expect(await res.json()).toHaveProperty('till_date');
  });

  test('invalid date format is rejected', async ({ request }) => {
    const res = await request.get(exportUrl, { headers, params: { from_date: '19.10.2026', till_date: day(1) } });
    expect(res.status()).toBe(400);
    expect(await res.json()).toHaveProperty('from_date');
  });

  // Not run: today the API accepts it and stores a junk report that cannot be deleted
  test.fixme('start date after end date is rejected', async ({ request }) => {
    const res = await request.get(exportUrl, { headers, params: { from_date: day(1), till_date: day(-6) } });
    expect(res.status()).toBe(400);
  });
});

test.describe('Reports — list', () => {
  test('list returns reports with pagination fields', async ({ request }) => {
    const p = await listReports(request);
    for (const k of ['count', 'page_size', 'current_page', 'last_page'] as const) {
      expect(typeof p[k], k).toBe('number');
    }
    for (const r of p.data) {
      expect(typeof r.id).toBe('number');
      expect(r.path, String(r.id)).toMatch(/^reports\/.+\.xlsx$/);
    }
  });

  test('list is sorted newest first', async ({ request }) => {
    const ids = (await listReports(request)).data.map((r) => r.id);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
  });

  test('limit controls page size', async ({ request }) => {
    const p = await listReports(request, { limit: 2, skip: 0 });
    test.skip(p.count < 3, 'Need at least 3 reports');
    expect(p.data).toHaveLength(2);
    expect(p.last_page).toBe(Math.ceil(p.count / 2));
  });
});

test.describe('Reports — access', () => {
  test('create and list without token are rejected', async ({ request }) => {
    const create = await request.get(exportUrl, { params: { from_date: day(-6), till_date: day(1) } });
    expect(create.status()).toBe(401);

    const list = await request.get(reportsUrl);
    expect(list.status()).toBe(401);
  });
});

// Cashier is read only: can see the reports list, cannot create a report.
// Needs an existing cashier (CASHIER_PHONE / CASHIER_PASSWORD in .env).
test.describe('Reports — cashier is read only', () => {
  let cashier: Record<string, string>;

  test.beforeEach(async ({ request }) => {
    const phone = process.env.CASHIER_PHONE ?? '';
    const password = process.env.CASHIER_PASSWORD ?? '';
    test.skip(!phone || !password, 'Set CASHIER_PHONE / CASHIER_PASSWORD in .env');
    const res = await login(request, phone, password);
    expect(res.status(), 'cashier login').toBe(200);
    cashier = bearer(extractTokens(await res.json()).access_token!);
  });

  test('cashier can see the reports list', async ({ request }) => {
    const res = await request.get(reportsUrl, { headers: cashier, params: { limit: 15, skip: 0 } });
    expect(res.status(), await res.text()).toBe(200);
  });

  test('cashier cannot create a report', async ({ request }) => {
    // If this is ever allowed it creates one report, which cannot be deleted
    const res = await request.get(exportUrl, { headers: cashier, params: { from_date: day(-1), till_date: day() } });
    expect(res.status(), await res.text()).toBe(403);
  });
});

// Manager can see reports but cannot create them. Needs MANAGER_PHONE / MANAGER_PASSWORD in .env.
test.describe('Reports — manager can only read', () => {
  let manager: Record<string, string>;

  test.beforeEach(async ({ request }) => {
    const phone = process.env.MANAGER_PHONE ?? '';
    const password = process.env.MANAGER_PASSWORD ?? '';
    test.skip(!phone || !password, 'Set MANAGER_PHONE / MANAGER_PASSWORD in .env');
    const res = await login(request, phone, password);
    expect(res.status(), 'manager login').toBe(200);
    manager = bearer(extractTokens(await res.json()).access_token!);
  });

  test('manager can see the reports list', async ({ request }) => {
    const res = await request.get(reportsUrl, { headers: manager, params: { limit: 15, skip: 0 } });
    expect(res.status(), await res.text()).toBe(200);
  });

  test('manager cannot create a report', async ({ request }) => {
    // If this is ever allowed it creates one report, which cannot be deleted
    const res = await request.get(exportUrl, { headers: manager, params: { from_date: day(-1), till_date: day() } });
    expect(res.status(), await res.text()).toBe(403);
  });
});

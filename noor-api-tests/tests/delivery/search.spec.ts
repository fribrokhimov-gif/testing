import { test, expect, APIRequestContext } from '@playwright/test';
import { getTokens, bearer, env } from '../../api/auth';

// Delivery orders list: GET orders/for-merchant ?search=&limit=&skip=&from_date=&till_date=&is_<tab>=true
// Response: { data: Order[], count, page_size, current_page, last_page, count_info }
// till_date is exclusive — the panel sends the day after the last selected date.
const url = `${env.deliveryUrl}/orders/for-merchant`;

type Order = {
  id: number;
  display_id: number;
  vendor_order_id: string | null;
  stage: number;
  created_at: string;
  total_delivery_price: number;
  origin_address: string[];
  destination_address: string[];
};
type CountInfo = Record<(typeof TABS)[number], number> & { total: number; not_paid_count: number; debt_count: number };
type Page = {
  data: Order[] | null;
  count: number;
  page_size: number;
  current_page: number;
  last_page: number;
  count_info: CountInfo;
};

// Status tabs: query flag is_<key>=true, count in count_info[key]
const TABS = ['scheduled', 'in_search', 'not_found', 'active', 'returned', 'finished', 'cancelled'] as const;

const day = (iso: string, plusDays = 0) => {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + plusDays);
  return d.toISOString().slice(0, 10);
};

// Access tokens live 60s, so each test logs in fresh
let headers: Record<string, string>;
test.beforeEach(async ({ request }) => {
  headers = bearer((await getTokens(request)).access_token);
});

const list = (request: APIRequestContext, params: Record<string, string | number | boolean> = {}) =>
  request.get(url, { headers, params: { limit: 25, skip: 0, ...params } });

async function page(request: APIRequestContext, params: Record<string, string | number | boolean> = {}) {
  const res = await list(request, params);
  expect(res.status(), await res.text()).toBe(200);
  const body = (await res.json()) as Page;
  return { ...body, data: body.data ?? [] };
}

/** All orders on the account, newest first. */
async function allOrders(request: APIRequestContext) {
  const out: Order[] = [];
  for (let skip = 0; ; skip += 100) {
    const p = await page(request, { limit: 100, skip });
    out.push(...p.data);
    if (!p.data.length || out.length >= p.count) return out;
  }
}

/** Week ending at the newest order — the panel's default view. */
async function lastWeek(request: APIRequestContext) {
  const newest = (await page(request, { limit: 1 })).data[0];
  test.skip(!newest, 'No orders on this account');
  return { from_date: day(newest.created_at, -6), till_date: day(newest.created_at, 1) };
}

test.describe('Orders — search', () => {
  test('search by full order ID finds that order', async ({ request }) => {
    const target = (await page(request)).data[0];
    test.skip(!target, 'No orders on this account');

    const p = await page(request, { search: String(target.display_id) });
    expect(p.data.map((o) => o.id)).toEqual([target.id]);
  });

  test('search by start of order ID finds that order', async ({ request }) => {
    const target = (await page(request)).data[0];
    test.skip(!target, 'No orders on this account');

    const prefix = String(target.display_id).slice(0, 4);
    const p = await page(request, { search: prefix, limit: 100 });
    expect(p.data.map((o) => o.id)).toContain(target.id);
  });

  test('order ID with # is not supported', async ({ request }) => {
    const target = (await page(request)).data[0];
    test.skip(!target, 'No orders on this account');

    const p = await page(request, { search: `#${target.display_id}` });
    expect(p.count).toBe(0);
  });

  test('search by vendor order ID finds that order', async ({ request }) => {
    // Use the rarest vendor ID so the check means something when most orders share one
    const orders = await allOrders(request);
    const freq = new Map<string, number>();
    for (const o of orders) if (o.vendor_order_id) freq.set(o.vendor_order_id, (freq.get(o.vendor_order_id) ?? 0) + 1);
    const rarest = [...freq].sort((a, b) => a[1] - b[1])[0]?.[0];
    test.skip(!rarest || freq.get(rarest) === orders.length, 'No order with a distinct vendor_order_id');

    const expected = orders.filter((o) => o.vendor_order_id === rarest).map((o) => o.id);
    const p = await page(request, { search: rarest!, limit: 100 });
    expect(p.data.map((o) => o.id)).toEqual(expect.arrayContaining(expected));
  });

  test('search finds orders outside the selected dates', async ({ request }) => {
    test.fail(true, 'Known: API applies from_date/till_date to search, so older orders are not found');

    const range = await lastWeek(request);
    const older = (await allOrders(request)).find((o) => o.created_at < range.from_date);
    test.skip(!older, 'No orders older than the last week');

    const p = await page(request, { ...range, search: String(older!.display_id) });
    expect(p.data.map((o) => o.id)).toContain(older!.id);
  });

  test('empty search returns the same list as no search', async ({ request }) => {
    const range = await lastWeek(request);
    const plain = await page(request, range);
    const empty = await page(request, { ...range, search: '' });
    expect(empty.count).toBe(plain.count);
    expect(empty.data.map((o) => o.id)).toEqual(plain.data.map((o) => o.id));
  });

  test('no match returns empty list and count 0', async ({ request }) => {
    const p = await page(request, { search: 'zzqx-no-such-order-91' });
    expect(p.data).toHaveLength(0);
    expect(p.count).toBe(0);
  });

  test('special characters and long input do not cause server errors', async ({ request }) => {
    for (const term of [`' OR 1=1 --`, '%', '_', '<script>', '+998', 'ўзбек', 'a'.repeat(600)]) {
      const res = await list(request, { search: term });
      expect(res.status(), `term: ${term.slice(0, 20)}`).toBeLessThan(500);
    }
  });
});

test.describe('Orders — status tabs', () => {
  test('each tab returns only its own orders and matches its count', async ({ request }) => {
    const range = await lastWeek(request);
    const { count_info } = await page(request, range);
    const seen = new Set<number>();

    for (const tab of TABS) {
      const p = await page(request, { ...range, limit: 100, [`is_${tab}`]: true });
      expect(p.count, tab).toBe(count_info[tab]);
      expect(new Set(p.data.map((o) => o.stage)).size, `${tab}: one stage per tab`).toBeLessThanOrEqual(1);
      for (const o of p.data) {
        expect(seen.has(o.id), `order ${o.display_id} is in more than one tab`).toBe(false);
        seen.add(o.id);
      }
    }
  });

  test('tab counts add up to "All"', async ({ request }) => {
    const p = await page(request, await lastWeek(request));
    const sum = TABS.reduce((n, tab) => n + p.count_info[tab], 0);
    expect(p.count_info.total).toBe(p.count);
    expect(sum).toBe(p.count_info.total);
  });

  test('unpaid and courier-debt filters match their counts', async ({ request }) => {
    // Both are 0 on the test account today, so this only bites once such orders exist
    const range = await lastWeek(request);
    const { count_info } = await page(request, range);
    expect((await page(request, { ...range, is_paid: false })).count).toBe(count_info.not_paid_count);
    expect((await page(request, { ...range, is_courier_debt: true })).count).toBe(count_info.debt_count);
  });

  test('tab and search apply together', async ({ request }) => {
    const range = await lastWeek(request);
    const target = (await page(request, { ...range, is_cancelled: true })).data[0];
    test.skip(!target, 'No cancelled orders in the last week');
    const search = String(target.display_id);

    expect((await page(request, { ...range, search, is_cancelled: true })).data.map((o) => o.id)).toEqual([target.id]);
    expect((await page(request, { ...range, search, is_finished: true })).count).toBe(0);
  });
});

test.describe('Orders — date range', () => {
  test('returns only orders inside the range', async ({ request }) => {
    const range = await lastWeek(request);
    const p = await page(request, { ...range, limit: 100 });
    expect(p.count).toBeGreaterThan(0);
    for (const o of p.data) {
      expect(day(o.created_at) >= range.from_date && day(o.created_at) < range.till_date, `${o.display_id} ${o.created_at}`).toBe(true);
    }
  });

  test('single day includes orders from that day only', async ({ request }) => {
    const target = (await page(request)).data[0];
    test.skip(!target, 'No orders on this account');
    const d = day(target.created_at);

    const p = await page(request, { from_date: d, till_date: day(d, 1), limit: 100 });
    expect(p.data.map((o) => o.id)).toContain(target.id);
    for (const o of p.data) expect(day(o.created_at), String(o.display_id)).toBe(d);
  });

  test('future range returns nothing', async ({ request }) => {
    const p = await page(request, { from_date: day(new Date().toISOString(), 365), till_date: day(new Date().toISOString(), 395) });
    expect(p.count).toBe(0);
  });

  test('reversed range returns nothing', async ({ request }) => {
    const range = await lastWeek(request);
    const p = await page(request, { from_date: range.till_date, till_date: range.from_date });
    expect(p.count).toBe(0);
  });

  test('invalid date format is rejected', async ({ request }) => {
    const res = await list(request, { from_date: '19.10.2026', till_date: '2026-10-26' });
    expect(res.status()).toBe(400);
  });
});

test.describe('Orders — pagination', () => {
  test('list returns pagination fields', async ({ request }) => {
    const p = await page(request);
    for (const k of ['count', 'page_size', 'current_page', 'last_page'] as const) {
      expect(typeof p[k], k).toBe('number');
    }
    expect(p.data.length).toBeLessThanOrEqual(25);
  });

  test('page 2 continues page 1 without overlap', async ({ request }) => {
    const p1 = await page(request, { limit: 5, skip: 0 });
    test.skip(p1.count <= 5, 'Need more than 5 orders');
    const p2 = await page(request, { limit: 5, skip: 5 });

    expect(p2.current_page).toBe(2);
    expect(p2.last_page).toBe(Math.ceil(p2.count / 5));
    const ids1 = p1.data.map((o) => o.id);
    for (const o of p2.data) expect(ids1).not.toContain(o.id);
  });

  test('orders are sorted newest first', async ({ request }) => {
    const dates = (await page(request, { limit: 100 })).data.map((o) => o.created_at);
    expect(dates).toEqual([...dates].sort().reverse());
  });

  test('skip past the end returns an empty page', async ({ request }) => {
    const { count } = await page(request, { limit: 1 });
    const p = await page(request, { limit: 5, skip: count + 100 });
    expect(p.data).toHaveLength(0);
  });

  test('negative limit or skip does not cause server errors', async ({ request }) => {
    test.fail(true, 'Known: limit=-1 and skip=-1 return 500');
    for (const params of [{ limit: -1 }, { skip: -1 }] as Record<string, number>[]) {
      const res = await list(request, params);
      expect(res.status(), JSON.stringify(params)).toBeLessThan(500);
    }
  });
});

test.describe('Orders — row data', () => {
  test('each order has the fields shown in the table', async ({ request }) => {
    const p = await page(request, { limit: 100 });
    for (const o of p.data) {
      expect(typeof o.display_id, String(o.id)).toBe('number');
      expect(typeof o.stage, String(o.display_id)).toBe('number');
      expect(o.origin_address.length, `${o.display_id} origin`).toBeGreaterThan(0);
      expect(o.destination_address.length, `${o.display_id} destination`).toBeGreaterThan(0);
      expect(o.total_delivery_price, `${o.display_id} price`).toBeGreaterThanOrEqual(0);
    }
  });
});

test.describe('Orders — access', () => {
  test('request without token is rejected', async ({ request }) => {
    const res = await request.get(url, { params: { search: '1' } });
    expect(res.status()).toBe(401);
  });

  test('request with invalid token is rejected', async ({ request }) => {
    const res = await request.get(url, { headers: bearer('abc.def.ghi'), params: { search: '1' } });
    expect(res.status()).toBe(401);
  });
});

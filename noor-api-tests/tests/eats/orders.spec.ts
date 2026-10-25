import { test, expect, APIRequestContext } from '@playwright/test';
import { getTokens, bearer, env } from '../../api/auth';

// Eats → Заказы. Read-only: these tests never change an order.
//   GET merchant/orders/by-restaurant?restaurant_id=&pagination.limit=  — { list, data: { counts }, meta: { total } }
//       restaurant_id is optional: without it the merchant's orders across all branches come back
//   GET merchant/orders/by-restaurant/{id}?restaurant_id=               — { data: { order } }
//   GET merchant/orders/weekday-counts?created_from=&created_to=        — dashboard "Нагруженные дни"
// Every row: { merchant_order_status, order: { status, items, delivery_fee, service_fee, total_price, … } }
const api = env.merchantApiUrl;
const ordersUrl = `${api}/merchant/orders/by-restaurant`;
const weekdayUrl = `${api}/merchant/orders/weekday-counts`;
const restaurantsUrl = `${api}/merchant/restaurants`;

type Item = { name: string; price: number; quantity: number; product_id: string };
type Order = {
  id: string;
  order_number: number;
  status: string;
  restaurant_id: string;
  created_at: string;
  items: Item[];
  delivery_fee: number;
  service_fee: number;
  total_price: number;
  payment_type: string;
  delivery_method: string;
};
type Row = { merchant_order_status: string; order: Order };

const WEEKDAYS = ['WEEKDAY_MONDAY', 'WEEKDAY_TUESDAY', 'WEEKDAY_WEDNESDAY', 'WEEKDAY_THURSDAY', 'WEEKDAY_FRIDAY', 'WEEKDAY_SATURDAY', 'WEEKDAY_SUNDAY'];

// Access tokens live 60s, so each test logs in fresh
let headers: Record<string, string>;
test.beforeEach(async ({ request }) => {
  headers = { ...bearer((await getTokens(request)).access_token), 'x-locale': 'ru' };
});

async function page(request: APIRequestContext, params: Record<string, string | number> = {}) {
  const res = await request.get(ordersUrl, { headers, params: { 'pagination.limit': 100, ...params } });
  expect(res.status(), await res.text()).toBe(200);
  const body = await res.json();
  return { rows: (body.list ?? []) as Row[], counts: body.data?.counts as Record<string, number>, total: body.meta?.total as number };
}

/** The branch with the most orders, so the checks have data to work on. */
async function busiestBranch(request: APIRequestContext) {
  const restaurants = (await (await request.get(restaurantsUrl, { headers })).json()).list as { id: string; name: string }[];
  let best = { id: '', total: 0 };
  for (const r of restaurants) {
    const { total } = await page(request, { restaurant_id: r.id, 'pagination.limit': 1 });
    if (total > best.total) best = { id: r.id, total };
  }
  test.skip(!best.total, 'No Eats orders on this account');
  return best.id;
}

test.describe('Eats orders — list', () => {
  test('list returns orders with the fields the table shows', async ({ request }) => {
    const { rows, total } = await page(request, { restaurant_id: await busiestBranch(request) });
    expect(rows.length).toBe(total);
    for (const { order, merchant_order_status } of rows) {
      expect(order.order_number, order.id).toBeGreaterThan(0);
      expect(order.status, order.id).toMatch(/^ORDER_STATUS_/);
      expect(merchant_order_status, order.id).toMatch(/^MERCHANT_ORDER_STATUS_/);
      expect(order.items.length, `${order.order_number} items`).toBeGreaterThan(0);
      expect(order.payment_type, String(order.order_number)).toMatch(/^PAYMENT_TYPE_/);
    }
  });

  test('every order belongs to the branch it was listed for', async ({ request }) => {
    const restaurantId = await busiestBranch(request);
    const { rows } = await page(request, { restaurant_id: restaurantId });
    for (const { order } of rows) expect(order.restaurant_id, String(order.order_number)).toBe(restaurantId);
  });

  test('all-branches list equals the sum of the branch lists', async ({ request }) => {
    const restaurants = (await (await request.get(restaurantsUrl, { headers })).json()).list as { id: string }[];
    let sum = 0;
    for (const r of restaurants) sum += (await page(request, { restaurant_id: r.id, 'pagination.limit': 1 })).total;
    expect((await page(request, { 'pagination.limit': 1 })).total).toBe(sum);
  });

  test('orders are sorted newest first', async ({ request }) => {
    const { rows } = await page(request, { restaurant_id: await busiestBranch(request) });
    const dates = rows.map((r) => r.order.created_at);
    expect(dates).toEqual([...dates].sort().reverse());
  });

  test('limit controls page size', async ({ request }) => {
    const restaurantId = await busiestBranch(request);
    const { total } = await page(request, { restaurant_id: restaurantId, 'pagination.limit': 1 });
    test.skip(total < 2, 'Need at least 2 orders');
    const one = await page(request, { restaurant_id: restaurantId, 'pagination.limit': 1 });
    expect(one.rows).toHaveLength(1);
    expect(one.total).toBe(total);
  });
});

test.describe('Eats orders — money', () => {
  test('total = items + delivery fee + service fee', async ({ request }) => {
    const { rows } = await page(request);
    test.skip(!rows.length, 'No Eats orders');
    for (const { order } of rows) {
      const items = order.items.reduce((s, i) => s + i.price * i.quantity, 0);
      expect(order.total_price, `#${order.order_number}`).toBe(items + order.delivery_fee + order.service_fee);
    }
  });

  test('prices and fees are not negative', async ({ request }) => {
    const { rows } = await page(request);
    for (const { order } of rows) {
      for (const [k, v] of Object.entries({ delivery_fee: order.delivery_fee, service_fee: order.service_fee, total_price: order.total_price })) {
        expect(v, `#${order.order_number} ${k}`).toBeGreaterThanOrEqual(0);
      }
      for (const i of order.items) {
        expect(i.price, `#${order.order_number} ${i.name}`).toBeGreaterThanOrEqual(0);
        expect(i.quantity, `#${order.order_number} ${i.name}`).toBeGreaterThan(0);
      }
    }
  });
});

test.describe('Eats orders — statuses', () => {
  test('cancelled and delivered orders agree on both sides', async ({ request }) => {
    const { rows } = await page(request);
    for (const { order, merchant_order_status: m } of rows) {
      const id = `#${order.order_number}`;
      if (order.status === 'ORDER_STATUS_CANCELLED' || m === 'MERCHANT_ORDER_STATUS_CANCELLED') {
        expect([order.status, m], id).toEqual(['ORDER_STATUS_CANCELLED', 'MERCHANT_ORDER_STATUS_CANCELLED']);
      }
      if (order.status === 'ORDER_STATUS_DELIVERED' || m === 'MERCHANT_ORDER_STATUS_DELIVERED') {
        expect([order.status, m], id).toEqual(['ORDER_STATUS_DELIVERED', 'MERCHANT_ORDER_STATUS_DELIVERED']);
      }
    }
  });

  test('status tab counts match the orders in the list', async ({ request }) => {
    test.fail(true, 'Known: counts.preparing includes READY orders, so the "Готовы" tab shows 0');
    const restaurantId = await busiestBranch(request);
    const { rows, counts, total } = await page(request, { restaurant_id: restaurantId });
    const by = (s: string) => rows.filter((r) => r.merchant_order_status === `MERCHANT_ORDER_STATUS_${s}`).length;
    expect(counts.all, 'all').toBe(total);
    expect(counts.new, 'new').toBe(by('NEW'));
    expect(counts.preparing, 'preparing').toBe(by('PREPARING'));
  });

  test('cancelled orders have a readable cancel reason', async ({ request }) => {
    test.fail(true, 'Known: most cancelled orders have no reason; one shows a raw code (noor:cancelled:27)');
    const { rows } = await page(request);
    const cancelled = rows.filter((r) => r.order.status === 'ORDER_STATUS_CANCELLED');
    test.skip(!cancelled.length, 'No cancelled orders');
    for (const { order } of cancelled) {
      const reason = (order as Order & { cancel_reason: string }).cancel_reason;
      expect(reason, `#${order.order_number}`).toBeTruthy();
      expect(reason, `#${order.order_number}`).not.toMatch(/^noor:/);
    }
  });
});

test.describe('Eats orders — detail', () => {
  test('order detail matches the list row', async ({ request }) => {
    const restaurantId = await busiestBranch(request);
    const [row] = (await page(request, { restaurant_id: restaurantId, 'pagination.limit': 1 })).rows;
    const res = await request.get(`${ordersUrl}/${row.order.id}`, { headers, params: { restaurant_id: restaurantId } });
    expect(res.status(), await res.text()).toBe(200);
    const detail = (await res.json()).data.order;
    expect(detail.order ?? detail).toMatchObject({ id: row.order.id, order_number: row.order.order_number, total_price: row.order.total_price, status: row.order.status });
  });

  test('unknown order returns 404', async ({ request }) => {
    const restaurantId = await busiestBranch(request);
    const res = await request.get(`${ordersUrl}/00000000-0000-0000-0000-000000000000`, { headers, params: { restaurant_id: restaurantId } });
    expect(res.status()).toBe(404);
  });
});

test.describe('Eats orders — dashboard "Нагруженные дни"', () => {
  test('weekday counts match the orders created in that week', async ({ request }) => {
    const from = '2026-10-19T00:00:00+05:00';
    const to = '2026-10-25T23:59:59+05:00';
    const res = await request.get(weekdayUrl, { headers, params: { created_from: from, created_to: to } });
    expect(res.status(), await res.text()).toBe(200);
    const list = (await res.json()).list as { weekday: string; count: number }[];
    expect(list.map((d) => d.weekday)).toEqual(WEEKDAYS);

    const expected = Object.fromEntries(WEEKDAYS.map((w) => [w, 0]));
    for (const { order } of (await page(request)).rows) {
      const t = Date.parse(order.created_at);
      if (t < Date.parse(from) || t > Date.parse(to)) continue;
      const day = new Date(t + 5 * 3_600_000).getUTCDay(); // Tashkent, 0 = Sunday
      expected[WEEKDAYS[(day + 6) % 7]]++;
    }
    expect(Object.fromEntries(list.map((d) => [d.weekday, d.count]))).toEqual(expected);
  });

  test('weekday counts without dates are rejected', async ({ request }) => {
    const res = await request.get(weekdayUrl, { headers });
    expect(res.status()).toBe(400);
  });
});

test.describe('Eats orders — access', () => {
  test('orders and weekday counts without token are rejected', async ({ request }) => {
    expect((await request.get(ordersUrl)).status()).toBe(401);
    expect((await request.get(weekdayUrl, { params: { created_from: '2026-10-19T00:00:00+05:00', created_to: '2026-10-25T23:59:59+05:00' } })).status()).toBe(401);
  });
});

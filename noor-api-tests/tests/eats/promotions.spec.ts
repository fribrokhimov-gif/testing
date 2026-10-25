import { test, expect, APIRequestContext } from '@playwright/test';
import { getTokens, bearer, env } from '../../api/auth';

// Eats → Мастер-меню → Скидки и акции (promotions)
//   GET    merchant/promotions                       — one row per product: { product, restaurant, promotion }
//   GET    merchant/promotions/{id}?restaurant_id=   — { data: { promotion } }
//   POST   merchant/promotions { restaurant_id, product_ids, name, promo_type, discount_type, discount_value, starts_at, ends_at }
//   PATCH  merchant/promotions/{id} { name, promo_type, discount_type, discount_value, starts_at, ends_at }
//   DELETE merchant/promotions/{id}
// discount_type PERCENTAGE: discount_value = percent off. FIXED: discount_value = the new (final) price.
// Only one promotion per product at a time. New promotions start as DRAFT.
// Tests use dates ~2 months ahead so they never change today's prices, and delete every promotion they create.
const url = `${env.merchantApiUrl}/merchant/promotions`;
const restaurantsUrl = `${env.merchantApiUrl}/merchant/restaurants`;
const byRestaurantUrl = `${env.merchantApiUrl}/merchant/products/by-restaurant`;

type Names = { ru: string; uz: string; en: string };
type Promotion = {
  id: string;
  restaurant_id: string;
  product_ids: string[];
  name: Names;
  discount_type: string;
  discount_value: number;
  starts_at: string | null;
  ends_at: string | null;
  moderation_state: string;
};

// Access tokens live 60s, so each test logs in fresh
let headers: Record<string, string>;
test.beforeEach(async ({ request }) => {
  headers = { ...bearer((await getTokens(request)).access_token), 'x-locale': 'ru' };
});

const toDelete = new Set<string>();
async function cleanup(request: APIRequestContext) {
  if (!toDelete.size) return;
  const h = bearer((await getTokens(request)).access_token);
  for (const id of toDelete) await request.delete(`${url}/${id}`, { headers: h });
  toDelete.clear();
}
// One promotion per product at a time, so remove each test's promotions before the next test
test.afterEach(async ({ request }) => cleanup(request));

const at = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().replace(/\.\d+Z$/, 'Z');
const qaNames = (tag: string): Names => {
  const stamp = `${tag} ${Date.now()}`;
  return { ru: `QA-autotest ru ${stamp}`, uz: `QA-autotest uz ${stamp}`, en: `QA-autotest en ${stamp}` };
};

/** An approved restaurant with at least one product, and that product's price. */
async function target(request: APIRequestContext) {
  const restaurants = (await (await request.get(restaurantsUrl, { headers })).json()).list as { id: string; moderation_state: string }[];
  for (const r of restaurants.filter((x) => x.moderation_state === 'MERCHANT_MODERATION_STATE_APPROVED')) {
    const res = await request.get(byRestaurantUrl, { headers, params: { restaurant_id: r.id, 'pagination.limit': 1, 'pagination.offset': 0 } });
    const [p] = ((await res.json()).list ?? []) as { id: string; price: number }[];
    if (p) return { restaurantId: r.id, productId: p.id, price: p.price };
  }
  test.skip(true, 'No approved restaurant with products');
  throw new Error('unreachable');
}

const validBody = (t: { restaurantId: string; productId: string }, tag: string, startDay = 60) => ({
  restaurant_id: t.restaurantId,
  product_ids: [t.productId],
  name: qaNames(tag),
  promo_type: 'PROMO_TYPE_DISCOUNT',
  discount_type: 'DISCOUNT_TYPE_PERCENTAGE',
  discount_value: 10,
  starts_at: at(startDay),
  ends_at: at(startDay + 1),
});

async function create(request: APIRequestContext, body: Record<string, unknown>) {
  const res = await request.post(url, { headers, data: body });
  if (res.ok()) toDelete.add((await res.json()).data.promotion.id);
  return res;
}

async function get(request: APIRequestContext, id: string, restaurantId: string) {
  const res = await request.get(`${url}/${id}`, { headers, params: { restaurant_id: restaurantId } });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()).data.promotion as Promotion;
}

test.describe('Promotions — create → view → edit → delete', () => {
  test('full flow on one promotion', async ({ request }) => {
    const t = await target(request);
    const body = validBody(t, 'crud');

    // Create
    const res = await create(request, body);
    expect(res.status(), await res.text()).toBe(200);
    const id = (await res.json()).data.promotion.id as string;

    // View: draft with the data sent, and in the list
    expect(await get(request, id, t.restaurantId)).toMatchObject({
      restaurant_id: t.restaurantId,
      product_ids: [t.productId],
      name: body.name,
      discount_type: 'DISCOUNT_TYPE_PERCENTAGE',
      discount_value: 10,
      moderation_state: 'MERCHANT_MODERATION_STATE_DRAFT',
    });
    const rows = (await (await request.get(url, { headers })).json()).list as { promotion: { id: string } }[];
    expect(rows.map((r) => r.promotion.id)).toContain(id);

    // Edit: name, discount and dates
    const changes = { name: qaNames('upd'), discount_value: 15, starts_at: at(61), ends_at: at(63) };
    const upd = await request.patch(`${url}/${id}`, {
      headers,
      data: { promo_type: 'PROMO_TYPE_DISCOUNT', discount_type: 'DISCOUNT_TYPE_PERCENTAGE', ...changes },
    });
    expect(upd.status(), await upd.text()).toBe(200);
    const after = await get(request, id, t.restaurantId);
    expect(after).toMatchObject({ name: changes.name, discount_value: 15 });
    expect(Date.parse(after.ends_at!)).toBe(Date.parse(changes.ends_at));

    // Delete
    const del = await request.delete(`${url}/${id}`, { headers });
    expect(del.status(), await del.text()).toBe(200);
    toDelete.delete(id);
    expect((await request.get(`${url}/${id}`, { headers, params: { restaurant_id: t.restaurantId } })).status()).toBe(404);
  });

  test('fixed price below the product price is allowed', async ({ request }) => {
    const t = await target(request);
    test.skip(t.price < 2, 'Product price too low for a fixed discount');
    const res = await create(request, { ...validBody(t, 'fixed'), discount_type: 'DISCOUNT_TYPE_FIXED', discount_value: t.price - 1 });
    expect(res.status(), await res.text()).toBe(200);
    expect((await res.json()).data.promotion).toMatchObject({ discount_type: 'DISCOUNT_TYPE_FIXED', discount_value: t.price - 1 });
  });

  test('deleting a promotion twice returns 404 the second time', async ({ request }) => {
    test.fail(true, 'Known: second delete returns 200 (an id that never existed gets 404)');
    const t = await target(request);
    const id = (await (await create(request, validBody(t, 'twice'))).json()).data.promotion.id;
    expect((await request.delete(`${url}/${id}`, { headers })).status()).toBe(200);
    toDelete.delete(id);
    expect((await request.delete(`${url}/${id}`, { headers })).status()).toBe(404);
  });
});

test.describe('Promotions — one promotion per product at a time', () => {
  test('second promotion on the same product for overlapping dates is rejected', async ({ request }) => {
    const t = await target(request);
    expect((await create(request, validBody(t, 'first'))).status()).toBe(200);
    const res = await create(request, validBody(t, 'overlap'));
    expect(res.status(), await res.text()).toBe(400);
  });

  test('second promotion on the same product for later dates is allowed', async ({ request }) => {
    const t = await target(request);
    expect((await create(request, validBody(t, 'first'))).status()).toBe(200);
    const res = await create(request, validBody(t, 'later', 70));
    expect(res.status(), await res.text()).toBe(200);
  });
});

test.describe('Promotions — validation', () => {
  type Build = (b: ReturnType<typeof validBody>, price: number) => Record<string, unknown>;
  const without = (b: Record<string, unknown>, key: string) => Object.fromEntries(Object.entries(b).filter(([k]) => k !== key));

  const rejected: [string, Build, number][] = [
    ['missing restaurant', (b) => without(b, 'restaurant_id'), 400],
    ['unknown restaurant', (b) => ({ ...b, restaurant_id: '00000000-0000-0000-0000-000000000000' }), 404],
    ['product not sold at this restaurant', (b) => ({ ...b, product_ids: ['00000000-0000-0000-0000-000000000000'] }), 400],
    ['missing name', (b) => without(b, 'name'), 400],
    ['all three names empty', (b) => ({ ...b, name: { ru: '', uz: '', en: '' } }), 400],
    ['missing discount', (b) => without(b, 'discount_value'), 400],
    ['0% discount', (b) => ({ ...b, discount_value: 0 }), 400],
    ['negative discount', (b) => ({ ...b, discount_value: -5 }), 400],
    ['discount over 100%', (b) => ({ ...b, discount_value: 150 }), 400],
    ['fixed price not below the product price', (b, price) => ({ ...b, discount_type: 'DISCOUNT_TYPE_FIXED', discount_value: price }), 400],
    ['end date before start date', (b) => ({ ...b, starts_at: at(61), ends_at: at(60) }), 400],
    ['unknown discount type', (b) => ({ ...b, discount_type: 'DISCOUNT_TYPE_XYZ' }), 400],
  ];
  for (const [name, build, status] of rejected) {
    test(`${name} is rejected`, async ({ request }) => {
      const t = await target(request);
      const res = await create(request, build(validBody(t, 'invalid'), t.price));
      expect(res.status(), await res.text()).toBe(status);
    });
  }

  // Bugs: the API accepts these today
  const questionable: [string, Build][] = [
    ['end date already in the past', (b) => ({ ...b, starts_at: at(-3), ends_at: at(-2) })],
    ['no products', (b) => without(b, 'product_ids')],
  ];
  for (const [name, build] of questionable) {
    test(`${name} is rejected`, async ({ request }) => {
      test.fail(true, `Known: API accepts a promotion with ${name}`);
      const t = await target(request);
      const res = await create(request, build(validBody(t, 'questionable'), t.price));
      expect(res.status(), await res.text()).toBe(400);
    });
  }

  test('100% discount is allowed', async ({ request }) => {
    const t = await target(request);
    const res = await create(request, { ...validBody(t, 'free'), discount_value: 100 });
    expect(res.status(), await res.text()).toBe(200);
    expect((await res.json()).data.promotion.discount_value).toBe(100);
  });

  test('unknown promotion returns 404 on view, edit and delete', async ({ request }) => {
    const t = await target(request);
    const unknown = `${url}/00000000-0000-0000-0000-000000000000`;
    expect((await request.get(unknown, { headers, params: { restaurant_id: t.restaurantId } })).status()).toBe(404);
    expect((await request.patch(unknown, { headers, data: { discount_value: 5 } })).status()).toBe(404);
    expect((await request.delete(unknown, { headers })).status()).toBe(404);
  });
});

test.describe('Promotions — access', () => {
  test('list, create, edit and delete without token are rejected', async ({ request }) => {
    const unknown = `${url}/00000000-0000-0000-0000-000000000000`;
    expect((await request.get(url)).status()).toBe(401);
    expect((await request.post(url, { data: { name: qaNames('no-token') } })).status()).toBe(401);
    expect((await request.patch(unknown, { data: { discount_value: 5 } })).status()).toBe(401);
    expect((await request.delete(unknown)).status()).toBe(401);
  });
});

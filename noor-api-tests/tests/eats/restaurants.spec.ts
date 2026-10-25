import { test, expect, APIRequestContext } from '@playwright/test';
import { getTokens, bearer, env } from '../../api/auth';

// Eats → Мастер-меню → Филиалы (restaurants)
//   GET    merchant/restaurants       — { list, data: { counts: { all, approved, on_moderation, rejected } } }
//   GET    merchant/restaurants/{id}  — { data: { restaurant }, list: week schedule (7 days) }
//   POST   merchant/restaurants { name, phone, address: { line, latitude, longitude }, description,
//                                 restaurant_category_ids, week_schedule: 7 × { day_of_week, open_time, close_time, is_closed, … } }
//   PATCH  merchant/restaurants/{id}  (same body)
//   DELETE merchant/restaurants/{id}
// New restaurants start as a hidden draft. Every restaurant a test creates is deleted at the end.
const url = `${env.merchantApiUrl}/merchant/restaurants`;
const cuisinesUrl = `${env.merchantApiUrl}/merchant/restaurant-categories`;
const DAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];

type Day = { day_of_week: string; open_time: string; close_time: string; is_closed: boolean; order_from: string; order_to: string };
type Restaurant = {
  id: string;
  name: { ru: string; uz: string; en: string };
  phone: string;
  address: { line: { ru: string }; latitude: number; longitude: number };
  restaurant_category_ids: string[];
  moderation_state: string;
  status: string;
};

// Access tokens live 60s, so each test logs in fresh
let headers: Record<string, string>;
test.beforeEach(async ({ request }) => {
  headers = { ...bearer((await getTokens(request)).access_token), 'x-locale': 'ru' };
});

const toDelete = new Set<string>();
test.afterAll(async ({ request }) => {
  if (!toDelete.size) return;
  const h = bearer((await getTokens(request)).access_token);
  for (const id of toDelete) await request.delete(`${url}/${id}`, { headers: h });
});

const schedule = (open = '09:00', close = '21:00'): Day[] =>
  DAYS.map((day_of_week) => ({ day_of_week, open_time: open, close_time: close, is_closed: false, order_from: '', order_to: '' }));

async function cuisines(request: APIRequestContext) {
  const res = await request.get(cuisinesUrl, { headers });
  expect(res.status(), await res.text()).toBe(200);
  const list = (await res.json()).list as { id: string }[];
  test.skip(list.length < 2, 'Need at least 2 restaurant categories');
  return list.map((c) => c.id);
}

const validBody = (cuisineId: string, tag: string) => ({
  name: { ru: `QA-autotest ${tag} ${Date.now()}` },
  phone: '+998901234567',
  address: { line: { ru: 'QA адрес, Ташкент' }, latitude: 41.311, longitude: 69.279 },
  description: { ru: 'QA описание', uz: 'QA tavsif', en: 'QA description' },
  restaurant_category_ids: [cuisineId],
  week_schedule: schedule(),
});

async function create(request: APIRequestContext, body: Record<string, unknown>) {
  const res = await request.post(url, { headers, data: body });
  if (res.ok()) toDelete.add((await res.json()).data.restaurant.id);
  return res;
}

async function get(request: APIRequestContext, id: string) {
  const res = await request.get(`${url}/${id}`, { headers });
  expect(res.status(), await res.text()).toBe(200);
  const body = await res.json();
  return { restaurant: body.data.restaurant as Restaurant, schedule: body.list as Day[] };
}

async function list(request: APIRequestContext) {
  const res = await request.get(url, { headers });
  expect(res.status(), await res.text()).toBe(200);
  const body = await res.json();
  return { items: body.list as { id: string; name: string }[], counts: body.data.counts as Record<string, number> };
}

test.describe('Branches (restaurants) — create → view → edit → delete', () => {
  test.describe.configure({ mode: 'serial' });
  let id: string;
  let body: ReturnType<typeof validBody>;
  let ids: string[];
  let before: number;

  test('create a branch', async ({ request }) => {
    ids = await cuisines(request);
    before = (await list(request)).counts.all;
    body = validBody(ids[0], 'crud');

    const res = await create(request, body);
    expect(res.status(), await res.text()).toBe(200);
    const created = await res.json();
    id = created.data.restaurant.id;
    expect(id).toBeTruthy();
    expect(created.list).toHaveLength(7);
  });

  test('new branch is a hidden draft with the data sent', async ({ request }) => {
    test.skip(!id, 'Branch was not created');
    const { restaurant, schedule: days } = await get(request, id);
    expect(restaurant).toMatchObject({
      name: { ru: body.name.ru },
      phone: body.phone,
      address: { line: { ru: body.address.line.ru }, latitude: body.address.latitude, longitude: body.address.longitude },
      restaurant_category_ids: [ids[0]],
      moderation_state: 'MERCHANT_MODERATION_STATE_DRAFT',
      status: 'RESTAURANT_STATUS_HIDDEN',
    });
    expect(days.map((d) => [d.day_of_week, d.open_time, d.close_time, d.is_closed])).toEqual(DAYS.map((d) => [d, '09:00', '21:00', false]));

    const { items, counts } = await list(request);
    expect(items.map((r) => r.id)).toContain(id);
    expect(counts.all).toBe(before + 1);
  });

  test('edit name, phone, address and cuisine', async ({ request }) => {
    test.skip(!id, 'Branch was not created');
    const changes = {
      name: { ru: `QA-upd ${Date.now()}` },
      phone: '+998907654321',
      address: { line: { ru: 'QA новый адрес' }, latitude: 41.32, longitude: 69.25 },
      restaurant_category_ids: [ids[1]],
    };
    const res = await request.patch(`${url}/${id}`, { headers, data: { ...body, ...changes, min_order_amount: null } });
    expect(res.status(), await res.text()).toBe(200);
    expect((await get(request, id)).restaurant).toMatchObject({ ...changes, name: { ru: changes.name.ru } });
    body = { ...body, ...changes };
  });

  test('close the branch on Sunday and change opening hours', async ({ request }) => {
    test.skip(!id, 'Branch was not created');
    const week = schedule('10:00', '22:00').map((d) => (d.day_of_week === 'SUNDAY' ? { ...d, is_closed: true, open_time: '', close_time: '' } : d));
    const res = await request.patch(`${url}/${id}`, { headers, data: { ...body, week_schedule: week, min_order_amount: null } });
    expect(res.status(), await res.text()).toBe(200);

    const days = (await get(request, id)).schedule;
    expect(days.find((d) => d.day_of_week === 'MONDAY')).toMatchObject({ open_time: '10:00', close_time: '22:00', is_closed: false });
    expect(days.find((d) => d.day_of_week === 'SUNDAY')).toMatchObject({ is_closed: true });
  });

  test('delete the branch', async ({ request }) => {
    test.skip(!id, 'Branch was not created');
    const res = await request.delete(`${url}/${id}`, { headers });
    expect(res.status(), await res.text()).toBe(200);
    toDelete.delete(id);

    expect((await request.get(`${url}/${id}`, { headers })).status()).toBe(404);
    const { items, counts } = await list(request);
    expect(items.map((r) => r.id)).not.toContain(id);
    expect(counts.all).toBe(before);
  });

  test('deleting it again returns 404', async ({ request }) => {
    test.skip(!id, 'Branch was not created');
    test.fail(true, 'Known: second delete returns 200 (an id that never existed gets 404)');
    expect((await request.delete(`${url}/${id}`, { headers })).status()).toBe(404);
  });
});

test.describe('Branches (restaurants) — validation', () => {
  let cuisineId: string;
  test.beforeEach(async ({ request }) => {
    cuisineId = (await cuisines(request))[0];
  });

  const without = (b: Record<string, unknown>, key: string) => Object.fromEntries(Object.entries(b).filter(([k]) => k !== key));
  type Build = (b: ReturnType<typeof validBody>) => Record<string, unknown>;

  const rejected: [string, Build, number][] = [
    ['missing name', (b) => without(b, 'name'), 400],
    ['empty name', (b) => ({ ...b, name: { ru: '' } }), 400],
    ['latitude outside -90…90', (b) => ({ ...b, address: { ...b.address, latitude: 200 } }), 400],
    ['unknown cuisine category', (b) => ({ ...b, restaurant_category_ids: ['00000000-0000-0000-0000-000000000000'] }), 404],
    ['missing schedule', (b) => without(b, 'week_schedule'), 400],
    ['schedule with 6 days', (b) => ({ ...b, week_schedule: b.week_schedule.slice(0, 6) }), 400],
    ['invalid time 25:00', (b) => ({ ...b, week_schedule: schedule('25:00', '21:00') }), 400],
  ];
  for (const [name, build, status] of rejected) {
    test(`${name} is rejected`, async ({ request }) => {
      const res = await create(request, build(validBody(cuisineId, 'invalid')));
      expect(res.status(), await res.text()).toBe(status);
    });
  }

  // Bugs: the API accepts these today
  const accepted: [string, Build][] = [
    ['missing phone', (b) => without(b, 'phone')],
    ['phone that is not a number', (b) => ({ ...b, phone: 'abc' })],
    ['missing address', (b) => without(b, 'address')],
  ];
  for (const [name, build] of accepted) {
    test(`${name} is rejected`, async ({ request }) => {
      test.fail(true, `Known: API accepts a branch with ${name}`);
      const res = await create(request, build(validBody(cuisineId, 'invalid')));
      expect(res.status(), await res.text()).toBe(400);
    });
  }

  test('branch without a cuisine category is allowed', async ({ request }) => {
    const res = await create(request, { ...validBody(cuisineId, 'no-cuisine'), restaurant_category_ids: [] });
    expect(res.status(), await res.text()).toBe(200);
    const { restaurant } = await get(request, (await res.json()).data.restaurant.id);
    expect(restaurant.restaurant_category_ids).toEqual([]);
  });

  test('branch with coordinates 0, 0 is allowed', async ({ request }) => {
    const b = validBody(cuisineId, 'zero-coords');
    const res = await create(request, { ...b, address: { ...b.address, latitude: 0, longitude: 0 } });
    expect(res.status(), await res.text()).toBe(200);
    const { restaurant } = await get(request, (await res.json()).data.restaurant.id);
    expect(restaurant.address).toMatchObject({ latitude: 0, longitude: 0 });
  });

  test('unknown branch returns 404 on view, edit and delete', async ({ request }) => {
    const unknown = `${url}/00000000-0000-0000-0000-000000000000`;
    expect((await request.get(unknown, { headers })).status()).toBe(404);
    expect((await request.patch(unknown, { headers, data: validBody(cuisineId, 'unknown') })).status()).toBe(404);
    expect((await request.delete(unknown, { headers })).status()).toBe(404);
  });
});

test.describe('Branches (restaurants) — access', () => {
  test('list, create, edit and delete without token are rejected', async ({ request }) => {
    const unknown = `${url}/00000000-0000-0000-0000-000000000000`;
    expect((await request.get(url)).status()).toBe(401);
    expect((await request.post(url, { data: { name: { ru: 'QA' } } })).status()).toBe(401);
    expect((await request.patch(unknown, { data: { name: { ru: 'QA' } } })).status()).toBe(401);
    expect((await request.delete(unknown)).status()).toBe(401);
  });
});

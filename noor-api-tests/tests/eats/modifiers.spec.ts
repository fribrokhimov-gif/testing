import { test, expect, APIRequestContext } from '@playwright/test';
import { getTokens, bearer, env } from '../../api/auth';

// Eats → product → Модификаторы (modifier groups and options)
// A group belongs to one product.
//   POST   merchant/modifier-groups { product_id, name, min_select, max_select?, options: [{ name, price, sort_order, ikpu_code, unit_code, vat_percent }] }
//   GET    merchant/modifier-groups/{id}   — { data: { group } }
//   PATCH  merchant/modifier-groups/{id}   { name?, min_select?, max_select? }
//   POST   merchant/modifier-groups/{id}/options { option }
//   PATCH  merchant/modifier-options/{id}  { name?, price? }
//   DELETE merchant/modifier-options/{id}
//   DELETE merchant/products/{pid}/modifier-groups/{gid}  — detach; this is how the panel removes a group
//                                                          (it never deletes groups; there is no delete route)
// Each run creates one draft QA product, works on it, then deletes it (its groups go with it)
// and withdraws any change request it caused, so nothing is left in the moderation queue.
const api = env.merchantApiUrl;
const groupsUrl = `${api}/merchant/modifier-groups`;
const optionsUrl = `${api}/merchant/modifier-options`;
const productsUrl = `${api}/merchant/products`;
const changeRequestsUrl = `${api}/merchant/change-requests`;

type Names = { ru: string; uz: string; en: string };
type Option = { id: string; name: Names; price: number; sort_order: number; ikpu_code: string };
type Group = { id: string; product_id: string; name: Names; min_select: number; max_select?: number; options: Option[] };

// Access tokens live 60s, so each test logs in fresh
let headers: Record<string, string>;
test.beforeEach(async ({ request }) => {
  headers = { ...bearer((await getTokens(request)).access_token), 'x-locale': 'ru' };
});

const stamp = Date.now();
const names = (tag: string): Names => ({ ru: `QA-${tag} ${stamp}`, uz: `QA-${tag} uz`, en: `QA-${tag} en` });
const option = (tag: string, price: number, sort_order: number) => ({
  name: names(tag), price, sort_order, ikpu_code: '12345678901234567', unit_code: '2', vat_percent: 12,
});

let productId: string;

test.beforeAll(async ({ request }) => {
  const h = { ...bearer((await getTokens(request)).access_token), 'x-locale': 'ru' };
  const categoryId = (await (await request.get(`${api}/merchant/product-categories`, { headers: h })).json()).list[0]?.id;
  if (!categoryId) return;
  const res = await request.post(productsUrl, {
    headers: h,
    data: {
      product_category_id: categoryId, name: names('product'), description: names('desc'),
      is_always_ready: true, is_adult: false, price: 15000,
      ikpu_code: '12345678901234567', unit_code: '2', vat_percent: 12, measure_amount: 1, measurement_type: 'MEASUREMENT_TYPE_KG',
    },
  });
  if (res.ok()) productId = (await res.json()).data.product.id;
});

test.afterAll(async ({ request }) => {
  if (!productId) return;
  const h = bearer((await getTokens(request)).access_token);
  await request.delete(`${productsUrl}/${productId}`, { headers: h });
  const pending = ((await (await request.get(changeRequestsUrl, { headers: h })).json()).list ?? []) as { id: string; status: string; entity_id: string }[];
  for (const cr of pending.filter((c) => c.status === 'pending' && c.entity_id === productId)) {
    await request.post(`${changeRequestsUrl}/${cr.id}/cancel`, { headers: h, data: {} });
  }
});

async function getGroup(request: APIRequestContext, id: string) {
  const res = await request.get(`${groupsUrl}/${id}`, { headers });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()).data.group as Group;
}

const createGroup = (request: APIRequestContext, body: Record<string, unknown>) =>
  request.post(groupsUrl, { headers, data: { product_id: productId, ...body } });

test.describe('Modifiers — group and options', () => {
  test.describe.configure({ mode: 'serial' });
  let group: Group;
  let added: Option;

  test.beforeEach(() => test.skip(!productId, 'QA product was not created'));

  test('create a group with two options', async ({ request }) => {
    const res = await createGroup(request, { name: names('group'), min_select: 1, max_select: 2, options: [option('opt1', 0, 1), option('opt2', 2000, 2)] });
    expect(res.status(), await res.text()).toBe(200);
    group = (await res.json()).data.group;
    expect(group).toMatchObject({ product_id: productId, name: names('group'), min_select: 1, max_select: 2 });
    expect(group.options.map((o) => [o.name.ru, o.price])).toEqual([[names('opt1').ru, 0], [names('opt2').ru, 2000]]);
  });

  test('group shows on the product', async ({ request }) => {
    test.skip(!group, 'Group was not created');
    const product = (await (await request.get(`${productsUrl}/${productId}`, { headers })).json()).data.product;
    expect((product.modifiers as Group[]).map((m) => m.id)).toContain(group.id);
  });

  test('edit group name and selection limits', async ({ request }) => {
    test.skip(!group, 'Group was not created');
    const res = await request.patch(`${groupsUrl}/${group.id}`, { headers, data: { name: names('group-upd'), min_select: 0, max_select: 1 } });
    expect(res.status(), await res.text()).toBe(200);
    expect(await getGroup(request, group.id)).toMatchObject({ name: names('group-upd'), min_select: 0, max_select: 1 });
  });

  test('remove the maximum selection limit', async ({ request }) => {
    test.skip(!group, 'Group was not created');
    test.fail(true, 'Known: API rejects clear_max_select (sent by the panel) as an unknown field, so the whole edit fails');
    // Exactly what the panel sends when the merchant removes the limit (plus the selected branch)
    const restaurantId = (await (await request.get(`${api}/merchant/restaurants`, { headers })).json()).list[0]?.id;
    const res = await request.patch(`${groupsUrl}/${group.id}`, { headers, data: { name: names('group-nolimit'), clear_max_select: true, restaurant_id: restaurantId } });
    expect(res.status(), await res.text()).toBe(200);
    const after = await getGroup(request, group.id);
    expect(after.max_select ?? 0).toBe(0);
    expect(after.name).toEqual(names('group-nolimit'));
  });

  test('max_select null removes the limit (what the API accepts)', async ({ request }) => {
    test.skip(!group, 'Group was not created');
    await request.patch(`${groupsUrl}/${group.id}`, { headers, data: { max_select: 2 } });
    const res = await request.patch(`${groupsUrl}/${group.id}`, { headers, data: { max_select: null } });
    expect(res.status(), await res.text()).toBe(200);
    expect((await getGroup(request, group.id)).max_select ?? 0).toBe(0);
  });

  test('add an option', async ({ request }) => {
    test.skip(!group, 'Group was not created');
    const res = await request.post(`${groupsUrl}/${group.id}/options`, { headers, data: { option: option('opt3', 3000, 3) } });
    expect(res.status(), await res.text()).toBe(200);
    added = (await res.json()).data.option;
    expect(added).toMatchObject({ name: names('opt3'), price: 3000 });
    expect((await getGroup(request, group.id)).options.map((o) => o.id)).toContain(added.id);
  });

  test('edit an option name and price', async ({ request }) => {
    test.skip(!added, 'Option was not added');
    const res = await request.patch(`${optionsUrl}/${added.id}`, { headers, data: { name: names('opt3-upd'), price: 3500 } });
    expect(res.status(), await res.text()).toBe(200);
    expect((await getGroup(request, group.id)).options.find((o) => o.id === added.id)).toMatchObject({ name: names('opt3-upd'), price: 3500 });
  });

  test('delete an option', async ({ request }) => {
    test.skip(!added, 'Option was not added');
    const res = await request.delete(`${optionsUrl}/${added.id}`, { headers });
    expect(res.status(), await res.text()).toBe(200);
    expect((await getGroup(request, group.id)).options.map((o) => o.id)).not.toContain(added.id);
  });

  test('deleting the option again returns 404', async ({ request }) => {
    test.skip(!added, 'Option was not added');
    test.fail(true, 'Known: second delete returns 200');
    expect((await request.delete(`${optionsUrl}/${added.id}`, { headers })).status()).toBe(404);
  });

  test('detaching a group removes it from the product', async ({ request }) => {
    test.skip(!group, 'Group was not created');
    // The panel removes a group this way — it never deletes groups directly
    const res = await request.delete(`${productsUrl}/${productId}/modifier-groups/${group.id}`, { headers });
    expect(res.status(), await res.text()).toBe(200);
    const product = (await (await request.get(`${productsUrl}/${productId}`, { headers })).json()).data.product;
    expect((product.modifiers as Group[]).map((m) => m.id)).not.toContain(group.id);
  });

  test('detaching from a draft product does not create a change request', async ({ request }) => {
    test.skip(!group, 'Group was not created');
    test.fail(true, 'Known: detach applies immediately but also files an "update" change request into the moderation queue');
    const pending = ((await (await request.get(changeRequestsUrl, { headers })).json()).list as { entity_id: string; status: string }[])
      .filter((c) => c.entity_id === productId && c.status === 'pending');
    expect(pending).toHaveLength(0);
  });
});

test.describe('Modifiers — validation', () => {
  test.beforeEach(() => test.skip(!productId, 'QA product was not created'));

  test('group without a name is rejected', async ({ request }) => {
    const res = await createGroup(request, { min_select: 0, options: [option('x', 0, 1)] });
    expect(res.status(), await res.text()).toBe(400);
  });

  test('group for an unknown product is rejected', async ({ request }) => {
    const res = await request.post(groupsUrl, { headers, data: { product_id: '00000000-0000-0000-0000-000000000000', name: names('x'), min_select: 0, options: [option('x', 0, 1)] } });
    expect(res.status(), await res.text()).toBe(404);
  });

  test('minimum selection above maximum is rejected', async ({ request }) => {
    const res = await createGroup(request, { name: names('minmax'), min_select: 3, max_select: 1, options: [option('x', 0, 1)] });
    expect(res.status(), await res.text()).toBe(400);
  });

  test('option with a negative price is rejected', async ({ request }) => {
    const res = await createGroup(request, { name: names('neg'), min_select: 0, options: [option('neg', -1, 1)] });
    expect(res.status(), await res.text()).toBe(400);
  });

  test('unknown group and option return 404', async ({ request }) => {
    const unknown = '00000000-0000-0000-0000-000000000000';
    expect((await request.get(`${groupsUrl}/${unknown}`, { headers })).status()).toBe(404);
    expect((await request.patch(`${optionsUrl}/${unknown}`, { headers, data: { price: 1 } })).status()).toBe(404);
  });
});

test.describe('Modifiers — access', () => {
  test('list, create and edit without token are rejected', async ({ request }) => {
    const unknown = '00000000-0000-0000-0000-000000000000';
    expect((await request.get(groupsUrl)).status()).toBe(401);
    expect((await request.post(groupsUrl, { data: { product_id: unknown, name: names('x') } })).status()).toBe(401);
    expect((await request.patch(`${optionsUrl}/${unknown}`, { data: { price: 1 } })).status()).toBe(401);
  });
});

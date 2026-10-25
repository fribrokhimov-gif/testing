import { test, expect, APIRequestContext } from '@playwright/test';
import { getTokens, bearer, env } from '../../api/auth';

// Eats moderation — the merchant side. No admin involved.
//   POST merchant/entities/product_category/{id}/submit-for-review → change request (pending), state ON_MODERATION
//   POST merchant/change-requests/{id}/cancel                      → withdraw, state back to DRAFT
//   GET  merchant/product-categories/{id}/published                → what customers see
// Approve / reject by the admin is tested in tests/admin/moderation.spec.ts.
// Every category a test creates is a draft at the end and gets deleted.
const api = env.merchantApiUrl;
const categoriesUrl = `${api}/merchant/product-categories`;
const changeRequestsUrl = `${api}/merchant/change-requests`;

type Names = { ru: string; uz: string; en: string };
type ChangeRequest = { id: string; entity_id: string; entity_type: string; operation: string; status: string };

const state = (s: string) => `MERCHANT_MODERATION_STATE_${s}`;

// Access tokens live 60s, so each test logs in fresh
let headers: Record<string, string>;
test.beforeEach(async ({ request }) => {
  headers = { ...bearer((await getTokens(request)).access_token), 'x-locale': 'ru' };
});

const created = new Set<string>();
test.afterAll(async ({ request }) => {
  if (!created.size) return;
  const h = bearer((await getTokens(request)).access_token);
  const list = (((await (await request.get(changeRequestsUrl, { headers: h })).json()).list ?? []) as ChangeRequest[]);
  for (const id of created) {
    for (const c of list.filter((x) => x.entity_id === id && x.status === 'pending')) {
      await request.post(`${changeRequestsUrl}/${c.id}/cancel`, { headers: h, data: {} });
    }
    await request.delete(`${categoriesUrl}/${id}`, { headers: h });
  }
});

const names = (tag: string): Names => {
  const stamp = `${tag} ${Date.now()}`;
  return { ru: `QA-autotest ru ${stamp}`, uz: `QA-autotest uz ${stamp}`, en: `QA-autotest en ${stamp}` };
};

async function createCategory(request: APIRequestContext, tag: string) {
  const res = await request.post(categoriesUrl, { headers, data: { names: [names(tag)] } });
  expect(res.status(), await res.text()).toBe(200);
  const id = (await res.json()).list[0].id as string;
  created.add(id);
  return id;
}

const submitUrl = (id: string) => `${api}/merchant/entities/product_category/${id}/submit-for-review`;

async function moderationState(request: APIRequestContext, id: string) {
  const res = await request.get(`${categoriesUrl}/${id}`, { headers });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()).data.category.moderation_state as string;
}

/** True when customers can see the category. */
async function isPublished(request: APIRequestContext, id: string) {
  const res = await request.get(`${categoriesUrl}/${id}/published`, { headers });
  if (res.status() === 404) return false;
  return Boolean((await res.json()).data?.client_visible);
}

async function changeRequest(request: APIRequestContext, id: string) {
  const list = ((await (await request.get(changeRequestsUrl, { headers })).json()).list ?? []) as ChangeRequest[];
  return list.find((c) => c.id === id);
}

test.describe('Moderation (merchant) — drafts', () => {
  test('a new category is a draft and hidden from customers', async ({ request }) => {
    const id = await createCategory(request, 'draft');
    expect(await moderationState(request, id)).toBe(state('DRAFT'));
    expect(await isPublished(request, id)).toBe(false);
  });

  test('editing a draft applies directly, without a change request', async ({ request }) => {
    const id = await createCategory(request, 'draft-edit');
    const updated = names('draft-edited');
    const res = await request.patch(`${categoriesUrl}/${id}`, { headers, data: { name: updated } });
    expect(res.status(), await res.text()).toBe(200);
    const body = await res.json();
    expect(body.data.pending_change).toBeUndefined();
    expect(body.data.category.name).toEqual(updated);
    expect(await moderationState(request, id)).toBe(state('DRAFT'));
  });
});

test.describe('Moderation (merchant) — submit for review', () => {
  test('submit creates a pending publish request; category stays hidden', async ({ request }) => {
    const id = await createCategory(request, 'submit');
    const res = await request.post(submitUrl(id), { headers, data: {} });
    expect(res.status(), await res.text()).toBe(200);

    const cr = (await res.json()).data.change_request as ChangeRequest;
    expect(cr).toMatchObject({ entity_id: id, entity_type: 'product_category', operation: 'publish', status: 'pending' });
    expect(await changeRequest(request, cr.id)).toMatchObject({ status: 'pending' });
    expect(await moderationState(request, id)).toBe(state('ON_MODERATION'));
    expect(await isPublished(request, id)).toBe(false);
  });

  test('category counts show it as on moderation', async ({ request }) => {
    const before = (await (await request.get(categoriesUrl, { headers })).json()).data.counts.on_moderation as number;
    const id = await createCategory(request, 'counts');
    expect((await request.post(submitUrl(id), { headers, data: {} })).status()).toBe(200);
    const after = (await (await request.get(categoriesUrl, { headers })).json()).data.counts.on_moderation as number;
    expect(after).toBe(before + 1);
  });

  test('unknown category cannot be submitted', async ({ request }) => {
    const res = await request.post(submitUrl('00000000-0000-0000-0000-000000000000'), { headers, data: {} });
    expect(res.status()).toBe(404);
  });
});

test.describe('Moderation (merchant) — withdraw', () => {
  test('withdrawing returns the category to draft', async ({ request }) => {
    const id = await createCategory(request, 'withdraw');
    const cr = (await (await request.post(submitUrl(id), { headers, data: {} })).json()).data.change_request.id as string;

    const res = await request.post(`${changeRequestsUrl}/${cr}/cancel`, { headers, data: {} });
    expect(res.status(), await res.text()).toBe(200);
    expect((await res.json()).data.change_request.status).toBe('withdrawn');
    expect(await changeRequest(request, cr)).toMatchObject({ status: 'withdrawn' });
    expect(await moderationState(request, id)).toBe(state('DRAFT'));
    expect(await isPublished(request, id)).toBe(false);
  });

  test('a withdrawn category can be submitted again', async ({ request }) => {
    const id = await createCategory(request, 'resubmit');
    const first = (await (await request.post(submitUrl(id), { headers, data: {} })).json()).data.change_request.id as string;
    await request.post(`${changeRequestsUrl}/${first}/cancel`, { headers, data: {} });

    const again = await request.post(submitUrl(id), { headers, data: {} });
    expect(again.status(), await again.text()).toBe(200);
    expect((await again.json()).data.change_request.id).not.toBe(first);
    expect(await moderationState(request, id)).toBe(state('ON_MODERATION'));
  });
});

test.describe('Moderation (merchant) — access', () => {
  test('submit and withdraw without token are rejected', async ({ request }) => {
    const unknown = '00000000-0000-0000-0000-000000000000';
    expect((await request.post(submitUrl(unknown), { data: {} })).status()).toBe(401);
    expect((await request.post(`${changeRequestsUrl}/${unknown}/cancel`, { data: {} })).status()).toBe(401);
  });
});

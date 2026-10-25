import { test, expect, APIRequestContext } from '@playwright/test';
import { getTokens, bearer, env } from '../../api/auth';
import { adminEnv, adminHeaders, approve, reject } from '../../api/admin';

// Admin panel (cpanel.test.noor.uz) — moderating Eats change requests.
// The merchant side (submit, withdraw, drafts hidden) is in tests/eats/moderation.spec.ts.
//   merchant: POST merchant/entities/product_category/{id}/submit-for-review → change request (pending)
//             POST merchant/change-requests/{id}/cancel                      → withdraw
//   admin:    POST admin/change-requests/{id}/approve | /reject { reason }
//   customers see only merchant/product-categories/{id}/published
// Lifecycle: DRAFT → ON_MODERATION → APPROVED (published) | REJECTED (with reason).
// Edits and deletes of an approved category become change requests too; customers keep the old version until approved.
// Uses product categories (no products, so nothing customers could order). The admin queue holds every merchant's
// requests — these tests only ever approve or reject change requests they created themselves.
// Cleanup deletes every QA category, approving the delete request when the category was already published.
const api = env.merchantApiUrl;
const categoriesUrl = `${api}/merchant/product-categories`;
const changeRequestsUrl = `${api}/merchant/change-requests`;

type Names = { ru: string; uz: string; en: string };
type Category = { id: string; name: Names; moderation_state: string; lifecycle_status: string; rejection_reason: string };
type ChangeRequest = { id: string; entity_id: string; operation: string; status: string; payload: Record<string, unknown> };

const state = (s: string) => `MERCHANT_MODERATION_STATE_${s}`;

let headers: Record<string, string>;
let admin: Record<string, string>;
test.beforeEach(async ({ request }) => {
  test.skip(!adminEnv.phone || !adminEnv.password, 'Set ADMIN_PHONE / ADMIN_PASSWORD in .env');
  headers = { ...bearer((await getTokens(request)).access_token), 'x-locale': 'ru' };
  admin = await adminHeaders(request);
});

const created = new Set<string>();
test.afterAll(async ({ request }) => {
  if (!created.size || !adminEnv.phone) return;
  const h = { ...bearer((await getTokens(request)).access_token), 'x-locale': 'ru' };
  const a = await adminHeaders(request);
  const pending = async (id: string) =>
    (((await (await request.get(changeRequestsUrl, { headers: h })).json()).list ?? []) as ChangeRequest[]).filter((c) => c.entity_id === id && c.status === 'pending');
  for (const id of created) {
    for (const c of await pending(id)) await request.post(`${changeRequestsUrl}/${c.id}/cancel`, { headers: h, data: {} });
    const res = await request.delete(`${categoriesUrl}/${id}`, { headers: h });
    const deleteRequest = res.ok() ? (await res.json()).data?.pending_change?.id : undefined;
    if (deleteRequest) await approve(request, a, deleteRequest);
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

async function submit(request: APIRequestContext, id: string) {
  const res = await request.post(`${api}/merchant/entities/product_category/${id}/submit-for-review`, { headers, data: {} });
  expect(res.status(), await res.text()).toBe(200);
  const cr = (await res.json()).data.change_request as ChangeRequest;
  expect(cr).toMatchObject({ entity_id: id, operation: 'publish', status: 'pending' });
  return cr.id;
}

async function category(request: APIRequestContext, id: string) {
  const res = await request.get(`${categoriesUrl}/${id}`, { headers });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()).data.category as Category;
}

/** What customers see: the published name, or null when the category is not visible. */
async function published(request: APIRequestContext, id: string) {
  const res = await request.get(`${categoriesUrl}/${id}/published`, { headers });
  if (res.status() === 404) return null;
  expect(res.status(), await res.text()).toBe(200);
  const body = (await res.json()).data;
  if (!body.client_visible) return null;
  return body.category?.name as Names | string;
}

const ru = (n: Names | string | null) => (n && typeof n === 'object' ? n.ru : n);

async function merchantChangeRequest(request: APIRequestContext, id: string) {
  const list = ((await (await request.get(changeRequestsUrl, { headers })).json()).list ?? []) as ChangeRequest[];
  return list.find((c) => c.id === id);
}

test.describe('Admin moderation — approve', () => {
  test('approved category becomes visible to customers', async ({ request }) => {
    const id = await createCategory(request, 'approve');
    expect((await category(request, id)).moderation_state).toBe(state('DRAFT'));
    expect(await published(request, id), 'draft is hidden').toBeNull();

    const cr = await submit(request, id);
    expect((await category(request, id)).moderation_state).toBe(state('ON_MODERATION'));
    expect(await published(request, id), 'on moderation is hidden').toBeNull();

    const res = await approve(request, admin, cr);
    expect(res.status(), await res.text()).toBe(200);
    expect((await res.json()).data.change_request).toMatchObject({ id: cr, status: 'approved' });

    expect(await category(request, id)).toMatchObject({ moderation_state: state('APPROVED'), lifecycle_status: 'life' });
    expect(ru(await published(request, id))).toBe((await category(request, id)).name.ru);
    expect(await merchantChangeRequest(request, cr)).toMatchObject({ status: 'approved' });
  });
});

test.describe('Admin moderation — reject', () => {
  test('rejected category stays hidden and shows the reason', async ({ request }) => {
    const id = await createCategory(request, 'reject');
    const cr = await submit(request, id);
    const reason = `QA autotest: name not allowed ${Date.now()}`;

    const res = await reject(request, admin, cr, reason);
    expect(res.status(), await res.text()).toBe(200);

    expect(await category(request, id)).toMatchObject({ moderation_state: state('REJECTED'), rejection_reason: reason });
    expect(await published(request, id)).toBeNull();
    expect(await merchantChangeRequest(request, cr)).toMatchObject({ status: 'rejected' });
  });
});

test.describe('Admin moderation — withdrawn requests', () => {
  test('a request the merchant withdrew cannot be approved', async ({ request }) => {
    const id = await createCategory(request, 'withdrawn');
    const cr = await submit(request, id);
    expect((await request.post(`${changeRequestsUrl}/${cr}/cancel`, { headers, data: {} })).status()).toBe(200);

    const res = await approve(request, admin, cr);
    expect(res.status(), await res.text()).toBe(409);
    expect((await res.json()).error.message).toBe('change request is not pending');
    expect(await published(request, id)).toBeNull();
  });
});

test.describe('Admin moderation — changes to an approved category', () => {
  test.describe.configure({ mode: 'serial' });
  let id: string;
  let original: string;

  test('approve a category to start from', async ({ request }) => {
    id = await createCategory(request, 'live');
    expect((await approve(request, admin, await submit(request, id))).status()).toBe(200);
    original = (await category(request, id)).name.ru;
    expect(ru(await published(request, id))).toBe(original);
  });

  test('edit goes to moderation; customers keep the old name until approved', async ({ request }) => {
    test.skip(!id, 'Category was not approved');
    const updated = names('edited');
    const res = await request.patch(`${categoriesUrl}/${id}`, { headers, data: { name: updated } });
    expect(res.status(), await res.text()).toBe(200);
    const crId = (await res.json()).data.pending_change?.id as string;
    expect(crId, 'edit creates a change request').toBeTruthy();

    expect(await merchantChangeRequest(request, crId)).toMatchObject({ operation: 'update', status: 'pending', payload: { name: updated } });
    expect((await category(request, id)).moderation_state).toBe(state('ON_MODERATION'));
    expect(ru(await published(request, id)), 'customers still see the old name').toBe(original);

    expect((await approve(request, admin, crId)).status()).toBe(200);
    expect(ru(await published(request, id)), 'customers see the new name').toBe(updated.ru);
    expect((await category(request, id)).moderation_state).toBe(state('APPROVED'));
  });

  test('rejected edit keeps the published name', async ({ request }) => {
    test.skip(!id, 'Category was not approved');
    const before = ru(await published(request, id));
    const res = await request.patch(`${categoriesUrl}/${id}`, { headers, data: { name: names('rejected-edit') } });
    const crId = (await res.json()).data.pending_change?.id as string;
    expect(crId).toBeTruthy();

    expect((await reject(request, admin, crId, 'QA autotest: edit rejected')).status()).toBe(200);
    expect(ru(await published(request, id))).toBe(before);
    expect(await merchantChangeRequest(request, crId)).toMatchObject({ status: 'rejected' });
  });

  test('delete goes to moderation; category disappears only after approval', async ({ request }) => {
    test.skip(!id, 'Category was not approved');
    const res = await request.delete(`${categoriesUrl}/${id}`, { headers });
    expect(res.status(), await res.text()).toBe(200);
    const crId = (await res.json()).data.pending_change?.id as string;
    expect(crId, 'delete creates a change request').toBeTruthy();
    expect(await merchantChangeRequest(request, crId)).toMatchObject({ operation: 'delete', status: 'pending' });
    expect(await published(request, id), 'still visible while the delete waits').not.toBeNull();

    expect((await approve(request, admin, crId)).status()).toBe(200);
    expect(await published(request, id), 'gone after approval').toBeNull();
    expect((await request.get(`${categoriesUrl}/${id}`, { headers })).status()).toBe(404);
    created.delete(id);
  });
});

test.describe('Admin moderation — access', () => {
  test('merchant token cannot approve change requests', async ({ request }) => {
    const id = await createCategory(request, 'merchant-approve');
    const cr = await submit(request, id);
    const res = await approve(request, headers, cr);
    expect([401, 403], await res.text()).toContain(res.status());
    expect(await merchantChangeRequest(request, cr)).toMatchObject({ status: 'pending' });
  });

  test('approve and reject without token are rejected', async ({ request }) => {
    const unknown = '00000000-0000-0000-0000-000000000000';
    expect((await approve(request, {}, unknown)).status()).toBe(401);
    expect((await reject(request, {}, unknown, 'x')).status()).toBe(401);
  });
});

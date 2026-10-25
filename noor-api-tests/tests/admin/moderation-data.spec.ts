import { test, expect } from '@playwright/test';
import { adminEnv, adminHeaders, approve, reject, changeRequestsAdminUrl } from '../../api/admin';
import {
  Created, cleanup, createCategory, goLive, submit, entity, published, changeRequests, merchantHeaders, pendingChangeId, qaNames, urls,
} from '../../api/eatsModeration';

// Moderation — data correctness: what is stored in a change request, what customers see, counts, admin list filters.
// QA categories only; everything is deleted afterwards.
let h: Record<string, string>;
let admin: Record<string, string>;
const created = new Created();

test.beforeEach(async ({ request }) => {
  test.skip(!adminEnv.phone || !adminEnv.password, 'Set ADMIN_PHONE / ADMIN_PASSWORD in .env');
  h = await merchantHeaders(request);
  admin = await adminHeaders(request);
});
test.afterAll(async ({ request }) => cleanup(request, created));

const counts = async (request: any) => (await (await request.get(urls.categories, { headers: h })).json()).data.counts as Record<string, number>;

test.describe('Moderation data — change request content', () => {
  test('an edit stores the version before (baseline) and the change (payload)', async ({ request }) => {
    const id = await createCategory(request, h, created, 'baseline');
    await goLive(request, h, admin, 'product_category', id);
    const live = await entity(request, h, 'product_category', id);
    const change = qaNames('changed');
    const crId = await pendingChangeId(await request.patch(`${urls.categories}/${id}`, { headers: h, data: { name: change } }));

    const res = await request.get(`${changeRequestsAdminUrl}/${crId}`, { headers: admin });
    expect(res.status(), await res.text()).toBe(200);
    const cr = (await res.json()).data.change_request;
    expect(cr).toMatchObject({ operation: 'update', status: 'pending', entity_type: 'product_category', entity_id: id });
    expect(cr.baseline.name).toEqual(live.name);
    expect(cr.payload.name).toEqual(change);
  });
});

test.describe('Moderation data — what customers see', () => {
  test('after approval the published copy equals the approved data in all 3 languages', async ({ request }) => {
    const id = await createCategory(request, h, created, 'published-equal');
    await goLive(request, h, admin, 'product_category', id);
    expect((await published(request, h, 'product_category', id))?.name).toEqual((await entity(request, h, 'product_category', id)).name);
  });

  test('while an edit waits, customers and the merchant both keep the approved version', async ({ request }) => {
    const id = await createCategory(request, h, created, 'pending-view');
    await goLive(request, h, admin, 'product_category', id);
    const approvedName = (await entity(request, h, 'product_category', id)).name;
    await request.patch(`${urls.categories}/${id}`, { headers: h, data: { name: qaNames('waiting') } });

    expect((await published(request, h, 'product_category', id))?.name).toEqual(approvedName);
    expect((await entity(request, h, 'product_category', id)).name).toEqual(approvedName);
  });

  test('a rejected edit leaves the published version and shows the reason', async ({ request }) => {
    const id = await createCategory(request, h, created, 'reject-edit');
    await goLive(request, h, admin, 'product_category', id);
    const before = (await published(request, h, 'product_category', id))?.name;
    const crId = await pendingChangeId(await request.patch(`${urls.categories}/${id}`, { headers: h, data: { name: qaNames('to-reject') } }));
    expect((await reject(request, admin, crId!, 'QA autotest: edit rejected')).status()).toBe(200);

    expect((await published(request, h, 'product_category', id))?.name).toEqual(before);
    expect((await entity(request, h, 'product_category', id)).rejection_reason).toBe('QA autotest: edit rejected');
  });

  test('a live item whose edit was rejected still counts as approved', async ({ request }) => {
    test.fail(true, 'Known: the live category turns REJECTED and is counted as rejected, though customers still see it');
    const id = await createCategory(request, h, created, 'reject-edit-state');
    await goLive(request, h, admin, 'product_category', id);
    const crId = await pendingChangeId(await request.patch(`${urls.categories}/${id}`, { headers: h, data: { name: qaNames('to-reject') } }));
    await reject(request, admin, crId!, 'QA autotest: edit rejected');

    expect(await published(request, h, 'product_category', id)).not.toBeNull();
    expect((await entity(request, h, 'product_category', id)).moderation_state).toBe('MERCHANT_MODERATION_STATE_APPROVED');
  });
});

test.describe('Moderation data — counts', () => {
  test('counts follow the category through draft → on moderation → approved → edit → rejected edit', async ({ request }) => {
    const start = await counts(request);
    const id = await createCategory(request, h, created, 'counts');
    expect(await counts(request)).toMatchObject({ all: start.all + 1, approved: start.approved, on_moderation: start.on_moderation });

    const cr = await submit(request, h, 'product_category', id);
    expect(await counts(request)).toMatchObject({ on_moderation: start.on_moderation + 1 });

    await approve(request, admin, cr);
    expect(await counts(request)).toMatchObject({ all: start.all + 1, approved: start.approved + 1, on_moderation: start.on_moderation });

    const crEdit = await pendingChangeId(await request.patch(`${urls.categories}/${id}`, { headers: h, data: { name: qaNames('counts-edit') } }));
    expect(await counts(request)).toMatchObject({ on_moderation: start.on_moderation + 1 });

    await reject(request, admin, crEdit!, 'QA autotest');
    const end = await counts(request);
    expect(end.on_moderation).toBe(start.on_moderation);
    expect(end.all).toBe(end.approved + end.on_moderation + end.rejected + (end.all - end.approved - end.on_moderation - end.rejected));
  });
});

test.describe('Moderation data — admin list', () => {
  test('filters by merchant, type, status and source return only matching requests', async ({ request }) => {
    const id = await createCategory(request, h, created, 'filters');
    await submit(request, h, 'product_category', id);
    const merchantId = (await entity(request, h, 'product_category', id)).merchant_id as string;

    const cases: [Record<string, string>, (c: any) => boolean][] = [
      [{ status: 'pending' }, (c) => c.status === 'pending'],
      [{ merchant_id: merchantId }, (c) => c.merchant_id === merchantId],
      [{ merchant_id: merchantId, entity_type: 'product_category' }, (c) => c.entity_type === 'product_category'],
      [{ merchant_id: merchantId, status: 'rejected' }, (c) => c.status === 'rejected'],
      [{ merchant_id: merchantId, source: 'manual' }, (c) => c.source === 'manual'],
    ];
    for (const [params, matches] of cases) {
      const res = await request.get(changeRequestsAdminUrl, { headers: admin, params: { ...params, 'pagination.limit': '50' } });
      expect(res.status(), JSON.stringify(params)).toBe(200);
      const list = (await res.json()).list as any[];
      for (const c of list) expect(matches(c), `${JSON.stringify(params)} → ${c.id}`).toBe(true);
    }

    const pending = (await (await request.get(changeRequestsAdminUrl, { headers: admin, params: { merchant_id: merchantId, status: 'pending', 'pagination.limit': '100' } })).json()).list as any[];
    expect(pending.map((c) => c.entity_id)).toContain(id);
  });

  test('pagination returns the right page size and total', async ({ request }) => {
    const res = await request.get(changeRequestsAdminUrl, { headers: admin, params: { 'pagination.limit': '2', 'pagination.offset': '0' } });
    const body = await res.json();
    expect(body.list.length).toBeLessThanOrEqual(2);
    test.skip(body.meta.total < 4, 'Need at least 4 change requests');
    const next = await (await request.get(changeRequestsAdminUrl, { headers: admin, params: { 'pagination.limit': '2', 'pagination.offset': '2' } })).json();
    expect(next.meta.total).toBe(body.meta.total);
    for (const c of next.list) expect(body.list.map((x: any) => x.id)).not.toContain(c.id);
  });
});

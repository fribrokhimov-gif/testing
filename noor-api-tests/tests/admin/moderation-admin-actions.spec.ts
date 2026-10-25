import { test, expect } from '@playwright/test';
import { adminEnv, adminHeaders, approve, reject, changeRequestsAdminUrl } from '../../api/admin';
import {
  Created, cleanup, createCategory, goLive, submit, entity, published, changeRequests, merchantHeaders, pendingChangeId, qaNames, urls,
} from '../../api/eatsModeration';

// Moderation — what the admin (cpanel) can do beyond approve/reject:
// approve with corrections (payload_patch), publish / unpublish directly, rejection reasons, audit trail.
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

test.describe('Admin — approve with corrections', () => {
  test("admin's correction is what customers see, and it is recorded", async ({ request }) => {
    const id = await createCategory(request, h, created, 'patch');
    await goLive(request, h, admin, 'product_category', id);
    const merchantName = qaNames('merchant-typo');
    const crId = await pendingChangeId(await request.patch(`${urls.categories}/${id}`, { headers: h, data: { name: merchantName } }));

    const adminName = qaNames('admin-fixed');
    const res = await request.post(`${changeRequestsAdminUrl}/${crId}/approve`, { headers: admin, data: { payload_patch: { name: adminName } } });
    expect(res.status(), await res.text()).toBe(200);

    expect((await published(request, h, 'product_category', id))?.name).toEqual(adminName);
    expect((await entity(request, h, 'product_category', id)).name).toEqual(adminName);
    const cr = (await changeRequests(request, h, id)).find((c) => c.id === crId)!;
    expect(cr).toMatchObject({ status: 'approved', payload: { name: adminName }, original_payload: { name: merchantName } });
    expect(cr.amender?.kind).toBe('admin');
    expect(cr.amended_at).toBeTruthy();
  });

  test('a publish request has nothing to correct', async ({ request }) => {
    const id = await createCategory(request, h, created, 'patch-publish');
    const cr = await submit(request, h, 'product_category', id);
    const res = await request.post(`${changeRequestsAdminUrl}/${cr}/approve`, { headers: admin, data: { payload_patch: { name: qaNames('x') } } });
    expect(res.status(), await res.text()).toBe(400);
    expect((await changeRequests(request, h, id)).find((c) => c.id === cr)?.status).toBe('pending');
  });
});

test.describe('Admin — publish and unpublish directly', () => {
  test('publishing a draft makes it live, recorded as an admin decision', async ({ request }) => {
    const id = await createCategory(request, h, created, 'direct-publish');
    const res = await request.post(urls.adminEntity('product_category', id, 'publish'), { headers: admin, data: {} });
    expect(res.status(), await res.text()).toBe(200);

    expect((await entity(request, h, 'product_category', id)).moderation_state).toBe('MERCHANT_MODERATION_STATE_APPROVED');
    expect(await published(request, h, 'product_category', id)).not.toBeNull();
    expect((await changeRequests(request, h, id)).map((c) => [c.operation, c.status, c.reviewer?.kind])).toContainEqual(['publish', 'approved', 'admin']);
  });

  test('unpublishing hides the item from customers', async ({ request }) => {
    const id = await createCategory(request, h, created, 'unpublish');
    await goLive(request, h, admin, 'product_category', id);
    const res = await request.post(urls.adminEntity('product_category', id, 'unpublish'), { headers: admin, data: { reason: 'QA autotest unpublish' } });
    expect(res.status(), await res.text()).toBe(200);
    expect(await published(request, h, 'product_category', id)).toBeNull();
  });

  test('the merchant sees why the item was unpublished', async ({ request }) => {
    test.fail(true, 'Known: the unpublish reason is not stored; the merchant sees an empty reason');
    const id = await createCategory(request, h, created, 'unpublish-reason');
    await goLive(request, h, admin, 'product_category', id);
    const reason = `QA autotest unpublish ${Date.now()}`;
    await request.post(urls.adminEntity('product_category', id, 'unpublish'), { headers: admin, data: { reason } });
    expect((await entity(request, h, 'product_category', id)).rejection_reason).toBe(reason);
  });
});

test.describe('Admin — rejection reason', () => {
  test('empty reason is refused', async ({ request }) => {
    const id = await createCategory(request, h, created, 'reason-empty');
    const cr = await submit(request, h, 'product_category', id);
    const res = await reject(request, admin, cr, '');
    expect(res.status(), await res.text()).toBe(400);
    expect((await changeRequests(request, h, id)).find((c) => c.id === cr)?.status).toBe('pending');
  });

  test('reason of only spaces is refused', async ({ request }) => {
    test.fail(true, 'Known: "   " is accepted, so the merchant sees a blank reason');
    const id = await createCategory(request, h, created, 'reason-spaces');
    const cr = await submit(request, h, 'product_category', id);
    expect((await reject(request, admin, cr, '   ')).status()).toBe(400);
  });

  test('the merchant sees the exact reason', async ({ request }) => {
    const id = await createCategory(request, h, created, 'reason-shown');
    const cr = await submit(request, h, 'product_category', id);
    const reason = `QA autotest: please fix the name — ${Date.now()}`;
    expect((await reject(request, admin, cr, reason)).status()).toBe(200);
    expect((await entity(request, h, 'product_category', id)).rejection_reason).toBe(reason);
  });
});

test.describe('Admin — audit trail', () => {
  test('approve and reject record the reviewer and time', async ({ request }) => {
    const ok = await createCategory(request, h, created, 'audit-ok');
    const crOk = await submit(request, h, 'product_category', ok);
    await approve(request, admin, crOk);
    const bad = await createCategory(request, h, created, 'audit-bad');
    const crBad = await submit(request, h, 'product_category', bad);
    await reject(request, admin, crBad, 'QA autotest audit');

    for (const [id, cr, status] of [[ok, crOk, 'approved'], [bad, crBad, 'rejected']]) {
      const c = (await changeRequests(request, h, id)).find((x) => x.id === cr)!;
      expect(c.status).toBe(status);
      expect(c.reviewer?.kind, `${status} reviewer`).toBe('admin');
      expect(Date.parse(c.reviewed_at!), `${status} reviewed_at`).toBeGreaterThan(Date.now() - 10 * 60_000);
    }
  });
});

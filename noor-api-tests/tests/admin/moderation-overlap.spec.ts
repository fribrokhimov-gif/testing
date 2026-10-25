import { test, expect } from '@playwright/test';
import { adminEnv, adminHeaders, approve, reject } from '../../api/admin';
import {
  Created, cleanup, createCategory, goLive, submit, entity, published, changeRequests, merchantHeaders, pendingChangeId, qaNames, urls,
} from '../../api/eatsModeration';

// Moderation — overlapping changes and races (QA categories; everything is deleted afterwards).
// Rules: one pending change request per entity; requests built on an outdated version become "stale";
// when two decisions race, exactly one wins.
let h: Record<string, string>;
let admin: Record<string, string>;
const created = new Created();

test.beforeEach(async ({ request }) => {
  test.skip(!adminEnv.phone || !adminEnv.password, 'Set ADMIN_PHONE / ADMIN_PASSWORD in .env');
  h = await merchantHeaders(request);
  admin = await adminHeaders(request);
});
test.afterAll(async ({ request }) => cleanup(request, created));

const edit = (request: any, id: string) => request.patch(`${urls.categories}/${id}`, { headers: h, data: { name: qaNames('edit') } });

test.describe('Moderation — one pending change at a time', () => {
  test('a second edit while one is pending is refused', async ({ request }) => {
    const id = await createCategory(request, h, created, 'two-edits');
    await goLive(request, h, admin, 'product_category', id);
    expect(await pendingChangeId(await edit(request, id))).toBeTruthy();

    const second = await edit(request, id);
    expect(second.status(), await second.text()).toBe(409);
    expect((await second.json()).error.code).toBe(4605);
    expect((await changeRequests(request, h, id)).filter((c) => c.status === 'pending')).toHaveLength(1);
  });

  test('delete while an edit is pending is refused', async ({ request }) => {
    const id = await createCategory(request, h, created, 'edit-then-delete');
    await goLive(request, h, admin, 'product_category', id);
    expect(await pendingChangeId(await edit(request, id))).toBeTruthy();

    const del = await request.delete(`${urls.categories}/${id}`, { headers: h });
    expect(del.status(), await del.text()).toBe(409);
    expect(await published(request, h, 'product_category', id), 'still live').not.toBeNull();
  });

  test('submitting an item already on moderation does not create a second request', async ({ request }) => {
    const id = await createCategory(request, h, created, 'submit-twice');
    const first = await submit(request, h, 'product_category', id);
    const again = await request.post(urls.submit('product_category', id), { headers: h, data: {} });
    expect(again.status(), await again.text()).toBeLessThan(500);
    const pending = (await changeRequests(request, h, id)).filter((c) => c.status === 'pending');
    expect(pending.map((c) => c.id)).toEqual([first]);
  });
});

test.describe('Moderation — stale requests', () => {
  test('pending edit becomes stale when the admin unpublishes the item, and cannot be approved', async ({ request }) => {
    const id = await createCategory(request, h, created, 'stale');
    await goLive(request, h, admin, 'product_category', id);
    const crId = await pendingChangeId(await edit(request, id));

    const un = await request.post(urls.adminEntity('product_category', id, 'unpublish'), { headers: admin, data: { reason: 'QA autotest unpublish' } });
    expect(un.status(), await un.text()).toBe(200);
    expect((await changeRequests(request, h, id)).find((c) => c.id === crId)?.status).toBe('stale');

    const late = await approve(request, admin, crId!);
    expect(late.status()).toBe(409);
    expect(await published(request, h, 'product_category', id)).toBeNull();
  });
});

test.describe('Moderation — races', () => {
  for (let i = 1; i <= 3; i++) {
    test(`approve and reject at the same moment: exactly one wins (try ${i})`, async ({ request }) => {
      const id = await createCategory(request, h, created, `race-ar-${i}`);
      const cr = await submit(request, h, 'product_category', id);
      const [a, r] = await Promise.all([approve(request, admin, cr), reject(request, admin, cr, 'QA race')]);

      expect([a.status(), r.status()].sort()).toEqual([200, 409]);
      const status = (await changeRequests(request, h, id)).find((c) => c.id === cr)?.status;
      const state = (await entity(request, h, 'product_category', id)).moderation_state;
      const visible = (await published(request, h, 'product_category', id)) !== null;
      if (a.status() === 200) expect([status, state, visible]).toEqual(['approved', 'MERCHANT_MODERATION_STATE_APPROVED', true]);
      else expect([status, state, visible]).toEqual(['rejected', 'MERCHANT_MODERATION_STATE_REJECTED', false]);
    });
  }

  for (let i = 1; i <= 3; i++) {
    test(`merchant withdraws while the admin approves: exactly one wins (try ${i})`, async ({ request }) => {
      const id = await createCategory(request, h, created, `race-wa-${i}`);
      const cr = await submit(request, h, 'product_category', id);
      const [w, a] = await Promise.all([request.post(`${urls.changeRequests}/${cr}/cancel`, { headers: h, data: {} }), approve(request, admin, cr)]);

      expect([w.ok(), a.ok()].filter(Boolean), `withdraw ${w.status()} / approve ${a.status()}`).toHaveLength(1);
      const status = (await changeRequests(request, h, id)).find((c) => c.id === cr)?.status;
      const visible = (await published(request, h, 'product_category', id)) !== null;
      if (a.ok()) expect([status, visible]).toEqual(['approved', true]);
      else expect([status, visible]).toEqual(['withdrawn', false]);
    });
  }
});

test.describe('Moderation — decided requests are final', () => {
  test('approved request cannot be approved again, rejected or withdrawn', async ({ request }) => {
    const id = await createCategory(request, h, created, 'final');
    const cr = await submit(request, h, 'product_category', id);
    expect((await approve(request, admin, cr)).status()).toBe(200);

    expect((await approve(request, admin, cr)).status()).toBe(409);
    expect((await reject(request, admin, cr, 'QA late reject')).status()).toBe(409);
    expect((await request.post(`${urls.changeRequests}/${cr}/cancel`, { headers: h, data: {} })).ok()).toBe(false);
    expect(await published(request, h, 'product_category', id)).not.toBeNull();
  });

  test('an approved, unchanged item cannot be submitted again', async ({ request }) => {
    const id = await createCategory(request, h, created, 'resubmit-live');
    await goLive(request, h, admin, 'product_category', id);
    const res = await request.post(urls.submit('product_category', id), { headers: h, data: {} });
    expect(res.status(), await res.text()).toBe(400);
  });

  test('unknown change request returns 404', async ({ request }) => {
    expect((await approve(request, admin, '00000000-0000-0000-0000-000000000000')).status()).toBe(404);
  });
});

import { test, expect } from '@playwright/test';
import { getTokens, bearer, login, extractTokens } from '../../api/auth';
import {
  branchesUrl, branchBody, listBranches, createBranch, updateBranch, deleteBranch, validatePoint,
  Branch, TASHKENT, LONDON,
} from '../../api/branches';

// Access tokens live 60s, so each test logs in fresh
let token: string;
test.beforeEach(async ({ request }) => {
  token = (await getTokens(request)).access_token;
});

test.describe('Branches — create → list → update → delete', () => {
  test.describe.configure({ mode: 'serial' });

  const name = `QA-autotest-${Date.now()}`;
  let id: number | undefined;

  test.afterAll(async ({ request }) => {
    // Safety net if a step failed before delete
    if (id) await deleteBranch(request, (await getTokens(request)).access_token, id);
  });

  test('create returns the new branch', async ({ request }) => {
    const res = await createBranch(request, token, branchBody(name, 'QA test address'));
    expect(res.status(), await res.text()).toBe(200);

    const b = (await res.json()) as Branch;
    id = b.id;
    expect(typeof b.id).toBe('number');
    expect(b).toMatchObject({
      name,
      address: 'QA test address',
      location: TASHKENT,
      floor: 3,
      client_phone: '+998901234567',
      is_business: true,
    });
  });

  test('list and search find the new branch', async ({ request }) => {
    expect((await listBranches(request, token)).map((b) => b.id)).toContain(id);

    const found = await listBranches(request, token, name);
    expect(found.map((b) => b.id)).toEqual([id]);
  });

  test('update changes name and address', async ({ request }) => {
    const res = await updateBranch(request, token, id!, branchBody(`${name}-upd`, 'QA updated address', { floor: null }));
    expect(res.status(), await res.text()).toBe(200);

    const b = (await listBranches(request, token)).find((x) => x.id === id);
    expect(b).toMatchObject({ name: `${name}-upd`, address: 'QA updated address', floor: null });
  });

  test('delete removes the branch', async ({ request }) => {
    const res = await deleteBranch(request, token, id!);
    expect(res.status(), await res.text()).toBe(204);

    expect((await listBranches(request, token)).map((b) => b.id)).not.toContain(id);

    const again = await deleteBranch(request, token, id!);
    expect(again.status()).toBe(404);
    id = undefined;
  });
});

test.describe('Branches — get all', () => {
  test('list returns branches with expected fields', async ({ request }) => {
    const res = await request.get(branchesUrl, { headers: bearer(token), params: { is_business: true } });
    expect(res.status(), await res.text()).toBe(200);

    const list = ((await res.json()) as Branch[] | null) ?? [];
    expect(Array.isArray(list)).toBe(true);
    for (const b of list) {
      expect(typeof b.id).toBe('number');
      expect(b.location).toEqual({ lat: expect.any(Number), long: expect.any(Number) });
      expect(b.is_business).toBe(true);
      for (const key of ['name', 'address', 'floor', 'client_phone']) expect(b).toHaveProperty(key);
    }
  });
});

test.describe('Branches — validation and access', () => {
  test('create without location is rejected', async ({ request }) => {
    const { location, ...body } = branchBody('QA-no-location', 'x');
    const res = await createBranch(request, token, body);
    expect(res.status()).toBe(400);
    expect(await res.json()).toHaveProperty('location');
  });

  test('search with no match returns empty list', async ({ request }) => {
    expect(await listBranches(request, token, 'zzqx-no-such-branch-91')).toHaveLength(0);
  });

  test('delete of unknown id returns 404', async ({ request }) => {
    const res = await deleteBranch(request, token, 1);
    expect(res.status()).toBe(404);
  });

  test('list and create without token are rejected', async ({ request }) => {
    const list = await request.get(branchesUrl, { params: { is_business: true } });
    expect(list.status()).toBe(401);

    const create = await request.post(branchesUrl, { data: branchBody('QA-no-token', 'x') });
    expect(create.status()).toBe(401);
  });
});

test.describe('Service area — gis/locations/validate', () => {
  test('point inside service area is accepted', async ({ request }) => {
    const res = await validatePoint(request, token, { location: TASHKENT });
    expect(res.status(), await res.text()).toBe(204);
  });

  test('point outside service area is rejected', async ({ request }) => {
    const res = await validatePoint(request, token, { location: LONDON });
    expect(res.status()).toBe(403);
    expect(await res.json()).toEqual({ error: 'out.of.bounds' });
  });

  test('missing location is rejected', async ({ request }) => {
    const res = await validatePoint(request, token, {});
    expect(res.status()).toBe(400);
  });
});

// Cashier has no access to branch addresses: 403 on list, create, edit and delete.
// Needs an existing cashier (CASHIER_PHONE / CASHIER_PASSWORD in .env).
test.describe('Branches — cashier has no access', () => {
  const phone = process.env.CASHIER_PHONE ?? '';
  const password = process.env.CASHIER_PASSWORD ?? '';
  let cashier: string;
  let targetId: number | undefined;

  test.beforeEach(async ({ request }) => {
    test.skip(!phone || !password, 'Set CASHIER_PHONE / CASHIER_PASSWORD in .env');
    const res = await login(request, phone, password);
    expect(res.status(), 'cashier login').toBe(200);
    cashier = extractTokens(await res.json()).access_token!;
  });

  test.afterAll(async ({ request }) => {
    if (targetId) await deleteBranch(request, (await getTokens(request)).access_token, targetId);
  });

  test('cashier cannot list branches', async ({ request }) => {
    const res = await request.get(branchesUrl, { headers: bearer(cashier), params: { is_business: true } });
    expect(res.status(), await res.text()).toBe(403);
  });

  test('cashier cannot create a branch', async ({ request }) => {
    const res = await createBranch(request, cashier, branchBody(`QA-cashier-${Date.now()}`, 'QA cashier address'));
    if (res.ok()) targetId = (await res.json()).id;
    expect(res.status()).toBe(403);
  });

  test('cashier cannot edit or delete a branch', async ({ request }) => {
    // Admin creates the branch the cashier tries to change; afterAll removes it
    const created = await createBranch(request, token, branchBody(`QA-target-${Date.now()}`, 'QA target address'));
    expect(created.status(), await created.text()).toBe(200);
    targetId = (await created.json()).id;

    expect((await updateBranch(request, cashier, targetId!, branchBody('QA-cashier-edit', 'x'))).status()).toBe(403);
    expect((await deleteBranch(request, cashier, targetId!)).status()).toBe(403);
    expect((await listBranches(request, token)).find((b) => b.id === targetId)).toMatchObject({ address: 'QA target address' });
  });
});

// Manager can manage branch addresses. Needs MANAGER_PHONE / MANAGER_PASSWORD in .env.
test.describe('Branches — manager can manage addresses', () => {
  test.describe.configure({ mode: 'serial' });
  let manager: string;
  let id: number | undefined;

  test.beforeEach(async ({ request }) => {
    const phone = process.env.MANAGER_PHONE ?? '';
    const password = process.env.MANAGER_PASSWORD ?? '';
    test.skip(!phone || !password, 'Set MANAGER_PHONE / MANAGER_PASSWORD in .env');
    const res = await login(request, phone, password);
    expect(res.status(), 'manager login').toBe(200);
    manager = extractTokens(await res.json()).access_token!;
  });

  test.afterAll(async ({ request }) => {
    if (id) await deleteBranch(request, (await getTokens(request)).access_token, id);
  });

  test('manager can list, create, edit and delete a branch', async ({ request }) => {
    expect(Array.isArray(await listBranches(request, manager))).toBe(true);

    const created = await createBranch(request, manager, branchBody(`QA-manager-${Date.now()}`, 'QA manager address'));
    expect(created.status(), await created.text()).toBe(200);
    id = (await created.json()).id;

    const updated = await updateBranch(request, manager, id!, branchBody('QA-manager-upd', 'QA manager updated'));
    expect(updated.status(), await updated.text()).toBe(200);
    expect((await listBranches(request, manager)).find((b) => b.id === id)).toMatchObject({ address: 'QA manager updated' });

    const deleted = await deleteBranch(request, manager, id!);
    expect(deleted.status(), await deleted.text()).toBe(204);
    id = undefined;
  });
});

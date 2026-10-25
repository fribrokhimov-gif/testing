import { test, expect, APIRequestContext, APIResponse } from '@playwright/test';
import { getTokens, bearer, env, login, extractTokens } from '../../api/auth';

// Merchant employees (eats API, same merchant token)
//   GET    merchant-employees        — { list: Employee[] }
//   GET    merchant-employees/{id}
//   POST   merchant-employees        { new_identity: { phone, role, first_name, last_name } } — { data: { employee } }
//   PATCH  merchant-employees/{id}   { first_name, last_name }
//   DELETE merchant-employees/{id}   — detach
// The panel lets you add only "manager" and "cashier".
const url = `${env.employeesUrl}/merchant-employees`;

type Employee = {
  employee_id: string;
  merchant_id: string;
  phone: string;
  role: string;
  status: string;
  first_name: string;
  last_name: string;
  created_at: string;
  updated_at: string;
};

// Adding an employee sends an SMS with a password to their phone.
// Use only numbers you control (in .env). Tests that would add someone are skipped without them.
const PHONE = process.env.EMPLOYEE_TEST_PHONE ?? '';
const PHONE_2 = process.env.EMPLOYEE_TEST_PHONE_2 ?? '';
const needPhone = (p: string) => test.skip(!p, 'Set EMPLOYEE_TEST_PHONE / EMPLOYEE_TEST_PHONE_2 in .env — adding an employee sends an SMS');

// Access tokens live 60s, so each test logs in fresh
let headers: Record<string, string>;
test.beforeEach(async ({ request }) => {
  headers = bearer((await getTokens(request)).access_token);
});

// Everything a test creates is detached at the end, even if the test fails
const toDetach = new Set<string>();
test.afterAll(async ({ request }) => {
  if (!toDetach.size) return;
  const h = bearer((await getTokens(request)).access_token);
  for (const id of toDetach) await request.delete(`${url}/${id}`, { headers: h });
});

/** Single employee from any of the response shapes the API uses. */
const unwrap = (body: any): Employee => body?.data?.employee ?? body?.data ?? body;

async function create(request: APIRequestContext, identity: Record<string, unknown>): Promise<APIResponse> {
  const res = await request.post(url, { headers, data: { new_identity: identity } });
  if (res.ok()) toDetach.add(unwrap(await res.json()).employee_id);
  return res;
}

async function list(request: APIRequestContext): Promise<Employee[]> {
  const res = await request.get(url, { headers });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()).list ?? [];
}

test.describe('Employees — add → view → edit → remove', () => {
  test.describe.configure({ mode: 'serial' });
  test.beforeEach(() => needPhone(PHONE));

  const phone = PHONE;
  let emp: Employee;

  test('add a manager', async ({ request }) => {
    const res = await create(request, { phone, role: 'manager', first_name: 'QA', last_name: 'Autotest' });
    expect(res.status(), await res.text()).toBe(200);

    emp = unwrap(await res.json());
    expect(emp).toMatchObject({ phone, role: 'manager', first_name: 'QA', last_name: 'Autotest', status: 'active' });
    expect(emp.employee_id).toBeTruthy();
    expect(emp.merchant_id).toBeTruthy();
  });

  test('new employee is in the list', async ({ request }) => {
    test.skip(!emp, 'Employee was not added');
    const found = (await list(request)).find((e) => e.employee_id === emp.employee_id);
    expect(found).toMatchObject({ phone, role: 'manager', first_name: 'QA', last_name: 'Autotest' });
  });

  test('get employee by id', async ({ request }) => {
    test.skip(!emp, 'Employee was not added');
    const res = await request.get(`${url}/${emp.employee_id}`, { headers });
    expect(res.status(), await res.text()).toBe(200);
    expect(unwrap(await res.json())).toMatchObject({ employee_id: emp.employee_id, phone, role: 'manager' });
  });

  // Rule: one phone has one role per merchant — a manager cannot also be added as cashier
  test('same phone cannot be added again', async ({ request }) => {
    test.skip(!emp, 'Employee was not added');
    test.fail(true, 'Known: API returns 200 with the existing employee instead of an error');
    const res = await create(request, { phone, role: 'cashier', first_name: 'QA', last_name: 'Duplicate' });
    expect(res.status(), await res.text()).toBeGreaterThanOrEqual(400);
    expect(res.status()).toBeLessThan(500);
  });

  test('same phone added again does not duplicate or change the employee', async ({ request }) => {
    test.skip(!emp, 'Employee was not added');
    await create(request, { phone, role: 'cashier', first_name: 'QA', last_name: 'Duplicate' });

    const same = (await list(request)).filter((e) => e.phone === phone);
    expect(same).toHaveLength(1);
    expect(same[0]).toMatchObject({ employee_id: emp.employee_id, role: 'manager', first_name: 'QA', last_name: 'Autotest' });
  });

  test('edit first and last name, then get again', async ({ request }) => {
    test.skip(!emp, 'Employee was not added');
    const res = await request.patch(`${url}/${emp.employee_id}`, { headers, data: { first_name: 'QA-upd', last_name: 'Autotest-upd' } });
    expect(res.status(), await res.text()).toBe(200);
    const edited = unwrap(await res.json());
    expect(edited).toMatchObject({ employee_id: emp.employee_id, first_name: 'QA-upd', last_name: 'Autotest-upd', phone, role: 'manager' });
    expect(Date.parse(edited.updated_at)).toBeGreaterThan(Date.parse(emp.updated_at));

    const get = await request.get(`${url}/${emp.employee_id}`, { headers });
    expect(get.status(), await get.text()).toBe(200);
    expect(unwrap(await get.json())).toMatchObject({ first_name: 'QA-upd', last_name: 'Autotest-upd', phone, role: 'manager' });

    const inList = (await list(request)).find((e) => e.employee_id === emp.employee_id);
    expect(inList).toMatchObject({ first_name: 'QA-upd', last_name: 'Autotest-upd' });
  });

  test('phone and role cannot be edited', async ({ request }) => {
    test.skip(!emp, 'Employee was not added');
    const res = await request.patch(`${url}/${emp.employee_id}`, {
      headers,
      data: { first_name: 'QA-upd', last_name: 'Autotest-upd', phone: PHONE_2 || '+998000000000', role: 'cashier' },
    });
    expect(res.status(), await res.text()).toBeLessThan(500);

    const get = await request.get(`${url}/${emp.employee_id}`, { headers });
    expect(unwrap(await get.json())).toMatchObject({ phone, role: 'manager' });
  });

  test('remove the employee', async ({ request }) => {
    test.skip(!emp, 'Employee was not added');
    const res = await request.delete(`${url}/${emp.employee_id}`, { headers });
    expect(res.status(), await res.text()).toBeLessThan(300);
    toDetach.delete(emp.employee_id);

    expect((await list(request)).map((e) => e.employee_id)).not.toContain(emp.employee_id);
  });
});

test.describe('Employees — roles', () => {
  test('add a cashier', async ({ request }) => {
    needPhone(PHONE_2);
    const phone = PHONE_2;
    const res = await create(request, { phone, role: 'cashier', first_name: 'QA', last_name: 'Cashier' });
    expect(res.status(), await res.text()).toBe(200);
    expect(unwrap(await res.json())).toMatchObject({ phone, role: 'cashier', status: 'active' });
  });

  test('unknown role is rejected', async ({ request }) => {
    needPhone(PHONE);
    const res = await create(request, { phone: PHONE, role: 'superuser', first_name: 'QA', last_name: 'Role' });
    expect(res.status(), await res.text()).toBe(400);
  });
});

// Rule: one phone has one role per merchant (merchant-admin, manager or cashier)
test.describe('Employees — one role per phone', () => {
  for (const role of ['manager', 'cashier']) {
    test(`admin's own phone cannot be added as ${role}`, async ({ request }) => {
      const before = (await list(request)).length;
      const res = await create(request, { phone: env.phone, role, first_name: 'QA', last_name: 'Self' });
      expect(res.status(), await res.text()).toBe(403);
      expect(await res.json()).toMatchObject({ error: { code: 9402 } });
      expect(await list(request)).toHaveLength(before);
    });
  }
  // Manager's phone added again as cashier: see "same phone cannot be added again" in the main flow
});

test.describe('Employees — validation', () => {
  test('missing phone is rejected', async ({ request }) => {
    const res = await create(request, { role: 'manager', first_name: 'QA', last_name: 'NoPhone' });
    expect(res.status(), await res.text()).toBe(400);
  });

  test('invalid phone is rejected', async ({ request }) => {
    const res = await create(request, { phone: 'abc', role: 'manager', first_name: 'QA', last_name: 'BadPhone' });
    expect(res.status(), await res.text()).toBe(400);
  });

  test('missing role is rejected', async ({ request }) => {
    needPhone(PHONE);
    const res = await create(request, { phone: PHONE, first_name: 'QA', last_name: 'NoRole' });
    expect(res.status(), await res.text()).toBe(400);
  });

  test('unknown employee returns 404', async ({ request }) => {
    const res = await request.get(`${url}/00000000-0000-0000-0000-000000000000`, { headers });
    expect(res.status()).toBe(404);
  });
});

// Roles: merchant-admin — everything; manager — everything except creating reports;
// cashier — no access to employees or branch addresses; reports read only.
// These need existing accounts in .env (the password comes by SMS when someone is added as an employee).
// Write requests are chosen so nothing changes and no SMS is sent whatever the API does:
//   add: empty body — 403 if the role is refused, 400 (validation) if it is let through
//   edit: the same names; remove: an id that does not exist — 403 if refused, 404 if let through
async function roleLogin(request: APIRequestContext, phone: string, password: string) {
  test.skip(!phone || !password, 'Set the phone / password for this role in .env');
  const res = await login(request, phone, password);
  expect(res.status(), `${phone} login`).toBe(200);
  return bearer(extractTokens(await res.json()).access_token!);
}

test.describe('Employees — cashier cannot add, edit or remove', () => {
  const phone = process.env.CASHIER_PHONE ?? '';
  let as: Record<string, string>;
  let self: Employee;
  const knownBug = (action: string) => test.fail(true, `Known: cashier can ${action} employees`);

  test.beforeEach(async ({ request }) => {
    as = await roleLogin(request, phone, process.env.CASHIER_PASSWORD ?? '');
    self = (await list(request)).find((e) => e.phone === phone)!;
    expect(self, `${phone} is an employee`).toMatchObject({ role: 'cashier' });
  });

  test('cashier cannot add an employee', async ({ request }) => {
    knownBug('add');
    const res = await request.post(url, { headers: as, data: { new_identity: {} } });
    expect(res.status(), await res.text()).toBe(403);
  });

  test('cashier cannot edit an employee', async ({ request }) => {
    knownBug('edit');
    const res = await request.patch(`${url}/${self.employee_id}`, { headers: as, data: { first_name: self.first_name, last_name: self.last_name } });
    expect(res.status(), await res.text()).toBe(403);
  });

  test('cashier cannot remove an employee', async ({ request }) => {
    knownBug('remove');
    const res = await request.delete(`${url}/00000000-0000-0000-0000-000000000000`, { headers: as });
    expect(res.status(), await res.text()).toBe(403);
  });
});

test.describe('Employees — manager can add, edit and remove', () => {
  const phone = process.env.MANAGER_PHONE ?? '';
  let as: Record<string, string>;
  let self: Employee;

  test.beforeEach(async ({ request }) => {
    as = await roleLogin(request, phone, process.env.MANAGER_PASSWORD ?? '');
    self = (await list(request)).find((e) => e.phone === phone)!;
    expect(self, `${phone} is an employee`).toMatchObject({ role: 'manager' });
  });

  test('manager can list and view employees', async ({ request }) => {
    expect((await request.get(url, { headers: as })).status()).toBe(200);
    expect((await request.get(`${url}/${self.employee_id}`, { headers: as })).status()).toBe(200);
  });

  test('manager is allowed to add an employee', async ({ request }) => {
    // Empty body gets past the role check and fails validation — no one is added
    const res = await request.post(url, { headers: as, data: { new_identity: {} } });
    expect(res.status(), await res.text()).toBe(400);
  });

  test('manager can edit an employee', async ({ request }) => {
    test.fail(true, 'Known: manager gets 403 on employee edit');
    const res = await request.patch(`${url}/${self.employee_id}`, { headers: as, data: { first_name: self.first_name, last_name: self.last_name } });
    expect(res.status(), await res.text()).toBe(200);
  });

  test('manager is allowed to remove an employee', async ({ request }) => {
    // Unknown id gets past the role check and is not found — no one is removed
    const res = await request.delete(`${url}/00000000-0000-0000-0000-000000000000`, { headers: as });
    expect(res.status(), await res.text()).toBe(404);
  });
});

test.describe('Employees — cashier cannot read', () => {
  test('cashier cannot list or view employees', async ({ request }) => {
    test.fail(true, 'Known: cashier can list and view employees');
    const as = await roleLogin(request, process.env.CASHIER_PHONE ?? '', process.env.CASHIER_PASSWORD ?? '');
    expect((await request.get(url, { headers: as })).status(), 'list').toBe(403);
    const [any] = await list(request);
    expect((await request.get(`${url}/${any.employee_id}`, { headers: as })).status(), 'view').toBe(403);
  });
});

test.describe('Employees — access', () => {
  test('list and add without token are rejected', async ({ request }) => {
    expect((await request.get(url)).status()).toBe(401);
    const res = await request.post(url, { data: { new_identity: { phone: '+998000000000', role: 'manager' } } });
    expect(res.status()).toBe(401);
  });
});

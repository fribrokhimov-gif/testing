import { test, expect, APIRequestContext } from '@playwright/test';
import { login, extractTokens, bearer, env, Tokens } from '../../api/auth';

// Change password — allowed for every role
//   POST auth/change-password { old_password, new_password }
// After a change every session of that user is revoked ("session revoked", 401)
// and only the new password logs in.
// Every test changes the password back, so the accounts in .env keep working.
// Changing a password logs out every session of that user — including the admin sessions other
// test files use in parallel — so this file only runs on its own: npm run test:password
const changeUrl = `${env.authUrl}/api/v1/auth/change-password`;
const refreshUrl = `${env.authUrl}/api/v1/auth/refresh`;
const protectedUrl = `${env.deliveryUrl}/merchants/me`;

const ACCOUNTS = {
  admin: { phone: env.phone, password: env.password },
  manager: { phone: process.env.MANAGER_PHONE ?? '', password: process.env.MANAGER_PASSWORD ?? '' },
  cashier: { phone: process.env.CASHIER_PHONE ?? '', password: process.env.CASHIER_PASSWORD ?? '' },
};

async function signIn(request: APIRequestContext, phone: string, password: string): Promise<Tokens> {
  const res = await login(request, phone, password);
  expect(res.status(), `login ${phone}`).toBe(200);
  return extractTokens(await res.json()) as Tokens;
}

const change = (request: APIRequestContext, token: string, old_password: string, new_password: string) =>
  request.post(changeUrl, { headers: bearer(token), data: { old_password, new_password } });

test.skip(!process.env.PASSWORD_TESTS, 'Run on its own: npm run test:password');

for (const [role, { phone, password }] of Object.entries(ACCOUNTS)) {
  test.describe(`Change password — ${role}`, () => {
    test.describe.configure({ mode: 'serial' });
    const temp = `${password}Qa1`;

    test.beforeEach(() => {
      test.skip(!phone || !password, `Set the ${role} phone / password in .env`);
    });

    // Safety net: if a test stopped after changing, put the original password back
    test.afterEach(async ({ request }) => {
      const res = await login(request, phone, temp);
      if (!res.ok()) return;
      const t = extractTokens(await res.json());
      await change(request, t.access_token!, temp, password);
    });

    test(`${role} changes password: all sessions are logged out, only the new password works`, async ({ request }) => {
      const a = await signIn(request, phone, password);
      const b = await signIn(request, phone, password); // second device

      const res = await change(request, a.access_token, password, temp);
      expect(res.status(), await res.text()).toBe(200);

      for (const [name, s] of [['this session', a], ['other session', b]] as const) {
        const me = await request.get(protectedUrl, { headers: bearer(s.access_token) });
        expect(me.status(), `${name}: access token`).toBe(401);
        expect(await me.json(), name).toMatchObject({ error: { code: 5015 } });

        const refresh = await request.post(refreshUrl, { data: { refresh_token: s.refresh_token } });
        expect([400, 401, 403], `${name}: refresh token`).toContain(refresh.status());
      }

      expect((await login(request, phone, password)).status(), 'old password').toBe(401);
      const fresh = await signIn(request, phone, temp);
      expect((await request.get(protectedUrl, { headers: bearer(fresh.access_token) })).status(), 'new session').toBe(200);

      // Change back
      const back = await change(request, fresh.access_token, temp, password);
      expect(back.status(), await back.text()).toBe(200);
      await signIn(request, phone, password);
    });

    test(`${role}: wrong old password is rejected and nothing changes`, async ({ request }) => {
      const a = await signIn(request, phone, password);
      const res = await change(request, a.access_token, `${password}-wrong`, temp);
      expect(res.status(), await res.text()).toBeGreaterThanOrEqual(400);
      expect(res.status()).toBeLessThan(500);

      expect((await login(request, phone, temp)).status(), 'new password must not work').toBe(401);
      await signIn(request, phone, password);
    });
  });
}

// Negative cases on one account: the cashier if set, else the manager, else the admin.
// Minimum length (8) and new = old are only checked by the panel today — see the backlog tests below.
test.describe('Change password — invalid requests', () => {
  const [role, acc] = (['cashier', 'manager', 'admin'] as const).map((r) => [r, ACCOUNTS[r]] as const).find(([, a]) => a.phone && a.password)!;
  const temp = `${acc.password}Qa1`;

  // Safety net: if anything got through, put the original password back
  test.afterEach(async ({ request }) => {
    const res = await login(request, acc.phone, temp);
    if (res.ok()) await change(request, extractTokens(await res.json()).access_token!, temp, acc.password);
  });

  const cases: [string, Record<string, unknown>, string[]][] = [
    ['empty body', {}, ['old_password', 'new_password']],
    ['missing old password', { new_password: temp }, ['old_password']],
    ['missing new password', { old_password: acc.password }, ['new_password']],
    ['empty old password', { old_password: '', new_password: temp }, ['old_password']],
    ['empty new password', { old_password: acc.password, new_password: '' }, ['new_password']],
    ['new password longer than 128 characters', { old_password: acc.password, new_password: 'Aa1!' + 'x'.repeat(125) }, ['new_password']],
  ];
  for (const [name, data, fields] of cases) {
    test(`${name} is rejected`, async ({ request }) => {
      const { access_token } = await signIn(request, acc.phone, acc.password);
      const res = await request.post(changeUrl, { headers: bearer(access_token), data });
      expect(res.status(), await res.text()).toBe(400);
      const details = (await res.json()).error.details as { field: string }[];
      expect(details.map((d) => d.field).sort()).toEqual([...fields].sort());
      await signIn(request, acc.phone, acc.password);
    });
  }

  test('numbers instead of text are rejected', async ({ request }) => {
    const { access_token } = await signIn(request, acc.phone, acc.password);
    const res = await request.post(changeUrl, { headers: bearer(access_token), data: { old_password: 12345678, new_password: 87654321 } });
    expect(res.status(), await res.text()).toBe(400);
  });

  // Backlog for backend — today only the panel checks these. Switch to test() once the API does too.
  test.fixme('new password shorter than 8 characters is rejected', async ({ request }) => {
    const { access_token } = await signIn(request, acc.phone, acc.password);
    const res = await change(request, access_token, acc.password, 'Aa1!');
    expect(res.status(), await res.text()).toBe(400);
  });

  test.fixme('new password same as the old one is rejected', async ({ request }) => {
    const { access_token } = await signIn(request, acc.phone, acc.password);
    const res = await change(request, access_token, acc.password, acc.password);
    expect(res.status(), await res.text()).toBe(400);
  });

  test('logged-out session cannot change the password again', async ({ request }) => {
    const { access_token } = await signIn(request, acc.phone, acc.password);
    expect((await change(request, access_token, acc.password, temp)).status()).toBe(200);

    const again = await change(request, access_token, temp, acc.password);
    expect(again.status()).toBe(401);
    expect(await again.json()).toMatchObject({ error: { code: 5015 } });
    // afterEach changes it back
  });

  test(`invalid token is rejected (${role} account)`, async ({ request }) => {
    const res = await request.post(changeUrl, { headers: bearer('abc.def.ghi'), data: { old_password: acc.password, new_password: temp } });
    expect(res.status()).toBe(401);
  });
});

test.describe('Change password — access', () => {
  test('change password without token is rejected', async ({ request }) => {
    const res = await request.post(changeUrl, { data: { old_password: 'x', new_password: 'y' } });
    expect(res.status()).toBe(401);
  });
});

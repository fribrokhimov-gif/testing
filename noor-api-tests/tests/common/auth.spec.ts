import { test, expect } from '@playwright/test';
import { login, logout, extractTokens, getTokens, bearer, env } from '../../api/auth';

const vendorMe = `${env.deliveryUrl}/vendors/me`; // protected Delivery endpoint

test.describe('Auth — login', () => {
  test('valid credentials return access and refresh tokens', async ({ request }) => {
    const res = await login(request);
    expect(res.status(), await res.text()).toBeLessThan(300);

    const { access_token, refresh_token } = extractTokens(await res.json());
    expect(access_token, 'access_token').toBeTruthy();
    expect(refresh_token, 'refresh_token').toBeTruthy();
    expect(access_token!.split('.')).toHaveLength(3); // JWT shape
  });

  test('access token opens a protected Delivery endpoint', async ({ request }) => {
    const { access_token } = await getTokens(request);
    const res = await request.get(vendorMe, { headers: bearer(access_token) });
    expect(res.status(), await res.text()).toBe(200);
  });

  test('wrong password is rejected', async ({ request }) => {
    const res = await login(request, env.phone, 'wrong-password-123');
    expect([400, 401, 403]).toContain(res.status());
    expect(extractTokens(await res.json().catch(() => ({}))).access_token).toBeFalsy();
  });

  test('unknown phone is rejected', async ({ request }) => {
    const res = await login(request, '+998000000000', env.password);
    expect([400, 401, 403, 404]).toContain(res.status());
  });

  test('empty body returns validation error', async ({ request }) => {
    const res = await request.post(`${env.authUrl}${env.loginPath}`, { data: {} });
    expect([400, 422]).toContain(res.status());
  });
});

test.describe('Auth — logout', () => {
  test('logout with refresh token succeeds', async ({ request }) => {
    const tokens = await getTokens(request);
    const res = await logout(request, tokens);
    expect(res.status(), await res.text()).toBeLessThan(300);
  });

  test('refresh token cannot be used after logout', async ({ request }) => {
    const tokens = await getTokens(request);
    await logout(request, tokens);

    const res = await request.post(`${env.authUrl}/api/v1/auth/refresh`, {
      data: { refresh_token: tokens.refresh_token },
    });
    expect([400, 401, 403], 'revoked refresh token must be refused').toContain(res.status());
  });
});

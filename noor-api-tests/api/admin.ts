import { APIRequestContext } from '@playwright/test';
import { env, bearer, extractTokens } from './auth';

// Noor admin panel (cpanel.test.noor.uz) — the moderator side of Eats
export const adminEnv = {
  phone: process.env.ADMIN_PHONE ?? '',
  password: process.env.ADMIN_PASSWORD ?? '',
  eatsUrl: process.env.EATS_ADMIN_API_URL ?? 'https://eats.test.api.noor.uz/api/v1',
};
export const changeRequestsAdminUrl = `${adminEnv.eatsUrl}/admin/change-requests`;

/** POST auth/user — the admin login cpanel uses. */
export async function adminHeaders(request: APIRequestContext) {
  const res = await request.post(`${env.authUrl}/api/v1/auth/user`, {
    data: { phone: adminEnv.phone, password: adminEnv.password, device_id: 'qa-autotest', device_name: 'QA autotest', platform: 'web' },
  });
  if (!res.ok()) throw new Error(`Admin login failed: ${res.status()} ${await res.text()}`);
  return bearer(extractTokens(await res.json()).access_token!);
}

export const approve = (request: APIRequestContext, headers: Record<string, string>, changeRequestId: string) =>
  request.post(`${changeRequestsAdminUrl}/${changeRequestId}/approve`, { headers, data: {} });

export const reject = (request: APIRequestContext, headers: Record<string, string>, changeRequestId: string, reason: string) =>
  request.post(`${changeRequestsAdminUrl}/${changeRequestId}/reject`, { headers, data: { reason } });

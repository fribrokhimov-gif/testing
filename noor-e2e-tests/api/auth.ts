import { APIRequestContext, APIResponse } from '@playwright/test';

export const env = {
  authUrl: process.env.AUTH_API_URL ?? 'https://core.test.api.noor.uz',
  deliveryUrl: process.env.DELIVERY_API_URL ?? 'https://core.test.api.noor.uz/api/v1',
  // Merchant API for Eats (menu, categories) and uploads — the panel's VITE_API_BASE_URL
  merchantApiUrl: process.env.MERCHANT_API_URL ?? 'https://test.api.noor.uz/api/v1',
  uploadsUrl: process.env.UPLOADS_API_URL ?? 'https://test.api.noor.uz/api/v1',
  // Merchant employees — the panel's VITE_MERCHANT_EMPLOYEE_API_BASE_URL
  employeesUrl: process.env.EMPLOYEES_API_URL ?? 'https://eats.test.api.noor.uz/api/v1',
  // Generated files (reports) — the panel's VITE_FILE_API_URL
  filesUrl: process.env.FILES_URL ?? 'https://tback.noor.uz/files',
  phone: process.env.MERCHANT_PHONE!,
  password: process.env.MERCHANT_PASSWORD!,
  loginPath: process.env.LOGIN_PATH ?? '/api/v1/auth/merchant',
  logoutPath: process.env.LOGOUT_PATH ?? '/api/v1/auth/logout',
};

export type Tokens = { access_token: string; refresh_token: string };

/** POST auth/merchant  body: { phone, password } */
export function login(
  request: APIRequestContext,
  phone = env.phone,
  password = env.password,
): Promise<APIResponse> {
  if (!phone || !password) {
    throw new Error('MERCHANT_PHONE / MERCHANT_PASSWORD are not set — copy .env.example to .env and fill them in');
  }
  return request.post(`${env.authUrl}${env.loginPath}`, { data: { phone, password } });
}

/** POST auth/logout  body: { refresh_token } */
export function logout(request: APIRequestContext, tokens?: Partial<Tokens>): Promise<APIResponse> {
  return request.post(`${env.authUrl}${env.logoutPath}`, {
    headers: tokens?.access_token ? bearer(tokens.access_token) : {},
    data: tokens?.refresh_token ? { refresh_token: tokens.refresh_token } : {},
  });
}

/** The app unwraps `data` if present, then reads access_token / refresh_token. */
export function extractTokens(body: any): Partial<Tokens> {
  const d = body && typeof body === 'object' && 'data' in body ? body.data : body;
  return { access_token: d?.access_token, refresh_token: d?.refresh_token };
}

export async function getTokens(request: APIRequestContext): Promise<Tokens> {
  const res = await login(request);
  if (!res.ok()) throw new Error(`Login failed: ${res.status()} ${await res.text()}`);
  const t = extractTokens(await res.json());
  if (!t.access_token || !t.refresh_token) throw new Error('Tokens missing in login response');
  return t as Tokens;
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

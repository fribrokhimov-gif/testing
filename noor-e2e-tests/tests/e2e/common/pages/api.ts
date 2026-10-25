import { APIRequestContext, Page, expect } from '@playwright/test';
import { getTokens, bearer, env } from '../../../../api/auth';

// Backend calls the E2E tests use to compare the panel with the API and to put things back.
// E2E projects send no default headers, so X-Platform is added here (the API refuses without it).
export const meUrl = `${env.deliveryUrl}/merchants/me`;
export const vendorUrl = `${env.deliveryUrl}/vendors/me`;
export const employeesUrl = `${env.employeesUrl}/merchant-employees`;
export const refreshUrl = `${env.authUrl}/api/v1/auth/refresh`;

export type Merchant = { merchant_id: string; name: string; logo_url: string | null };
export type Vendor = { name: string; business_name: string; business_logo: string | null };
export type Employee = { employee_id: string; phone: string; role: string; first_name: string; last_name: string };

const platform = { 'X-Platform': process.env.X_PLATFORM ?? 'web', Accept: 'application/json' };

/** Fresh admin token (access tokens live 60s) */
export async function adminHeaders(request: APIRequestContext) {
  return { ...bearer((await getTokens(request)).access_token), ...platform };
}

export async function getMerchant(request: APIRequestContext): Promise<Merchant> {
  const res = await request.get(meUrl, { headers: await adminHeaders(request) });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()).data.merchant;
}

/** vendors/me — the profile page shows business_name from here */
export async function getVendor(request: APIRequestContext): Promise<Vendor> {
  const res = await request.get(vendorUrl, { headers: await adminHeaders(request) });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

/** Puts the original merchant name and logo back; vendors/me picks the name up a few seconds later. */
export async function restoreMerchant(request: APIRequestContext, original: Merchant, vendorName: string) {
  const now = await getMerchant(request);
  if (now.name !== original.name || now.logo_url !== original.logo_url) {
    const res = await request.patch(meUrl, { headers: await adminHeaders(request), data: { name: original.name, logo_url: original.logo_url } });
    expect(res.status(), await res.text()).toBe(200);
  }
  await expect.poll(async () => (await getVendor(request)).name, { timeout: 30_000, message: 'vendors/me name restored' }).toBe(vendorName);
}

export async function listEmployees(request: APIRequestContext): Promise<Employee[]> {
  const res = await request.get(employeesUrl, { headers: await adminHeaders(request) });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()).list ?? [];
}

/**
 * Aborts every non-GET request matching `url` and records it, so a form under test can never
 * really save (no employee is created — no SMS). Assert the returned list at the end.
 */
export async function blockWrites(page: Page, url: RegExp): Promise<string[]> {
  const attempts: string[] = [];
  await page.route(url, (route) => {
    if (route.request().method() === 'GET') return route.continue();
    attempts.push(`${route.request().method()} ${route.request().url()}`);
    return route.abort();
  });
  return attempts;
}

import { test, expect, APIRequestContext } from '@playwright/test';
import { getTokens, bearer, env, login, extractTokens } from '../../api/auth';

// Merchant profile — name and logo ("photo")
//   GET   merchants/me                       — { data: { employee, merchant } }
//   POST  uploads/presign { count, bucket: 'eats', folder: 'restaurant' } — { list: [{ key, upload_url, public_url }] }
//   PUT   <upload_url>  (the image itself, straight to S3)
//   PATCH merchants/me { name, logo_url: <key> }
// Edits are visible in the panel, so every test puts the original name and logo back.
const meUrl = `${env.deliveryUrl}/merchants/me`;
const presignUrl = `${env.uploadsUrl}/uploads/presign`;

type Merchant = { merchant_id: string; name: string; logo_url: string | null; updated_at: string };

// 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

// Access tokens live 60s, so each test logs in fresh
let headers: Record<string, string>;
test.beforeEach(async ({ request }) => {
  headers = bearer((await getTokens(request)).access_token);
});

async function profile(request: APIRequestContext, h = headers): Promise<Merchant> {
  const res = await request.get(meUrl, { headers: h });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()).data.merchant;
}

/** Presign + upload — returns the key to save as logo_url and the public link. */
async function uploadLogo(request: APIRequestContext, h = headers) {
  const res = await request.post(presignUrl, { headers: h, data: { count: 1, bucket: 'eats', folder: 'restaurant' } });
  expect(res.status(), await res.text()).toBe(200);
  const [slot] = (await res.json()).list as { key: string; upload_url: string; public_url: string; error: string }[];
  expect(slot.error).toBe('');
  expect(slot.key).toMatch(/^restaurant\//);

  const put = await request.put(slot.upload_url, { data: PNG, headers: { 'Content-Type': 'image/png' } });
  expect(put.status(), await put.text()).toBe(200);
  return slot;
}

type Role = 'admin' | 'manager' | 'cashier';

/** Token for a role — admin from MERCHANT_*, the others from MANAGER_* / CASHIER_* in .env. */
async function tokenFor(request: APIRequestContext, role: Role) {
  if (role === 'admin') return bearer((await getTokens(request)).access_token);
  const phone = process.env[`${role.toUpperCase()}_PHONE`] ?? '';
  const password = process.env[`${role.toUpperCase()}_PASSWORD`] ?? '';
  test.skip(!phone || !password, `Set ${role.toUpperCase()}_PHONE / ${role.toUpperCase()}_PASSWORD in .env`);
  const res = await login(request, phone, password);
  expect(res.status(), `${role} login`).toBe(200);
  return bearer(extractTokens(await res.json()).access_token!);
}

test.describe('Merchant profile — view', () => {
  test('profile returns merchant and the logged-in employee', async ({ request }) => {
    const res = await request.get(meUrl, { headers });
    expect(res.status()).toBe(200);
    const { employee, merchant } = (await res.json()).data;
    expect(employee).toMatchObject({ phone: env.phone, role: 'merchant-admin' });
    expect(merchant).toMatchObject({ merchant_id: employee.merchant_id, name: expect.any(String) });
  });

  test('current logo can be opened', async ({ request }) => {
    const { logo_url } = await profile(request);
    test.skip(!logo_url, 'Merchant has no logo');
    const res = await request.get(`https://s3.test.api.noor.uz/eats/${logo_url}`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toMatch(/^image\//);
  });
});

// Admin and manager can change the merchant name and logo; cashier can do neither
for (const role of ['admin', 'manager', 'cashier'] as Role[]) {
  test.describe(`Merchant profile — ${role} edits name and photo`, () => {
    let original: Merchant;

    test.beforeEach(async ({ request }) => {
      original = await profile(request);
    });

    // Put the original name and logo back whatever happened
    test.afterEach(async ({ request }) => {
      const h = bearer((await getTokens(request)).access_token);
      const now = await profile(request, h);
      if (now.name !== original.name || now.logo_url !== original.logo_url) {
        await request.patch(meUrl, { headers: h, data: { name: original.name, logo_url: original.logo_url } });
      }
    });

    if (role !== 'cashier') {
      test(`${role} can change name`, async ({ request }) => {
        const as = await tokenFor(request, role);
        const name = `${original.name}-qa-${role}`;
        const res = await request.patch(meUrl, { headers: as, data: { name, logo_url: original.logo_url } });
        expect(res.status(), await res.text()).toBe(200);
        expect(await profile(request)).toMatchObject({ name, logo_url: original.logo_url });
      });

      test(`${role} can change logo`, async ({ request }) => {
        const as = await tokenFor(request, role);
        const slot = await uploadLogo(request, as);
        const res = await request.patch(meUrl, { headers: as, data: { name: original.name, logo_url: slot.key } });
        expect(res.status(), await res.text()).toBe(200);
        expect(await profile(request)).toMatchObject({ name: original.name, logo_url: slot.key });

        const img = await request.get(slot.public_url);
        expect(img.status()).toBe(200);
        expect((await img.body()).equals(PNG)).toBe(true);
      });
    } else {
      test('cashier cannot change name', async ({ request }) => {
        test.fail(true, 'Known until the backend change: cashier gets 200 on merchants/me PATCH');
        const as = await tokenFor(request, role);
        const res = await request.patch(meUrl, { headers: as, data: { name: `${original.name}-qa-cashier`, logo_url: original.logo_url } });
        expect(res.status(), await res.text()).toBe(403);
        expect((await profile(request)).name).toBe(original.name);
      });

      test('cashier cannot change logo', async ({ request }) => {
        const as = await tokenFor(request, role);
        // No upload link for a cashier
        const presign = await request.post(presignUrl, { headers: as, data: { count: 1, bucket: 'eats', folder: 'restaurant' } });
        expect(presign.status(), await presign.text()).toBe(403);

        // Nor setting an already uploaded picture (uploaded here by admin)
        test.fail(true, 'Known until the backend change: cashier gets 200 on merchants/me PATCH');
        const slot = await uploadLogo(request);
        const res = await request.patch(meUrl, { headers: as, data: { name: original.name, logo_url: slot.key } });
        expect(res.status(), await res.text()).toBe(403);
        expect((await profile(request)).logo_url).toBe(original.logo_url);
      });
    }
  });
}

test.describe('Merchant profile — access', () => {
  test('view, edit and upload without token are rejected', async ({ request }) => {
    expect((await request.get(meUrl)).status()).toBe(401);
    expect((await request.patch(meUrl, { data: { name: 'QA' } })).status()).toBe(401);
    expect((await request.post(presignUrl, { data: { count: 1, bucket: 'eats', folder: 'restaurant' } })).status()).toBe(401);
  });
});

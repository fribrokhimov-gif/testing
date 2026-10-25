import { test, expect } from '@playwright/test';
import { adminEnv, adminHeaders, approve } from '../../api/admin';
import {
  Created, cleanup, createCategory, createProduct, createBranch, addToBranch, goLive, submit, published, merchantHeaders, pendingChangeId, qaNames, api, urls,
} from '../../api/eatsModeration';

// Moderation — dependencies between categories, products and branches.
// Rule under test: a customer must never see an item whose parent is hidden or gone.
// Creates QA categories / products / branches (some briefly live on the test app); everything is deleted afterwards.
let h: Record<string, string>;
let admin: Record<string, string>;
const created = new Created();

test.beforeEach(async ({ request }) => {
  test.skip(!adminEnv.phone || !adminEnv.password, 'Set ADMIN_PHONE / ADMIN_PASSWORD in .env');
  h = await merchantHeaders(request);
  admin = await adminHeaders(request);
});
test.afterAll(async ({ request }) => cleanup(request, created));

test.describe('Moderation — category and its products', () => {
  test('a product cannot be submitted without a photo', async ({ request }) => {
    const category = await createCategory(request, h, created, 'no-photo-cat');
    const res = await request.post(urls.products, {
      headers: h,
      data: {
        product_category_id: category, name: { ru: `QA-autotest no-photo ${Date.now()}`, uz: '', en: '' }, description: { ru: 'QA', uz: '', en: '' },
        is_always_ready: true, is_adult: false, price: 15000, ikpu_code: '12345678901234567', unit_code: '2', vat_percent: 12,
        measure_amount: 1, measurement_type: 'MEASUREMENT_TYPE_KG',
      },
    });
    const product = created.add('product', (await res.json()).data.product.id);
    const sub = await request.post(urls.submit('product', product), { headers: h, data: {} });
    expect(sub.status(), await sub.text()).toBe(400);
    expect(JSON.stringify(await sub.json())).toContain('images');
  });

  test('a product in a draft category stays hidden from customers', async ({ request }) => {
    test.fail(true, 'Known: the product goes live while its category is still a hidden draft');
    const category = await createCategory(request, h, created, 'draft-cat');
    const product = await createProduct(request, h, created, category, 'prod-in-draft-cat');
    await goLive(request, h, admin, 'product', product);

    expect(await published(request, h, 'product_category', category), 'category hidden').toBeNull();
    expect(await published(request, h, 'product', product), 'product must be hidden too').toBeNull();
  });

  test('deleting a live category hides its live products', async ({ request }) => {
    test.fail(true, 'Known: the product stays live, pointing at the deleted category');
    const category = await createCategory(request, h, created, 'live-cat');
    await goLive(request, h, admin, 'product_category', category);
    const product = await createProduct(request, h, created, category, 'prod-in-live-cat');
    await goLive(request, h, admin, 'product', product);
    expect(await published(request, h, 'product', product)).not.toBeNull();

    const res = await request.delete(`${urls.categories}/${category}`, { headers: h });
    expect(res.status(), await res.text()).toBe(200);
    const deleteRequest = await pendingChangeId(res);
    expect((await approve(request, admin, deleteRequest!)).status()).toBe(200);
    created.forget(category);

    expect((await request.get(`${urls.categories}/${category}`, { headers: h })).status()).toBe(404);
    expect(await published(request, h, 'product', product), 'product must not stay live without its category').toBeNull();
  });
});

test.describe('Moderation — branch and its products', () => {
  test('a branch cannot be submitted without preparation times', async ({ request }) => {
    const branch = await createBranch(request, h, created, 'no-prep');
    const patch = await request.patch(`${urls.restaurants}/${branch}`, { headers: h, data: { min_prep_time: 0, max_prep_time: 0 } });
    test.skip(!patch.ok(), 'Preparation times cannot be cleared on this environment');
    const res = await request.post(urls.submit('restaurant', branch), { headers: h, data: {} });
    expect(res.status(), await res.text()).toBe(400);
  });

  test('a product sold only in a draft branch stays hidden from customers', async ({ request }) => {
    test.fail(true, 'Known: the product goes live although its only branch is a hidden draft');
    const category = await createCategory(request, h, created, 'branch-cat');
    await goLive(request, h, admin, 'product_category', category);
    const branch = await createBranch(request, h, created, 'draft-branch');
    const product = await createProduct(request, h, created, category, 'prod-in-draft-branch');
    await addToBranch(request, h, product, branch);
    await goLive(request, h, admin, 'product', product);

    expect(await published(request, h, 'restaurant', branch), 'branch hidden').toBeNull();
    expect(await published(request, h, 'product', product), 'product must be hidden too').toBeNull();
  });

  test('unpublishing a live branch hides its products', async ({ request }) => {
    test.fail(true, 'Known: the branch is hidden but its product stays live');
    const category = await createCategory(request, h, created, 'unpub-cat');
    await goLive(request, h, admin, 'product_category', category);
    const branch = await createBranch(request, h, created, 'live-branch');
    await goLive(request, h, admin, 'restaurant', branch);
    const product = await createProduct(request, h, created, category, 'prod-in-live-branch');
    await addToBranch(request, h, product, branch);
    await goLive(request, h, admin, 'product', product);
    expect(await published(request, h, 'restaurant', branch)).not.toBeNull();

    const un = await request.post(urls.adminEntity('restaurant', branch, 'unpublish'), { headers: admin, data: { reason: 'QA autotest' } });
    expect(un.status(), await un.text()).toBe(200);
    expect(await published(request, h, 'restaurant', branch), 'branch hidden').toBeNull();
    expect(await published(request, h, 'product', product), 'its product must be hidden too').toBeNull();
  });
});

test.describe('Moderation — submitting the parent first', () => {
  test('a live branch with a submitted category and product: all three visible after approval', async ({ request }) => {
    const category = await createCategory(request, h, created, 'chain-cat');
    const branch = await createBranch(request, h, created, 'chain-branch');
    const product = await createProduct(request, h, created, category, 'chain-prod');
    await addToBranch(request, h, product, branch);

    const crs = [await submit(request, h, 'product_category', category), await submit(request, h, 'restaurant', branch), await submit(request, h, 'product', product)];
    for (const cr of crs) expect((await approve(request, admin, cr)).status()).toBe(200);

    expect(await published(request, h, 'product_category', category)).not.toBeNull();
    expect(await published(request, h, 'restaurant', branch)).not.toBeNull();
    expect(await published(request, h, 'product', product)).not.toBeNull();
  });
});

// Promotions: a draft promotion for a not-yet-live product is fine (merchants prepare ahead),
// but customers must never see a promotion before its branch and product are live.
// Dates are 2 months ahead so nothing changes today's prices.
test.describe('Moderation — promotion and its product / branch', () => {
  const promotionsUrl = `${api}/merchant/promotions`;
  const at = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().replace(/\.\d+Z$/, 'Z');

  async function createPromotion(request: any, branch: string, product: string, tag: string) {
    const res = await request.post(promotionsUrl, {
      headers: h,
      data: {
        restaurant_id: branch, product_ids: [product], name: qaNames(tag), promo_type: 'PROMO_TYPE_DISCOUNT',
        discount_type: 'DISCOUNT_TYPE_PERCENTAGE', discount_value: 10, starts_at: at(60), ends_at: at(61),
      },
    });
    expect(res.status(), await res.text()).toBe(200);
    return created.add('promotion', (await res.json()).data.promotion.id);
  }

  async function promotionVisible(request: any, id: string, branch: string) {
    const res = await request.get(`${promotionsUrl}/${id}/published`, { headers: h, params: { restaurant_id: branch } });
    return res.status() === 200 && Boolean((await res.json()).data?.client_visible);
  }

  test('a draft promotion can be prepared for a product that is not live yet', async ({ request }) => {
    const category = await createCategory(request, h, created, 'promo-prep-cat');
    await goLive(request, h, admin, 'product_category', category);
    const branch = await createBranch(request, h, created, 'promo-prep-branch');
    await goLive(request, h, admin, 'restaurant', branch);
    const product = await createProduct(request, h, created, category, 'promo-prep-prod');
    await addToBranch(request, h, product, branch);

    const promotion = await createPromotion(request, branch, product, 'promo-prep');
    expect(await promotionVisible(request, promotion, branch)).toBe(false);
  });

  test('a promotion in a draft branch cannot be approved', async ({ request }) => {
    const category = await createCategory(request, h, created, 'promo-db-cat');
    await goLive(request, h, admin, 'product_category', category);
    const branch = await createBranch(request, h, created, 'promo-draft-branch');
    const product = await createProduct(request, h, created, category, 'promo-db-prod');
    await addToBranch(request, h, product, branch);
    const promotion = await createPromotion(request, branch, product, 'promo-draft-branch');

    const res = await approve(request, admin, await submit(request, h, 'promotion', promotion));
    expect(res.status(), await res.text()).toBe(400);
    expect((await res.json()).error.details[0].issue).toContain('parent entity is not published');
    expect(await promotionVisible(request, promotion, branch)).toBe(false);
  });

  test('a promotion for a draft product cannot go live', async ({ request }) => {
    test.fail(true, 'Known: approved and visible although its product is hidden (the branch is checked, the product is not)');
    const category = await createCategory(request, h, created, 'promo-dp-cat');
    await goLive(request, h, admin, 'product_category', category);
    const branch = await createBranch(request, h, created, 'promo-dp-branch');
    await goLive(request, h, admin, 'restaurant', branch);
    const product = await createProduct(request, h, created, category, 'promo-draft-prod');
    await addToBranch(request, h, product, branch);
    const promotion = await createPromotion(request, branch, product, 'promo-draft-prod');

    const res = await approve(request, admin, await submit(request, h, 'promotion', promotion));
    expect(await published(request, h, 'product', product), 'product hidden').toBeNull();
    expect(res.status(), 'approve must be blocked like for a draft branch').toBe(400);
    expect(await promotionVisible(request, promotion, branch), 'promotion must stay hidden').toBe(false);
  });
});

import { test, expect, APIRequestContext } from '@playwright/test';
import { getTokens, bearer, env } from '../../api/auth';

// Eats → Мастер-меню → Продукты
//   GET    merchant/products?pagination.limit=&pagination.offset= — { list, meta: { total } }
//   GET    merchant/products/{id}  — { data: { product } }, name/description = { ru, uz, en }
//   POST   merchant/products { product_category_id, name, description, price, ikpu_code, unit_code, … }
//   PATCH  merchant/products/{id} { category_id, name, description, price, … }  (note: category_id, not product_category_id)
//   DELETE merchant/products/{id}
// Photo: POST uploads/presign { bucket: 'eats', folder: 'product' } → PUT the file → images: [key]
// New products start as DRAFT. Every product a test creates is deleted at the end.
const url = `${env.merchantApiUrl}/merchant/products`;
const categoriesUrl = `${env.merchantApiUrl}/merchant/product-categories`;
const presignUrl = `${env.uploadsUrl}/uploads/presign`;

type Names = { ru: string; uz: string; en: string };
type Product = {
  id: string;
  name: Names;
  description: Names;
  price: number;
  effective_price: number;
  product_category_id: string;
  ikpu_code: string;
  cook_time_seconds: number;
  images: { id: string; url: string }[];
  moderation_state: string;
  status: string;
};

// 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

// Access tokens live 60s, so each test logs in fresh
let headers: Record<string, string>;
test.beforeEach(async ({ request }) => {
  headers = { ...bearer((await getTokens(request)).access_token), 'x-locale': 'ru' };
});

const toDelete = new Set<string>();
test.afterAll(async ({ request }) => {
  if (!toDelete.size) return;
  const h = bearer((await getTokens(request)).access_token);
  for (const id of toDelete) await request.delete(`${url}/${id}`, { headers: h });
});

const qaNames = (tag: string): Names => {
  const stamp = `${tag} ${Date.now()}`;
  return { ru: `QA-autotest ru ${stamp}`, uz: `QA-autotest uz ${stamp}`, en: `QA-autotest en ${stamp}` };
};

async function categories(request: APIRequestContext) {
  const res = await request.get(categoriesUrl, { headers });
  expect(res.status(), await res.text()).toBe(200);
  const list = (await res.json()).list as { id: string; name: string }[];
  test.skip(list.length < 2, 'Need at least 2 product categories');
  return list;
}

const validBody = (categoryId: string, tag: string) => ({
  product_category_id: categoryId,
  name: qaNames(tag),
  description: { ru: 'QA описание', uz: 'QA tavsif', en: 'QA description' },
  is_always_ready: false,
  is_adult: false,
  price: 15000,
  cook_time_seconds: 600,
  ikpu_code: '12345678901234567',
  unit_code: '2',
  vat_percent: 12,
  measure_amount: 1,
  measurement_type: 'MEASUREMENT_TYPE_KG',
});

async function create(request: APIRequestContext, body: Record<string, unknown>) {
  const res = await request.post(url, { headers, data: body });
  if (res.ok()) toDelete.add((await res.json()).data.product.id);
  return res;
}

async function get(request: APIRequestContext, id: string) {
  const res = await request.get(`${url}/${id}`, { headers });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()).data.product as Product;
}

async function list(request: APIRequestContext) {
  const res = await request.get(url, { headers, params: { 'pagination.limit': 100, 'pagination.offset': 0 } });
  expect(res.status(), await res.text()).toBe(200);
  const body = await res.json();
  return { items: body.list as { id: string; name: string }[], total: body.meta.total as number };
}

async function uploadPhoto(request: APIRequestContext) {
  const res = await request.post(presignUrl, { headers, data: { count: 1, bucket: 'eats', folder: 'product' } });
  expect(res.status(), await res.text()).toBe(200);
  const [slot] = (await res.json()).list as { key: string; upload_url: string; public_url: string }[];
  const put = await request.put(slot.upload_url, { data: PNG, headers: { 'Content-Type': 'image/png' } });
  expect(put.status(), await put.text()).toBe(200);
  return slot;
}

test.describe('Products — create → view → edit → delete', () => {
  test.describe.configure({ mode: 'serial' });
  let product: Product;
  let body: ReturnType<typeof validBody>;
  let cats: { id: string; name: string }[];
  let totalBefore: number;

  test('create a product with a photo', async ({ request }) => {
    cats = await categories(request);
    totalBefore = (await list(request)).total;
    const photo = await uploadPhoto(request);
    body = validBody(cats[0].id, 'crud');

    const res = await create(request, { ...body, images: [photo.key] });
    expect(res.status(), await res.text()).toBe(200);
    product = (await res.json()).data.product;
    expect(product).toMatchObject({
      name: body.name,
      description: body.description,
      price: 15000,
      product_category_id: cats[0].id,
      ikpu_code: body.ikpu_code,
      cook_time_seconds: 600,
    });
    expect(product.images).toHaveLength(1);

    const img = await request.get(product.images[0].url);
    expect(img.status(), 'photo opens').toBe(200);
  });

  test('new product is in the list as a draft', async ({ request }) => {
    test.skip(!product, 'Product was not created');
    const { items, total } = await list(request);
    expect(items.find((p) => p.id === product.id)?.name).toBe(body.name.ru);
    expect(total).toBe(totalBefore + 1);
    expect((await get(request, product.id)).moderation_state).toBe('MERCHANT_MODERATION_STATE_DRAFT');
  });

  test('edit name, description, price and cooking time', async ({ request }) => {
    test.skip(!product, 'Product was not created');
    const { product_category_id, ...rest } = body;
    const changes = { name: qaNames('upd'), description: { ru: 'QA новое', uz: 'QA yangi', en: 'QA new' }, price: 17000, cook_time_seconds: 900 };

    const res = await request.patch(`${url}/${product.id}`, { headers, data: { ...rest, category_id: product_category_id, ...changes } });
    expect(res.status(), await res.text()).toBe(200);
    expect(await get(request, product.id)).toMatchObject({ ...changes, effective_price: 17000 });
  });

  test('move the product to another category', async ({ request }) => {
    test.skip(!product, 'Product was not created');
    const current = await get(request, product.id);
    const { product_category_id, ...rest } = body;
    const res = await request.patch(`${url}/${product.id}`, {
      headers,
      data: { ...rest, name: current.name, description: current.description, price: current.price, cook_time_seconds: current.cook_time_seconds, category_id: cats[1].id },
    });
    expect(res.status(), await res.text()).toBe(200);
    expect((await get(request, product.id)).product_category_id).toBe(cats[1].id);
  });

  test('delete the product', async ({ request }) => {
    test.skip(!product, 'Product was not created');
    const res = await request.delete(`${url}/${product.id}`, { headers });
    expect(res.status(), await res.text()).toBe(200);
    toDelete.delete(product.id);

    expect((await request.get(`${url}/${product.id}`, { headers })).status()).toBe(404);
    const { items, total } = await list(request);
    expect(items.map((p) => p.id)).not.toContain(product.id);
    expect(total).toBe(totalBefore);
  });

  test('deleting it again returns 404', async ({ request }) => {
    test.skip(!product, 'Product was not created');
    test.fail(true, 'Known: second delete returns 200 (an id that never existed gets 404)');
    expect((await request.delete(`${url}/${product.id}`, { headers })).status()).toBe(404);
  });
});

test.describe('Products — validation', () => {
  let categoryId: string;
  test.beforeEach(async ({ request }) => {
    categoryId = (await categories(request))[0].id;
  });

  const without = (b: Record<string, unknown>, key: string) => Object.fromEntries(Object.entries(b).filter(([k]) => k !== key));
  const cases: [string, (b: ReturnType<typeof validBody>) => Record<string, unknown>, number][] = [
    ['missing category', (b) => without(b, 'product_category_id'), 400],
    ['unknown category', (b) => ({ ...b, product_category_id: '00000000-0000-0000-0000-000000000000' }), 404],
    ['missing name', (b) => without(b, 'name'), 400],
    ['all three names empty', (b) => ({ ...b, name: { ru: '', uz: '', en: '' } }), 400],
    ['missing price', (b) => without(b, 'price'), 400],
    ['price 0', (b) => ({ ...b, price: 0 }), 400],
    ['negative price', (b) => ({ ...b, price: -100 }), 400],
    ['missing IKPU code', (b) => without(b, 'ikpu_code'), 400],
    ['VAT over 100%', (b) => ({ ...b, vat_percent: 150 }), 400],
    ['no cooking time when not always ready', (b) => without(b, 'cook_time_seconds'), 400],
  ];
  for (const [name, build, status] of cases) {
    test(`${name} is rejected`, async ({ request }) => {
      const res = await create(request, build(validBody(categoryId, 'invalid')));
      expect(res.status(), await res.text()).toBe(status);
    });
  }

  for (const [name, ikpu] of [['IKPU code shorter than 17 digits', '123'], ['IKPU code with letters', 'abcdefghijklmnopq']]) {
    test(`${name} is rejected`, async ({ request }) => {
      test.fail(true, 'Known: API accepts any IKPU code; only the panel checks 17 digits');
      const res = await create(request, { ...validBody(categoryId, 'ikpu'), ikpu_code: ikpu });
      expect(res.status(), await res.text()).toBe(400);
    });
  }

  test('unknown product returns 404 on view, edit and delete', async ({ request }) => {
    const unknown = `${url}/00000000-0000-0000-0000-000000000000`;
    expect((await request.get(unknown, { headers })).status()).toBe(404);
    expect((await request.patch(unknown, { headers, data: { price: 1 } })).status()).toBe(404);
    expect((await request.delete(unknown, { headers })).status()).toBe(404);
  });
});

test.describe('Products — access', () => {
  test('list, create, edit and delete without token are rejected', async ({ request }) => {
    const unknown = `${url}/00000000-0000-0000-0000-000000000000`;
    expect((await request.get(url)).status()).toBe(401);
    expect((await request.post(url, { data: { name: qaNames('no-token') } })).status()).toBe(401);
    expect((await request.patch(unknown, { data: { price: 1 } })).status()).toBe(401);
    expect((await request.delete(unknown)).status()).toBe(401);
  });
});

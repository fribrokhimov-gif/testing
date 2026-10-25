import { APIRequestContext, expect } from '@playwright/test';
import { env, bearer, getTokens } from './auth';
import { adminHeaders, approve, adminEnv } from './admin';

// Shared steps for Eats moderation tests: merchant creates/submits, customers see /published, cleanup undoes it all.
export const api = env.merchantApiUrl;
export const urls = {
  categories: `${api}/merchant/product-categories`,
  products: `${api}/merchant/products`,
  restaurants: `${api}/merchant/restaurants`,
  changeRequests: `${api}/merchant/change-requests`,
  submit: (type: EntityType, id: string) => `${api}/merchant/entities/${type}/${id}/submit-for-review`,
  adminEntity: (type: EntityType, id: string, action: 'publish' | 'unpublish') => `${adminEnv.eatsUrl}/admin/entities/${type}/${id}/${action}`,
};

export type EntityType = 'product_category' | 'product' | 'restaurant' | 'promotion';
export type Names = { ru: string; uz: string; en: string };
export type ChangeRequest = {
  id: string; entity_id: string; entity_type: string; operation: string; status: string;
  payload: Record<string, unknown>; baseline: Record<string, unknown> | null; original_payload?: Record<string, unknown>;
  reviewer?: { kind: string; id: string }; reviewed_at?: string; amender?: { kind: string }; amended_at?: string;
};

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const DAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];
const pathOf: Record<EntityType, string> = { product_category: urls.categories, product: urls.products, restaurant: urls.restaurants, promotion: `${api}/merchant/promotions` };
const keyOf: Record<EntityType, string> = { product_category: 'category', product: 'product', restaurant: 'restaurant', promotion: 'promotion' };

/** Names are unique per language, so every language gets the stamp. */
export const qaNames = (tag: string): Names => {
  const n = `QA-autotest ${tag} ${Date.now()}${Math.floor(Math.random() * 1000)}`;
  return { ru: n, uz: `${n} uz`, en: `${n} en` };
};

export async function merchantHeaders(request: APIRequestContext) {
  return { ...bearer((await getTokens(request)).access_token), 'x-locale': 'ru' };
}

/** Everything a test created, cleaned up by cleanup(). */
export class Created {
  items: { type: EntityType; id: string }[] = [];
  add(type: EntityType, id: string) { this.items.push({ type, id }); return id; }
  forget(id: string) { this.items = this.items.filter((i) => i.id !== id); }
}

async function upload(request: APIRequestContext, h: Record<string, string>, folder: 'product' | 'restaurant') {
  const res = await request.post(`${env.uploadsUrl}/uploads/presign`, { headers: h, data: { count: 1, bucket: 'eats', folder } });
  const slot = (await res.json()).list[0];
  await request.put(slot.upload_url, { data: PNG, headers: { 'Content-Type': 'image/png' } });
  return slot.key as string;
}

export async function createCategory(request: APIRequestContext, h: Record<string, string>, created: Created, tag: string) {
  const res = await request.post(urls.categories, { headers: h, data: { names: [qaNames(tag)] } });
  expect(res.status(), await res.text()).toBe(200);
  return created.add('product_category', (await res.json()).list[0].id);
}

export async function createProduct(request: APIRequestContext, h: Record<string, string>, created: Created, categoryId: string, tag: string) {
  const res = await request.post(urls.products, {
    headers: h,
    data: {
      product_category_id: categoryId, images: [await upload(request, h, 'product')], name: qaNames(tag), description: { ru: 'QA', uz: 'QA', en: 'QA' },
      is_always_ready: true, is_adult: false, price: 15000, ikpu_code: '12345678901234567', unit_code: '2', vat_percent: 12,
      measure_amount: 1, measurement_type: 'MEASUREMENT_TYPE_KG',
    },
  });
  expect(res.status(), await res.text()).toBe(200);
  return created.add('product', (await res.json()).data.product.id);
}

export async function createBranch(request: APIRequestContext, h: Record<string, string>, created: Created, tag: string) {
  const cuisine = (await (await request.get(`${api}/merchant/restaurant-categories`, { headers: h })).json()).list[0].id;
  const res = await request.post(urls.restaurants, {
    headers: h,
    data: {
      name: qaNames(tag), phone: '+998901234567', address: { line: { ru: 'QA адрес, Ташкент' }, latitude: 41.311, longitude: 69.279 },
      description: { ru: 'QA', uz: 'QA', en: 'QA' }, restaurant_category_ids: [cuisine], min_prep_time: 10, max_prep_time: 20,
      icon: await upload(request, h, 'restaurant'), background_image: await upload(request, h, 'restaurant'),
      week_schedule: DAYS.map((d) => ({ day_of_week: d, open_time: '09:00', close_time: '21:00', is_closed: false, order_from: '', order_to: '' })),
    },
  });
  expect(res.status(), await res.text()).toBe(200);
  return created.add('restaurant', (await res.json()).data.restaurant.id);
}

export async function addToBranch(request: APIRequestContext, h: Record<string, string>, productId: string, restaurantId: string) {
  const res = await request.post(`${urls.products}/${productId}/restaurant-products`, { headers: h, data: { patches: [{ restaurant_id: restaurantId, price: 15000 }] } });
  expect(res.status(), await res.text()).toBe(200);
}

export async function submit(request: APIRequestContext, h: Record<string, string>, type: EntityType, id: string) {
  const res = await request.post(urls.submit(type, id), { headers: h, data: {} });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()).data.change_request.id as string;
}

/** Create → submit → admin approves. */
export async function goLive(request: APIRequestContext, h: Record<string, string>, admin: Record<string, string>, type: EntityType, id: string) {
  const res = await approve(request, admin, await submit(request, h, type, id));
  expect(res.status(), await res.text()).toBe(200);
}

export async function entity(request: APIRequestContext, h: Record<string, string>, type: EntityType, id: string) {
  const res = await request.get(`${pathOf[type]}/${id}`, { headers: h });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()).data[keyOf[type]] as Record<string, any>;
}

/** What customers see, or null when hidden. */
export async function published(request: APIRequestContext, h: Record<string, string>, type: EntityType, id: string) {
  const res = await request.get(`${pathOf[type]}/${id}/published`, { headers: h });
  if (res.status() !== 200) return null;
  const body = (await res.json()).data;
  return body.client_visible ? (body[keyOf[type]] as Record<string, any>) : null;
}

export async function changeRequests(request: APIRequestContext, h: Record<string, string>, entityId: string) {
  const list = ((await (await request.get(urls.changeRequests, { headers: h })).json()).list ?? []) as ChangeRequest[];
  return list.filter((c) => c.entity_id === entityId);
}

/** Pending edit/delete of a live entity returns { pending_change: { id } }. */
export const pendingChangeId = async (res: { json(): Promise<any> }) => (await res.json()).data?.pending_change?.id as string | undefined;

/** Withdraw pending requests, delete, and approve the delete when the entity was already live. Children first. */
export async function cleanup(request: APIRequestContext, created: Created) {
  if (!created.items.length || !adminEnv.phone) return;
  const h = await merchantHeaders(request);
  const admin = await adminHeaders(request);
  const order: EntityType[] = ['promotion', 'product', 'product_category', 'restaurant'];
  for (const type of order) {
    for (const { id } of created.items.filter((i) => i.type === type)) {
      for (const c of (await changeRequests(request, h, id)).filter((x) => x.status === 'pending')) {
        await request.post(`${urls.changeRequests}/${c.id}/cancel`, { headers: h, data: {} });
      }
      const res = await request.delete(`${pathOf[type]}/${id}`, { headers: h });
      const pending = res.ok() ? await pendingChangeId(res) : undefined;
      if (pending) await approve(request, admin, pending);
    }
  }
  created.items = [];
}

import { test, expect, APIRequestContext } from '@playwright/test';
import { getTokens, bearer, env } from '../../api/auth';

// Eats → Мастер-меню → Категории
//   GET    merchant/product-categories       — { list, data: { counts: { all, approved, on_moderation, rejected } } }
//   GET    merchant/product-categories/{id}  — { data: { category } }, name = { ru, uz, en }
//   POST   merchant/product-categories { names: [{ ru, uz, en }, …] } — creates one category per item
//   PATCH  merchant/product-categories/{id} { name: { ru, uz, en } } or { is_active }
//   DELETE merchant/product-categories/{id}
// The list shows the name in the x-locale language. New categories start as DRAFT.
// Every category a test creates is deleted at the end.
const url = `${env.merchantApiUrl}/merchant/product-categories`;

type Names = { ru: string; uz: string; en: string };
type Category = {
  id: string;
  name: Names;
  is_active: boolean;
  moderation_state: string;
  lifecycle_status: string;
  merchant_id: string;
};
type ListItem = Omit<Category, 'name'> & { name: string };

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

async function create(request: APIRequestContext, names: Names[]) {
  const res = await request.post(url, { headers, data: { names } });
  if (res.ok()) for (const c of (await res.json()).list as Category[]) toDelete.add(c.id);
  return res;
}

async function list(request: APIRequestContext, locale = 'ru') {
  const res = await request.get(url, { headers: { ...headers, 'x-locale': locale } });
  expect(res.status(), await res.text()).toBe(200);
  const body = await res.json();
  return { items: body.list as ListItem[], counts: body.data.counts as Record<string, number> };
}

async function get(request: APIRequestContext, id: string) {
  const res = await request.get(`${url}/${id}`, { headers });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()).data.category as Category;
}

test.describe('Categories — create → view → edit → delete', () => {
  test.describe.configure({ mode: 'serial' });
  const names = qaNames('crud');
  let cat: Category;
  let before: number;

  test('create a category', async ({ request }) => {
    before = (await list(request)).counts.all;
    const res = await create(request, [names]);
    expect(res.status(), await res.text()).toBe(200);

    const created = (await res.json()).list as Category[];
    expect(created).toHaveLength(1);
    cat = created[0];
    expect(cat).toMatchObject({ name: names, is_active: true });
    expect(cat.id).toBeTruthy();
  });

  test('new category is in the list as a draft', async ({ request }) => {
    test.skip(!cat, 'Category was not created');
    const { items, counts } = await list(request);
    expect(items.find((c) => c.id === cat.id)).toMatchObject({ name: names.ru, is_active: true });
    expect(counts.all).toBe(before + 1);
    expect((await get(request, cat.id)).moderation_state).toBe('MERCHANT_MODERATION_STATE_DRAFT');
  });

  test('list shows the name in the requested language', async ({ request }) => {
    test.skip(!cat, 'Category was not created');
    for (const lang of ['ru', 'uz', 'en'] as const) {
      const { items } = await list(request, lang);
      expect(items.find((c) => c.id === cat.id)?.name, lang).toBe(names[lang]);
    }
  });

  test('edit the name in all three languages', async ({ request }) => {
    test.skip(!cat, 'Category was not created');
    const updated = qaNames('upd');
    const res = await request.patch(`${url}/${cat.id}`, { headers, data: { name: updated } });
    expect(res.status(), await res.text()).toBe(200);
    expect((await res.json()).data.category.name).toEqual(updated);
    expect((await get(request, cat.id)).name).toEqual(updated);
  });

  test('switch the category off and on', async ({ request }) => {
    test.skip(!cat, 'Category was not created');
    for (const is_active of [false, true]) {
      const res = await request.patch(`${url}/${cat.id}`, { headers, data: { is_active } });
      expect(res.status(), await res.text()).toBe(200);
      expect((await get(request, cat.id)).is_active).toBe(is_active);
    }
  });

  test('delete the category', async ({ request }) => {
    test.skip(!cat, 'Category was not created');
    const res = await request.delete(`${url}/${cat.id}`, { headers });
    expect(res.status(), await res.text()).toBe(200);
    toDelete.delete(cat.id);

    expect((await request.get(`${url}/${cat.id}`, { headers })).status()).toBe(404);
    const { items, counts } = await list(request);
    expect(items.map((c) => c.id)).not.toContain(cat.id);
    expect(counts.all).toBe(before);
  });
});

test.describe('Categories — create several at once', () => {
  test('two names create two categories', async ({ request }) => {
    const names = [qaNames('multi-1'), qaNames('multi-2')];
    const res = await create(request, names);
    expect(res.status(), await res.text()).toBe(200);
    const created = (await res.json()).list as Category[];
    expect(created.map((c) => c.name)).toEqual(names);

    const ids = (await list(request)).items.map((c) => c.id);
    for (const c of created) expect(ids).toContain(c.id);
  });

  test('a category with only the Russian name is created', async ({ request }) => {
    const ru = qaNames('ru-only').ru;
    const res = await create(request, [{ ru, uz: '', en: '' }]);
    expect(res.status(), await res.text()).toBe(200);
    expect(((await res.json()).list as Category[])[0].name.ru).toBe(ru);
  });
});

test.describe('Categories — validation', () => {
  const cases: [string, unknown, string][] = [
    ['no body', {}, 'names'],
    ['empty list', { names: [] }, 'names'],
    ['all three names empty', { names: [{ ru: '', uz: '', en: '' }] }, 'names[0]'],
  ];
  for (const [name, data, field] of cases) {
    test(`${name} is rejected`, async ({ request }) => {
      const res = await request.post(url, { headers, data });
      if (res.ok()) for (const c of (await res.json()).list ?? []) toDelete.add(c.id);
      expect(res.status(), await res.text()).toBe(400);
      expect((await res.json()).error.details.map((d: { field: string }) => d.field)).toContain(field);
    });
  }

  test('names as a single object instead of a list is rejected', async ({ request }) => {
    const res = await request.post(url, { headers, data: { names: qaNames('obj') } });
    if (res.ok()) for (const c of (await res.json()).list ?? []) toDelete.add(c.id);
    expect(res.status()).toBe(400);
  });

  test('unknown category returns 404 on view and edit', async ({ request }) => {
    const unknown = `${url}/00000000-0000-0000-0000-000000000000`;
    expect((await request.get(unknown, { headers })).status()).toBe(404);
    expect((await request.patch(unknown, { headers, data: { is_active: false } })).status()).toBe(404);
  });

  test('deleting an already deleted category returns 404', async ({ request }) => {
    test.fail(true, 'Known: second delete returns 200');
    const res = await create(request, [qaNames('twice')]);
    const id = ((await res.json()).list as Category[])[0].id;
    expect((await request.delete(`${url}/${id}`, { headers })).status()).toBe(200);
    toDelete.delete(id);
    expect((await request.delete(`${url}/${id}`, { headers })).status()).toBe(404);
  });
});

test.describe('Categories — access', () => {
  test('list, create, edit and delete without token are rejected', async ({ request }) => {
    const id = '00000000-0000-0000-0000-000000000000';
    expect((await request.get(url)).status()).toBe(401);
    expect((await request.post(url, { data: { names: [qaNames('no-token')] } })).status()).toBe(401);
    expect((await request.patch(`${url}/${id}`, { data: { is_active: false } })).status()).toBe(401);
    expect((await request.delete(`${url}/${id}`)).status()).toBe(401);
  });
});

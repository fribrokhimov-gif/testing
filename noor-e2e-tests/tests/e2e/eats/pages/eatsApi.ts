import { APIRequestContext } from '@playwright/test';
import { merchantHeaders, urls } from '../../../../api/eatsModeration';

// API side of the Eats E2E tests: setup checks and cleanup only, the flows themselves go through the panel.
// The e2e projects don't send X-Platform, so it is added here.
export async function apiHeaders(request: APIRequestContext) {
  return { ...(await merchantHeaders(request)), 'X-Platform': 'web', Accept: 'application/json' };
}

/** Names are unique per language, so every language gets the stamp. Prefix "QA-autotest e2e" marks E2E data. */
export const e2eNames = (tag: string) => {
  const n = `QA-autotest e2e ${tag} ${Date.now()}`;
  return { ru: n, uz: `${n} uz`, en: `${n} en` };
};

/** Deletes every "QA-autotest e2e" category this account has, withdrawing pending change requests first. */
export async function removeE2eCategories(request: APIRequestContext) {
  const h = await apiHeaders(request);
  const list = ((await (await request.get(urls.categories, { headers: h })).json()).list ?? []) as { id: string; name: string }[];
  const mine = list.filter((c) => c.name.startsWith('QA-autotest e2e'));
  const pending = ((await (await request.get(urls.changeRequests, { headers: h })).json()).list ?? []) as { id: string; entity_id: string; status: string }[];
  for (const c of mine) {
    for (const cr of pending.filter((x) => x.entity_id === c.id && x.status === 'pending')) {
      await request.post(`${urls.changeRequests}/${cr.id}/cancel`, { headers: h, data: {} });
    }
    await request.delete(`${urls.categories}/${c.id}`, { headers: h });
  }
}

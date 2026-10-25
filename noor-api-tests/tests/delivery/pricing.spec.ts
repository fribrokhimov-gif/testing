import { test, expect } from '@playwright/test';
import { getTokens, bearer, env } from '../../api/auth';

// Merchant tariff: GET vendors/pricing
// Prices are in sum, distances in metres, free_wait_time in minutes
const url = `${env.deliveryUrl}/vendors/pricing`;

type Pricing = {
  base_rate: {
    courier_call: number;
    door_to_door: number;
    payment_per_km: number;
    fixed_price: number;
    dynamic_pricings: { distance: number; price: number }[] | null;
    new_point: number;
    cancelled_paid_price: number;
  };
  wait_time: { free_wait_time: number; price_per_minute_after: number };
  time_frame_coefficient: number;
  discount: number | null;
  discount_valid_from: string | null;
  discount_valid_till: string | null;
  calculate_discount_for_courier: boolean;
  tariff: unknown;
};

// Access tokens live 60s, so each test logs in fresh
let headers: Record<string, string>;
test.beforeEach(async ({ request }) => {
  headers = bearer((await getTokens(request)).access_token);
});

async function getPricing(request: any): Promise<Pricing> {
  const res = await request.get(url, { headers });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

test.describe('Pricing — vendors/pricing', () => {
  test('returns the tariff with all sections', async ({ request }) => {
    const p = await getPricing(request);
    expect(p).toMatchObject({
      base_rate: {
        courier_call: expect.any(Number),
        door_to_door: expect.any(Number),
        payment_per_km: expect.any(Number),
        fixed_price: expect.any(Number),
        new_point: expect.any(Number),
        cancelled_paid_price: expect.any(Number),
      },
      wait_time: { free_wait_time: expect.any(Number), price_per_minute_after: expect.any(Number) },
      time_frame_coefficient: expect.any(Number),
      calculate_discount_for_courier: expect.any(Boolean),
    });
    for (const k of ['discount', 'discount_valid_from', 'discount_valid_till', 'tariff'] as const) {
      expect(p, k).toHaveProperty(k);
    }
  });

  test('prices are not negative', async ({ request }) => {
    const { base_rate, wait_time, time_frame_coefficient } = await getPricing(request);
    const values: Record<string, number> = {
      ...Object.fromEntries(Object.entries(base_rate).filter(([, v]) => typeof v === 'number')),
      free_wait_time: wait_time.free_wait_time,
      price_per_minute_after: wait_time.price_per_minute_after,
      time_frame_coefficient,
    };
    for (const [k, v] of Object.entries(values)) expect(v, k).toBeGreaterThanOrEqual(0);
  });

  test('distance tiers are sorted by distance with no duplicates', async ({ request }) => {
    const tiers = (await getPricing(request)).base_rate.dynamic_pricings ?? [];
    test.skip(!tiers.length, 'No distance tiers on this tariff');

    for (const t of tiers) {
      expect(t.distance, JSON.stringify(t)).toBeGreaterThan(0);
      expect(t.price, JSON.stringify(t)).toBeGreaterThanOrEqual(0);
    }
    const distances = tiers.map((t) => t.distance);
    expect(distances).toEqual([...distances].sort((a, b) => a - b));
    expect(new Set(distances).size).toBe(distances.length);
  });

  test('discount dates are set only together with a discount', async ({ request }) => {
    const p = await getPricing(request);
    if (p.discount == null) {
      expect(p.discount_valid_from).toBeNull();
      expect(p.discount_valid_till).toBeNull();
    } else {
      expect(p.discount).toBeGreaterThan(0);
      expect(p.discount).toBeLessThanOrEqual(100);
      if (p.discount_valid_from && p.discount_valid_till) {
        expect(new Date(p.discount_valid_from) <= new Date(p.discount_valid_till)).toBe(true);
      }
    }
  });

  test('request without token is rejected', async ({ request }) => {
    const res = await request.get(url);
    expect(res.status()).toBe(401);
  });

  test('request with invalid token is rejected', async ({ request }) => {
    const res = await request.get(url, { headers: bearer('abc.def.ghi') });
    expect(res.status()).toBe(401);
  });
});

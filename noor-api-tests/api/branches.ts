import { APIRequestContext, APIResponse } from '@playwright/test';
import { env, bearer } from './auth';

// Branch addresses — legacy vendors/locations API
export const branchesUrl = `${env.deliveryUrl}/vendors/locations`;
export const validateUrl = `${env.deliveryUrl}/gis/locations/validate`;

export type Point = { lat: number; long: number };
export type Branch = {
  id: number;
  name: string | null;
  address: string | null;
  location: Point;
  floor: number | null;
  client_phone: string | null;
  is_business: boolean;
};

export const TASHKENT: Point = { lat: 41.311, long: 69.279 };
export const LONDON: Point = { lat: 51.5, long: -0.12 };

/** Body as the panel sends it: one address string copied into ru/en/uz, empty fields as null. */
export function branchBody(name: string, address: string, overrides: Record<string, unknown> = {}) {
  return {
    location: TASHKENT,
    address: { ru: address, en: address, uz: address },
    name,
    shop_id: null,
    external_id: null,
    floor: 3,
    apartment: null,
    entrance: null,
    door_phone: null,
    comment: null,
    client_phone: '+998901234567',
    client_name: null,
    is_business: true,
    ...overrides,
  };
}

/** GET vendors/locations — returns [] when the API answers `null` (no matches). */
export async function listBranches(request: APIRequestContext, token: string, search?: string): Promise<Branch[]> {
  const res = await request.get(branchesUrl, {
    headers: bearer(token),
    params: { is_business: true, ...(search ? { search } : {}) },
  });
  if (!res.ok()) throw new Error(`List branches failed: ${res.status()} ${await res.text()}`);
  return ((await res.json()) as Branch[] | null) ?? [];
}

export function createBranch(request: APIRequestContext, token: string, body: object): Promise<APIResponse> {
  return request.post(branchesUrl, { headers: bearer(token), data: body });
}

export function updateBranch(request: APIRequestContext, token: string, id: number, body: object): Promise<APIResponse> {
  return request.patch(`${branchesUrl}/${id}`, { headers: bearer(token), data: body });
}

export function deleteBranch(request: APIRequestContext, token: string, id: number): Promise<APIResponse> {
  return request.delete(`${branchesUrl}/${id}`, { headers: bearer(token) });
}

export function validatePoint(request: APIRequestContext, token: string, body: object): Promise<APIResponse> {
  return request.post(validateUrl, { headers: bearer(token), data: body });
}

import type { Place } from "./places";

export type Group = {
  id: string;
  name: string;
  isWishlist?: boolean;
  places: Place[];
  placeIds?: string[];
  createdAt?: string;
  updatedAt?: string;
};

export class GroupsApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "GroupsApiError";
  }
}

async function parseResponse<T>(response: Response): Promise<T> {
  if (response.ok) {
    const body = await response.text();
    return (body ? JSON.parse(body) : undefined) as T;
  }
  let message = "Groups are unavailable right now. Please try again.";
  try { message = (await response.json() as { detail?: string }).detail ?? message; } catch { /* friendly fallback */ }
  throw new GroupsApiError(message, response.status);
}

function rawPlaces(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value;
}

function normalizeGroup(value: unknown): Group {
  const source = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const places = rawPlaces(source.places).filter((place): place is Place => Boolean(place && typeof place === "object" && typeof (place as Record<string, unknown>).id === "string")) as Place[];
  const rawPlaceIds = source.placeIds ?? source.place_ids;
  const placeIds = Array.isArray(rawPlaceIds) ? rawPlaceIds.filter((id): id is string => typeof id === "string") : places.map((place) => place.id);
  return {
    id: String(source.id ?? ""),
    name: String(source.name ?? "Untitled group"),
    isWishlist: source.isWishlist === true || source.is_wishlist === true || source.id === "wishlist" || source.kind === "wishlist",
    places,
    placeIds,
    ...(typeof source.createdAt === "string" ? { createdAt: source.createdAt } : {}),
    ...(typeof source.updatedAt === "string" ? { updatedAt: source.updatedAt } : {}),
  };
}

export function normalizeGroups(value: unknown): Group[] {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>).groups
    : value;
  return rawPlaces(source).map(normalizeGroup).filter((group) => group.id);
}

export type AuthenticatedRequest = (path: string, init?: RequestInit) => Promise<Response>;

export async function listGroups(request: AuthenticatedRequest): Promise<Group[]> {
  return normalizeGroups(await parseResponse<unknown>(await request("/api/groups", { cache: "no-store" })));
}

export async function createGroup(request: AuthenticatedRequest, name: string, placeIds: string[]): Promise<Group> {
  return normalizeGroup(await parseResponse<unknown>(await request("/api/groups", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, placeIds: [...new Set(placeIds)] }),
  })));
}

export async function updateGroup(request: AuthenticatedRequest, id: string, name: string): Promise<Group> {
  return normalizeGroup(await parseResponse<unknown>(await request(`/api/groups/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  })));
}

export async function deleteGroup(request: AuthenticatedRequest, id: string): Promise<void> {
  await parseResponse<void>(await request(`/api/groups/${encodeURIComponent(id)}`, { method: "DELETE" }));
}

export async function addGroupPlace(request: AuthenticatedRequest, groupId: string, placeId: string): Promise<Group> {
  return normalizeGroup(await parseResponse<unknown>(await request(`/api/groups/${encodeURIComponent(groupId)}/places`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ placeIds: [placeId] }) })));
}

export async function removeGroupPlace(request: AuthenticatedRequest, groupId: string, placeId: string): Promise<Group> {
  return normalizeGroup(await parseResponse<unknown>(await request(`/api/groups/${encodeURIComponent(groupId)}/places`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ placeIds: [placeId] }) })));
}

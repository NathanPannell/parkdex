import { describe, expect, it, vi } from "vitest";

import {
  createPlaceDataCache,
  createPlaceGateway,
  stablePlacePriorityKey,
  type PlaceDataItem,
} from "./place-data-gateway";
import type { KeyValueStore } from "./platform-storage";

class MemoryStore implements KeyValueStore {
  readonly values = new Map<string, string>();
  async getItem(key: string) { return this.values.get(key) ?? null; }
  async setItem(key: string, value: string) { this.values.set(key, value); }
  async removeItem(key: string) { this.values.delete(key); }
}

function place(id: string, options: Partial<PlaceDataItem> = {}): PlaceDataItem {
  const category = options.category ?? "regional";
  return {
    id,
    name: options.name ?? id,
    category,
    latitude: options.latitude ?? 49,
    longitude: options.longitude ?? -123,
    region: options.region ?? "Coast",
    description: options.description ?? "",
    sourceUrl: options.sourceUrl ?? "",
    sourceName: options.sourceName ?? "Parkdex",
    visited: options.visited ?? false,
    priorityTier: options.priorityTier ?? (category === "national" ? 0 : category === "island" ? 1 : 2),
    priorityKey: options.priorityKey ?? stablePlacePriorityKey(id),
    ...(options.authority !== undefined ? { authority: options.authority } : {}),
    ...(options.listRegion !== undefined ? { listRegion: options.listRegion } : {}),
    ...(options.sourceId !== undefined ? { sourceId: options.sourceId } : {}),
    ...(options.distanceKm !== undefined ? { distanceKm: options.distanceKm } : {}),
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => payload } as Response;
}

describe("place data cache", () => {
  it("keeps at most 100 records and protects recently interacted and visited places", async () => {
    const store = new MemoryStore();
    let now = 0;
    const cache = createPlaceDataCache({ identityKey: "account:first", store, limit: 3, now: () => ++now, legacyStorageKey: null });

    await cache.remember(place("old"));
    await cache.remember(place("clicked"), "interaction");
    await cache.remember(place("visited", { visited: true }));
    await cache.remember(place("new"));

    const cached = await cache.list();
    expect(cached.map(({ id }) => id)).toContain("clicked");
    expect(cached.map(({ id }) => id)).toContain("visited");
    expect(cached.map(({ id }) => id)).toContain("new");
    expect(cached.map(({ id }) => id)).not.toContain("old");

    for (let index = 0; index < 130; index += 1) await cache.remember(place(`row-${index}`));
    expect(await cache.list()).toHaveLength(3);
  });

  it("keeps each identity's place cache in a separate storage namespace", async () => {
    const store = new MemoryStore();
    const guest = createPlaceDataCache({ identityKey: "guest:abc", store, legacyStorageKey: null });
    const account = createPlaceDataCache({ identityKey: "account:123", store, legacyStorageKey: null });

    await guest.remember(place("guest-place"));
    await account.remember(place("account-place"));

    expect((await guest.list()).map(({ id }) => id)).toEqual(["guest-place"]);
    expect((await account.list()).map(({ id }) => id)).toEqual(["account-place"]);
  });

  it("best-effort imports the compact legacy place index into its bounded cache", async () => {
    const store = new MemoryStore();
    store.values.set("every-park:places:v1", JSON.stringify([
      { ...place("provincial", { category: "provincial" }), protection: 0 },
      { ...place("national", { category: "national" }), protection: 0 },
      { ...place("visited", { visited: true }), protection: 2 },
    ]));
    const cache = createPlaceDataCache({ identityKey: "guest:abc", store, limit: 2, now: () => 100 });

    expect((await cache.list()).map(({ id }) => id)).toEqual(["visited", "national"]);
  });
});

describe("place data gateway", () => {
  it("sends repeated category and visit filters to the map endpoint", async () => {
    const store = new MemoryStore();
    const fetcher = vi.fn(async (...args: Parameters<typeof fetch>) => {
      void args;
      return jsonResponse({ places: [place("n1", { category: "national" })], total: 8, limit: 50 });
    });
    const gateway = createPlaceGateway({ apiBaseUrl: "https://api.example.test", identityKey: "guest:k", store, fetcher, legacyStorageKey: null });

    const result = await gateway.fetchMap({
      viewport: { west: -128, south: 48, east: -122, north: 54 },
      categories: ["national", "island"],
      authorities: ["BC Parks", "Parks Canada"],
      query: "coast",
      groupId: "collection-123",
      visited: "unseen",
      limit: 50,
      selectedPlaceId: "n1",
    });

    const requested = new URL(String(fetcher.mock.calls[0][0]));
    expect(requested.pathname).toBe("/api/map/places");
    expect(requested.searchParams.getAll("category")).toEqual(["island", "national"]);
    expect(requested.searchParams.getAll("authority")).toEqual(["BC Parks", "Parks Canada"]);
    expect(requested.searchParams.get("query")).toBe("coast");
    expect(requested.searchParams.get("group_id")).toBe("collection-123");
    expect(requested.searchParams.get("visited")).toBe("unseen");
    expect(requested.searchParams.get("selected_id")).toBe("n1");
    expect(result).toMatchObject({ total: 8, scope: "full", partial: true, limit: 50 });
  });

  it("uses only cached rows offline, filters antimeridian bounds, and keeps the selected place", async () => {
    const store = new MemoryStore();
    const cache = createPlaceDataCache({ identityKey: "account:first", store, legacyStorageKey: null });
    await cache.remember([
      place("national", { category: "national", longitude: 179, priorityKey: "00" }),
      place("island", { category: "island", longitude: -179, priorityTier: 1, priorityKey: "01" }),
      place("regional-first", { longitude: 178, priorityKey: "10" }),
      place("regional-selected", { longitude: -178, priorityKey: "ff" }),
      place("outside", { category: "island", longitude: -150, priorityTier: 1, priorityKey: "00" }),
    ]);
    const fetcher = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
    const gateway = createPlaceGateway({ apiBaseUrl: "https://api.example.test", identityKey: "account:first", store, fetcher, legacyStorageKey: null });

    const result = await gateway.fetchMap({
      viewport: { west: 170, south: 45, east: -170, north: 55 },
      categories: ["national", "island", "regional"],
      visited: "visited",
      visitedPlaceIds: new Set(["national", "island", "regional-first", "regional-selected"]),
      groupId: "offline-group",
      groupPlaceIds: new Set(["national", "regional-selected"]),
      selectedPlaceId: "regional-selected",
      limit: 3,
    });

    expect(result.scope).toBe("cached");
    expect(result.partial).toBe(true);
    expect(result.total).toBe(2);
    expect(result.places.map(({ id }) => id)).toContain("regional-selected");
    expect(result.places.map(({ id }) => id)).not.toContain("island");
    expect(result.places.map(({ id }) => id)).not.toContain("outside");
    expect(gateway.getOfflineStatus().offline).toBe(true);
    expect(gateway.getOfflineStatus().message).toContain("saved places only");
  });

  it("filters and paginates cached search and visited results", async () => {
    const store = new MemoryStore();
    const gateway = createPlaceGateway({
      apiBaseUrl: "https://api.example.test",
      identityKey: "guest:k",
      store,
      fetcher: vi.fn(async () => { throw new TypeError("Failed to fetch"); }),
      legacyStorageKey: null,
    });
    await gateway.remember(place("goldstream", { name: "Goldstream Park", visited: true, authority: "BC Parks", listRegion: "Vancouver Island" }), "visited");
    await gateway.remember(place("garry", { name: "Garry Oak", category: "provincial" }));
    await gateway.remember(place("regional", { name: "Regional Park", visited: true }), "visited");

    const search = await gateway.fetchSearch({ query: "park", authorities: ["BC Parks"], visited: "visited", visitedPlaceIds: new Set(["goldstream", "regional"]), limit: 1, offset: 0 });
    const visited = await gateway.fetchVisited({ visitedPlaceIds: new Set(["regional"]), limit: 10 });

    expect(search.places.map(({ id }) => id)).toEqual(["goldstream"]);
    expect(search).toMatchObject({ total: 1, scope: "cached", partial: true, offset: 0 });
    expect(visited.places.map(({ id }) => id)).toEqual(["regional"]);
    expect(search.places[0]?.listRegion).toBe("Vancouver Island");
  });

  it("keeps offline status until a successful retry request", async () => {
    const store = new MemoryStore();
    const fetcher = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(jsonResponse({ places: [place("online")], total: 1, limit: 50 }));
    const gateway = createPlaceGateway({ apiBaseUrl: "https://api.example.test", identityKey: "guest:k", store, fetcher, legacyStorageKey: null });
    const observed: boolean[] = [];
    gateway.subscribeOfflineStatus((status) => observed.push(status.offline));

    await gateway.fetchMap({ viewport: { west: -128, south: 48, east: -122, north: 54 } });
    expect(gateway.getOfflineStatus().offline).toBe(true);

    const retried = await gateway.retryMap({ viewport: { west: -128, south: 48, east: -122, north: 54 } });
    expect(retried.scope).toBe("full");
    expect(gateway.getOfflineStatus()).toEqual({ offline: false, message: null });
    expect(observed).toEqual([false, true, false]);
  });

  it("serves cache without ordinary network retries after a 5xx until retryMap is called", async () => {
    const store = new MemoryStore();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({}, 503))
      .mockResolvedValueOnce(jsonResponse({ places: [place("recovered", { visited: true })], total: 1, limit: 50 }));
    const gateway = createPlaceGateway({
      apiBaseUrl: "https://api.example.test",
      identityKey: "account:first",
      store,
      fetcher,
      isOnline: () => true,
      legacyStorageKey: null,
    });
    await gateway.remember(place("saved", { visited: true }), "visited");
    const viewport = { west: -128, south: 48, east: -122, north: 54 };

    const initial = await gateway.fetchMap({ viewport });
    const search = await gateway.fetchSearch({ query: "saved" });
    const visited = await gateway.fetchVisited({ visitedPlaceIds: new Set(["saved"]) });
    const stillCached = await gateway.fetchMap({ viewport });

    expect(initial.scope).toBe("cached");
    expect(search.scope).toBe("cached");
    expect(visited.places.map(({ id }) => id)).toEqual(["saved"]);
    expect(stillCached.scope).toBe("cached");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(gateway.getOfflineStatus().offline).toBe(true);

    const retried = await gateway.retryMap({ viewport });
    expect(retried.scope).toBe("full");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(gateway.getOfflineStatus().offline).toBe(false);
  });

  it("supports explicit online retries for direct visited-list and search loads", async () => {
    const store = new MemoryStore();
    const saved = place("saved", { name: "Saved Park", visited: true });
    const fetcher = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(jsonResponse({}, 503))
      .mockResolvedValueOnce(jsonResponse({ places: [saved], total: 1, limit: 25, offset: 0 }))
      .mockResolvedValueOnce(jsonResponse({}, 503))
      .mockResolvedValueOnce(jsonResponse({ places: [saved], total: 1, limit: 25, offset: 0 }));
    const gateway = createPlaceGateway({
      apiBaseUrl: "https://api.example.test",
      identityKey: "guest:direct-list",
      store,
      fetcher,
      isOnline: () => true,
      legacyStorageKey: null,
    });
    await gateway.remember(saved, "visited");

    const visitedFallback = await gateway.fetchVisited({ visitedPlaceIds: new Set(["saved"]) });
    expect(visitedFallback.scope).toBe("cached");
    expect(gateway.getOfflineStatus().offline).toBe(true);
    const visitedRetry = await gateway.retryVisited({ visitedPlaceIds: new Set(["saved"]) });
    expect(visitedRetry.scope).toBe("full");
    expect(gateway.getOfflineStatus().offline).toBe(false);

    const searchFallback = await gateway.fetchSearch({ query: "saved" });
    expect(searchFallback.scope).toBe("cached");
    expect(gateway.getOfflineStatus().offline).toBe(true);
    const searchRetry = await gateway.retrySearch({ query: "saved" });
    expect(searchRetry.scope).toBe("full");
    expect(gateway.getOfflineStatus().offline).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(new URL(String(fetcher.mock.calls[1][0])).pathname).toBe("/api/catalogue/visited");
    expect(new URL(String(fetcher.mock.calls[3][0])).pathname).toBe("/api/places/search");
  });
});

import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";

import type { BoundaryFeature } from "./boundaries";
import {
  createIndexedDbRecentPlaceStore,
  createRecentPlaceCache,
  RECENT_PLACE_CACHE_LIMIT,
  RECENT_PLACE_PHOTO_TIMEOUT_MS,
  type CachedPlaceBundle,
  type RecentPlaceCacheRecord,
} from "./place-cache";
import type { Place } from "./places";

function place(id: string): Place {
  return {
    id,
    name: `Place ${id}`,
    category: "regional",
    latitude: 49,
    longitude: -124,
    region: "Coast",
    description: "A public place description.",
    sourceUrl: "https://example.test/place",
    sourceName: "Example source",
    sourceId: id,
  };
}

function boundary(id: string): BoundaryFeature {
  return {
    type: "Feature",
    properties: {
      id,
      name: `Boundary ${id}`,
      category: "regional",
      sourceName: "Boundary source",
      sourceUrl: "https://example.test/boundary",
      sourceId: `boundary-${id}`,
    },
    geometry: {
      type: "Polygon",
      coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
    },
  };
}

function record(id: string, viewedAt: number): RecentPlaceCacheRecord {
  const park = place(id);
  const photo = new Blob([`full photo ${id}`], { type: "image/webp" });
  const bundle: CachedPlaceBundle = {
    place: park,
    boundary: boundary(id),
    boundaryVersion: "canonical-1",
    visitorInformation: null,
    image: null,
    descriptionSource: null,
    area: "Approx. 1 km²",
    sourceAttribution: {
      place: { name: park.sourceName, url: park.sourceUrl, ...(park.sourceId ? { id: park.sourceId } : {}) },
      boundary: { name: "Boundary source", url: "https://example.test/boundary", id: `boundary-${id}` },
      photo: null,
    },
    photo,
    photoError: null,
    viewedAt,
  };
  return { placeId: id, viewedAt, bundle };
}

function apiFetcher({
  failPhoto = false,
  deferPlace,
}: { failPhoto?: boolean; deferPlace?: (placeId: string) => Promise<Response> } = {}): typeof fetch {
  return async (input) => {
    const url = String(input);
    const match = url.match(/\/api\/places\/([^/]+)\/offline-bundle$/);
    if (match) {
      const id = decodeURIComponent(match[1]);
      if (deferPlace) return deferPlace(id);
      return new Response(JSON.stringify({ place: place(id), boundary: boundary(id), boundaryVersion: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (failPhoto) return new Response("unavailable", { status: 503 });
    return new Response(new Blob(["full-resolution-photo"], { type: "image/webp" }), {
      status: 200,
      headers: { "content-type": "image/webp" },
    });
  };
}

describe("recent place cache", () => {
  it("keeps a strict durable 20-place LRU and removes the evicted photo and geometry", async () => {
    const store = createIndexedDbRecentPlaceStore(new IDBFactory());
    for (let index = 0; index < RECENT_PLACE_CACHE_LIMIT + 1; index += 1) {
      await store.saveAndPrune(record(`place-${index}`, index + 1));
    }

    const saved = await store.list();
    expect(saved).toHaveLength(RECENT_PLACE_CACHE_LIMIT);
    expect(saved.map((entry) => entry.placeId)).toEqual(Array.from({ length: 20 }, (_, index) => `place-${20 - index}`));
    expect(await store.get("place-0")).toBeNull();
    expect((await store.get("place-20"))?.bundle.photo?.size).toBeGreaterThan(0);
    expect((await store.get("place-20"))?.bundle.boundary?.geometry.type).toBe("Polygon");
  });

  it("does not let an old in-flight completion resurrect a park that has fallen outside the 20 most recent views", async () => {
    let releaseOld!: (response: Response) => void;
    const startedOld = vi.fn();
    const fetcher = apiFetcher({ deferPlace: (id) => id === "old-place"
      ? new Promise<Response>((resolve) => { releaseOld = resolve; startedOld(); })
      : Promise.resolve(new Response(JSON.stringify({ place: place(id), boundary: boundary(id), boundaryVersion: 1 }), { status: 200 })) });
    const cache = createRecentPlaceCache({ indexedDB: new IDBFactory(), fetcher });
    const pendingOld = cache.view("old-place", "https://api.example.test");
    await vi.waitFor(() => expect(startedOld).toHaveBeenCalledOnce());

    for (let index = 0; index < RECENT_PLACE_CACHE_LIMIT; index += 1) {
      await cache.view(`new-place-${index}`, "https://api.example.test");
    }
    releaseOld(new Response(JSON.stringify({ place: place("old-place"), boundary: boundary("old-place"), boundaryVersion: 1 }), { status: 200 }));
    await pendingOld;

    expect(await cache.get("old-place")).toBeNull();
    expect(await cache.list()).toHaveLength(RECENT_PLACE_CACHE_LIMIT);
  });

  it("stores place, full photo, boundary, detail metadata, and attribution as one complete result", async () => {
    const fetcher = vi.fn(apiFetcher());
    const cache = createRecentPlaceCache({
      indexedDB: new IDBFactory(),
      fetcher,
      assetUrl: (src) => `https://assets.example.test${src}`,
    });
    const result = await cache.view("provincial-goldstream-park", "https://api.example.test/");

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[0][0])).toBe("https://api.example.test/api/places/provincial-goldstream-park/offline-bundle");
    expect(String(fetcher.mock.calls[1][0])).toContain("https://assets.example.test/");
    expect(result.place.id).toBe("provincial-goldstream-park");
    expect(result.boundary?.properties.sourceName).toBe("Boundary source");
    expect(result.boundaryVersion).toBe(1);
    expect(result.photo?.type).toBe("image/webp");
    expect(await result.photo?.text()).toBe("full-resolution-photo");
    expect(result.image?.creator).toBe("Mike");
    expect(result.sourceAttribution.photo?.license).toBe(result.image?.license);
    expect(result.area).toBeTruthy();
    expect((await cache.get(result.place.id))?.viewedAt).toBe(result.viewedAt);
  });

  it("updates LRU recency as soon as a cached place is actually opened", async () => {
    const store = createIndexedDbRecentPlaceStore(new IDBFactory());
    const initial = createRecentPlaceCache({ storage: store, fetcher: apiFetcher() });
    const saved = await initial.view("place-opened", "https://api.example.test");
    let release!: (response: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>((resolve) => { release = resolve; }));
    const refreshing = createRecentPlaceCache({ storage: store, fetcher });

    const pending = refreshing.view("place-opened", "https://api.example.test");
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    const touched = await refreshing.get("place-opened");

    expect(touched?.viewedAt).toBeGreaterThan(saved.viewedAt);
    release(new Response(JSON.stringify({
      place: place("place-opened"),
      boundary: boundary("place-opened"),
      boundaryVersion: "v2",
    }), { status: 200 }));
    await pending;
  });

  it("hydrates a bounded metadata-only claims index once and drops evicted geometry", async () => {
    const durable = createIndexedDbRecentPlaceStore(new IDBFactory());
    const storage = {
      ...durable,
      listMetadata: vi.fn(() => durable.listMetadata()),
    };
    const cache = createRecentPlaceCache({ storage, fetcher: apiFetcher() });
    await cache.view("first", "https://api.example.test");
    const claimsIndex = await cache.listForClaims();
    expect(claimsIndex).toHaveLength(1);
    expect(claimsIndex[0]).toMatchObject({
      placeId: "first",
      place: { id: "first" },
      boundary: { properties: { id: "first" } },
    });
    expect("photo" in claimsIndex[0]).toBe(false);
    await cache.listForClaims();
    expect(storage.listMetadata).toHaveBeenCalledOnce();

    const restarted = createRecentPlaceCache({ storage, fetcher: apiFetcher() });
    expect((await restarted.listForClaims()).map((entry) => entry.placeId)).toEqual(["first"]);
    expect(storage.listMetadata).toHaveBeenCalledTimes(2);
    await restarted.clear();
    expect(await restarted.listForClaims()).toEqual([]);
  });

  it("uses a complete cached bundle when offline and keeps detail plus boundary if the optional photo cannot be cached", async () => {
    const store = createIndexedDbRecentPlaceStore(new IDBFactory());
    const online = createRecentPlaceCache({ storage: store, fetcher: apiFetcher() });
    const saved = await online.view("provincial-goldstream-park", "https://api.example.test");
    const offline = createRecentPlaceCache({ storage: store, fetcher: async () => { throw new TypeError("offline"); } });

    await expect(offline.view(saved.place.id, "https://api.example.test")).resolves.toMatchObject({
      place: { id: saved.place.id },
      boundary: { properties: { id: saved.place.id } },
      photo: expect.any(Blob),
    });

    const partialPhoto = createRecentPlaceCache({
      indexedDB: new IDBFactory(),
      fetcher: apiFetcher({ failPhoto: true }),
    });
    const result = await partialPhoto.view("provincial-goldstream-park", "https://api.example.test");
    expect(result.photo).toBeNull();
    expect(result.photoError).toContain("503");
    expect((await partialPhoto.get("provincial-goldstream-park"))?.boundary?.properties.id).toBe("provincial-goldstream-park");
  });

  it("persists details and precise geometry when the optional photo fetch hangs", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let markPhotoStarted!: () => void;
      const photoStarted = new Promise<void>((resolve) => { markPhotoStarted = resolve; });
      const photoSignal: { value: AbortSignal | undefined } = { value: undefined };
      const fetcher: typeof fetch = async (input, init) => {
        if (String(input).endsWith("/offline-bundle")) {
          return new Response(JSON.stringify({
            place: place("provincial-goldstream-park"),
            boundary: boundary("provincial-goldstream-park"),
            boundaryVersion: "canonical-v2",
          }), { status: 200, headers: { "content-type": "application/json" } });
        }
        photoSignal.value = init?.signal as AbortSignal;
        markPhotoStarted();
        return new Promise<Response>(() => undefined);
      };
      const cache = createRecentPlaceCache({
        indexedDB: new IDBFactory(),
        fetcher,
        assetUrl: (src) => `https://assets.example.test${src}`,
      });

      const pending = cache.view("provincial-goldstream-park", "https://api.example.test");
      await photoStarted;
      expect(photoSignal.value?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(RECENT_PLACE_PHOTO_TIMEOUT_MS);
      const result = await pending;
      const saved = await cache.get("provincial-goldstream-park");

      expect(photoSignal.value?.aborted).toBe(true);
      expect(result.photo).toBeNull();
      expect(result.photoError).toContain("timed out");
      expect(saved?.place.id).toBe("provincial-goldstream-park");
      expect(saved?.boundary?.properties.id).toBe("provincial-goldstream-park");
      expect(saved?.boundaryVersion).toBe("canonical-v2");
    } finally {
      vi.useRealTimers();
    }
  });

  it("includes a stalled response blob read inside the optional photo deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let markPhotoStarted!: () => void;
      const photoStarted = new Promise<void>((resolve) => { markPhotoStarted = resolve; });
      const fetcher: typeof fetch = async (input) => {
        if (String(input).endsWith("/offline-bundle")) {
          return new Response(JSON.stringify({
            place: place("provincial-goldstream-park"),
            boundary: boundary("provincial-goldstream-park"),
            boundaryVersion: "canonical-v2",
          }), { status: 200, headers: { "content-type": "application/json" } });
        }
        const response = new Response(null, { status: 200, headers: { "content-type": "image/webp" } });
        Object.defineProperty(response, "blob", { value: () => {
          markPhotoStarted();
          return new Promise<Blob>(() => undefined);
        } });
        return response;
      };
      const cache = createRecentPlaceCache({
        indexedDB: new IDBFactory(),
        fetcher,
        assetUrl: (src) => `https://assets.example.test${src}`,
      });

      const pending = cache.view("provincial-goldstream-park", "https://api.example.test");
      await photoStarted;
      await vi.advanceTimersByTimeAsync(RECENT_PLACE_PHOTO_TIMEOUT_MS);
      const result = await pending;

      expect(result.photo).toBeNull();
      expect(result.photoError).toContain("timed out");
      expect((await cache.get("provincial-goldstream-park"))?.boundary?.properties.id).toBe("provincial-goldstream-park");
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains a same-source full photo when an online refresh cannot download it", async () => {
    const store = createIndexedDbRecentPlaceStore(new IDBFactory());
    const first = createRecentPlaceCache({ storage: store, fetcher: apiFetcher() });
    const saved = await first.view("provincial-goldstream-park", "https://api.example.test");
    const refreshed = createRecentPlaceCache({ storage: store, fetcher: apiFetcher({ failPhoto: true }) });

    const result = await refreshed.view(saved.place.id, "https://api.example.test");

    expect(await result.photo?.text()).toBe(await saved.photo?.text());
    expect(result.photo?.type).toBe(saved.photo?.type);
    expect(result.photoError).toBeNull();
    expect(await (await refreshed.get(saved.place.id))?.photo?.text()).toBe(await saved.photo?.text());
  });

  it("prevents a pending fetch from repopulating the cache after clear", async () => {
    let release!: (response: Response) => void;
    const started = vi.fn();
    const cache = createRecentPlaceCache({
      indexedDB: new IDBFactory(),
      fetcher: apiFetcher({ deferPlace: () => new Promise<Response>((resolve) => { release = resolve; started(); }) }),
    });
    const pending = cache.view("pending-place", "https://api.example.test");
    await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());
    await cache.clear();
    release(new Response(JSON.stringify({ place: place("pending-place"), boundary: boundary("pending-place"), boundaryVersion: 1 }), { status: 200 }));
    await pending;
    expect(await cache.get("pending-place")).toBeNull();
  });
});

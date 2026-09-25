import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";

import type { BoundaryFeature } from "./boundaries";
import { getPlaceImages } from "./place-images";
import {
  createIndexedDbRecentPlaceStore,
  createRecentPlaceCache,
  RECENT_PLACE_CACHE_LIMIT,
  RECENT_PLACE_PHOTO_TIMEOUT_MS,
  type CachedPlaceBundle,
  type RecentPlaceCacheRecord,
} from "./place-cache";
import type { Place } from "./places";
import type { PlaceVisitorDetails } from "./visitor-details";

function place(id: string, visitorDetails?: PlaceVisitorDetails | null): Place {
  const value: Place = {
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
  if (visitorDetails !== undefined) value.visitorDetails = visitorDetails;
  return value;
}

function visitorDetails(): PlaceVisitorDetails {
  return {
    schemaVersion: "1.0.0",
    scope: { kind: "park", matchedName: "Example Park", parentName: null, matchMethod: "official title" },
    source: {
      primaryUrl: "https://example.test/park",
      authority: "Example Parks",
      kind: "visitor_page",
      geographicSourceUrl: null,
      retrievedAt: null,
      status: "partial",
    },
    overview: null,
    areaHectares: 84.2,
    activities: [{ name: "Hiking", details: null }],
    facilities: [
      { name: "Picnic tables", details: null, availability: "seasonal" },
      { name: "Water", details: "Bring your own.", availability: null },
    ],
    access: {
      directions: null,
      address: "1 Park Road",
      transportNotes: null,
      entryPoints: [{ name: null, latitude: 49.1, longitude: -124.2 }],
    },
    trails: [{ name: "Creek loop", description: null, lengthKm: null, elevationGainM: 80, difficulty: "Moderate", mapUrl: null }],
    maps: [{ title: null, url: null, kind: null }],
    mapNotes: null,
    rules: { pets: null, cycling: "Stay on marked paths.", campfires: null, other: null },
    accessibility: { summary: null, features: [{ name: "Firm path", details: null }] },
    operations: { hours: null, seasons: "Open year round.", notes: null },
    camping: { summary: null, reservationRequired: false, bookingUrl: null, reservationNotes: null, fees: null },
    contacts: [{ name: null, role: "Visitor information", phone: null, email: null, url: null }],
    background: { history: null, conservation: "Sensitive habitat.", culturalContext: null, wildlife: "Black-tailed deer." },
    officialUpdatesUrl: null,
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

function record(id: string, viewedAt: number, details?: PlaceVisitorDetails): RecentPlaceCacheRecord {
  const park = place(id, details);
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
    galleryPhotos: [],
    viewedAt,
  };
  return { placeId: id, viewedAt, bundle };
}

function apiFetcher(options: {
  failPhoto?: boolean;
  deferPlace?: (placeId: string) => Promise<Response>;
  visitorDetails?: unknown;
} = {}): typeof fetch {
  return async (input) => {
    const url = String(input);
    const match = url.match(/\/api\/places\/([^/]+)\/offline-bundle$/);
    if (match) {
      const id = decodeURIComponent(match[1]);
      if (options.deferPlace) return options.deferPlace(id);
      const placeValue = "visitorDetails" in options
        ? { ...place(id), visitorDetails: options.visitorDetails }
        : place(id);
      return new Response(JSON.stringify({ place: placeValue, boundary: boundary(id), boundaryVersion: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (options.failPhoto) return new Response("unavailable", { status: 503 });
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
      await store.saveAndPrune(record(`place-${index}`, index + 1, index === 20 ? visitorDetails() : undefined));
    }

    const saved = await store.list();
    expect(saved).toHaveLength(RECENT_PLACE_CACHE_LIMIT);
    expect(saved.map((entry) => entry.placeId)).toEqual(Array.from({ length: 20 }, (_, index) => `place-${20 - index}`));
    expect(await store.get("place-0")).toBeNull();
    expect((await store.get("place-20"))?.bundle.photo?.size).toBeGreaterThan(0);
    expect((await store.get("place-20"))?.bundle.boundary?.geometry.type).toBe("Polygon");
    expect((await store.get("place-20"))?.bundle.place.visitorDetails).toEqual(visitorDetails());
    expect("visitorDetails" in (await store.listMetadata())[0].place).toBe(false);
  });

  it("evicts alternate gallery photo bytes with the least-recently viewed place", async () => {
    const store = createIndexedDbRecentPlaceStore(new IDBFactory());
    const images = getPlaceImages("provincial-bear-creek-park");
    const victim = record("provincial-bear-creek-park", 1);
    victim.bundle.image = images[0] ?? null;
    victim.bundle.galleryPhotos = images.slice(1).map((image) => ({
      image,
      photo: new Blob(["alternate full photo"], { type: "image/webp" }),
      photoError: null,
    }));
    await store.saveAndPrune(victim);

    for (let index = 0; index < RECENT_PLACE_CACHE_LIMIT; index += 1) {
      await store.saveAndPrune(record(`new-place-${index}`, index + 2));
    }

    expect(await store.get(victim.placeId)).toBeNull();
    expect(await store.list()).toHaveLength(RECENT_PLACE_CACHE_LIMIT);
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

  it("stores the primary and every approved alternate as full-resolution offline gallery photos", async () => {
    const fetcher = vi.fn(apiFetcher());
    const cache = createRecentPlaceCache({
      indexedDB: new IDBFactory(),
      fetcher,
      assetUrl: (src) => `https://assets.example.test${src}`,
    });
    const result = await cache.view("provincial-bear-creek-park", "https://api.example.test");
    const images = getPlaceImages(result.place.id);

    expect(images).toHaveLength(2);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(result.image?.detail.src).toBe(images[0]?.detail.src);
    expect(result.photo?.type).toBe("image/webp");
    expect(await result.photo?.text()).toBe("full-resolution-photo");
    expect(result.galleryPhotos).toHaveLength(1);
    expect(result.galleryPhotos[0]).toMatchObject({
      image: images[1],
      photoError: null,
    });
    expect(await result.galleryPhotos[0]?.photo?.text()).toBe("full-resolution-photo");
    expect(result.galleryPhotos[0]?.image.creator).toBe("Preeteesh");
    expect((await cache.get(result.place.id))?.galleryPhotos[0]?.image.originalUrl).toBe(images[1]?.originalUrl);
  });

  it("replaces an already-viewed primary-only bundle with newly cached gallery photos", async () => {
    const storage = createIndexedDbRecentPlaceStore(new IDBFactory());
    const placeId = "provincial-bear-creek-park";
    const images = getPlaceImages(placeId);
    const legacy = record(placeId, 1);
    legacy.bundle.image = images[0] ?? null;
    legacy.bundle.photo = new Blob(["previous primary photo"], { type: "image/webp" });
    await storage.saveAndPrune(legacy);

    const online = createRecentPlaceCache({ storage, fetcher: apiFetcher() });
    await online.view(placeId, "https://api.example.test");
    const offline = createRecentPlaceCache({ storage, fetcher: async () => { throw new TypeError("offline"); } });
    const reopened = await offline.view(placeId, "https://api.example.test");

    expect(reopened.galleryPhotos).toHaveLength(1);
    expect(await reopened.galleryPhotos[0]?.photo?.text()).toBe("full-resolution-photo");
    expect(reopened.galleryPhotos[0]?.image.originalUrl).toBe(images[1]?.originalUrl);
  });

  it("preserves public visitor details across persistent reload and an offline reopen", async () => {
    const store = createIndexedDbRecentPlaceStore(new IDBFactory());
    const details = visitorDetails();
    const responseDetails = {
      ...details,
      source: { ...details.source, archiveIds: ["internal-archive-id"], extractionMethod: "api_mapping" },
      reviewFlagIds: ["internal-review-flag"],
    };
    const online = createRecentPlaceCache({ storage: store, fetcher: apiFetcher({ visitorDetails: responseDetails }) });
    const saved = await online.view("metadata-cache-place", "https://api.example.test");
    const reloaded = createRecentPlaceCache({ storage: store, fetcher: async () => { throw new TypeError("offline"); } });

    expect(saved.place.visitorDetails).toEqual(details);
    const offline = await reloaded.view(saved.place.id, "https://api.example.test");

    expect(offline.place.visitorDetails).toEqual(details);
    expect(offline.boundary).toEqual(saved.boundary);
    expect(offline.boundaryVersion).toBe(saved.boundaryVersion);
    expect(offline.place.visitorDetails?.camping.reservationRequired).toBe(false);
    expect(offline.place.visitorDetails?.source.retrievedAt).toBeNull();
    expect(offline.place.visitorDetails?.background.wildlife).toBe("Black-tailed deer.");
  });

  it("drops malformed or unsafe visitor metadata while keeping valid place geometry and version", async () => {
    const details = visitorDetails();
    const unsafe = {
      ...details,
      source: { ...details.source, primaryUrl: "javascript:alert(1)" },
    };
    const cache = createRecentPlaceCache({
      indexedDB: new IDBFactory(),
      fetcher: apiFetcher({ visitorDetails: unsafe }),
    });

    const result = await cache.view("unsafe-metadata-place", "https://api.example.test");

    expect(result.place.id).toBe("unsafe-metadata-place");
    expect(result.place).not.toHaveProperty("visitorDetails");
    expect(result.boundary).toEqual(boundary("unsafe-metadata-place"));
    expect(result.boundaryVersion).toBe(1);
  });

  it("reads old bundles and strips malformed persisted visitor metadata without changing their geometry", async () => {
    const store = createIndexedDbRecentPlaceStore(new IDBFactory());
    const oldBundle = record("old-cache-place", 4);
    await store.saveAndPrune(oldBundle);
    expect((await store.get("old-cache-place"))?.bundle.place).not.toHaveProperty("visitorDetails");

    const malformedBundle = record("malformed-cache-place", 5);
    malformedBundle.bundle.place.visitorDetails = {
      ...visitorDetails(),
      source: { ...visitorDetails().source, primaryUrl: "javascript:alert(1)" },
    };
    await store.saveAndPrune(malformedBundle);

    const loaded = await store.get("malformed-cache-place");
    expect(loaded?.bundle.place).not.toHaveProperty("visitorDetails");
    expect(loaded?.bundle.boundary).toEqual(malformedBundle.bundle.boundary);
    expect(loaded?.bundle.boundaryVersion).toBe(malformedBundle.bundle.boundaryVersion);
    expect((await store.listMetadata()).map((entry) => entry.placeId)).toEqual(["malformed-cache-place", "old-cache-place"]);
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
    const saved = await first.view("provincial-bear-creek-park", "https://api.example.test");
    const refreshed = createRecentPlaceCache({ storage: store, fetcher: apiFetcher({ failPhoto: true }) });

    const result = await refreshed.view(saved.place.id, "https://api.example.test");

    expect(await result.photo?.text()).toBe(await saved.photo?.text());
    expect(result.photo?.type).toBe(saved.photo?.type);
    expect(result.photoError).toBeNull();
    expect(await (await refreshed.get(saved.place.id))?.photo?.text()).toBe(await saved.photo?.text());
    expect(await result.galleryPhotos[0]?.photo?.text()).toBe(await saved.galleryPhotos[0]?.photo?.text());
    expect(result.galleryPhotos[0]?.photoError).toBeNull();
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

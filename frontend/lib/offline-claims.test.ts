import { afterEach, describe, expect, it, vi } from "vitest";
import type { BoundaryFeature } from "./boundaries";
import type { KeyValueStore } from "./platform-storage";
import type { PhotoRetryStore } from "./photo-retry";
import { createOfflineClaimsService, type OfflineClaimOwner, type RecentPlaceCacheForClaims } from "./offline-claims";

const API = "https://api.example.test";
const OWNER_A: OfflineClaimOwner = { kind: "account", accountId: "account-a", token: "bearer-a" };
const OWNER_B: OfflineClaimOwner = { kind: "account", accountId: "account-b", token: "bearer-b" };

class MemoryStore implements KeyValueStore {
  readonly values = new Map<string, string>();

  async getItem(key: string) { return this.values.get(key) ?? null; }
  async setItem(key: string, value: string) { this.values.set(key, value); }
  async removeItem(key: string) { this.values.delete(key); }
}

const place = (id: string, category: "national" | "provincial" | "regional" | "island" = "regional") => ({
  id,
  name: id,
  category,
  latitude: 49,
  longitude: -125,
  region: "Coast",
  description: "",
  sourceUrl: "https://example.test",
  sourceName: "Test source",
});

function polygon(id: string, outer: number[][], holes: number[][][] = []): BoundaryFeature {
  return {
    type: "Feature",
    properties: { id, name: id, category: "regional", sourceName: "Test source", sourceUrl: "https://example.test", sourceId: null },
    geometry: { type: "Polygon", coordinates: [outer, ...holes] },
  } as BoundaryFeature;
}

const square = (west: number, south: number, east: number, north: number) => [
  [west, south], [east, south], [east, north], [west, north], [west, south],
];

function bundle(id: string, boundary: BoundaryFeature, category: "national" | "provincial" | "regional" | "island" = "regional", version: string | number | null = "v1") {
  return { place: place(id, category), boundary, boundaryVersion: version };
}

function cacheOf(...bundles: ReturnType<typeof bundle>[]): RecentPlaceCacheForClaims {
  const byId = new Map(bundles.map((item) => [item.place.id, item]));
  return {
    async get(id) { return byId.get(id) ?? null; },
    async list() { return [...byId.values()]; },
  };
}

function grant(token = "grant-a", version: string | number = "v1") {
  return { grantToken: token, issuedAt: "2026-09-24T11:00:00.000Z", expiresAt: "2026-09-25T11:00:00.000Z", boundaryVersion: version };
}

function serverConfirmation(placeId: string) {
  return {
    placeId,
    visited: true as const,
    visitedCount: 1,
    visitedAt: "2026-09-24T12:00:00.000Z",
    claim: {
      claimedAt: "2026-09-24T12:00:00.000Z",
      capturedAt: "2026-09-24T11:59:59.000Z",
      coordinates: { latitude: 2, longitude: 2 },
      accuracyMeters: 8,
      boundaryVersion: "v1",
      matchKind: "exact" as const,
      distanceMeters: 0,
      hasPhoto: false,
    },
  };
}

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

const locationAt = (now: number, longitude = 2, latitude = 2) => ({
  latitude,
  longitude,
  accuracyMeters: 8,
  capturedAtEpochMs: now - 1_000,
});

async function prepareOfflineClaim(options: {
  store?: MemoryStore;
  cache?: RecentPlaceCacheForClaims;
  owner?: OfflineClaimOwner;
  now?: () => number;
  uploadPhoto?: (owner: { kind: "account"; token: string }, placeId: string, file: File) => Promise<void>;
  photoRetry?: PhotoRetryStore;
  photoRetryIsDurable?: () => boolean;
  photoExpected?: boolean;
} = {}) {
  const store = options.store ?? new MemoryStore();
  const now = options.now ?? (() => Date.parse("2026-09-24T12:00:00.000Z"));
  const owner = options.owner ?? OWNER_A;
  const service = createOfflineClaimsService({
    apiBaseUrl: API,
    store,
    placeCache: options.cache ?? cacheOf(bundle("park", polygon("park", square(0, 0, 5, 5)))),
    now,
    uploadPhoto: options.uploadPhoto,
    photoRetry: options.photoRetry,
    photoRetryIsDurable: options.photoRetryIsDurable,
  });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(grant())));
  await service.provisionGrant(owner);
  const recommendation = await service.recommendLocal(owner, { location: locationAt(now()) });
  expect(recommendation.status).toBe("recommended");
  if (recommendation.status !== "recommended") throw new Error("Expected a local recommendation.");
  const pending = await service.createLocal(owner, {
    recommendationToken: recommendation.recommendationToken,
    expectedPlaceId: recommendation.candidate.placeId,
    photoExpected: options.photoExpected,
  });
  return { service, store, owner, recommendation, pending };
}

afterEach(() => vi.unstubAllGlobals());

describe("offline claims service", () => {
  it("uses the smallest containing park and rejects locations in holes or outside all boundaries", async () => {
    const now = Date.parse("2026-09-24T12:00:00.000Z");
    const cache = cacheOf(
      bundle("large", polygon("large", square(0, 0, 10, 10)), "national"),
      bundle("small", polygon("small", square(1, 1, 4, 4)), "regional"),
      bundle("island", polygon("island", square(1.5, 1.5, 2.5, 2.5)), "island"),
    );
    const store = new MemoryStore();
    const service = createOfflineClaimsService({ apiBaseUrl: API, store, placeCache: cache, now: () => now });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(grant())));
    await service.provisionGrant(OWNER_A);
    const inside = await service.recommendLocal(OWNER_A, { location: locationAt(now) });
    expect(inside).toMatchObject({ status: "recommended", candidate: { placeId: "small", matchKind: "exact", distanceMeters: 0 } });
    if (inside.status === "recommended") expect(Date.parse(inside.expiresAt)).toBe(locationAt(now).capturedAtEpochMs + 20_000);

    const holeCache = cacheOf(bundle("with-hole", polygon("with-hole", square(0, 0, 5, 5), [square(1, 1, 3, 3)])));
    const holeService = createOfflineClaimsService({ apiBaseUrl: API, store, placeCache: holeCache, now: () => now });
    expect(await holeService.recommendLocal(OWNER_A, { location: locationAt(now, 2, 2) })).toEqual({ status: "none" });
    expect(await service.recommendLocal(OWNER_A, { location: locationAt(now, 20, 20) })).toEqual({ status: "none" });
  });

  it("excludes externally visited and queued places before choosing a local recommendation, including after restart", async () => {
    const now = Date.parse("2026-09-24T12:00:00.000Z");
    const cache = cacheOf(
      bundle("large", polygon("large", square(0, 0, 10, 10)), "national"),
      bundle("small", polygon("small", square(1, 1, 4, 4)), "regional"),
    );
    const store = new MemoryStore();
    const service = createOfflineClaimsService({ apiBaseUrl: API, store, placeCache: cache, now: () => now });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(grant())));
    await service.provisionGrant(OWNER_A);

    const recommendation = await service.recommendLocal(OWNER_A, {
      location: locationAt(now),
      excludedPlaceIds: new Set(["small"]),
    });
    expect(recommendation).toMatchObject({ status: "recommended", candidate: { placeId: "large" } });
    if (recommendation.status !== "recommended") throw new Error("Expected the unvisited larger place to be recommended.");
    await service.createLocal(OWNER_A, { recommendationToken: recommendation.recommendationToken, expectedPlaceId: "large" });

    await expect(service.recommendLocal(OWNER_A, {
      location: locationAt(now),
      excludedPlaceIds: new Set(["small"]),
    })).resolves.toEqual({ status: "none" });

    const restarted = createOfflineClaimsService({ apiBaseUrl: API, store, placeCache: cache, now: () => now });
    await expect(restarted.recommendLocal(OWNER_A, {
      location: locationAt(now),
      excludedPlaceIds: new Set(["small"]),
    })).resolves.toEqual({ status: "none" });
  });

  it("requires a fresh precise fix and a matching cached boundary version", async () => {
    const now = Date.parse("2026-09-24T12:00:00.000Z");
    const store = new MemoryStore();
    const service = createOfflineClaimsService({
      apiBaseUrl: API,
      store,
      placeCache: cacheOf(bundle("park", polygon("park", square(0, 0, 5, 5)), "regional", "old-version")),
      now: () => now,
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(grant("grant-a", "new-version"))));
    await service.provisionGrant(OWNER_A);
    await expect(service.recommendLocal(OWNER_A, { location: { ...locationAt(now), capturedAtEpochMs: now - 20_001 } })).rejects.toThrow("out of date");
    await expect(service.recommendLocal(OWNER_A, { location: { ...locationAt(now), accuracyMeters: 50.01 } })).rejects.toThrow("too broad");
    await expect(service.recommendLocal(OWNER_A, { location: { ...locationAt(now), accuracyMeters: 0 } })).rejects.toThrow("valid precise location");
    expect(await service.recommendLocal(OWNER_A, { location: locationAt(now) })).toEqual({ status: "none" });
  });

  it("uses the newest usable grant after a boundary version refresh and retains an older queued grant", async () => {
    const now = Date.parse("2026-09-24T12:00:00.000Z");
    let boundaryVersion: string = "v1";
    const cachedPlace = () => bundle("park", polygon("park", square(0, 0, 5, 5)), "regional", boundaryVersion);
    const cachedOtherPlace = () => bundle("z-other", polygon("z-other", square(0, 0, 5, 5)), "regional", boundaryVersion);
    const cache: RecentPlaceCacheForClaims = {
      async get(id) { return id === "park" ? cachedPlace() : id === "z-other" ? cachedOtherPlace() : null; },
      async list() { return [cachedPlace(), cachedOtherPlace()]; },
    };
    const store = new MemoryStore();
    const service = createOfflineClaimsService({ apiBaseUrl: API, store, placeCache: cache, now: () => now });
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(response(grant("grant-old", "v1")))
      .mockResolvedValueOnce(response(grant("grant-new", "v2"))));
    await service.provisionGrant(OWNER_A);
    const oldRecommendation = await service.recommendLocal(OWNER_A, { location: locationAt(now) });
    if (oldRecommendation.status !== "recommended") throw new Error("Expected a v1 recommendation.");
    await service.createLocal(OWNER_A, { recommendationToken: oldRecommendation.recommendationToken, expectedPlaceId: "park" });

    boundaryVersion = "v2";
    await service.provisionGrant(OWNER_A);
    const storedGrants = JSON.parse(store.values.get("parkdex:offline-claims:grants:v1:account-a") ?? "{}") as { items?: Array<{ grantToken: string }> };
    expect(storedGrants.items?.map((item) => item.grantToken).sort()).toEqual(["grant-new", "grant-old"]);
    expect(await service.recommendLocal(OWNER_A, { location: locationAt(now) })).toMatchObject({ status: "recommended", candidate: { placeId: "z-other" } });
  });

  it("reuses a durable grant and refreshes it when a cached boundary version changes", async () => {
    const now = Date.parse("2026-09-24T12:00:00.000Z");
    let boundaryVersion: string = "v1";
    const currentBundle = () => bundle("park", polygon("park", square(0, 0, 5, 5)), "regional", boundaryVersion);
    const cache: RecentPlaceCacheForClaims = {
      async get() { return currentBundle(); },
      async list() { return [currentBundle()]; },
    };
    const store = new MemoryStore();
    const service = createOfflineClaimsService({ apiBaseUrl: API, store, placeCache: cache, now: () => now });
    const firstGrant = { ...grant("grant-v1", "v1"), expiresAt: "2026-10-25T11:00:00.000Z" };
    const secondGrant = { ...grant("grant-v2", "v2"), expiresAt: "2026-10-25T11:00:00.000Z" };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(firstGrant))
      .mockResolvedValueOnce(response(secondGrant));
    vi.stubGlobal("fetch", fetchMock);

    await service.ensureGrant(OWNER_A, 1_000);
    await service.ensureGrant(OWNER_A, 1_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    boundaryVersion = "v2";
    await service.ensureGrant(OWNER_A, 1_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await service.ensureGrant(OWNER_A, 1_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const storedGrants = JSON.parse(store.values.get("parkdex:offline-claims:grants:v1:account-a") ?? "{}") as { items?: Array<{ grantToken: string }> };
    expect(storedGrants.items?.map((item) => item.grantToken)).toEqual(["grant-v2"]);
  });

  it("persists a client-pending claim before returning and replays the same request ID after restart", async () => {
    const { service, store, owner, recommendation, pending } = await prepareOfflineClaim();
    expect(pending).toMatchObject({ placeId: "park", pendingSync: true, claim: { hasPhoto: false, matchKind: "exact" } });
    expect(await service.pending(owner)).toBe(1);
    await expect(service.createLocal(owner, { recommendationToken: recommendation.recommendationToken, expectedPlaceId: "park" })).resolves.toEqual(pending);

    const queueKey = "parkdex:offline-claims:queue:v1:account-a";
    const queueJson = store.values.get(queueKey) ?? "";
    expect(queueJson).toContain("requestId");
    expect(queueJson).not.toContain("grant-a");
    expect(queueJson).not.toContain("bearer-a");
    expect(store.values.get("parkdex:offline-claims:grants:v1:account-a")).toContain("grant-a");

    const restart = createOfflineClaimsService({
      apiBaseUrl: API,
      store,
      placeCache: cacheOf(bundle("park", polygon("park", square(0, 0, 5, 5)))),
      now: () => Date.parse("2026-09-24T12:00:00.000Z"),
    });
    expect(await restart.list(owner)).toHaveLength(1);
    const requests: Array<{ requestId: string; grantToken: string }> = [];
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as { requestId: string; grantToken: string });
      return requests.length === 1
        ? Promise.reject(new TypeError("offline"))
        : Promise.resolve(response(serverConfirmation("park")));
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(restart.drain(owner)).resolves.toEqual({ confirmed: [], photos: [] });
    expect(await restart.pending(owner)).toBe(1);
    const drained = await restart.drain(owner);
    expect(drained.confirmed).toHaveLength(1);
    expect(drained.confirmed[0]).not.toHaveProperty("pendingSync");
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual(requests[1]);
    expect(new Headers(fetchMock.mock.calls[1][1]?.headers).get("Authorization")).toBe("Bearer bearer-a");
  });

  it("lets the server replay an accepted receipt after the offline grant expires", async () => {
    let now = Date.parse("2026-09-24T12:00:00.000Z");
    const { service, owner } = await prepareOfflineClaim({ now: () => now });
    now = Date.parse("2026-09-26T12:00:00.000Z");
    const fetchMock = vi.fn().mockResolvedValue(response(serverConfirmation("park")));
    vi.stubGlobal("fetch", fetchMock);

    const result = await service.drain(owner);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.confirmed).toHaveLength(1);
    expect(result.confirmed[0]).not.toHaveProperty("pendingSync");
  });

  it("does not recommend the same place again while its local claim is pending", async () => {
    const { service, store, owner, pending } = await prepareOfflineClaim();
    const second = await service.recommendLocal(owner, { location: locationAt(Date.parse("2026-09-24T12:00:00.000Z")) });
    expect(second).toEqual({ status: "none" });
    const queue = JSON.parse(store.values.get("parkdex:offline-claims:queue:v1:account-a") ?? "{}") as { items?: unknown[] };
    expect(queue.items).toHaveLength(1);
    expect(await service.list(owner)).toMatchObject([{ placeId: pending.placeId, state: "pending" }]);
  });

  it("attaches a newly accepted photo to an existing pending place claim through its stable token", async () => {
    const photo = new File(["saved-photo"], "visit.jpg", { type: "image/jpeg" });
    let filePresent = false;
    const photoRetry: PhotoRetryStore = {
      async save() { filePresent = true; },
      async load() { return filePresent ? { file: photo, mimeType: photo.type } : null; },
      async remove() { filePresent = false; },
      async clearOwner() { filePresent = false; },
    };
    const uploadPhoto = vi.fn(async () => undefined);
    const { service, owner, recommendation, pending } = await prepareOfflineClaim({ photoRetry, photoRetryIsDurable: () => true, uploadPhoto });
    filePresent = true;
    await expect(service.createLocal(owner, {
      recommendationToken: recommendation.recommendationToken,
      expectedPlaceId: "park",
      photoExpected: true,
    })).resolves.toEqual(pending);
    expect(await service.list(owner)).toMatchObject([{ state: "pending", photoState: "pending" }]);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(serverConfirmation("park"))));
    const drained = await service.drain(owner);
    expect(uploadPhoto).toHaveBeenCalledTimes(1);
    expect(drained.confirmed[0]).toMatchObject({ claim: { hasPhoto: true } });
  });

  it("keeps terminal server rejections actionable and keeps one account from reading another account's queue", async () => {
    const store = new MemoryStore();
    const { service, recommendation } = await prepareOfflineClaim({ store });
    const queueKeyB = "parkdex:offline-claims:queue:v1:account-b";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(grant("grant-b"))));
    await service.provisionGrant(OWNER_B);
    const recommendationB = await service.recommendLocal(OWNER_B, { location: locationAt(Date.parse("2026-09-24T12:00:00.000Z")) });
    if (recommendationB.status !== "recommended") throw new Error("Expected account B recommendation.");
    await service.createLocal(OWNER_B, { recommendationToken: recommendationB.recommendationToken, expectedPlaceId: "park" });
    expect(await service.list(OWNER_B)).toHaveLength(1);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ detail: "The offline claim grant does not match this visit." }, 409)));
    await service.drain(OWNER_A);
    expect(await service.list(OWNER_A)).toMatchObject([{ state: "rejected", lastError: "The offline claim grant does not match this visit." }]);
    expect(await service.pending(OWNER_A)).toBe(0);
    expect(await service.list({ ...OWNER_B, token: "different-bearer" })).toHaveLength(1);
    await expect(service.createLocal(OWNER_B, { recommendationToken: recommendation.recommendationToken, expectedPlaceId: "park" })).rejects.toThrow("expired");
    await service.clearOwner(OWNER_A.accountId);
    expect(store.values.has(queueKeyB)).toBe(true);
    expect(await service.list(OWNER_B)).toHaveLength(1);
  });

  it("aborts and awaits an in-flight owner drain before clearing grants and queued visits", async () => {
    const { service, store, owner, recommendation } = await prepareOfflineClaim();
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }));
    vi.stubGlobal("fetch", fetchMock);
    const drain = service.drain(owner);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const clearing = service.clearOwner(owner.accountId);
    await expect(drain).rejects.toThrow("account changed");
    await clearing;
    expect(store.values.has("parkdex:offline-claims:grants:v1:account-a")).toBe(false);
    expect(store.values.has("parkdex:offline-claims:queue:v1:account-a")).toBe(false);
    expect(await service.pending(owner)).toBe(0);
    expect(service.isOfflineToken(recommendation.recommendationToken)).toBe(true);
  });

  it("preserves malformed durable queue bytes and fails closed without sending a claim", async () => {
    const store = new MemoryStore();
    const queueKey = "parkdex:offline-claims:queue:v1:account-a";
    store.values.set(queueKey, "{invalid-json");
    const service = createOfflineClaimsService({
      apiBaseUrl: API,
      store,
      placeCache: cacheOf(bundle("park", polygon("park", square(0, 0, 5, 5)))),
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(service.drain(OWNER_A)).rejects.toThrow("remains on this device");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.values.get(queueKey)).toBe("{invalid-json");
  });

  it("uploads a saved photo only after the server confirms the visit, then removes its local retry copy", async () => {
    const photo = new File(["saved-photo"], "visit.jpg", { type: "image/jpeg" });
    const retryPhotos = new Map<string, File>([["account:account-a\u0000park", photo]]);
    const photoRetry: PhotoRetryStore = {
      async save() {},
      async load(accountKey, placeId) {
        const file = retryPhotos.get(`${accountKey}\u0000${placeId}`);
        return file ? { file, mimeType: file.type, processingState: "prepared" } : null;
      },
      async remove(accountKey, placeId) { retryPhotos.delete(`${accountKey}\u0000${placeId}`); },
      async clearOwner(accountKey) { for (const key of retryPhotos.keys()) if (key.startsWith(`${accountKey}\u0000`)) retryPhotos.delete(key); },
    };
    const events: string[] = [];
    const uploadPhoto = vi.fn(async () => { events.push("photo"); });
    const { service, owner } = await prepareOfflineClaim({ photoRetry, photoRetryIsDurable: () => true, uploadPhoto });
    const fetchMock = vi.fn().mockImplementation(() => { events.push("claim"); return Promise.resolve(response(serverConfirmation("park"))); });
    vi.stubGlobal("fetch", fetchMock);

    const drained = await service.drain(owner);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(uploadPhoto).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["claim", "photo"]);
    expect(uploadPhoto).toHaveBeenCalledWith({ kind: "account", token: "bearer-a" }, "park", photo);
    expect(drained.confirmed[0]).not.toHaveProperty("pendingSync");
    expect(drained.confirmed[0]).toMatchObject({ claim: { hasPhoto: true } });
    expect(drained.photos).toEqual([{ requestId: expect.any(String), placeId: "park", status: "uploaded" }]);
    expect(retryPhotos.size).toBe(0);
  });

  it("reports a retry photo as volatile when IndexedDB is unavailable", async () => {
    const photo = new File(["saved-photo"], "visit.jpg", { type: "image/jpeg" });
    const photoRetry: PhotoRetryStore = {
      async save() {},
      async load() { return { file: photo, mimeType: photo.type, processingState: "prepared" }; },
      async remove() {},
      async clearOwner() {},
    };
    const { service, owner } = await prepareOfflineClaim({ photoRetry, photoRetryIsDurable: () => false });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(serverConfirmation("park"))));
    const drained = await service.drain(owner);
    expect(drained.photos[0]).toMatchObject({ status: "volatile", message: "The visit is saved. Its photo is waiting for an upload handler." });
    expect(await service.list(owner)).toMatchObject([{ state: "photo-retry", photoState: "volatile" }]);
  });

  it("replays a persisted server confirmation after restart while a photo still needs retry", async () => {
    const photo = new File(["saved-photo"], "visit.jpg", { type: "image/jpeg" });
    const photoRetry: PhotoRetryStore = {
      async save() {},
      async load() { return { file: photo, mimeType: photo.type, processingState: "prepared" }; },
      async remove() {},
      async clearOwner() {},
    };
    const { service, store, owner } = await prepareOfflineClaim({ photoRetry, photoRetryIsDurable: () => true });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(serverConfirmation("park"))));
    const firstDrain = await service.drain(owner);
    expect(firstDrain.confirmed).toMatchObject([{ placeId: "park", visited: true }]);
    expect(firstDrain.photos).toMatchObject([{ status: "retry" }]);
    expect(await service.list(owner)).toMatchObject([{ state: "photo-retry" }]);

    const restarted = createOfflineClaimsService({
      apiBaseUrl: API,
      store,
      placeCache: cacheOf(bundle("park", polygon("park", square(0, 0, 5, 5)))),
      now: () => Date.parse("2026-09-24T12:00:00.000Z"),
      photoRetry,
      photoRetryIsDurable: () => true,
    });
    const fetchMock = vi.fn().mockResolvedValue(response(serverConfirmation("park")));
    vi.stubGlobal("fetch", fetchMock);
    const replay = await restarted.drain(owner);
    expect(replay.confirmed).toMatchObject([{ placeId: "park", visited: true, claim: { hasPhoto: false } }]);
    expect(replay.photos).toMatchObject([{ status: "retry" }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({ requestId: expect.any(String), expectedPlaceId: "park" });
  });

  it("does not resurrect an acknowledged visit or upload its photo after the server invalidates the receipt", async () => {
    const photo = new File(["saved-photo"], "visit.jpg", { type: "image/jpeg" });
    const photoRetry: PhotoRetryStore = {
      async save() {},
      async load() { return { file: photo, mimeType: photo.type, processingState: "prepared" }; },
      async remove() {},
      async clearOwner() {},
    };
    const { service, store, owner } = await prepareOfflineClaim({ photoRetry, photoRetryIsDurable: () => true });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(serverConfirmation("park"))));
    expect((await service.drain(owner)).confirmed).toHaveLength(1);

    const uploadPhoto = vi.fn(async () => undefined);
    const restarted = createOfflineClaimsService({
      apiBaseUrl: API,
      store,
      placeCache: cacheOf(bundle("park", polygon("park", square(0, 0, 5, 5)))),
      now: () => Date.parse("2026-09-24T12:00:00.000Z"),
      photoRetry,
      photoRetryIsDurable: () => true,
      uploadPhoto,
    });
    const fetchMock = vi.fn().mockResolvedValue(response({ detail: "The visit receipt was invalidated after the visit was removed." }, 410));
    vi.stubGlobal("fetch", fetchMock);
    const result = await restarted.drain(owner);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.confirmed).toEqual([]);
    expect(result.photos).toEqual([]);
    expect(uploadPhoto).not.toHaveBeenCalled();
    expect(await restarted.list(owner)).toMatchObject([{ state: "rejected", lastError: "The visit receipt was invalidated after the visit was removed." }]);
  });

  it("discards only rejected queue rows and preserves pending, confirmed, and private photo work", async () => {
    const photoRetry: PhotoRetryStore = {
      async save() {},
      async load() { return null; },
      async remove() { throw new Error("private photos must be retained"); },
      async clearOwner() {},
    };
    const { service, store, owner } = await prepareOfflineClaim({ photoRetry });
    const key = "parkdex:offline-claims:queue:v1:account-a";
    const saved = JSON.parse(store.values.get(key) ?? "{}") as { version: number; ownerId: string; items: Array<Record<string, unknown>> };
    const pending = saved.items[0];
    const rejected = { ...pending, requestId: "rejected-request", placeId: "rejected-park", state: "rejected", photoState: "pending" };
    const confirmed = {
      ...pending,
      requestId: "confirmed-request",
      placeId: "confirmed-park",
      state: "confirmed",
      photoState: "retry",
      serverConfirmation: serverConfirmation("confirmed-park"),
    };
    store.values.set(key, JSON.stringify({ ...saved, items: [pending, rejected, confirmed] }));

    await expect(service.discardRejected(owner)).resolves.toBe(1);
    const remaining = await service.list(owner);
    expect(remaining).toMatchObject([
      { requestId: pending.requestId, placeId: pending.placeId, state: "pending" },
      { requestId: "confirmed-request", placeId: "confirmed-park", state: "photo-retry" },
    ]);
  });

  it("cancels only the selected place queue rows and retains private photo bytes", async () => {
    const removePhoto = vi.fn(async () => undefined);
    const photoRetry: PhotoRetryStore = {
      async save() {},
      async load() { return null; },
      remove: removePhoto,
      async clearOwner() {},
    };
    const { service, store, owner } = await prepareOfflineClaim({ photoRetry });
    const key = "parkdex:offline-claims:queue:v1:account-a";
    const saved = JSON.parse(store.values.get(key) ?? "{}") as { items: Array<Record<string, unknown>> };
    const targetPending = { ...saved.items[0], placeId: "park" };
    const targetConfirmed = {
      ...saved.items[0],
      requestId: "confirmed-request",
      placeId: "park",
      state: "confirmed",
      photoState: "retry",
      serverConfirmation: serverConfirmation("park"),
    };
    const unrelated = { ...saved.items[0], requestId: "other-request", placeId: "other-park" };
    store.values.set(key, JSON.stringify({ ...JSON.parse(store.values.get(key) ?? "{}"), items: [targetPending, targetConfirmed, unrelated] }));

    await expect(service.cancelPlace(owner, "park")).resolves.toBe(2);
    expect(await service.list(owner)).toMatchObject([{ requestId: "other-request", placeId: "other-park", state: "pending" }]);
    expect(removePhoto).not.toHaveBeenCalled();
  });

  it("serializes place cancellation behind an in-flight receipt drain", async () => {
    const { service, owner } = await prepareOfflineClaim();
    let resolveReceipt: ((value: Response) => void) | undefined;
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
      resolveReceipt = resolve;
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }));
    vi.stubGlobal("fetch", fetchMock);
    const draining = service.drain(owner);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    let cancellationSettled = false;
    const cancellation = service.cancelPlace(owner, "park").then((count) => {
      cancellationSettled = true;
      return count;
    });
    await Promise.resolve();
    expect(cancellationSettled).toBe(false);
    resolveReceipt?.(response(serverConfirmation("park")));
    await draining;
    await expect(cancellation).resolves.toBe(0);
    expect(await service.list(owner)).toHaveLength(0);
  });

  it("removes a retry photo only after queue metadata durably stops photo upload", async () => {
    const photo = new File(["saved-photo"], "visit.jpg", { type: "image/jpeg" });
    let filePresent = true;
    const photoRetry: PhotoRetryStore = {
      async save() { filePresent = true; },
      async load() { return filePresent ? { file: photo, mimeType: photo.type, processingState: "prepared" } : null; },
      async remove(ownerKey, placeId) { expect(ownerKey).toBe("account:account-a"); expect(placeId).toBe("park"); filePresent = false; },
      async clearOwner() { filePresent = false; },
    };
    const uploadPhoto = vi.fn(async () => undefined);
    const { service, owner } = await prepareOfflineClaim({ photoRetry, photoRetryIsDurable: () => true, uploadPhoto });
    await service.cancelPhotoRetry(owner, "park");
    expect(filePresent).toBe(false);
    expect(await service.list(owner)).toMatchObject([{ state: "pending", photoState: "none" }]);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(serverConfirmation("park"))));
    const result = await service.drain(owner);
    expect(result.confirmed).toHaveLength(1);
    expect(result.photos).toMatchObject([{ status: "none" }]);
    expect(uploadPhoto).not.toHaveBeenCalled();
  });

  it("retains accepted photo bytes when photo cancellation cannot persist its no-upload marker", async () => {
    const photo = new File(["saved-photo"], "visit.jpg", { type: "image/jpeg" });
    let filePresent = true;
    const photoRetry: PhotoRetryStore = {
      async save() { filePresent = true; },
      async load() { return filePresent ? { file: photo, mimeType: photo.type, processingState: "prepared" } : null; },
      async remove() { filePresent = false; },
      async clearOwner() { filePresent = false; },
    };
    const { service, store, owner } = await prepareOfflineClaim({ photoRetry, photoRetryIsDurable: () => true });
    const key = "parkdex:offline-claims:queue:v1:account-a";
    const originalSetItem = store.setItem.bind(store);
    store.setItem = async (targetKey, value) => {
      if (targetKey === key) throw new Error("queue storage unavailable");
      await originalSetItem(targetKey, value);
    };

    await expect(service.cancelPhotoRetry(owner, "park")).rejects.toThrow("queue storage unavailable");
    expect(filePresent).toBe(true);
    expect(await service.list(owner)).toMatchObject([{ state: "pending", photoState: "pending" }]);
  });

  it("keeps rejected queue data intact when durable deletion fails", async () => {
    const { service, store, owner } = await prepareOfflineClaim();
    const key = "parkdex:offline-claims:queue:v1:account-a";
    const saved = JSON.parse(store.values.get(key) ?? "{}") as { items: Array<Record<string, unknown>> };
    saved.items[0].state = "rejected";
    store.values.set(key, JSON.stringify(saved));
    const originalSetItem = store.setItem.bind(store);
    store.setItem = async (targetKey, value) => {
      if (targetKey === key) throw new Error("queue storage unavailable");
      await originalSetItem(targetKey, value);
    };

    await expect(service.discardRejected(owner)).rejects.toThrow("queue storage unavailable");
    expect(store.values.get(key)).toBe(JSON.stringify(saved));
    expect(await service.list(owner)).toMatchObject([{ state: "rejected" }]);
  });

  it("does not queue a photo claim when retry storage cannot verify the accepted photo", async () => {
    const photoRetry: PhotoRetryStore = {
      async save() {},
      async load() { throw new Error("private file store failed"); },
      async remove() {},
      async clearOwner() {},
    };
    const store = new MemoryStore();
    const now = Date.parse("2026-09-24T12:00:00.000Z");
    const service = createOfflineClaimsService({
      apiBaseUrl: API,
      store,
      placeCache: cacheOf(bundle("park", polygon("park", square(0, 0, 5, 5)))),
      now: () => now,
      photoRetry,
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(grant())));
    await service.provisionGrant(OWNER_A);
    const recommendation = await service.recommendLocal(OWNER_A, { location: locationAt(now) });
    if (recommendation.status !== "recommended") throw new Error("Expected a local recommendation.");
    await expect(service.createLocal(OWNER_A, { recommendationToken: recommendation.recommendationToken, expectedPlaceId: "park" }))
      .rejects.toThrow("Could not check the saved photo");
    expect(await service.pending(OWNER_A)).toBe(0);
  });

  it("fails before queueing when an accepted photo is not yet saved for retry", async () => {
    const photoRetry: PhotoRetryStore = {
      async save() {},
      async load() { return null; },
      async remove() {},
      async clearOwner() {},
    };
    const now = Date.parse("2026-09-24T12:00:00.000Z");
    const service = createOfflineClaimsService({
      apiBaseUrl: API,
      store: new MemoryStore(),
      placeCache: cacheOf(bundle("park", polygon("park", square(0, 0, 5, 5)))),
      now: () => now,
      photoRetry,
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(grant())));
    await service.provisionGrant(OWNER_A);
    const recommendation = await service.recommendLocal(OWNER_A, { location: locationAt(now) });
    if (recommendation.status !== "recommended") throw new Error("Expected a local recommendation.");
    await expect(service.createLocal(OWNER_A, {
      recommendationToken: recommendation.recommendationToken,
      expectedPlaceId: "park",
      photoExpected: true,
    })).rejects.toThrow("not saved for retry yet");
    expect(await service.pending(OWNER_A)).toBe(0);
  });

  it("retains an accepted photo as actionable when its bytes disappear after queue commit", async () => {
    const photo = new File(["saved-photo"], "visit.jpg", { type: "image/jpeg" });
    let loads = 0;
    const photoRetry: PhotoRetryStore = {
      async save() {},
      async load() { loads += 1; return loads === 1 ? { file: photo, mimeType: photo.type } : null; },
      async remove() {},
      async clearOwner() {},
    };
    const { service, owner } = await prepareOfflineClaim({ photoRetry, photoExpected: true, photoRetryIsDurable: () => true });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(serverConfirmation("park"))));
    const drained = await service.drain(owner);
    expect(drained.confirmed).toHaveLength(1);
    expect(drained.photos).toMatchObject([{ status: "missing" }]);
    expect(await service.list(owner)).toMatchObject([{ state: "photo-retry", photoState: "missing" }]);
  });
});

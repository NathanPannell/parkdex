// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nativeCamera = vi.hoisted(() => ({ clearRestoredCameraPhoto: vi.fn() }));
vi.mock("./capacitor-native-capabilities", () => nativeCamera);
const nativePhoto = vi.hoisted(() => ({
  clearPhotoRetryOwner: vi.fn(),
  getNativeCapabilities: vi.fn(() => ({})),
  currentNativeAppState: vi.fn(() => true),
  NATIVE_APP_STATE_EVENT: "parkdex:native-app-state",
}));
vi.mock("./native-capabilities", () => nativePhoto);
const recentPlaceCache = vi.hoisted(() => ({ get: vi.fn(), list: vi.fn() }));
vi.mock("./place-cache", () => ({ getRecentPlaceCache: () => recentPlaceCache }));

import { ACCOUNT_TOKEN_KEY, type Visit } from "./account";
import { markUnresolvedClaim } from "./claim-recovery";
import { JOURNAL_STORAGE, accountPendingKey, importedGuestKey } from "./field-journal-state";
import type { Place } from "./places";
import { catalogueIndex, useFieldJournal } from "./use-field-journal";

const API = "https://api.example.test";
const KEY = "k".repeat(43);
const ACCOUNT = { id: "account-one", email: "explorer@example.com" };
const PLACE = {
  id: "park",
  name: "Park",
  category: "regional" as const,
  latitude: 49,
  longitude: -124,
  region: "CRD",
  description: "Test",
  sourceUrl: "https://example.test",
  sourceName: "Test",
  sourceId: null,
};
const CLAIM_CONFIRMATION = {
  placeId: PLACE.id,
  visited: true as const,
  visitedCount: 1,
  visitedAt: "2026-09-08T12:00:00Z",
  claim: {
    claimedAt: "2026-09-08T12:00:00Z",
    capturedAt: "2026-09-08T12:00:00Z",
    coordinates: { latitude: 49, longitude: -124 },
    accuracyMeters: 8,
    boundaryVersion: "v1",
    matchKind: "exact" as const,
    distanceMeters: 0,
    hasPhoto: false,
  },
};
const CLAIM_VISIT = {
  placeId: CLAIM_CONFIRMATION.placeId,
  visitedAt: CLAIM_CONFIRMATION.visitedAt,
  claim: CLAIM_CONFIRMATION.claim,
};

function json(data: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  }));
}

function catalogue(visitedIds: string[] = [], completedTrailIds: string[] = []) {
  return {
    total: 1,
    categoryTotals: { national: 0, provincial: 0, regional: 1, island: 0 },
    visitedCategoryTotals: { national: 0, provincial: 0, regional: visitedIds.length, island: 0 },
    visitedIds,
    completedTrailIds,
    coverageNote: "Coverage",
    visitClaims: { supported: true, enforcement: "required" as const },
    badges: [{ id: "first-visit", name: "First visit", species: "bear", description: "Visit a place", current: visitedIds.length, target: 1, earned: visitedIds.length > 0 }],
  };
}

function offlineCatalogue(visitedIds: string[] = []) {
  return {
    ...catalogue(visitedIds),
    visitClaims: { supported: true, enforcement: "required" as const, offlineSupported: true },
  };
}

function offlinePlaceBundle() {
  const boundary = {
    type: "Feature" as const,
    properties: {
      id: PLACE.id,
      name: PLACE.name,
      category: PLACE.category,
      sourceName: PLACE.sourceName,
      sourceUrl: PLACE.sourceUrl,
      sourceId: null,
    },
    geometry: {
      type: "Polygon" as const,
      coordinates: [[[-125, 48], [-123, 48], [-123, 50], [-125, 50], [-125, 48]]],
    },
  };
  return { place: PLACE, boundary, boundaryVersion: "v1" };
}

function storedOfflineQueue(items: Array<Record<string, unknown>> = [{
  requestId: "offline-request-one",
  recommendationId: "offline-recommendation-one",
  ownerId: ACCOUNT.id,
  grantId: "offline-grant-one",
  placeId: PLACE.id,
  location: { latitude: 49, longitude: -124, accuracyMeters: 8, capturedAtEpochMs: Date.now() - 1_000 },
  boundaryVersion: "v1",
  createdAt: new Date(Date.now() - 1_000).toISOString(),
  state: "pending",
  photoState: "none",
  attemptCount: 0,
  pendingConfirmation: { ...CLAIM_CONFIRMATION, pendingSync: true },
}]) {
  return {
    version: 1,
    ownerId: ACCOUNT.id,
    items,
  };
}

function storedConfirmedOfflineItem({
  requestId = "offline-confirmed-one",
  placeId = PLACE.id,
  photoState = "none",
}: { requestId?: string; placeId?: string; photoState?: string } = {}) {
  const confirmation = { ...CLAIM_CONFIRMATION, placeId };
  return {
    ...storedOfflineQueue().items[0],
    requestId,
    placeId,
    state: "confirmed",
    photoState,
    pendingConfirmation: { ...confirmation, pendingSync: true },
    serverConfirmation: confirmation,
  };
}

function storeOfflineGrant() {
  window.localStorage.setItem(`parkdex:offline-claims:grants:v1:${encodeURIComponent(ACCOUNT.id)}`, JSON.stringify({
    version: 1,
    ownerId: ACCOUNT.id,
    items: [{
      id: "offline-grant-one",
      ownerId: ACCOUNT.id,
      grantToken: "offline-grant-token",
      issuedAt: new Date(Date.now() - 1_000).toISOString(),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      boundaryVersion: "v1",
    }],
  }));
}

function offlineQueueStorageKey() {
  return `parkdex:offline-claims:queue:v1:${encodeURIComponent(ACCOUNT.id)}`;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

let restoreNavigatorOnline: (() => void) | undefined;

function setNavigatorOnline(value: boolean) {
  restoreNavigatorOnline?.();
  const previous = Object.getOwnPropertyDescriptor(window.navigator, "onLine");
  Object.defineProperty(window.navigator, "onLine", { configurable: true, value });
  restoreNavigatorOnline = () => {
    if (previous) Object.defineProperty(window.navigator, "onLine", previous);
    else Reflect.deleteProperty(window.navigator, "onLine");
  };
}

beforeEach(() => {
  nativeCamera.clearRestoredCameraPhoto.mockReset();
  nativePhoto.clearPhotoRetryOwner.mockReset();
  nativePhoto.getNativeCapabilities.mockReset().mockReturnValue({});
  recentPlaceCache.get.mockReset().mockResolvedValue(null);
  recentPlaceCache.list.mockReset().mockResolvedValue([]);
  window.localStorage.clear();
  window.localStorage.setItem(JOURNAL_STORAGE.collectionKey, KEY);
});

afterEach(() => {
  restoreNavigatorOnline?.();
  restoreNavigatorOnline = undefined;
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useFieldJournal identity and progress races", () => {
  it("boots from compact catalogue state and exposes owner-scoped request context", async () => {
    const state = {
      ...catalogue([PLACE.id]),
      total: 1_030,
      categoryTotals: { national: 7, provincial: 693, regional: 293, island: 37 },
      visitedCategoryTotals: { national: 1, provincial: 2, regional: 3, island: 4 },
      badges: [{ id: "first-visit", name: "First visit", species: "bear", description: "Visit a place", current: 1, target: 1, earned: true }],
    };
    const fetchMock = vi.fn((url: string | URL | Request) => {
      if (!String(url).endsWith("/api/catalogue/state")) throw new Error(`Unexpected request: ${url}`);
      return json(state);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useFieldJournal({ apiBaseUrl: API }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(fetchMock).toHaveBeenCalledWith(`${API}/api/catalogue/state`, expect.objectContaining({
      cache: "no-store",
      headers: { "X-Collection-Key": KEY },
    }));
    expect(fetchMock.mock.calls.map(([url]) => String(url))).not.toContain(`${API}/api/places?summary=true`);
    expect(result.current.places).toEqual([]);
    expect(result.current.total).toBe(1_030);
    expect(result.current.categoryTotals).toEqual({ national: 7, provincial: 693, regional: 293, island: 37 });
    expect(result.current.visitedCategoryTotals).toEqual({ national: 1, provincial: 2, regional: 3, island: 4 });
    expect(result.current.badges).toEqual(state.badges);
    expect(result.current.catalogueOwnerKey).toMatch(/^guest:[0-9a-f]{8}$/);
    expect(result.current.catalogueHeaders).toEqual({ "X-Collection-Key": KEY });
    expect(JSON.parse(window.localStorage.getItem(JOURNAL_STORAGE.places) ?? "null")).toEqual([]);
    const storedMetadata = window.localStorage.getItem(`parkdex:catalogue-state:v1:${result.current.catalogueOwnerKey}`);
    expect(JSON.parse(storedMetadata ?? "{}")).toMatchObject({ total: 1_030, badges: state.badges });
    expect(JSON.parse(storedMetadata ?? "{}")).not.toHaveProperty("places");
  });

  it("migrates a legacy full index to a compact 100-place sample with visited parks first", async () => {
    const oldPlaces = Array.from({ length: 180 }, (_, index) => ({
      ...PLACE,
      id: `legacy-${index}`,
      name: `Legacy ${index}`,
      category: index < 10 ? "national" as const : index < 46 ? "island" as const : "regional" as const,
      visitorDetails: { private: true },
    }));
    const visitedId = "legacy-179";
    window.localStorage.setItem(JOURNAL_STORAGE.places, JSON.stringify(oldPlaces));
    window.localStorage.setItem(JOURNAL_STORAGE.guestVisited, JSON.stringify([visitedId]));
    window.localStorage.setItem(JOURNAL_STORAGE.guestVisitTimestamps, JSON.stringify({ [visitedId]: "2026-09-01T12:00:00Z" }));
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("offline"))));

    const { result } = renderHook(() => useFieldJournal({ apiBaseUrl: API }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    const migrated = JSON.parse(window.localStorage.getItem(JOURNAL_STORAGE.places) ?? "[]") as Place[];
    expect(migrated).toHaveLength(100);
    expect(migrated[0].id).toBe(visitedId);
    expect(migrated.every((place) => !("visitorDetails" in place))).toBe(true);
    expect(result.current.places).toEqual(migrated);
    expect(migrated.filter((place) => place.category === "national")).toHaveLength(10);
  });

  it("keeps a failed sign-in scoped to its caller rather than global sync feedback", async () => {
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request) => {
      if (String(url).endsWith("/api/auth/login")) return Promise.reject(new TypeError("Failed to fetch"));
      return json(catalogue());
    }));
    const { result } = renderHook(() => useFieldJournal({ apiBaseUrl: API }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await expect(result.current.authenticate("login", ACCOUNT.email, "invalid")).rejects.toThrow("Check your connection");
    });
    expect(result.current.syncMessage).toBe("");
    expect(result.current.transitionBusy).toBe(false);
    expect(result.current.authenticated).toBe(false);
  });

  it("retries a fresh guest catalogue as soon as the native network reports online", async () => {
    let catalogueAttempts = 0;
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request) => {
      if (!String(url).endsWith("/api/catalogue/state")) throw new Error(`Unexpected request: ${url}`);
      catalogueAttempts += 1;
      return catalogueAttempts === 1 ? Promise.reject(new TypeError("network not ready")) : json(catalogue());
    }));

    const { result } = renderHook(() => useFieldJournal({ apiBaseUrl: API }));
    await waitFor(() => expect(catalogueAttempts).toBe(1));
    act(() => window.dispatchEvent(new Event("online")));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(catalogueAttempts).toBe(2);
    expect(result.current.places).toEqual([]);
    await waitFor(() => expect(result.current.loadError).toBe(""));
  });

  it("finishes boot after one failed catalogue request while offline", async () => {
    vi.useFakeTimers();
    setNavigatorOnline(false);
    let catalogueAttempts = 0;
    vi.stubGlobal("fetch", vi.fn(() => {
      catalogueAttempts += 1;
      return Promise.reject(new TypeError("offline"));
    }));

    const { result } = renderHook(() => useFieldJournal({ apiBaseUrl: API }));
    for (let turn = 0; turn < 20 && catalogueAttempts === 0; turn += 1) {
      await act(async () => { await Promise.resolve(); });
    }
    expect(catalogueAttempts).toBe(1);
    await act(async () => { await Promise.resolve(); });
    expect(result.current.loading).toBe(false);
    expect(result.current.loadError).toBe("Could not load the field guide. Check your connection and try again.");
  });

  it("does not schedule catalogue retries and exposes an explicit retry action", async () => {
    vi.useFakeTimers();
    setNavigatorOnline(true);
    let catalogueAttempts = 0;
    vi.stubGlobal("fetch", vi.fn(() => {
      catalogueAttempts += 1;
      return catalogueAttempts === 1 ? Promise.reject(new TypeError("network still starting")) : json(catalogue());
    }));

    const { result } = renderHook(() => useFieldJournal({ apiBaseUrl: API }));
    for (let turn = 0; turn < 20 && catalogueAttempts === 0; turn += 1) {
      await act(async () => { await Promise.resolve(); });
    }
    expect(catalogueAttempts).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(catalogueAttempts).toBe(1);
    expect(result.current.loading).toBe(false);
    expect(result.current.retryCatalogue).toBeTypeOf("function");
    await act(async () => { expect(await result.current.retryCatalogue()).toBe(true); });
    expect(catalogueAttempts).toBe(2);
    expect(result.current.loadError).toBe("");
  });

  it.each(["visibilitychange", "parkdex:native-app-state"] as const)("recovers a failed catalogue request on %s", async (eventName) => {
    let catalogueAttempts = 0;
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request) => {
      if (!String(url).endsWith("/api/catalogue/state")) throw new Error(`Unexpected request: ${url}`);
      catalogueAttempts += 1;
      return catalogueAttempts === 1 ? Promise.reject(new TypeError("offline")) : json(catalogue());
    }));

    const { result } = renderHook(() => useFieldJournal({ apiBaseUrl: API }));
    for (let turn = 0; turn < 20 && catalogueAttempts === 0; turn += 1) {
      await act(async () => { await Promise.resolve(); });
    }
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => {
      if (eventName === "visibilitychange") document.dispatchEvent(new Event(eventName));
      else window.dispatchEvent(new Event(eventName));
    });
    await waitFor(() => expect(catalogueAttempts).toBe(2));
    await waitFor(() => expect(result.current.loadError).toBe(""));
  });

  it("does not retry a failed guest catalogue on a timer after account identity takes over", async () => {
    let guestCatalogueAttempts = 0;
    let accountCatalogueAttempts = 0;
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith("/api/auth/login")) {
        return json({ token: "account-token", expiresAt: new Date(Date.now() + 60_000).toISOString(), account: ACCOUNT, visitedIds: [PLACE.id], completedTrailIds: [] });
      }
      if (!path.endsWith("/api/catalogue/state")) throw new Error(`Unexpected request: ${url}`);
      if (new Headers(init?.headers).get("Authorization") === "Bearer account-token") {
        accountCatalogueAttempts += 1;
        return json(catalogue([PLACE.id]));
      }
      guestCatalogueAttempts += 1;
      return Promise.reject(new TypeError("guest offline"));
    }));

    const { result } = renderHook(() => useFieldJournal({ apiBaseUrl: API }));
    for (let turn = 0; turn < 20 && guestCatalogueAttempts === 0; turn += 1) {
      await act(async () => { await Promise.resolve(); });
    }
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(guestCatalogueAttempts).toBe(1);
    expect(result.current.loading).toBe(false);

    await act(() => result.current.authenticate("login", ACCOUNT.email, "password123"));
    for (let turn = 0; turn < 20 && accountCatalogueAttempts === 0; turn += 1) {
      await act(async () => { await Promise.resolve(); });
    }

    expect(guestCatalogueAttempts).toBe(1);
    expect(accountCatalogueAttempts).toBe(1);
    expect(result.current.authenticated).toBe(true);
    expect(result.current.visited.has(PLACE.id)).toBe(true);
  });

  it("refreshes the catalogue for the account that signs in after the guest request fails", async () => {
    let guestCatalogueAttempts = 0;
    let accountCatalogueAttempts = 0;
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith("/api/auth/login")) {
        return json({ token: "account-token", expiresAt: new Date(Date.now() + 60_000).toISOString(), account: ACCOUNT, visitedIds: [PLACE.id], completedTrailIds: [] });
      }
      if (!path.endsWith("/api/catalogue/state")) throw new Error(`Unexpected request: ${url}`);
      if (new Headers(init?.headers).get("Authorization") === "Bearer account-token") {
        accountCatalogueAttempts += 1;
        return json(catalogue([PLACE.id]));
      }
      guestCatalogueAttempts += 1;
      return Promise.reject(new TypeError("guest network not ready"));
    }));

    const { result } = renderHook(() => useFieldJournal({ apiBaseUrl: API }));
    await waitFor(() => expect(guestCatalogueAttempts).toBe(1));
    await act(() => result.current.authenticate("login", ACCOUNT.email, "password123"));
    act(() => window.dispatchEvent(new Event("online")));

    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() => expect(accountCatalogueAttempts).toBe(1));
    expect(guestCatalogueAttempts).toBe(1);
    expect(result.current.authenticated).toBe(true);
    expect(result.current.places).toEqual([]);
    expect(result.current.visited.has(PLACE.id)).toBe(true);
  });

  it("keeps a cached guest catalogue immediately available while offline", async () => {
    window.localStorage.setItem(JOURNAL_STORAGE.places, JSON.stringify([{ ...PLACE, visitorDetails: null }]));
    const fetchMock = vi.fn(() => Promise.reject(new TypeError("offline")));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useFieldJournal({ apiBaseUrl: API }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result.current.places).toEqual(catalogueIndex([PLACE]));
    expect(JSON.parse(window.localStorage.getItem(JOURNAL_STORAGE.places)!)).toEqual(catalogueIndex([PLACE]));
    expect(result.current.places[0]).not.toHaveProperty("visitorDetails");
    expect(result.current.loadError).toBe("Showing your saved field guide offline.");
  });

  it.each(["after failure", "in flight"] as const)("does not retry a catalogue request %s after unmount", async (phase) => {
    const lateCatalogue = deferred<Response>();
    let catalogueAttempts = 0;
    vi.stubGlobal("fetch", vi.fn(() => {
      catalogueAttempts += 1;
      return phase === "in flight" ? lateCatalogue.promise : Promise.reject(new TypeError("network not ready"));
    }));

    const mounted = renderHook(() => useFieldJournal({ apiBaseUrl: API }));
    await waitFor(() => expect(catalogueAttempts).toBe(1));
    mounted.unmount();
    await act(async () => {
      if (phase === "in flight") lateCatalogue.reject(new TypeError("network not ready"));
      await Promise.resolve();
    });
    act(() => window.dispatchEvent(new Event("online")));
    await new Promise((resolve) => window.setTimeout(resolve, 20));

    expect(catalogueAttempts).toBe(1);
  });

  it("falls back to legacy account writes when the previous API has no claim capability", async () => {
    window.localStorage.setItem(ACCOUNT_TOKEN_KEY, "account-token");
    window.localStorage.setItem(JOURNAL_STORAGE.accountSnapshot, JSON.stringify({ account: ACCOUNT, visitedIds: [], completedTrailIds: [] }));
    const visitWrites: RequestInit[] = [];
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith("/api/auth/me")) return json({ account: ACCOUNT, visitedIds: [], completedTrailIds: [], visits: [] });
      if (path.endsWith(`/api/visits/${PLACE.id}`)) {
        visitWrites.push(init ?? {});
        return json({ placeId: PLACE.id, visited: true, visitedCount: 1, visitedAt: "2026-09-08T12:00:00Z" });
      }
      return json({ places: [PLACE], visitedIds: [], completedTrailIds: [], coverageNote: "Old API" });
    }));

    const { result } = renderHook(() => useFieldJournal({ apiBaseUrl: API }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.visitClaimMode).toBe("legacy");
    expect(result.current.recommendClaim).toBeUndefined();
    expect(result.current.createClaim).toBeUndefined();

    await act(() => result.current.toggleVisit(PLACE.id));
    expect(visitWrites).toHaveLength(1);
    expect(JSON.parse(String(visitWrites[0].body))).toEqual({ visited: true });
  });

  it.each(["compatible", "required"] as const)("exposes claim methods only for an API advertising %s mode", async (enforcement) => {
    vi.stubGlobal("fetch", vi.fn(() => json({ ...catalogue(), visitClaims: { supported: true, enforcement } })));
    const { result } = renderHook(() => useFieldJournal({ apiBaseUrl: API }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.visitClaimMode).toBe(enforcement);
    expect(result.current.recommendClaim).toBeTypeOf("function");
    expect(result.current.createClaim).toBeTypeOf("function");
    expect(result.current.reconcileClaim).toBeTypeOf("function");
  });

  it("fails closed for a present but unrecognized claim capability", async () => {
    vi.stubGlobal("fetch", vi.fn(() => json({ ...catalogue(), visitClaims: { supported: true, enforcement: "future-mode" } })));
    const { result } = renderHook(() => useFieldJournal({ apiBaseUrl: API }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.visitClaimMode).toBe("unknown");
    expect(result.current.recommendClaim).toBeUndefined();
    expect(result.current.createClaim).toBeUndefined();
  });

  it("records a server visit timestamp immediately and clears it when undone", async () => {
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith(`/api/visits/${PLACE.id}`)) {
        const visited = JSON.parse(String(init?.body)).visited;
        return json({ placeId: PLACE.id, visited, visitedCount: visited ? 1 : 0, visitedAt: visited ? "2026-09-08T12:00:00Z" : null });
      }
      return json(catalogue());
    }));
    const { result } = renderHook(() => useFieldJournal({ apiBaseUrl: API }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(() => result.current.toggleVisit(PLACE.id));
    expect(result.current.visitTimestamps).toEqual({ [PLACE.id]: "2026-09-08T12:00:00Z" });
    await act(() => result.current.toggleVisit(PLACE.id));
    expect(result.current.visitTimestamps).toEqual({});
  });

  it("keeps the legacy raw guest key and reloads a raw bearer token without quotes", async () => {
    window.localStorage.setItem(ACCOUNT_TOKEN_KEY, "raw-token");
    window.localStorage.setItem(JOURNAL_STORAGE.accountSnapshot, JSON.stringify({
      account: ACCOUNT,
      visitedIds: [PLACE.id],
      completedTrailIds: [],
    }));
    const requests: RequestInit[] = [];
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request, init?: RequestInit) => {
      requests.push(init ?? {});
      if (String(url).endsWith("/api/auth/me")) {
        return json({ account: ACCOUNT, visitedIds: [PLACE.id], completedTrailIds: [] });
      }
      return json(catalogue([PLACE.id]));
    }));

    const { result } = renderHook(() => useFieldJournal({ apiBaseUrl: API }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(window.localStorage.getItem(JOURNAL_STORAGE.collectionKey)).toBe(KEY);
    expect(requests.every((request) => new Headers(request.headers).get("Authorization") === "Bearer raw-token")).toBe(true);
    expect(result.current.authenticated).toBe(true);
    expect(result.current.visited.has(PLACE.id)).toBe(true);
  });

  it("preserves a guest write across login and lets its late acknowledgement clear only the guest outbox", async () => {
    const guestWrite = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request) => {
      const path = String(url);
      if (path.endsWith(`/api/visits/${PLACE.id}`)) return guestWrite.promise;
      if (path.endsWith("/api/auth/login")) {
        return json({ token: "account-token", expiresAt: new Date(Date.now() + 60_000).toISOString(), account: ACCOUNT, visitedIds: [], completedTrailIds: [] });
      }
      return json(catalogue());
    }));
    const { result } = renderHook(() => useFieldJournal({ apiBaseUrl: API }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    let pendingToggle!: Promise<void>;
    act(() => { pendingToggle = result.current.toggleVisit(PLACE.id); });
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem(JOURNAL_STORAGE.guestVisitPending) ?? "{}")).toHaveProperty(PLACE.id));
    await act(() => result.current.authenticate("login", ACCOUNT.email, "password123"));

    expect(result.current.authenticated).toBe(true);
    expect(JSON.parse(window.localStorage.getItem(JOURNAL_STORAGE.guestVisitPending) ?? "{}")).toHaveProperty(PLACE.id);
    await act(async () => {
      guestWrite.resolve(await json({ placeId: PLACE.id, visited: true, visitedCount: 1 }));
      await pendingToggle;
    });
    expect(JSON.parse(window.localStorage.getItem(JOURNAL_STORAGE.guestVisitPending) ?? "{}")).toEqual({});
    expect(JSON.parse(window.localStorage.getItem(JOURNAL_STORAGE.guestVisited) ?? "[]")).toEqual([PLACE.id]);
    expect(result.current.visited.has(PLACE.id)).toBe(false);
  });

  it.each(["success", "failure"] as const)("ignores a guest catalogue %s that arrives after login", async (outcome) => {
    setNavigatorOnline(false);
    const lateCatalogue = deferred<Response>();
    let accountCatalogueAttempts = 0;
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith("/api/catalogue/state")) {
        if (new Headers(init?.headers).get("Authorization") === "Bearer account-token") {
          accountCatalogueAttempts += 1;
          return json(catalogue([PLACE.id]));
        }
        return lateCatalogue.promise;
      }
      return json({ token: "account-token", expiresAt: new Date(Date.now() + 60_000).toISOString(), account: ACCOUNT, visitedIds: [PLACE.id], completedTrailIds: [] });
    }));
    const { result } = renderHook(() => useFieldJournal({ apiBaseUrl: API }));

    await act(() => result.current.authenticate("login", ACCOUNT.email, "password123"));
    await waitFor(() => expect(accountCatalogueAttempts).toBe(1));
    expect(result.current.visited.has(PLACE.id)).toBe(true);
    await act(async () => {
      if (outcome === "success") lateCatalogue.resolve(await json(catalogue()));
      else lateCatalogue.reject(new TypeError("guest offline"));
      await Promise.resolve();
    });
    expect(result.current.authenticated).toBe(true);
    expect(result.current.visited.has(PLACE.id)).toBe(true);
    expect(result.current.loadError).toBe("");
  });

  it("replays the selected account's persisted outbox immediately after login", async () => {
    window.localStorage.setItem(accountPendingKey(ACCOUNT.id, "visits"), JSON.stringify({
      [PLACE.id]: { visited: true, revision: 4 },
    }));
    const writes: RequestInit[] = [];
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith("/api/auth/login")) {
        return json({ token: "fresh-token", expiresAt: new Date(Date.now() + 60_000).toISOString(), account: ACCOUNT, visitedIds: [], completedTrailIds: [] });
      }
      if (path.endsWith(`/api/visits/${PLACE.id}`)) {
        writes.push(init ?? {});
        return json({ placeId: PLACE.id, visited: true, visitedCount: 1 });
      }
      return json(catalogue());
    }));
    const { result } = renderHook(() => useFieldJournal({ apiBaseUrl: API }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(() => result.current.authenticate("login", ACCOUNT.email, "password123"));

    expect(result.current.visited.has(PLACE.id)).toBe(true);
    expect(new Headers(writes[0]?.headers).get("Authorization")).toBe("Bearer fresh-token");
    expect(JSON.parse(window.localStorage.getItem(accountPendingKey(ACCOUNT.id, "visits")) ?? "{}")).toEqual({});
  });

  it("waits for an in-flight account write before applying an import snapshot", async () => {
    window.localStorage.setItem(ACCOUNT_TOKEN_KEY, "account-token");
    window.localStorage.setItem(JOURNAL_STORAGE.accountSnapshot, JSON.stringify({ account: ACCOUNT, visitedIds: [], completedTrailIds: [] }));
    window.localStorage.setItem(JOURNAL_STORAGE.guestVisited, JSON.stringify(["guest-park"]));
    const accountWrite = deferred<Response>();
    let importStarted = false;
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request) => {
      const path = String(url);
      if (path.endsWith(`/api/visits/${PLACE.id}`)) return accountWrite.promise;
      if (path.endsWith("/api/account/import-guest")) {
        importStarted = true;
        return json({ importedVisitCount: 1, importedTrailCount: 0, visitedIds: [PLACE.id, "guest-park"], completedTrailIds: [] });
      }
      if (path.endsWith("/api/auth/me")) return json({ account: ACCOUNT, visitedIds: [], completedTrailIds: [] });
      return json(catalogue());
    }));
    const { result } = renderHook(() => useFieldJournal({ apiBaseUrl: API }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    let pendingToggle!: Promise<void>;
    act(() => { pendingToggle = result.current.toggleVisit(PLACE.id); });
    let importing!: Promise<void>;
    act(() => { importing = result.current.importGuest(); });
    await Promise.resolve();
    expect(importStarted).toBe(false);

    await act(async () => {
      accountWrite.resolve(await json({ placeId: PLACE.id, visited: true, visitedCount: 1 }));
      await pendingToggle;
      await importing;
    });
    expect(importStarted).toBe(true);
    expect(result.current.visited).toEqual(new Set([PLACE.id, "guest-park"]));
    expect(JSON.parse(window.localStorage.getItem(accountPendingKey(ACCOUNT.id, "visits")) ?? "{}")).toEqual({});
  });

  it("does not let an old account write alter guest state after logout", async () => {
    window.localStorage.setItem(ACCOUNT_TOKEN_KEY, "account-token");
    window.localStorage.setItem(JOURNAL_STORAGE.accountSnapshot, JSON.stringify({ account: ACCOUNT, visitedIds: [], completedTrailIds: [] }));
    window.localStorage.setItem(JOURNAL_STORAGE.guestVisited, JSON.stringify(["guest-park"]));
    const accountWrite = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request) => {
      const path = String(url);
      if (path.endsWith(`/api/visits/${PLACE.id}`)) return accountWrite.promise;
      if (path.endsWith("/api/auth/logout")) return Promise.resolve(new Response(null, { status: 204 }));
      if (path.endsWith("/api/auth/me")) return json({ account: ACCOUNT, visitedIds: [], completedTrailIds: [] });
      return json(catalogue());
    }));
    const { result } = renderHook(() => useFieldJournal({ apiBaseUrl: API }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    let pendingToggle!: Promise<void>;
    act(() => { pendingToggle = result.current.toggleVisit(PLACE.id); });
    await act(() => result.current.logout());
    expect(result.current.authenticated).toBe(false);
    expect([...result.current.visited]).toEqual(["guest-park"]);
    await act(async () => {
      accountWrite.resolve(await json({ placeId: PLACE.id, visited: true, visitedCount: 1 }));
      await pendingToggle;
    });
    expect([...result.current.visited]).toEqual(["guest-park"]);
    expect(JSON.parse(window.localStorage.getItem(accountPendingKey(ACCOUNT.id, "visits")) ?? "{}")).toEqual({});
  });

  it("waits for an account write, then resets remote and cached progress without resurrection", async () => {
    window.localStorage.setItem(ACCOUNT_TOKEN_KEY, "account-token");
    window.localStorage.setItem(JOURNAL_STORAGE.accountSnapshot, JSON.stringify({ account: ACCOUNT, visitedIds: [], completedTrailIds: ["west_coast_trail"] }));
    const accountWrite = deferred<Response>();
    let resetStarted = false;
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith(`/api/visits/${PLACE.id}`)) return accountWrite.promise;
      if (path.endsWith("/api/account/progress")) {
        resetStarted = true;
        expect(init?.method).toBe("DELETE");
        expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer account-token");
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (path.endsWith("/api/auth/me")) return json({ account: ACCOUNT, visitedIds: [], completedTrailIds: ["west_coast_trail"] });
      return json(catalogue([], ["west_coast_trail"]));
    }));
    const { result } = renderHook(() => useFieldJournal({ apiBaseUrl: API }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.completedTrails).toEqual(new Set(["west_coast_trail"]));
    vi.useFakeTimers();

    let pendingToggle!: Promise<void>;
    act(() => { pendingToggle = result.current.toggleVisit(PLACE.id); });
    let resetting!: Promise<void>;
    act(() => { resetting = result.current.resetProgress(); });
    await Promise.resolve();
    expect(resetStarted).toBe(false);

    await act(async () => {
      accountWrite.resolve(await json({ placeId: PLACE.id, visited: true, visitedCount: 1, visitedAt: "2026-09-08T12:00:00Z" }));
      await pendingToggle;
      await resetting;
    });
    expect(resetStarted).toBe(true);
    expect(result.current.progressRevision).toBe(1);
    expect(result.current.visited).toEqual(new Set());
    expect(result.current.completedTrails).toEqual(new Set());
    expect(result.current.visitTimestamps).toEqual({});
    expect(JSON.parse(window.localStorage.getItem(accountPendingKey(ACCOUNT.id, "visits")) ?? "{}")).toEqual({});
    expect(JSON.parse(window.localStorage.getItem(JOURNAL_STORAGE.accountSnapshot) ?? "{}")).toMatchObject({ visitedIds: [], completedTrailIds: [], visitTimestamps: {} });
    expect(result.current.syncMessage).toBe("Your progress has been reset.");
    act(() => vi.advanceTimersByTime(3999));
    expect(result.current.syncMessage).toBe("Your progress has been reset.");
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.syncMessage).toBe("");
    expect(result.current.progressRevision).toBe(1);
  });

  it("resets remote progress before clearing account photo retry and restored camera state", async () => {
    window.localStorage.setItem(ACCOUNT_TOKEN_KEY, "account-token");
    window.localStorage.setItem(JOURNAL_STORAGE.accountSnapshot, JSON.stringify({ account: ACCOUNT, visitedIds: [], completedTrailIds: [] }));
    const resetCalls: string[] = [];
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request) => {
      const path = String(url);
      if (path.endsWith("/api/account/progress")) {
        resetCalls.push("remote");
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (path.endsWith("/api/auth/me")) return json({ account: ACCOUNT, visitedIds: [], completedTrailIds: [], visits: [] });
      return json(catalogue());
    }));
    nativePhoto.clearPhotoRetryOwner.mockImplementation(async () => { resetCalls.push("photo"); });
    nativeCamera.clearRestoredCameraPhoto.mockImplementation(async () => { resetCalls.push("camera"); });

    const { result } = renderHook(() => useFieldJournal({ apiBaseUrl: API }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { await result.current.resetProgress(); });

    expect(nativePhoto.clearPhotoRetryOwner).toHaveBeenCalledWith(`account:${ACCOUNT.id}`);
    expect(nativeCamera.clearRestoredCameraPhoto).toHaveBeenCalledWith();
    expect(resetCalls).toEqual(["remote", "photo", "camera"]);
    expect(result.current.syncMessage).toBe("Your progress has been reset.");
  });

  it("keeps the reset committed and exposes cleanup retry when local photo cleanup fails", async () => {
    window.localStorage.setItem(ACCOUNT_TOKEN_KEY, "account-token");
    window.localStorage.setItem(JOURNAL_STORAGE.accountSnapshot, JSON.stringify({ account: ACCOUNT, visitedIds: [], completedTrailIds: [] }));
    let remoteResetCalled = false;
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request) => {
      const path = String(url);
      if (path.endsWith("/api/account/progress")) {
        remoteResetCalled = true;
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (path.endsWith("/api/auth/me")) return json({ account: ACCOUNT, visitedIds: [], completedTrailIds: [], visits: [] });
      return json(catalogue());
    }));
    nativePhoto.clearPhotoRetryOwner.mockRejectedValueOnce(new Error("Private photo storage is busy."));

    const { result } = renderHook(() => useFieldJournal({ apiBaseUrl: API }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(() => result.current.resetProgress());

    expect(remoteResetCalled).toBe(true);
    expect(nativeCamera.clearRestoredCameraPhoto).toHaveBeenCalled();
    expect(result.current.visited).toEqual(new Set());
    expect(result.current.syncMessage).toMatch(/progress has been reset, but private device cleanup still needs a retry/i);
    expect(window.localStorage.getItem(JOURNAL_STORAGE.accountProgressResetCleanup)).not.toBeNull();
  });

  it("deletes owner-bound account state while preserving the separate guest journal", async () => {
    const guestPlace = "guest-park";
    window.localStorage.setItem(ACCOUNT_TOKEN_KEY, "account-token");
    window.localStorage.setItem(JOURNAL_STORAGE.guestVisited, JSON.stringify([guestPlace]));
    window.localStorage.setItem(JOURNAL_STORAGE.guestVisitTimestamps, JSON.stringify({ [guestPlace]: "2026-09-01T00:00:00Z" }));
    window.localStorage.setItem(JOURNAL_STORAGE.guestTrails, JSON.stringify(["guest-trail"]));
    window.localStorage.setItem(JOURNAL_STORAGE.accountSnapshot, JSON.stringify({ account: ACCOUNT, visitedIds: [PLACE.id], completedTrailIds: ["account-trail"], visits: [CLAIM_VISIT] }));
    window.localStorage.setItem(accountPendingKey(ACCOUNT.id, "visits"), JSON.stringify({ [PLACE.id]: { visited: true, revision: 4 } }));
    window.localStorage.setItem(accountPendingKey(ACCOUNT.id, "trails"), JSON.stringify({ trail: { visited: true, revision: 2 } }));
    window.localStorage.setItem(importedGuestKey(ACCOUNT.id), "7");
    let requestId = "";
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith("/api/auth/me")) return json({ account: ACCOUNT, visitedIds: [PLACE.id], completedTrailIds: ["account-trail"], visits: [CLAIM_VISIT] });
      if (path.endsWith("/api/account") && init?.method === "DELETE") {
        requestId = JSON.parse(String(init.body)).requestId;
        return json({ deleted: true, photoCleanupPending: false });
      }
      if (path.endsWith("/api/catalogue/state")) return json({ ...catalogue([PLACE.id], ["account-trail"]), visits: [CLAIM_VISIT] });
      throw new Error(`Unexpected request: ${url}`);
    }));

    const { result } = renderHook(() => useFieldJournal({ apiBaseUrl: API }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    let deletion: unknown;
    await act(async () => { deletion = await result.current.deleteAccount(); });

    expect(deletion).toEqual({ deleted: true, photoCleanupPending: false });
    expect(result.current.authenticated).toBe(false);
    expect(result.current.account).toBeNull();
    expect(result.current.visited).toEqual(new Set([guestPlace]));
    expect(result.current.completedTrails).toEqual(new Set(["guest-trail"]));
    expect(window.localStorage.getItem(ACCOUNT_TOKEN_KEY)).toBeNull();
    expect(window.localStorage.getItem(JOURNAL_STORAGE.accountSnapshot)).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(accountPendingKey(ACCOUNT.id, "visits")) ?? "null")).toEqual({});
    expect(JSON.parse(window.localStorage.getItem(accountPendingKey(ACCOUNT.id, "trails")) ?? "null")).toEqual({});
    expect(window.localStorage.getItem(importedGuestKey(ACCOUNT.id))).toBeNull();
    expect(window.localStorage.getItem(JOURNAL_STORAGE.accountDeletion)).toBeNull();
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(nativePhoto.clearPhotoRetryOwner).toHaveBeenCalledWith(`account:${ACCOUNT.id}`);
    expect(nativeCamera.clearRestoredCameraPhoto).toHaveBeenCalledTimes(1);
  });

  it("keeps the same deletion request after a lost response and never treats 401 as success", async () => {
    window.localStorage.setItem(ACCOUNT_TOKEN_KEY, "account-token");
    window.localStorage.setItem(JOURNAL_STORAGE.accountSnapshot, JSON.stringify({ account: ACCOUNT, visitedIds: [PLACE.id], completedTrailIds: [], visits: [] }));
    let deletionAttempts = 0;
    const requestIds: string[] = [];
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith("/api/auth/me")) return json({ account: ACCOUNT, visitedIds: [PLACE.id], completedTrailIds: [], visits: [] });
      if (path.endsWith("/api/account") && init?.method === "DELETE") {
        deletionAttempts += 1;
        requestIds.push(JSON.parse(String(init.body)).requestId);
        if (deletionAttempts === 1) return Promise.reject(new TypeError("connection lost after the request was sent"));
        return json({ detail: "Session is no longer valid." }, 401);
      }
      if (path.endsWith("/api/catalogue/state")) return json(catalogue([PLACE.id]));
      throw new Error(`Unexpected request: ${url}`);
    }));

    const { result } = renderHook(() => useFieldJournal({ apiBaseUrl: API }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { await expect(result.current.deleteAccount()).rejects.toThrow("Could not reach Parkdex"); });
    const pendingAfterLoss = JSON.parse(window.localStorage.getItem(JOURNAL_STORAGE.accountDeletion) ?? "null");
    expect(pendingAfterLoss).toMatchObject({ accountId: ACCOUNT.id, requestId: expect.any(String) });
    expect(pendingAfterLoss.confirmed).toBeUndefined();
    await act(async () => { await expect(result.current.deleteAccount()).rejects.toMatchObject({ status: 401 }); });

    expect(deletionAttempts).toBe(2);
    expect(requestIds[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(requestIds[1]).toBe(requestIds[0]);
    expect(result.current.authenticated).toBe(true);
    expect(result.current.account).toEqual(ACCOUNT);
    expect(window.localStorage.getItem(ACCOUNT_TOKEN_KEY)).toBe("account-token");
    expect(nativePhoto.clearPhotoRetryOwner).not.toHaveBeenCalled();
    expect(nativeCamera.clearRestoredCameraPhoto).not.toHaveBeenCalled();
  });

  it("replays one pending deletion request on boot and then clears the owner session", async () => {
    const requestId = "11111111-1111-4111-8111-111111111111";
    window.localStorage.setItem(ACCOUNT_TOKEN_KEY, "account-token");
    window.localStorage.setItem(JOURNAL_STORAGE.accountSnapshot, JSON.stringify({ account: ACCOUNT, visitedIds: [PLACE.id], completedTrailIds: [], visits: [] }));
    window.localStorage.setItem(accountPendingKey(ACCOUNT.id, "visits"), JSON.stringify({ [PLACE.id]: { visited: true, revision: 1 } }));
    window.localStorage.setItem(JOURNAL_STORAGE.accountDeletion, JSON.stringify({ accountId: ACCOUNT.id, requestId }));
    let deletionAttempts = 0;
    let accountLoads = 0;
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith("/api/account") && init?.method === "DELETE") {
        deletionAttempts += 1;
        expect(JSON.parse(String(init.body))).toEqual({ confirm: "DELETE_ACCOUNT", requestId });
        return json({ deleted: true, photoCleanupPending: true });
      }
      if (path.endsWith("/api/auth/me")) {
        accountLoads += 1;
        return json({ account: ACCOUNT, visitedIds: [PLACE.id], completedTrailIds: [], visits: [] });
      }
      if (path.endsWith("/api/catalogue/state")) return json(catalogue());
      throw new Error(`Unexpected request: ${url}`);
    }));

    const { result } = renderHook(() => useFieldJournal({ apiBaseUrl: API }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(deletionAttempts).toBe(1);
    expect(accountLoads).toBe(0);
    expect(result.current.authenticated).toBe(false);
    expect(result.current.account).toBeNull();
    expect(window.localStorage.getItem(ACCOUNT_TOKEN_KEY)).toBeNull();
    expect(window.localStorage.getItem(JOURNAL_STORAGE.accountDeletion)).toBeNull();
    expect(nativePhoto.clearPhotoRetryOwner).toHaveBeenCalledWith(`account:${ACCOUNT.id}`);
    expect(nativeCamera.clearRestoredCameraPhoto).toHaveBeenCalledTimes(1);
  });

  it("does not reuse another account's pending deletion intent", async () => {
    const otherAccount = { id: "account-two", email: "other@example.com" };
    window.localStorage.setItem(ACCOUNT_TOKEN_KEY, "account-two-token");
    window.localStorage.setItem(JOURNAL_STORAGE.accountSnapshot, JSON.stringify({ account: otherAccount, visitedIds: [], completedTrailIds: [] }));
    window.localStorage.setItem(JOURNAL_STORAGE.accountDeletion, JSON.stringify({ accountId: ACCOUNT.id, requestId: "11111111-1111-4111-8111-111111111111" }));
    const fetchMock = vi.fn((url: string | URL | Request, _init?: RequestInit) => {
      void _init;
      const path = String(url);
      if (path.endsWith("/api/auth/me")) return json({ account: otherAccount, visitedIds: [], completedTrailIds: [], visits: [] });
      if (path.endsWith("/api/catalogue/state")) return json(catalogue());
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useFieldJournal({ apiBaseUrl: API }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { await expect(result.current.deleteAccount()).rejects.toThrow("Another account deletion"); });

    expect(fetchMock.mock.calls.some(([url, init]) => String(url).endsWith("/api/account") && init?.method === "DELETE")).toBe(false);
    expect(result.current.account).toEqual(otherAccount);
    expect(result.current.authenticated).toBe(true);
    expect(window.localStorage.getItem(ACCOUNT_TOKEN_KEY)).toBe("account-two-token");
  });

  it("does not clear the current account's camera or retry state while recovering another owner", async () => {
    const otherAccount = { id: "account-two", email: "other@example.com" };
    window.localStorage.setItem(ACCOUNT_TOKEN_KEY, "account-two-token");
    window.localStorage.setItem(JOURNAL_STORAGE.accountSnapshot, JSON.stringify({ account: otherAccount, visitedIds: [], completedTrailIds: [] }));
    window.localStorage.setItem(JOURNAL_STORAGE.accountDeletion, JSON.stringify({ accountId: ACCOUNT.id, requestId: "11111111-1111-4111-8111-111111111111", confirmed: true, photoCleanupPending: false }));
    window.localStorage.setItem(accountPendingKey(ACCOUNT.id, "visits"), JSON.stringify({ old: { visited: true, revision: 1 } }));
    window.localStorage.setItem(accountPendingKey(otherAccount.id, "visits"), JSON.stringify({ current: { visited: true, revision: 2 } }));
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request) => {
      const path = String(url);
      if (path.endsWith("/api/auth/me")) return json({ account: otherAccount, visitedIds: [], completedTrailIds: [], visits: [] });
      if (path.endsWith("/api/catalogue/state")) return json(catalogue());
      throw new Error(`Unexpected request: ${url}`);
    }));

    const { result } = renderHook(() => useFieldJournal({ apiBaseUrl: API }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.account).toEqual(otherAccount);
    expect(result.current.authenticated).toBe(true);
    expect(JSON.parse(window.localStorage.getItem(accountPendingKey(otherAccount.id, "visits")) ?? "null")).toEqual({ current: { visited: true, revision: 2 } });
    expect(JSON.parse(window.localStorage.getItem(accountPendingKey(ACCOUNT.id, "visits")) ?? "null")).toEqual({});
    expect(window.localStorage.getItem(JOURNAL_STORAGE.accountDeletion)).toBeNull();
    expect(nativeCamera.clearRestoredCameraPhoto).not.toHaveBeenCalled();
    expect(nativePhoto.clearPhotoRetryOwner).toHaveBeenCalledWith(`account:${ACCOUNT.id}`);
  });

  it("rejects a photo completion that returns after account deletion", async () => {
    window.localStorage.setItem(ACCOUNT_TOKEN_KEY, "account-token");
    window.localStorage.setItem(JOURNAL_STORAGE.accountSnapshot, JSON.stringify({ account: ACCOUNT, visitedIds: [PLACE.id], completedTrailIds: [], visits: [CLAIM_VISIT] }));
    const photoResponse = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith("/api/auth/me")) return json({ account: ACCOUNT, visitedIds: [PLACE.id], completedTrailIds: [], visits: [CLAIM_VISIT] });
      if (path.endsWith("/api/catalogue/state")) return json({ ...catalogue([PLACE.id]), visits: [CLAIM_VISIT] });
      if (path.endsWith(`/api/visits/${PLACE.id}/photo`) && init?.method === "PUT") return photoResponse.promise;
      if (path.endsWith("/api/account") && init?.method === "DELETE") return json({ deleted: true, photoCleanupPending: false });
      throw new Error(`Unexpected request: ${url}`);
    }));

    const { result } = renderHook(() => useFieldJournal({ apiBaseUrl: API }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    let pendingPhoto!: Promise<void>;
    act(() => { pendingPhoto = result.current.uploadVisitPhoto!(PLACE.id, new File(["photo"], "visit.jpg", { type: "image/jpeg" })); });
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(`${API}/api/visits/${PLACE.id}/photo`, expect.anything()));

    await act(async () => { await result.current.deleteAccount(); });
    await act(async () => {
      photoResponse.resolve(new Response(null, { status: 204 }));
      await expect(pendingPhoto).rejects.toThrow("journal changed");
    });
    expect(result.current.authenticated).toBe(false);
    expect(result.current.account).toBeNull();
    expect(nativePhoto.clearPhotoRetryOwner).toHaveBeenCalledWith(`account:${ACCOUNT.id}`);
  });

  it("does not mark signed-in account A verified when confirming account B's token", async () => {
    const accountA = { ...ACCOUNT, emailVerified: false };
    window.localStorage.setItem(ACCOUNT_TOKEN_KEY, "account-a-token");
    window.localStorage.setItem(JOURNAL_STORAGE.accountSnapshot, JSON.stringify({ account: accountA, visitedIds: [], completedTrailIds: [] }));
    let accountLoads = 0;
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith("/api/auth/email-verification/confirm")) {
        expect(JSON.parse(String(init?.body))).toEqual({ token: "account-b-verification-token" });
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (path.endsWith("/api/auth/me")) {
        accountLoads += 1;
        expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer account-a-token");
        return json({ account: accountA, visitedIds: [], completedTrailIds: [] });
      }
      return json(catalogue());
    }));

    const { result } = renderHook(() => useFieldJournal({ apiBaseUrl: API }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(() => result.current.confirmEmailVerification("account-b-verification-token"));

    expect(accountLoads).toBe(2);
    expect(result.current.account).toEqual(accountA);
    expect(JSON.parse(window.localStorage.getItem(JOURNAL_STORAGE.accountSnapshot) ?? "{}").account).toEqual(accountA);
  });

  it("retains cached account identity offline but clears it after an explicit 401", async () => {
    const snapshot = JSON.stringify({ account: ACCOUNT, visitedIds: [PLACE.id], completedTrailIds: [] });
    window.localStorage.setItem(ACCOUNT_TOKEN_KEY, "account-token");
    window.localStorage.setItem(JOURNAL_STORAGE.accountSnapshot, snapshot);
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("offline"))));
    const offline = renderHook(() => useFieldJournal({ apiBaseUrl: API }));
    await waitFor(() => expect(offline.result.current.loading).toBe(false));
    expect(offline.result.current.authenticated).toBe(true);
    expect(offline.result.current.account).toEqual(ACCOUNT);
    expect(offline.result.current.visited.has(PLACE.id)).toBe(true);
    offline.unmount();

    window.localStorage.setItem(ACCOUNT_TOKEN_KEY, "expired-token");
    window.localStorage.setItem(JOURNAL_STORAGE.accountSnapshot, snapshot);
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request) => String(url).endsWith("/api/auth/me")
      ? json({ detail: "Invalid authentication credentials" }, 401)
      : json(catalogue())));
    const expired = renderHook(() => useFieldJournal({ apiBaseUrl: API }));
    await waitFor(() => expect(expired.result.current.loading).toBe(false));
    expect(expired.result.current.authenticated).toBe(false);
    expect(window.localStorage.getItem(ACCOUNT_TOKEN_KEY)).toBeNull();
  });

  it("expires the current account when an authenticated group request returns 401", async () => {
    window.localStorage.setItem(ACCOUNT_TOKEN_KEY, "account-token");
    window.localStorage.setItem(JOURNAL_STORAGE.accountSnapshot, JSON.stringify({ account: ACCOUNT, visitedIds: [], completedTrailIds: [] }));
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request) => {
      const path = String(url);
      if (path.endsWith("/api/auth/me")) return json({ account: ACCOUNT, visitedIds: [], completedTrailIds: [] });
      if (path.endsWith("/api/groups")) return json({ detail: "Invalid authentication credentials" }, 401);
      return json(catalogue());
    }));
    const { result } = renderHook(() => useFieldJournal({ apiBaseUrl: API }));
    await waitFor(() => expect(result.current.authenticated).toBe(true));

    await act(() => result.current.authenticatedRequest("/api/groups"));

    expect(result.current.authenticated).toBe(false);
    expect(result.current.account).toBeNull();
    expect(window.localStorage.getItem(ACCOUNT_TOKEN_KEY)).toBeNull();
    expect(result.current.syncMessage).toBe("Your session expired. Sign in again to continue syncing your account.");
  });

  it("waits for the startup capability before exposing a claim", async () => {
    window.localStorage.setItem(ACCOUNT_TOKEN_KEY, "account-token");
    window.localStorage.setItem(JOURNAL_STORAGE.accountSnapshot, JSON.stringify({ account: ACCOUNT, visitedIds: [], completedTrailIds: [] }));
    const accountSnapshot = deferred<Response>();
    const catalogueSnapshot = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request) => {
      const path = String(url);
      if (path.endsWith("/api/auth/me")) return accountSnapshot.promise;
      if (path.endsWith("/api/claims")) return json(CLAIM_CONFIRMATION);
      if (path.endsWith("/api/catalogue/state")) return catalogueSnapshot.promise;
      return json({});
    }));

    const { result } = renderHook(() => useFieldJournal({ apiBaseUrl: API }));
    await waitFor(() => expect(result.current.authenticated).toBe(true));
    expect(result.current.visitClaimMode).toBe("unknown");
    expect(result.current.createClaim).toBeUndefined();

    await act(async () => {
      accountSnapshot.resolve(await json({ account: ACCOUNT, visitedIds: [], completedTrailIds: [], visits: [] }));
      await Promise.resolve();
    });
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(`${API}/api/catalogue/state`, expect.anything()));
    await act(async () => {
      catalogueSnapshot.resolve(await json(catalogue()));
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.visitClaimMode).toBe("required");
    await act(() => result.current.createClaim!({ recommendationToken: "signed", expectedPlaceId: PLACE.id }));
    expect(result.current.visited.has(PLACE.id)).toBe(true);
    expect(result.current.visitMetadata[PLACE.id]).toEqual(CLAIM_VISIT);
  });

  it("does not expose claim methods while the catalogue capability is in flight", async () => {
    window.localStorage.setItem(ACCOUNT_TOKEN_KEY, "account-token");
    window.localStorage.setItem(JOURNAL_STORAGE.accountSnapshot, JSON.stringify({ account: ACCOUNT, visitedIds: [], completedTrailIds: [] }));
    const catalogueSnapshot = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request) => {
      const path = String(url);
      if (path.endsWith("/api/auth/me")) return json({ account: ACCOUNT, visitedIds: [], completedTrailIds: [], visits: [] });
      if (path.endsWith("/api/claims")) return json(CLAIM_CONFIRMATION);
      if (path.endsWith("/api/catalogue/state")) return catalogueSnapshot.promise;
      return json({});
    }));

    const { result } = renderHook(() => useFieldJournal({ apiBaseUrl: API }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(`${API}/api/catalogue/state`, expect.anything()));
    expect(result.current.createClaim).toBeUndefined();
    await act(async () => { catalogueSnapshot.resolve(await json(catalogue())); });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.createClaim).toBeTypeOf("function");
    await act(() => result.current.createClaim!({ recommendationToken: "signed", expectedPlaceId: PLACE.id }));
    expect(result.current.visited.has(PLACE.id)).toBe(true);
    expect(result.current.visitTimestamps[PLACE.id]).toBe(CLAIM_VISIT.visitedAt);
    expect(result.current.visitMetadata[PLACE.id]).toEqual(CLAIM_VISIT);
  });

  it("keeps offline claims durable across restart and marks a visit only after server acknowledgement", async () => {
    window.localStorage.setItem(ACCOUNT_TOKEN_KEY, "account-token");
    window.localStorage.setItem(JOURNAL_STORAGE.accountSnapshot, JSON.stringify({ account: ACCOUNT, visitedIds: [], completedTrailIds: [], visits: [] }));
    const bundle = offlinePlaceBundle();
    recentPlaceCache.get.mockImplementation(async (placeId: string) => placeId === PLACE.id ? bundle : null);
    recentPlaceCache.list.mockResolvedValue([bundle]);
    let apiReachable = true;
    const offlineClaimRequests: RequestInit[] = [];
    const fetchMock = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      if (!apiReachable) return Promise.reject(new TypeError("offline"));
      if (path.endsWith("/api/auth/me")) return json({ account: ACCOUNT, visitedIds: [], completedTrailIds: [], visits: [] });
      if (path.endsWith("/api/catalogue/state")) return json(offlineCatalogue());
      if (path.endsWith("/api/offline-claim-grants")) return json({
        grantToken: "offline-grant-v1",
        issuedAt: new Date(Date.now() - 1_000).toISOString(),
        expiresAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1_000).toISOString(),
        boundaryVersion: "v1",
      });
      if (path.endsWith("/api/offline-claims")) {
        offlineClaimRequests.push(init ?? {});
        return json(CLAIM_CONFIRMATION);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const first = renderHook(() => useFieldJournal({ apiBaseUrl: API }));
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`${API}/api/offline-claim-grants`, expect.anything()));

    setNavigatorOnline(false);
    let recommendation!: Awaited<ReturnType<NonNullable<typeof first.result.current.recommendClaim>>>;
    await act(async () => {
      recommendation = await first.result.current.recommendClaim!({
        location: { latitude: 49, longitude: -124, accuracyMeters: 8, capturedAtEpochMs: Date.now() - 1_000 },
      });
    });
    expect(recommendation.status).toBe("recommended");
    if (recommendation.status !== "recommended") throw new Error("Expected an offline recommendation.");
    const recommended = recommendation as Extract<typeof recommendation, { status: "recommended" }>;
    let localConfirmation!: Awaited<ReturnType<NonNullable<typeof first.result.current.createClaim>>>;
    await act(async () => {
      localConfirmation = await first.result.current.createClaim!({
        recommendationToken: recommended.recommendationToken,
        expectedPlaceId: PLACE.id,
      });
    });
    expect(localConfirmation.pendingSync).toBe(true);
    expect(first.result.current.visited.has(PLACE.id)).toBe(false);
    expect(first.result.current.visitMetadata[PLACE.id]).toBeUndefined();
    await waitFor(() => expect(first.result.current.pendingClaims).toBe(1));
    let retryFailure!: Promise<void>;
    await act(async () => {
      retryFailure = first.result.current.retryPendingClaims();
      await retryFailure.catch(() => undefined);
    });
    await expect(retryFailure).rejects.toThrow(/waiting for a connection/i);
    expect(first.result.current.pendingClaims).toBe(1);
    await act(() => first.result.current.logout());
    expect(first.result.current.authenticated).toBe(true);
    expect(window.localStorage.getItem(ACCOUNT_TOKEN_KEY)).toBe("account-token");
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/api/auth/logout"))).toBe(false);
    expect(first.result.current.syncMessage).toMatch(/offline visit is still waiting to sync/i);
    first.unmount();

    apiReachable = false;
    const restarted = renderHook(() => useFieldJournal({ apiBaseUrl: API }));
    await waitFor(() => expect(restarted.result.current.loading).toBe(false));
    await waitFor(() => expect(restarted.result.current.pendingClaims).toBe(1));
    expect(restarted.result.current.visited.has(PLACE.id)).toBe(false);

    apiReachable = true;
    setNavigatorOnline(true);
    await act(async () => { window.dispatchEvent(new Event("online")); });
    await waitFor(() => expect(restarted.result.current.visited.has(PLACE.id)).toBe(true));
    await waitFor(() => expect(restarted.result.current.pendingClaims).toBe(0));
    expect(restarted.result.current.visitMetadata[PLACE.id]).toEqual(CLAIM_VISIT);
    expect(offlineClaimRequests).toHaveLength(1);
    expect(new Headers(offlineClaimRequests[0].headers).get("Authorization")).toBe("Bearer account-token");
  });

  it("does not recommend an already visited park for another offline claim", async () => {
    window.localStorage.setItem(ACCOUNT_TOKEN_KEY, "account-token");
    window.localStorage.setItem(JOURNAL_STORAGE.accountSnapshot, JSON.stringify({
      account: ACCOUNT,
      visitedIds: [PLACE.id],
      completedTrailIds: [],
      visits: [CLAIM_VISIT],
    }));
    const bundle = offlinePlaceBundle();
    recentPlaceCache.get.mockImplementation(async (placeId: string) => placeId === PLACE.id ? bundle : null);
    recentPlaceCache.list.mockResolvedValue([bundle]);
    const fetchMock = vi.fn((url: string | URL | Request) => {
      const path = String(url);
      if (path.endsWith("/api/auth/me")) return json({ account: ACCOUNT, visitedIds: [PLACE.id], completedTrailIds: [], visits: [CLAIM_VISIT] });
      if (path.endsWith("/api/catalogue/state")) return json(offlineCatalogue([PLACE.id]));
      if (path.endsWith("/api/offline-claim-grants")) return json({
        grantToken: "offline-grant-v1",
        issuedAt: new Date(Date.now() - 1_000).toISOString(),
        expiresAt: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
        boundaryVersion: "v1",
      });
      return json(offlineCatalogue([PLACE.id]));
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useFieldJournal({ apiBaseUrl: API }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`${API}/api/offline-claim-grants`, expect.anything()));
    setNavigatorOnline(false);

    let recommendation!: Awaited<ReturnType<NonNullable<typeof result.current.recommendClaim>>>;
    await act(async () => {
      recommendation = await result.current.recommendClaim!({
        location: { latitude: 49, longitude: -124, accuracyMeters: 8, capturedAtEpochMs: Date.now() - 1_000 },
      });
    });

    expect(recommendation).toEqual({ status: "none" });
    expect(result.current.visited.has(PLACE.id)).toBe(true);
  });

  it("discards only rejected offline claims and keeps active photo drafts queued", async () => {
    setNavigatorOnline(false);
    window.localStorage.setItem(ACCOUNT_TOKEN_KEY, "account-token");
    window.localStorage.setItem(JOURNAL_STORAGE.accountSnapshot, JSON.stringify({
      account: ACCOUNT,
      visitedIds: [],
      completedTrailIds: [],
      visits: [],
    }));
    const queueKey = offlineQueueStorageKey();
    const base = storedOfflineQueue().items[0];
    const rejected = {
      ...base,
      requestId: "offline-rejected-one",
      state: "rejected",
      photoState: "pending",
      lastError: "The server rejected this saved visit.",
    };
    const pending = {
      ...base,
      requestId: "offline-pending-one",
      state: "pending",
      photoState: "pending",
    };
    window.localStorage.setItem(queueKey, JSON.stringify(storedOfflineQueue([rejected, pending])));
    const photoRetry = {
      save: vi.fn(async () => undefined),
      load: vi.fn(async () => null),
      remove: vi.fn(async () => undefined),
      clearOwner: vi.fn(async () => undefined),
    };
    nativePhoto.getNativeCapabilities.mockReturnValue({ photoRetry });
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request) => {
      const path = String(url);
      if (path.endsWith("/api/auth/me")) return json({ account: ACCOUNT, visitedIds: [], completedTrailIds: [], visits: [] });
      return json(offlineCatalogue());
    }));

    const { result } = renderHook(() => useFieldJournal({ apiBaseUrl: API }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() => {
      expect(result.current.pendingClaims).toBe(1);
      expect(result.current.rejectedClaimCount).toBe(1);
    });
    expect(result.current.visited.has(PLACE.id)).toBe(false);

    let removed!: number;
    await act(async () => { removed = await result.current.discardRejectedClaims(); });

    expect(removed).toBe(1);
    expect(result.current.pendingClaims).toBe(1);
    expect(result.current.rejectedClaimCount).toBe(0);
    expect(result.current.visited.has(PLACE.id)).toBe(false);
    expect(photoRetry.remove).not.toHaveBeenCalled();
    const saved = JSON.parse(window.localStorage.getItem(queueKey) ?? "{}") as { items?: Array<{ requestId: string; state: string; photoState: string }> };
    expect(saved.items).toEqual([expect.objectContaining({
      requestId: "offline-pending-one",
      state: "pending",
      photoState: "pending",
    })]);
  });

  it("cancels only the undone place after saving its false intent and clears its ambiguous marker", async () => {
    setNavigatorOnline(false);
    window.localStorage.setItem(ACCOUNT_TOKEN_KEY, "account-token");
    window.localStorage.setItem(JOURNAL_STORAGE.accountSnapshot, JSON.stringify({
      account: ACCOUNT,
      visitedIds: [PLACE.id],
      completedTrailIds: [],
      visits: [CLAIM_VISIT],
    }));
    const queueKey = offlineQueueStorageKey();
    const samePlace = storedConfirmedOfflineItem({ photoState: "retry" });
    const otherPlace = {
      ...storedOfflineQueue().items[0],
      requestId: "offline-other-place",
      placeId: "other-park",
      state: "pending",
      pendingConfirmation: { ...CLAIM_CONFIRMATION, placeId: "other-park", pendingSync: true },
    };
    window.localStorage.setItem(queueKey, JSON.stringify(storedOfflineQueue([samePlace, otherPlace])));
    const photoRetry = {
      save: vi.fn(async () => undefined),
      load: vi.fn(async () => null),
      remove: vi.fn(async () => undefined),
      clearOwner: vi.fn(async () => undefined),
    };
    nativePhoto.getNativeCapabilities.mockReturnValue({ photoRetry });
    const recoveryKey = `parkdex:claim-recovery:v1:${encodeURIComponent(`account:${ACCOUNT.id}`)}`;
    await markUnresolvedClaim(`account:${ACCOUNT.id}`, PLACE.id, true);
    let queueAtUndo: string[] = [];
    const cancelOrdering: string[] = [];
    const originalSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === accountPendingKey(ACCOUNT.id, "visits")
        && JSON.parse(value)[PLACE.id]?.visited === false) cancelOrdering.push("false-intent");
      if (key === queueKey && !(JSON.parse(value).items as Array<{ placeId: string }>).some((item) => item.placeId === PLACE.id)) {
        cancelOrdering.push("queue-cancelled");
      }
      return originalSetItem.call(this, key, value);
    });
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith("/api/auth/me")) return json({ account: ACCOUNT, visitedIds: [PLACE.id], completedTrailIds: [], visits: [CLAIM_VISIT] });
      if (path.endsWith("/api/catalogue/state")) return json(offlineCatalogue([PLACE.id]));
      if (path.endsWith(`/api/visits/${PLACE.id}`) && init?.method === "PUT") {
        queueAtUndo = (JSON.parse(window.localStorage.getItem(queueKey) ?? "{}").items ?? []).map((item: { placeId: string }) => item.placeId);
        return json({ detail: { message: "Temporarily offline" } }, 503);
      }
      return json(offlineCatalogue());
    }));

    const { result } = renderHook(() => useFieldJournal({ apiBaseUrl: API }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.visited.has(PLACE.id)).toBe(true);
    await act(() => result.current.toggleVisit(PLACE.id));

    expect(result.current.visited.has(PLACE.id)).toBe(false);
    expect(cancelOrdering.indexOf("false-intent")).toBeLessThan(cancelOrdering.indexOf("queue-cancelled"));
    expect(queueAtUndo).toEqual(["other-park"]);
    expect(JSON.parse(window.localStorage.getItem(accountPendingKey(ACCOUNT.id, "visits")) ?? "{}")[PLACE.id])
      .toMatchObject({ visited: false });
    expect(window.localStorage.getItem(recoveryKey)).toBeNull();
    expect(photoRetry.remove).not.toHaveBeenCalled();
    expect(JSON.parse(window.localStorage.getItem(queueKey) ?? "{}").items.map((item: { placeId: string }) => item.placeId))
      .toEqual(["other-park"]);
  });

  it("cancels hydrated offline claims before replaying a saved visit undo", async () => {
    setNavigatorOnline(true);
    window.localStorage.setItem(ACCOUNT_TOKEN_KEY, "account-token");
    window.localStorage.setItem(JOURNAL_STORAGE.accountSnapshot, JSON.stringify({
      account: ACCOUNT,
      visitedIds: [PLACE.id],
      completedTrailIds: [],
      visits: [CLAIM_VISIT],
    }));
    const queueKey = offlineQueueStorageKey();
    window.localStorage.setItem(queueKey, JSON.stringify(storedOfflineQueue([
      storedConfirmedOfflineItem({ photoState: "retry" }),
    ])));
    window.localStorage.setItem(accountPendingKey(ACCOUNT.id, "visits"), JSON.stringify({
      [PLACE.id]: { visited: false, revision: 2 },
    }));
    const photoRetry = {
      save: vi.fn(async () => undefined),
      load: vi.fn(async () => null),
      remove: vi.fn(async () => undefined),
      clearOwner: vi.fn(async () => undefined),
    };
    nativePhoto.getNativeCapabilities.mockReturnValue({ photoRetry });
    const recoveryKey = `parkdex:claim-recovery:v1:${encodeURIComponent(`account:${ACCOUNT.id}`)}`;
    await markUnresolvedClaim(`account:${ACCOUNT.id}`, PLACE.id, true);
    let queueAtUndo: string[] = [];
    const claimRequests: string[] = [];
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith("/api/auth/me")) return json({ account: ACCOUNT, visitedIds: [PLACE.id], completedTrailIds: [], visits: [CLAIM_VISIT] });
      if (path.endsWith("/api/catalogue/state")) return json(offlineCatalogue([PLACE.id]));
      if (path.endsWith(`/api/visits/${PLACE.id}`) && init?.method === "PUT") {
        queueAtUndo = (JSON.parse(window.localStorage.getItem(queueKey) ?? "{}").items ?? []).map((item: { placeId: string }) => item.placeId);
        return json({ visited: false, visitedAt: null });
      }
      if (path.endsWith("/api/offline-claims")) {
        claimRequests.push(path);
        return json(CLAIM_CONFIRMATION);
      }
      return json(offlineCatalogue());
    }));

    const { result } = renderHook(() => useFieldJournal({ apiBaseUrl: API }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem(accountPendingKey(ACCOUNT.id, "visits")) ?? "{}"))
      .toEqual({}));

    expect(queueAtUndo).toEqual([]);
    expect(claimRequests).toEqual([]);
    expect(JSON.parse(window.localStorage.getItem(queueKey) ?? "{}").items ?? []).toEqual([]);
    expect(window.localStorage.getItem(recoveryKey)).toBeNull();
    expect(photoRetry.remove).not.toHaveBeenCalled();
    expect(result.current.visited.has(PLACE.id)).toBe(false);
    expect(result.current.visitMetadata[PLACE.id]).toBeUndefined();
  });

  it("does not let an in-flight offline confirmation re-add a place being undone", async () => {
    setNavigatorOnline(true);
    window.localStorage.setItem(ACCOUNT_TOKEN_KEY, "account-token");
    window.localStorage.setItem(JOURNAL_STORAGE.accountSnapshot, JSON.stringify({
      account: ACCOUNT,
      visitedIds: [PLACE.id],
      completedTrailIds: [],
      visits: [CLAIM_VISIT],
    }));
    storeOfflineGrant();
    window.localStorage.setItem(offlineQueueStorageKey(), JSON.stringify(storedOfflineQueue([{
      ...storedOfflineQueue().items[0],
      requestId: "offline-in-flight-one",
      photoState: "none",
    }])));
    const receipt = deferred<Response>();
    let undoCalls = 0;
    const claimCalls: RequestInit[] = [];
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith("/api/auth/me")) return json({ account: ACCOUNT, visitedIds: [PLACE.id], completedTrailIds: [], visits: [CLAIM_VISIT] });
      if (path.endsWith("/api/catalogue/state")) return json(offlineCatalogue([PLACE.id]));
      if (path.endsWith("/api/offline-claims")) {
        claimCalls.push(init ?? {});
        return receipt.promise;
      }
      if (path.endsWith(`/api/visits/${PLACE.id}`) && init?.method === "PUT") {
        undoCalls += 1;
        return json({ visited: false, visitedAt: null });
      }
      return json(offlineCatalogue([PLACE.id]));
    }));

    const { result } = renderHook(() => useFieldJournal({ apiBaseUrl: API }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() => expect(claimCalls).toHaveLength(1));

    let pendingUndo!: Promise<void>;
    act(() => { pendingUndo = result.current.toggleVisit(PLACE.id); });
    await waitFor(() => {
      expect(result.current.visited.has(PLACE.id)).toBe(false);
      expect(JSON.parse(window.localStorage.getItem(accountPendingKey(ACCOUNT.id, "visits")) ?? "{}")[PLACE.id])
        .toMatchObject({ visited: false });
    });
    expect(undoCalls).toBe(0);

    await act(async () => {
      receipt.resolve(await json(CLAIM_CONFIRMATION));
      await pendingUndo;
    });

    expect(undoCalls).toBe(1);
    expect(result.current.visited.has(PLACE.id)).toBe(false);
    expect(result.current.visitMetadata[PLACE.id]).toBeUndefined();
    expect(JSON.parse(window.localStorage.getItem(offlineQueueStorageKey()) ?? "{}").items ?? []).toEqual([]);
  });

  it("cancels queued photo retry before remote photo removal while keeping its confirmed visit", async () => {
    setNavigatorOnline(false);
    window.localStorage.setItem(ACCOUNT_TOKEN_KEY, "account-token");
    const visitWithPhoto: Visit = {
      ...CLAIM_VISIT,
      claim: { ...CLAIM_VISIT.claim, hasPhoto: true },
    };
    window.localStorage.setItem(JOURNAL_STORAGE.accountSnapshot, JSON.stringify({
      account: ACCOUNT,
      visitedIds: [PLACE.id],
      completedTrailIds: [],
      visits: [visitWithPhoto],
    }));
    const queueKey = offlineQueueStorageKey();
    const samePlace = storedConfirmedOfflineItem({ photoState: "retry" });
    const otherPlace = {
      ...storedOfflineQueue().items[0],
      requestId: "offline-other-place",
      placeId: "other-park",
      state: "pending",
      pendingConfirmation: { ...CLAIM_CONFIRMATION, placeId: "other-park", pendingSync: true },
    };
    window.localStorage.setItem(queueKey, JSON.stringify(storedOfflineQueue([samePlace, otherPlace])));
    const sequence: string[] = [];
    const photoRetry = {
      save: vi.fn(async () => undefined),
      load: vi.fn(async () => null),
      remove: vi.fn(async () => { sequence.push("local-photo"); }),
      clearOwner: vi.fn(async () => undefined),
    };
    nativePhoto.getNativeCapabilities.mockReturnValue({ photoRetry });
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith("/api/auth/me")) return json({ account: ACCOUNT, visitedIds: [PLACE.id], completedTrailIds: [], visits: [visitWithPhoto] });
      if (path.endsWith("/api/catalogue/state")) return json({ ...offlineCatalogue([PLACE.id]), visits: [visitWithPhoto] });
      if (path.endsWith(`/api/visits/${PLACE.id}/photo`) && init?.method === "DELETE") {
        sequence.push("remote-photo");
        const rows = JSON.parse(window.localStorage.getItem(queueKey) ?? "{}").items as Array<{ placeId: string; state: string; photoState: string }>;
        expect(rows).toEqual([
          expect.objectContaining({ placeId: PLACE.id, state: "confirmed", photoState: "none" }),
          expect.objectContaining({ placeId: "other-park", state: "pending" }),
        ]);
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return json(offlineCatalogue([PLACE.id]));
    }));

    const { result } = renderHook(() => useFieldJournal({ apiBaseUrl: API }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(() => result.current.removeVisitPhoto!(PLACE.id));

    expect(sequence).toEqual(["local-photo", "remote-photo"]);
    expect(result.current.visited.has(PLACE.id)).toBe(true);
    expect(result.current.visitMetadata[PLACE.id].claim?.hasPhoto).toBe(false);
  });

  it("skips remote photo deletion when private retry bytes cannot be removed", async () => {
    setNavigatorOnline(false);
    window.localStorage.setItem(ACCOUNT_TOKEN_KEY, "account-token");
    const visitWithPhoto: Visit = {
      ...CLAIM_VISIT,
      claim: { ...CLAIM_VISIT.claim, hasPhoto: true },
    };
    window.localStorage.setItem(JOURNAL_STORAGE.accountSnapshot, JSON.stringify({
      account: ACCOUNT,
      visitedIds: [PLACE.id],
      completedTrailIds: [],
      visits: [visitWithPhoto],
    }));
    const queueKey = offlineQueueStorageKey();
    window.localStorage.setItem(queueKey, JSON.stringify(storedOfflineQueue([
      storedConfirmedOfflineItem({ photoState: "retry" }),
    ])));
    const photoRetry = {
      save: vi.fn(async () => undefined),
      load: vi.fn(async () => null),
      remove: vi.fn(async () => { throw new Error("Private photo storage is busy."); }),
      clearOwner: vi.fn(async () => undefined),
    };
    nativePhoto.getNativeCapabilities.mockReturnValue({ photoRetry });
    let remoteDeletes = 0;
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith("/api/auth/me")) return json({ account: ACCOUNT, visitedIds: [PLACE.id], completedTrailIds: [], visits: [visitWithPhoto] });
      if (path.endsWith("/api/catalogue/state")) return json({ ...offlineCatalogue([PLACE.id]), visits: [visitWithPhoto] });
      if (path.endsWith(`/api/visits/${PLACE.id}/photo`) && init?.method === "DELETE") {
        remoteDeletes += 1;
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return json(offlineCatalogue([PLACE.id]));
    }));

    const { result } = renderHook(() => useFieldJournal({ apiBaseUrl: API }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    let removal!: Promise<void>;
    await act(async () => {
      removal = result.current.removeVisitPhoto!(PLACE.id);
      await removal.catch(() => undefined);
    });

    await expect(removal).rejects.toThrow("Private photo storage is busy.");
    expect(photoRetry.remove).toHaveBeenCalledWith(`account:${ACCOUNT.id}`, PLACE.id);
    expect(remoteDeletes).toBe(0);
    expect(JSON.parse(window.localStorage.getItem(queueKey) ?? "{}").items).toEqual([
      expect.objectContaining({ placeId: PLACE.id, state: "confirmed", photoState: "none" }),
    ]);
    expect(result.current.visited.has(PLACE.id)).toBe(true);
    expect(result.current.visitMetadata[PLACE.id].claim?.hasPhoto).toBe(true);
  });

  it("keeps the offline claim and photo queue when a server progress reset fails", async () => {
    setNavigatorOnline(false);
    window.localStorage.setItem(ACCOUNT_TOKEN_KEY, "account-token");
    window.localStorage.setItem(JOURNAL_STORAGE.accountSnapshot, JSON.stringify({ account: ACCOUNT, visitedIds: [PLACE.id], completedTrailIds: [], visits: [CLAIM_VISIT] }));
    const queueKey = offlineQueueStorageKey();
    window.localStorage.setItem(queueKey, JSON.stringify(storedOfflineQueue()));
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request) => {
      const path = String(url);
      if (path.endsWith("/api/auth/me")) return json({ account: ACCOUNT, visitedIds: [PLACE.id], completedTrailIds: [], visits: [CLAIM_VISIT] });
      if (path.endsWith("/api/account/progress")) return json({ detail: { message: "Temporary reset failure" } }, 503);
      return json(catalogue([PLACE.id]));
    }));

    const { result } = renderHook(() => useFieldJournal({ apiBaseUrl: API }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() => expect(result.current.pendingClaims).toBe(1));

    let resetFailure!: Promise<void>;
    await act(async () => {
      resetFailure = result.current.resetProgress();
      await resetFailure.catch(() => undefined);
    });
    await expect(resetFailure).rejects.toThrow();

    expect(result.current.visited.has(PLACE.id)).toBe(true);
    expect(window.localStorage.getItem(queueKey)).not.toBeNull();
    expect(nativePhoto.clearPhotoRetryOwner).not.toHaveBeenCalled();
  });

  it("does not restore old journal progress when reset cleanup fails after server confirmation", async () => {
    setNavigatorOnline(false);
    window.localStorage.setItem(ACCOUNT_TOKEN_KEY, "account-token");
    window.localStorage.setItem(JOURNAL_STORAGE.accountSnapshot, JSON.stringify({ account: ACCOUNT, visitedIds: [PLACE.id], completedTrailIds: [], visits: [CLAIM_VISIT] }));
    const queueKey = offlineQueueStorageKey();
    const recoveryKey = `parkdex:claim-recovery:v1:${encodeURIComponent(`account:${ACCOUNT.id}`)}`;
    window.localStorage.setItem(queueKey, JSON.stringify(storedOfflineQueue()));
    await markUnresolvedClaim(`account:${ACCOUNT.id}`, PLACE.id, true);
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith("/api/auth/me")) return json({ account: ACCOUNT, visitedIds: [PLACE.id], completedTrailIds: [], visits: [CLAIM_VISIT] });
      if (path.endsWith("/api/account/progress") && init?.method === "DELETE") return Promise.resolve(new Response(null, { status: 204 }));
      return json(catalogue([PLACE.id]));
    }));

    const { result } = renderHook(() => useFieldJournal({ apiBaseUrl: API }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() => expect(result.current.pendingClaims).toBe(1));
    let failQueueRemoval = true;
    const originalRemoveItem = Storage.prototype.removeItem;
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(function (this: Storage, key: string) {
      if (key === queueKey && failQueueRemoval) {
        failQueueRemoval = false;
        throw new Error("Offline queue storage is busy.");
      }
      return originalRemoveItem.call(this, key);
    });

    await act(() => result.current.resetProgress());

    expect(result.current.visited).toEqual(new Set());
    expect(result.current.visitMetadata).toEqual({});
    expect(result.current.syncMessage).toMatch(/progress has been reset, but private device cleanup still needs a retry/i);
    expect(window.localStorage.getItem(queueKey)).not.toBeNull();
    expect(window.localStorage.getItem(recoveryKey)).not.toBeNull();
    expect(JSON.parse(window.localStorage.getItem(JOURNAL_STORAGE.accountSnapshot) ?? "{}").visitedIds).toEqual([]);
    expect(window.localStorage.getItem(JOURNAL_STORAGE.accountProgressResetCleanup)).not.toBeNull();

    await act(() => result.current.retrySync());
    expect(window.localStorage.getItem(queueKey)).toBeNull();
    expect(window.localStorage.getItem(recoveryKey)).toBeNull();
    expect(window.localStorage.getItem(JOURNAL_STORAGE.accountProgressResetCleanup)).toBeNull();
    expect(nativePhoto.clearPhotoRetryOwner).toHaveBeenCalledWith(`account:${ACCOUNT.id}`);
    expect(result.current.visited).toEqual(new Set());
  });

  it("preserves unresolved claim recovery and retry photos across successful sign-out", async () => {
    window.localStorage.setItem(ACCOUNT_TOKEN_KEY, "account-token");
    window.localStorage.setItem(JOURNAL_STORAGE.accountSnapshot, JSON.stringify({ account: ACCOUNT, visitedIds: [], completedTrailIds: [], visits: [] }));
    const recoveryKey = `parkdex:claim-recovery:v1:${encodeURIComponent(`account:${ACCOUNT.id}`)}`;
    await markUnresolvedClaim(`account:${ACCOUNT.id}`, PLACE.id, true);
    const fetchMock = vi.fn((url: string | URL | Request) => {
      const path = String(url);
      if (path.endsWith("/api/auth/me")) return json({ account: ACCOUNT, visitedIds: [], completedTrailIds: [], visits: [] });
      if (path.endsWith("/api/auth/logout")) return Promise.resolve(new Response(null, { status: 204 }));
      return json(catalogue());
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useFieldJournal({ apiBaseUrl: API }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(() => result.current.logout());

    expect(result.current.authenticated).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/api/auth/logout"))).toBe(true);
    expect(window.localStorage.getItem(recoveryKey)).not.toBeNull();
    expect(nativePhoto.clearPhotoRetryOwner).not.toHaveBeenCalled();
  });

  it("durably rolls back location_claim_required so an offline restart stays unvisited", async () => {
    window.localStorage.setItem(ACCOUNT_TOKEN_KEY, "account-token");
    window.localStorage.setItem(JOURNAL_STORAGE.accountSnapshot, JSON.stringify({ account: ACCOUNT, visitedIds: [], completedTrailIds: [], visits: [] }));
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith("/api/auth/me")) return json({ account: ACCOUNT, visitedIds: [], completedTrailIds: [], visits: [] });
      if (path.endsWith(`/api/visits/${PLACE.id}`) && init?.method === "PUT") {
        return json({ detail: { code: "location_claim_required", message: "A current location claim is required" } }, 409);
      }
      return json(catalogue());
    }));

    const mounted = renderHook(() => useFieldJournal({ apiBaseUrl: API }));
    await waitFor(() => expect(mounted.result.current.loading).toBe(false));
    await act(() => mounted.result.current.toggleVisit(PLACE.id));

    const saved = JSON.parse(window.localStorage.getItem(JOURNAL_STORAGE.accountSnapshot) ?? "{}");
    expect(mounted.result.current.visited.has(PLACE.id)).toBe(false);
    expect(mounted.result.current.visitMetadata[PLACE.id]).toBeUndefined();
    expect(saved.visitedIds).toEqual([]);
    expect(saved.visits).toEqual([]);
    mounted.unmount();

    const restarted = renderHook(() => useFieldJournal({ apiBaseUrl: "" }));
    await waitFor(() => expect(restarted.result.current.loading).toBe(false));
    expect(restarted.result.current.visited.has(PLACE.id)).toBe(false);
    expect(restarted.result.current.visitMetadata[PLACE.id]).toBeUndefined();
  });

  it("rolls back a pre-upgrade account queue during startup and clears it durably", async () => {
    window.localStorage.setItem(ACCOUNT_TOKEN_KEY, "account-token");
    window.localStorage.setItem(JOURNAL_STORAGE.accountSnapshot, JSON.stringify({
      account: ACCOUNT,
      visitedIds: [PLACE.id],
      completedTrailIds: [],
      visits: [CLAIM_VISIT],
    }));
    // Boolean entries were written by the pre-revision outbox format.
    window.localStorage.setItem(accountPendingKey(ACCOUNT.id, "visits"), JSON.stringify({ [PLACE.id]: true }));
    const writes: RequestInit[] = [];
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith("/api/auth/me")) return json({ account: ACCOUNT, visitedIds: [], completedTrailIds: [], visits: [] });
      if (path.endsWith(`/api/visits/${PLACE.id}`)) {
        writes.push(init ?? {});
        return json({ detail: { code: "location_claim_required", message: "A current location claim is required" } }, 409);
      }
      return json(catalogue());
    }));

    const { result } = renderHook(() => useFieldJournal({ apiBaseUrl: API }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() => expect(writes).toHaveLength(1));

    expect(result.current.visited.has(PLACE.id)).toBe(false);
    expect(result.current.visitMetadata[PLACE.id]).toBeUndefined();
    expect(JSON.parse(window.localStorage.getItem(accountPendingKey(ACCOUNT.id, "visits")) ?? "{}"))
      .toEqual({});
    expect(JSON.parse(window.localStorage.getItem(JOURNAL_STORAGE.accountSnapshot) ?? "{}")).toMatchObject({
      visitedIds: [],
      visits: [],
    });
  });

  it("does not let a stale guest claim-required queue block guest import", async () => {
    window.localStorage.setItem(ACCOUNT_TOKEN_KEY, "account-token");
    window.localStorage.setItem(JOURNAL_STORAGE.accountSnapshot, JSON.stringify({ account: ACCOUNT, visitedIds: [], completedTrailIds: [], visits: [] }));
    window.localStorage.setItem(JOURNAL_STORAGE.guestVisited, JSON.stringify([PLACE.id]));
    window.localStorage.setItem(JOURNAL_STORAGE.guestVisitMetadata, JSON.stringify({ [PLACE.id]: CLAIM_VISIT }));
    window.localStorage.setItem(JOURNAL_STORAGE.guestVisitPending, JSON.stringify({ [PLACE.id]: true }));
    let importStarted = false;
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith("/api/auth/me")) return json({ account: ACCOUNT, visitedIds: [], completedTrailIds: [], visits: [] });
      if (path.endsWith(`/api/visits/${PLACE.id}`)) {
        expect(new Headers(init?.headers).get("X-Collection-Key")).toBe(KEY);
        return json({ detail: { code: "location_claim_required", message: "A current location claim is required" } }, 409);
      }
      if (path.endsWith("/api/account/import-guest")) {
        importStarted = true;
        return json({ importedVisitCount: 0, importedTrailCount: 0, visitedIds: [], completedTrailIds: [], visits: [] });
      }
      return json(catalogue());
    }));

    const { result } = renderHook(() => useFieldJournal({ apiBaseUrl: API }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(() => result.current.importGuest());

    expect(importStarted).toBe(true);
    expect(JSON.parse(window.localStorage.getItem(JOURNAL_STORAGE.guestVisited) ?? "[]")).toEqual([]);
    expect(JSON.parse(window.localStorage.getItem(JOURNAL_STORAGE.guestVisitMetadata) ?? "{}")).toEqual({});
    expect(JSON.parse(window.localStorage.getItem(JOURNAL_STORAGE.guestVisitPending) ?? "{}")).toEqual({});
  });

  it("clears claim and photo metadata before persisting an offline visit removal", async () => {
    window.localStorage.setItem(JOURNAL_STORAGE.guestVisited, JSON.stringify([PLACE.id]));
    window.localStorage.setItem(JOURNAL_STORAGE.guestVisitTimestamps, JSON.stringify({ [PLACE.id]: CLAIM_VISIT.visitedAt }));
    window.localStorage.setItem(JOURNAL_STORAGE.guestVisitMetadata, JSON.stringify({ [PLACE.id]: CLAIM_VISIT }));
    const { result } = renderHook(() => useFieldJournal({ apiBaseUrl: "" }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(() => result.current.toggleVisit(PLACE.id));

    expect(result.current.visited.has(PLACE.id)).toBe(false);
    expect(result.current.visitTimestamps[PLACE.id]).toBeUndefined();
    expect(result.current.visitMetadata[PLACE.id]).toBeUndefined();
    expect(JSON.parse(window.localStorage.getItem(JOURNAL_STORAGE.guestVisited) ?? "[]")).toEqual([]);
    expect(JSON.parse(window.localStorage.getItem(JOURNAL_STORAGE.guestVisitTimestamps) ?? "{}")).toEqual({});
    expect(JSON.parse(window.localStorage.getItem(JOURNAL_STORAGE.guestVisitMetadata) ?? "{}")).toEqual({});

    const restarted = renderHook(() => useFieldJournal({ apiBaseUrl: "" }));
    await waitFor(() => expect(restarted.result.current.loading).toBe(false));
    expect(restarted.result.current.visited.has(PLACE.id)).toBe(false);
    expect(restarted.result.current.visitMetadata[PLACE.id]).toBeUndefined();
  });

  it("does not resurrect a guest postcard when a crash leaves the removal outbox ahead of metadata", async () => {
    window.localStorage.setItem(JOURNAL_STORAGE.guestVisited, JSON.stringify([PLACE.id]));
    window.localStorage.setItem(JOURNAL_STORAGE.guestVisitTimestamps, JSON.stringify({ [PLACE.id]: CLAIM_VISIT.visitedAt }));
    window.localStorage.setItem(JOURNAL_STORAGE.guestVisitMetadata, JSON.stringify({ [PLACE.id]: CLAIM_VISIT }));
    // Simulate the crash window after the pending removal was written but
    // before the visit snapshot/metadata write completed.
    window.localStorage.setItem(JOURNAL_STORAGE.guestVisitPending, JSON.stringify({ [PLACE.id]: { visited: false, revision: 2 } }));

    const { result } = renderHook(() => useFieldJournal({ apiBaseUrl: "" }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.visited.has(PLACE.id)).toBe(false);
    expect(result.current.visitMetadata[PLACE.id]).toBeUndefined();
  });

  it("does not resurrect an account postcard when a crash leaves the removal outbox ahead of metadata", async () => {
    window.localStorage.setItem(ACCOUNT_TOKEN_KEY, "account-token");
    window.localStorage.setItem(JOURNAL_STORAGE.accountSnapshot, JSON.stringify({
      account: ACCOUNT,
      visitedIds: [PLACE.id],
      completedTrailIds: [],
      visitTimestamps: { [PLACE.id]: CLAIM_VISIT.visitedAt },
      visits: [CLAIM_VISIT],
    }));
    // Simulate the same crash window for the account-scoped outbox.
    window.localStorage.setItem(accountPendingKey(ACCOUNT.id, "visits"), JSON.stringify({
      [PLACE.id]: { visited: false, revision: 2 },
    }));

    const { result } = renderHook(() => useFieldJournal({ apiBaseUrl: "" }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.visited.has(PLACE.id)).toBe(false);
    expect(result.current.visitMetadata[PLACE.id]).toBeUndefined();
  });

  it("keeps stale account metadata filtered when refresh and catalogue responses still include a removed visit", async () => {
    window.localStorage.setItem(ACCOUNT_TOKEN_KEY, "account-token");
    window.localStorage.setItem(JOURNAL_STORAGE.accountSnapshot, JSON.stringify({
      account: ACCOUNT,
      visitedIds: [PLACE.id],
      completedTrailIds: [],
      visitTimestamps: { [PLACE.id]: CLAIM_VISIT.visitedAt },
      visits: [CLAIM_VISIT],
    }));
    window.localStorage.setItem(accountPendingKey(ACCOUNT.id, "visits"), JSON.stringify({
      [PLACE.id]: { visited: false, revision: 2 },
    }));
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith("/api/auth/me")) {
        return json({ account: ACCOUNT, visitedIds: [PLACE.id], completedTrailIds: [], visits: [CLAIM_VISIT] });
      }
      if (path.endsWith(`/api/visits/${PLACE.id}`)) {
        expect(JSON.parse(String(init?.body))).toEqual({ visited: false });
        return json({ placeId: PLACE.id, visited: false, visitedCount: 0, visitedAt: null });
      }
      return json({ ...catalogue([PLACE.id]), visits: [CLAIM_VISIT] });
    }));

    const { result } = renderHook(() => useFieldJournal({ apiBaseUrl: API }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem(accountPendingKey(ACCOUNT.id, "visits")) ?? "{}"))
      .toEqual({}));

    expect(result.current.visited.has(PLACE.id)).toBe(false);
    expect(result.current.visitMetadata[PLACE.id]).toBeUndefined();
  });

  it("filters stale guest metadata when an expired account switches to guest", async () => {
    window.localStorage.setItem(ACCOUNT_TOKEN_KEY, "expired-token");
    window.localStorage.setItem(JOURNAL_STORAGE.accountSnapshot, JSON.stringify({ account: ACCOUNT, visitedIds: [], completedTrailIds: [], visits: [] }));
    window.localStorage.setItem(JOURNAL_STORAGE.guestVisited, JSON.stringify([PLACE.id]));
    window.localStorage.setItem(JOURNAL_STORAGE.guestVisitTimestamps, JSON.stringify({ [PLACE.id]: CLAIM_VISIT.visitedAt }));
    window.localStorage.setItem(JOURNAL_STORAGE.guestVisitMetadata, JSON.stringify({ [PLACE.id]: CLAIM_VISIT }));
    window.localStorage.setItem(JOURNAL_STORAGE.guestVisitPending, JSON.stringify({
      [PLACE.id]: { visited: false, revision: 2 },
    }));
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request) => {
      const path = String(url);
      if (path.endsWith("/api/auth/me")) return json({ detail: "Invalid authentication credentials" }, 401);
      return json({ ...catalogue([PLACE.id]), visits: [CLAIM_VISIT] });
    }));

    const { result } = renderHook(() => useFieldJournal({ apiBaseUrl: API }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.authenticated).toBe(false);
    expect(result.current.visited.has(PLACE.id)).toBe(false);
    expect(result.current.visitMetadata[PLACE.id]).toBeUndefined();
  });

  it("filters stale account metadata when switching into an account with a pending removal", async () => {
    window.localStorage.setItem(accountPendingKey(ACCOUNT.id, "visits"), JSON.stringify({
      [PLACE.id]: { visited: false, revision: 2 },
    }));
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith("/api/auth/login")) {
        return json({
          token: "account-token",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          account: ACCOUNT,
          visitedIds: [PLACE.id],
          completedTrailIds: [],
          visits: [CLAIM_VISIT],
        });
      }
      if (path.endsWith(`/api/visits/${PLACE.id}`)) {
        expect(JSON.parse(String(init?.body))).toEqual({ visited: false });
        return json({ placeId: PLACE.id, visited: false, visitedCount: 0, visitedAt: null });
      }
      return json(catalogue());
    }));

    const { result } = renderHook(() => useFieldJournal({ apiBaseUrl: API }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(() => result.current.authenticate("login", ACCOUNT.email, "password123"));

    expect(result.current.authenticated).toBe(true);
    expect(result.current.visited.has(PLACE.id)).toBe(false);
    expect(result.current.visitMetadata[PLACE.id]).toBeUndefined();
  });

  it("rejects stale claim and photo completions after an account switch and clears restored camera work", async () => {
    const otherAccount = { id: "account-two", email: "other@example.com" };
    window.localStorage.setItem(ACCOUNT_TOKEN_KEY, "account-one-token");
    window.localStorage.setItem(JOURNAL_STORAGE.accountSnapshot, JSON.stringify({ account: ACCOUNT, visitedIds: [PLACE.id], completedTrailIds: [], visits: [CLAIM_VISIT] }));
    const claimResponse = deferred<Response>();
    const photoResponse = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith("/api/auth/me")) return json({ account: ACCOUNT, visitedIds: [PLACE.id], completedTrailIds: [], visits: [CLAIM_VISIT] });
      if (path.endsWith("/api/claims")) return claimResponse.promise;
      if (path.endsWith("/photo") && init?.method === "PUT") return photoResponse.promise;
      if (path.endsWith("/api/auth/logout")) return Promise.resolve(new Response(null, { status: 204 }));
      if (path.endsWith("/api/auth/login")) return json({ token: "account-two-token", expiresAt: new Date(Date.now() + 60_000).toISOString(), account: otherAccount, visitedIds: [], completedTrailIds: [], visits: [] });
      return json({ ...catalogue([PLACE.id]), visits: [CLAIM_VISIT] });
    }));

    const { result } = renderHook(() => useFieldJournal({ apiBaseUrl: API }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    let pendingClaim!: Promise<unknown>;
    let pendingPhoto!: Promise<unknown>;
    act(() => {
      pendingClaim = result.current.createClaim!({ recommendationToken: "signed", expectedPlaceId: PLACE.id });
      pendingPhoto = result.current.uploadVisitPhoto!(PLACE.id, new File(["photo"], "visit.jpg", { type: "image/jpeg" }));
    });
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(`${API}/api/claims`, expect.anything()));
    await act(() => result.current.logout());
    await act(() => result.current.authenticate("login", otherAccount.email, "password123"));

    await act(async () => {
      claimResponse.resolve(await json(CLAIM_CONFIRMATION));
      photoResponse.resolve(new Response(null, { status: 204 }));
      await expect(pendingClaim).rejects.toThrow("journal changed");
      await expect(pendingPhoto).rejects.toThrow("journal changed");
    });

    expect(result.current.account).toEqual(otherAccount);
    expect(result.current.visited.has(PLACE.id)).toBe(false);
    expect(result.current.visitMetadata[PLACE.id]).toBeUndefined();
    expect(nativeCamera.clearRestoredCameraPhoto).toHaveBeenCalledTimes(2);
  });

  it("does not send claim or photo requests for a logged-out guest", async () => {
    const fetchMock = vi.fn((url: string | URL | Request) => String(url).endsWith("/api/catalogue/state") ? json(catalogue()) : json(catalogue()));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useFieldJournal({ apiBaseUrl: API }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const location = { latitude: 49, longitude: -124, accuracyMeters: 8, capturedAtEpochMs: Date.now() };

    await expect(result.current.recommendClaim!({ location })).rejects.toThrow("Sign in to save visits and private photos.");
    await expect(result.current.createClaim!({ recommendationToken: "token", expectedPlaceId: PLACE.id })).rejects.toThrow("Sign in to save visits and private photos.");
    await expect(result.current.uploadVisitPhoto!(PLACE.id, new File(["photo"], "visit.jpg", { type: "image/jpeg" }))).rejects.toThrow("Sign in to save visits and private photos.");
    await expect(result.current.loadVisitPhoto!(PLACE.id)).rejects.toThrow("Sign in to save visits and private photos.");
    await expect(result.current.removeVisitPhoto!(PLACE.id)).rejects.toThrow("Sign in to save visits and private photos.");
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("claim-recommendations") || String(url).includes("/api/claims") || String(url).includes("/photo"))).toBe(false);
  });

  it("reconciles a claim that committed when the create response was lost", async () => {
    window.localStorage.setItem(ACCOUNT_TOKEN_KEY, "account-token");
    window.localStorage.setItem(JOURNAL_STORAGE.accountSnapshot, JSON.stringify({ account: ACCOUNT, visitedIds: [], completedTrailIds: [], visits: [] }));
    let accountLoads = 0;
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request) => {
      const path = String(url);
      if (path.endsWith("/api/auth/me")) {
        accountLoads += 1;
        return accountLoads === 1
          ? json({ account: ACCOUNT, visitedIds: [], completedTrailIds: [], visits: [] })
          : json({ account: ACCOUNT, visitedIds: [PLACE.id], completedTrailIds: [], visits: [CLAIM_VISIT] });
      }
      return json(catalogue());
    }));

    const { result } = renderHook(() => useFieldJournal({ apiBaseUrl: API }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    let recovered: unknown = null;
    await act(async () => { recovered = await result.current.reconcileClaim!(PLACE.id); });
    expect(recovered).toEqual(CLAIM_CONFIRMATION);
    expect(result.current.visited.has(PLACE.id)).toBe(true);
    expect(result.current.visitMetadata[PLACE.id]).toEqual(CLAIM_VISIT);
  });

  it("persists an account claim and updates its private photo flag through authenticated APIs", async () => {
    window.localStorage.setItem(ACCOUNT_TOKEN_KEY, "account-token");
    window.localStorage.setItem(JOURNAL_STORAGE.accountSnapshot, JSON.stringify({ account: ACCOUNT, visitedIds: [], completedTrailIds: [] }));
    const recommendation = { status: "recommended", recommendationToken: "signed", expiresAt: new Date(Date.now() + 60_000).toISOString(), candidate: { placeId: PLACE.id, matchKind: "exact", distanceMeters: 0 } };
    const confirmation = { placeId: PLACE.id, visited: true, visitedCount: 1, visitedAt: "2026-09-08T12:00:00Z", claim: { claimedAt: "2026-09-08T12:00:00Z", capturedAt: "2026-09-08T12:00:00Z", coordinates: { latitude: 49, longitude: -124 }, accuracyMeters: 8, boundaryVersion: "v1", matchKind: "exact", distanceMeters: 0, hasPhoto: false } };
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const path = String(url); calls.push({ path, init });
      if (path.endsWith("/api/auth/me")) return json({ account: ACCOUNT, visitedIds: [], completedTrailIds: [], visits: [] });
      if (path.endsWith("/api/claim-recommendations")) return json(recommendation);
      if (path.endsWith("/api/claims")) return json(confirmation);
      if (path.endsWith("/photo") && init?.method === "PUT") return Promise.resolve(new Response(null, { status: 204 }));
      if (path.endsWith("/photo") && init?.method === "DELETE") return Promise.resolve(new Response(null, { status: 204 }));
      if (path.endsWith("/photo")) return Promise.resolve(new Response(new Blob(["photo"], { type: "image/jpeg" }), { headers: { "Content-Type": "image/jpeg" } }));
      return json(catalogue());
    }));
    const { result } = renderHook(() => useFieldJournal({ apiBaseUrl: API }));
    await waitFor(() => expect(result.current.authenticated).toBe(true));
    const location = { latitude: 49, longitude: -124, accuracyMeters: 8, capturedAtEpochMs: Date.now() };
    await act(async () => {
      await result.current.recommendClaim!({ location });
      await result.current.createClaim!({ recommendationToken: "signed", expectedPlaceId: PLACE.id });
    });
    expect(result.current.visited.has(PLACE.id)).toBe(true);
    expect(result.current.visitMetadata[PLACE.id].claim?.hasPhoto).toBe(false);
    const photo = new File(["photo"], "visit.jpg", { type: "image/jpeg" });
    await act(() => result.current.uploadVisitPhoto!(PLACE.id, photo));
    expect(result.current.visitMetadata[PLACE.id].claim?.hasPhoto).toBe(true);
    await expect(result.current.loadVisitPhoto!(PLACE.id)).resolves.toBeInstanceOf(Blob);
    await act(() => result.current.removeVisitPhoto!(PLACE.id));
    expect(result.current.visitMetadata[PLACE.id].claim?.hasPhoto).toBe(false);
    const claimRequest = calls.find(({ path }) => path.endsWith("/api/claims"));
    expect(new Headers(claimRequest?.init?.headers).get("Authorization")).toBe("Bearer account-token");
    expect(JSON.parse(String(claimRequest?.init?.body))).toEqual({ recommendationToken: "signed", expectedPlaceId: PLACE.id });
    expect(JSON.parse(window.localStorage.getItem(JOURNAL_STORAGE.accountSnapshot) ?? "{}").visits[0].claim.hasPhoto).toBe(false);
  });
});

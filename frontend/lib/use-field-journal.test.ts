// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nativeCamera = vi.hoisted(() => ({ clearRestoredCameraPhoto: vi.fn() }));
vi.mock("./capacitor-native-capabilities", () => nativeCamera);
const nativePhoto = vi.hoisted(() => ({ clearPhotoRetryOwner: vi.fn() }));
vi.mock("./native-capabilities", () => nativePhoto);

import { ACCOUNT_TOKEN_KEY } from "./account";
import { JOURNAL_STORAGE, accountPendingKey } from "./field-journal-state";
import { useFieldJournal } from "./use-field-journal";

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
    places: [PLACE],
    visitedIds,
    completedTrailIds,
    coverageNote: "Coverage",
    visitClaims: { supported: true, enforcement: "required" as const },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  nativeCamera.clearRestoredCameraPhoto.mockReset();
  nativePhoto.clearPhotoRetryOwner.mockReset();
  window.localStorage.clear();
  window.localStorage.setItem(JOURNAL_STORAGE.collectionKey, KEY);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useFieldJournal identity and progress races", () => {
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
      if (!String(url).endsWith("/api/places")) throw new Error(`Unexpected request: ${url}`);
      catalogueAttempts += 1;
      return catalogueAttempts === 1 ? Promise.reject(new TypeError("network not ready")) : json(catalogue());
    }));

    const { result } = renderHook(() => useFieldJournal({ apiBaseUrl: API }));
    await waitFor(() => expect(catalogueAttempts).toBe(1));
    act(() => window.dispatchEvent(new Event("online")));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(catalogueAttempts).toBe(2);
    expect(result.current.places).toEqual([PLACE]);
    expect(result.current.loadError).toBe("");
  });

  it("keeps bounded boot recovery active through a slow Android reconnect", async () => {
    vi.useFakeTimers();
    let catalogueAttempts = 0;
    vi.stubGlobal("fetch", vi.fn(() => {
      catalogueAttempts += 1;
      return catalogueAttempts < 6 ? Promise.reject(new TypeError("network still starting")) : json(catalogue());
    }));

    const { result } = renderHook(() => useFieldJournal({ apiBaseUrl: API }));
    for (let turn = 0; turn < 20 && catalogueAttempts === 0; turn += 1) {
      await act(async () => { await Promise.resolve(); });
    }
    expect(catalogueAttempts).toBe(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(14_999); });
    expect(catalogueAttempts).toBe(5);
    expect(result.current.loading).toBe(true);

    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(catalogueAttempts).toBe(6);
    expect(result.current.loading).toBe(false);
    expect(result.current.places).toEqual([PLACE]);
  });

  it("continues finite timed recovery after every boot attempt fails without an online event", async () => {
    vi.useFakeTimers();
    let catalogueAttempts = 0;
    vi.stubGlobal("fetch", vi.fn(() => {
      catalogueAttempts += 1;
      return catalogueAttempts < 8 ? Promise.reject(new TypeError("network still unavailable")) : json(catalogue());
    }));

    const { result } = renderHook(() => useFieldJournal({ apiBaseUrl: API }));
    for (let turn = 0; turn < 20 && catalogueAttempts === 0; turn += 1) {
      await act(async () => { await Promise.resolve(); });
    }
    await act(async () => { await vi.advanceTimersByTimeAsync(31_000); });
    expect(catalogueAttempts).toBe(7);
    expect(result.current.loading).toBe(false);

    await act(async () => { await vi.advanceTimersByTimeAsync(1_999); });
    expect(catalogueAttempts).toBe(7);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });

    expect(catalogueAttempts).toBe(8);
    expect(result.current.places).toEqual([PLACE]);
    expect(result.current.loadError).toBe("");
  });

  it("cancels post-error timed recovery on unmount", async () => {
    vi.useFakeTimers();
    let catalogueAttempts = 0;
    vi.stubGlobal("fetch", vi.fn(() => {
      catalogueAttempts += 1;
      return Promise.reject(new TypeError("offline"));
    }));

    const mounted = renderHook(() => useFieldJournal({ apiBaseUrl: API }));
    for (let turn = 0; turn < 20 && catalogueAttempts === 0; turn += 1) {
      await act(async () => { await Promise.resolve(); });
    }
    await act(async () => { await vi.advanceTimersByTimeAsync(31_000); });
    expect(catalogueAttempts).toBe(7);
    expect(mounted.result.current.loading).toBe(false);

    mounted.unmount();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(catalogueAttempts).toBe(7);
  });

  it("discards a guest post-error schedule when account identity takes over", async () => {
    vi.useFakeTimers();
    let guestCatalogueAttempts = 0;
    let accountCatalogueAttempts = 0;
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith("/api/auth/login")) {
        return json({ token: "account-token", expiresAt: new Date(Date.now() + 60_000).toISOString(), account: ACCOUNT, visitedIds: [PLACE.id], completedTrailIds: [] });
      }
      if (!path.endsWith("/api/places")) throw new Error(`Unexpected request: ${url}`);
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
    await act(async () => { await vi.advanceTimersByTimeAsync(31_000); });
    expect(guestCatalogueAttempts).toBe(7);
    expect(result.current.loading).toBe(false);

    await act(() => result.current.authenticate("login", ACCOUNT.email, "password123"));
    for (let turn = 0; turn < 20 && accountCatalogueAttempts === 0; turn += 1) {
      await act(async () => { await Promise.resolve(); });
    }
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });

    expect(guestCatalogueAttempts).toBe(7);
    expect(accountCatalogueAttempts).toBe(1);
    expect(result.current.authenticated).toBe(true);
    expect(result.current.visited.has(PLACE.id)).toBe(true);
  });

  it("cancels the failed guest retry and refreshes the catalogue for the account that signs in", async () => {
    let guestCatalogueAttempts = 0;
    let accountCatalogueAttempts = 0;
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith("/api/auth/login")) {
        return json({ token: "account-token", expiresAt: new Date(Date.now() + 60_000).toISOString(), account: ACCOUNT, visitedIds: [PLACE.id], completedTrailIds: [] });
      }
      if (!path.endsWith("/api/places")) throw new Error(`Unexpected request: ${url}`);
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
    expect(result.current.places).toEqual([PLACE]);
    expect(result.current.visited.has(PLACE.id)).toBe(true);
  });

  it("keeps a cached guest catalogue immediately available while offline", async () => {
    window.localStorage.setItem(JOURNAL_STORAGE.places, JSON.stringify([PLACE]));
    const fetchMock = vi.fn(() => Promise.reject(new TypeError("offline")));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useFieldJournal({ apiBaseUrl: API }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result.current.places).toEqual([PLACE]);
    expect(result.current.loadError).toBe("Showing your saved field guide offline.");
  });

  it("does not continue a pending boot retry after unmount", async () => {
    let catalogueAttempts = 0;
    vi.stubGlobal("fetch", vi.fn(() => {
      catalogueAttempts += 1;
      return Promise.reject(new TypeError("network not ready"));
    }));

    const mounted = renderHook(() => useFieldJournal({ apiBaseUrl: API }));
    await waitFor(() => expect(catalogueAttempts).toBe(1));
    mounted.unmount();
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

  it("ignores a guest catalogue response that arrives after login", async () => {
    const lateCatalogue = deferred<Response>();
    let accountCatalogueAttempts = 0;
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith("/api/places")) {
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
    await act(async () => { lateCatalogue.resolve(await json(catalogue())); });
    expect(result.current.authenticated).toBe(true);
    expect(result.current.visited.has(PLACE.id)).toBe(true);
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
  });

  it("clears account photo retry and restored camera state before resetting remote progress", async () => {
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
    expect(resetCalls).toEqual(["photo", "camera", "remote"]);
    expect(result.current.syncMessage).toBe("Your progress has been reset.");
  });

  it("does not reset remote progress or report success when local photo cleanup fails", async () => {
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
    let failure!: Promise<void>;
    await act(async () => { failure = result.current.resetProgress(); await failure.catch(() => undefined); });
    await expect(failure).rejects.toThrow("Private photo storage is busy.");

    expect(remoteResetCalled).toBe(false);
    expect(nativeCamera.clearRestoredCameraPhoto).not.toHaveBeenCalled();
    expect(result.current.syncMessage).toBe("Private photo storage is busy.");
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
      if (path.endsWith("/api/places")) return catalogueSnapshot.promise;
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
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(`${API}/api/places`, expect.anything()));
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
      if (path.endsWith("/api/places")) return catalogueSnapshot.promise;
      return json({});
    }));

    const { result } = renderHook(() => useFieldJournal({ apiBaseUrl: API }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(`${API}/api/places`, expect.anything()));
    expect(result.current.createClaim).toBeUndefined();
    await act(async () => { catalogueSnapshot.resolve(await json(catalogue())); });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.createClaim).toBeTypeOf("function");
    await act(() => result.current.createClaim!({ recommendationToken: "signed", expectedPlaceId: PLACE.id }));
    expect(result.current.visited.has(PLACE.id)).toBe(true);
    expect(result.current.visitTimestamps[PLACE.id]).toBe(CLAIM_VISIT.visitedAt);
    expect(result.current.visitMetadata[PLACE.id]).toEqual(CLAIM_VISIT);
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
    const fetchMock = vi.fn((url: string | URL | Request) => String(url).endsWith("/api/places") ? json(catalogue()) : json(catalogue()));
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

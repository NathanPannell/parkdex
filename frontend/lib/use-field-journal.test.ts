// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ACCOUNT_TOKEN_KEY } from "./account";
import { JOURNAL_STORAGE, accountPendingKey } from "./field-journal-state";
import { registerNativePlatformStorage, resetPlatformStorageForTests, type KeyValueStore } from "./platform-storage";
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

function json(data: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  }));
}

function catalogue(visitedIds: string[] = [], completedTrailIds: string[] = []) {
  return { places: [PLACE], visitedIds, completedTrailIds, coverageNote: "Coverage" };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function memoryStore(): KeyValueStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: vi.fn(async (key) => values.get(key) ?? null),
    setItem: vi.fn(async (key, value) => { values.set(key, value); }),
    removeItem: vi.fn(async (key) => { values.delete(key); }),
  };
}

beforeEach(() => {
  resetPlatformStorageForTests();
  Reflect.deleteProperty(globalThis, "Capacitor");
  window.localStorage.clear();
  window.localStorage.setItem(JOURNAL_STORAGE.collectionKey, KEY);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetPlatformStorageForTests();
  Reflect.deleteProperty(globalThis, "Capacitor");
});

describe("useFieldJournal identity and progress races", () => {
  it("waits for native storage readiness before loading owner data", async () => {
    Object.defineProperty(globalThis, "Capacitor", { configurable: true, value: { isNativePlatform: () => true } });
    const ready = deferred<{ credentials: KeyValueStore; journal: KeyValueStore }>();
    registerNativePlatformStorage(() => ready.promise);
    const fetchMock = vi.fn(() => json(catalogue()));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useFieldJournal({ apiBaseUrl: API }));
    await Promise.resolve();
    expect(result.current.loading).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => { ready.resolve({ credentials: memoryStore(), journal: memoryStore() }); });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails closed when native credential storage cannot be read", async () => {
    window.localStorage.clear(); Object.defineProperty(globalThis, "Capacitor", { configurable: true, value: { isNativePlatform: () => true } });
    const credentials = memoryStore(), journalStore = memoryStore(); vi.mocked(credentials.getItem).mockRejectedValue(new Error("secure read failed"));
    registerNativePlatformStorage(async () => ({ credentials, journal: journalStore }));
    const fetchMock = vi.fn(() => json(catalogue())); vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useFieldJournal({ apiBaseUrl: API }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.storageUnavailable).toBe(true); expect(fetchMock).not.toHaveBeenCalled(); expect(credentials.setItem).not.toHaveBeenCalled();
  });

  it("does not fall back to guest when only the native account token read fails", async () => {
    window.localStorage.clear(); Object.defineProperty(globalThis, "Capacitor", { configurable: true, value: { isNativePlatform: () => true } });
    const credentials = memoryStore(), journalStore = memoryStore(); credentials.values.set(JOURNAL_STORAGE.collectionKey, KEY);
    vi.mocked(credentials.getItem).mockImplementation(async (key) => { if (key === ACCOUNT_TOKEN_KEY) throw new Error("token read failed"); return credentials.values.get(key) ?? null; });
    registerNativePlatformStorage(async () => ({ credentials, journal: journalStore }));
    const fetchMock = vi.fn(() => json(catalogue())); vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useFieldJournal({ apiBaseUrl: API })); await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.storageUnavailable).toBe(true); expect(fetchMock).not.toHaveBeenCalled(); expect(result.current.authenticated).toBe(false);
  });

  it("does not send a checkoff until its pending intent is durably stored", async () => {
    window.localStorage.clear(); Object.defineProperty(globalThis, "Capacitor", { configurable: true, value: { isNativePlatform: () => true } });
    const credentials = memoryStore(), journalStore = memoryStore(); credentials.values.set(JOURNAL_STORAGE.collectionKey, KEY);
    let rejectPending = false; vi.mocked(journalStore.setItem).mockImplementation(async (key, value) => { if (rejectPending && key === JOURNAL_STORAGE.guestVisitPending) throw new Error("disk full"); journalStore.values.set(key, value); });
    registerNativePlatformStorage(async () => ({ credentials, journal: journalStore }));
    const fetchMock = vi.fn(() => json(catalogue())); vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useFieldJournal({ apiBaseUrl: API })); await waitFor(() => expect(result.current.loading).toBe(false)); fetchMock.mockClear(); rejectPending = true;
    await act(() => result.current.toggleVisit(PLACE.id));
    expect(fetchMock).not.toHaveBeenCalled(); expect(result.current.storageUnavailable).toBe(true); expect(result.current.syncMessage).toContain("could not save"); expect(result.current.visited.has(PLACE.id)).toBe(true);
  });

  it("surfaces a guest revision read failure without sending the optimistic checkoff", async () => {
    window.localStorage.clear(); Object.defineProperty(globalThis, "Capacitor", { configurable: true, value: { isNativePlatform: () => true } });
    const credentials = memoryStore(), journalStore = memoryStore(); credentials.values.set(JOURNAL_STORAGE.collectionKey, KEY);
    let rejectRevision = false; vi.mocked(journalStore.getItem).mockImplementation(async (key) => { if (rejectRevision && key === JOURNAL_STORAGE.guestRevision) throw new Error("read failed"); return journalStore.values.get(key) ?? null; });
    registerNativePlatformStorage(async () => ({ credentials, journal: journalStore }));
    const fetchMock = vi.fn(() => json(catalogue())); vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useFieldJournal({ apiBaseUrl: API })); await waitFor(() => expect(result.current.loading).toBe(false)); fetchMock.mockClear(); rejectRevision = true;
    await act(() => result.current.toggleVisit(PLACE.id));
    expect(fetchMock).not.toHaveBeenCalled(); expect(result.current.syncMessage).toContain("could not save"); expect(result.current.visited.has(PLACE.id)).toBe(true);
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
    expect(result.current.visitMetadata).toEqual({});
  });

  it("drops a legacy location-required insertion instead of retrying forever", async () => {
    let visitWrites = 0;
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request) => {
      if (String(url).endsWith(`/api/visits/${PLACE.id}`)) {
        visitWrites += 1;
        return json({ detail: { code: "location_claim_required", message: "Location claim required" } }, 409);
      }
      return json(catalogue());
    }));
    const { result } = renderHook(() => useFieldJournal({ apiBaseUrl: API }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(() => result.current.toggleVisit(PLACE.id));
    expect(result.current.visited.has(PLACE.id)).toBe(false);
    expect(result.current.syncMessage).toContain("location claim");
    expect(JSON.parse(window.localStorage.getItem(JOURNAL_STORAGE.guestVisitPending) ?? "{}" )).toEqual({});
    act(() => window.dispatchEvent(new Event("online")));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(visitWrites).toBe(1);
  });

  it("creates a guest claim nonoptimistically and persists its metadata after confirmation", async () => {
    const claim = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith("/api/claim-recommendations")) {
        expect(new Headers(init?.headers).get("X-Collection-Key")).toBe(KEY);
        return json({ status: "recommended", recommendationToken: "signed", expiresAt: "2026-09-09T00:01:00Z", candidate: { placeId: PLACE.id, matchKind: "exact", distanceMeters: 0 } });
      }
      if (path.endsWith("/api/claims")) return claim.promise;
      return json(catalogue());
    }));
    const { result } = renderHook(() => useFieldJournal({ apiBaseUrl: API }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const recommendation = await result.current.recommendClaim({ location: { latitude: 49, longitude: -124, accuracyMeters: 5, capturedAtEpochMs: 1_789_000_000_000 } });
    expect(recommendation.status).toBe("recommended");

    let creating!: Promise<unknown>;
    act(() => { creating = result.current.createClaim({ recommendationToken: "signed", expectedPlaceId: PLACE.id }); });
    expect(result.current.visited.has(PLACE.id)).toBe(false);
    const confirmed = { placeId: PLACE.id, visited: true, visitedCount: 1, visitedAt: "2026-09-09T00:00:00Z", claim: { claimedAt: "2026-09-09T00:00:00Z", capturedAt: "2026-09-09T00:00:00Z", coordinates: { latitude: 49, longitude: -124 }, accuracyMeters: 5, boundaryVersion: "v1", matchKind: "exact", distanceMeters: 0, hasPhoto: false } };
    await act(async () => { claim.resolve(await json(confirmed)); await creating; });
    expect(result.current.visited.has(PLACE.id)).toBe(true);
    expect(result.current.visitMetadata[PLACE.id]).toEqual({ placeId: PLACE.id, visitedAt: confirmed.visitedAt, claim: confirmed.claim });
    expect(JSON.parse(window.localStorage.getItem(JOURNAL_STORAGE.guestVisitMetadata) ?? "{}")).toHaveProperty(`${PLACE.id}.claim.boundaryVersion`, "v1");
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
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request) => {
      const path = String(url);
      if (path.endsWith("/api/places")) return lateCatalogue.promise;
      return json({ token: "account-token", expiresAt: new Date(Date.now() + 60_000).toISOString(), account: ACCOUNT, visitedIds: [PLACE.id], completedTrailIds: [] });
    }));
    const { result } = renderHook(() => useFieldJournal({ apiBaseUrl: API }));

    await act(() => result.current.authenticate("login", ACCOUNT.email, "password123"));
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

  it("persists a late account A failure only to account A after account B signs in", async () => {
    const accountB = { id: "account-two", email: "second@example.com" };
    window.localStorage.setItem(ACCOUNT_TOKEN_KEY, "account-a-token"); window.localStorage.setItem(JOURNAL_STORAGE.accountSnapshot, JSON.stringify({ account: ACCOUNT, visitedIds: [], completedTrailIds: [] }));
    const accountWrite = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith(`/api/visits/${PLACE.id}`)) return accountWrite.promise;
      if (path.endsWith("/api/auth/logout")) return Promise.resolve(new Response(null, { status: 204 }));
      if (path.endsWith("/api/auth/login")) return json({ token: "account-b-token", expiresAt: new Date(Date.now() + 60_000).toISOString(), account: accountB, visitedIds: [], completedTrailIds: [] });
      if (path.endsWith("/api/auth/me")) return json({ account: ACCOUNT, visitedIds: [], completedTrailIds: [] });
      void init; return json(catalogue());
    }));
    const { result } = renderHook(() => useFieldJournal({ apiBaseUrl: API })); await waitFor(() => expect(result.current.loading).toBe(false));
    let pendingToggle!: Promise<void>; act(() => { pendingToggle = result.current.toggleVisit(PLACE.id); });
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem(accountPendingKey(ACCOUNT.id, "visits")) ?? "{}")).toHaveProperty(PLACE.id));
    await act(() => result.current.logout()); await act(() => result.current.authenticate("login", accountB.email, "password123"));
    await act(async () => { accountWrite.resolve(await json({ detail: "offline" }, 503)); await pendingToggle; });
    expect(JSON.parse(window.localStorage.getItem(accountPendingKey(ACCOUNT.id, "visits")) ?? "{}")).toHaveProperty(PLACE.id);
    expect(JSON.parse(window.localStorage.getItem(accountPendingKey(accountB.id, "visits")) ?? "{}")).toEqual({}); expect(result.current.account?.id).toBe(accountB.id);
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
});

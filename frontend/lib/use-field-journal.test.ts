// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem(JOURNAL_STORAGE.collectionKey, KEY);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useFieldJournal identity and progress races", () => {
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

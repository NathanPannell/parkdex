// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Place } from "./places";
import { registerNativePlatformStorage, resetPlatformStorageForTests, type KeyValueStore } from "./platform-storage";
import { accountGroupsCacheKey, accountGroupsOutboxKey, useGroups } from "./use-groups";

const place: Place = {
  id: "park-1",
  name: "One",
  category: "provincial",
  latitude: 49,
  longitude: -124,
  region: "South",
  description: "",
  sourceUrl: "https://example.test",
  sourceName: "Source",
  sourceId: null,
};

function json(body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  }));
}

function failed(status: number, detail: string) {
  return Promise.resolve(new Response(JSON.stringify({ detail }), {
    status,
    headers: { "Content-Type": "application/json" },
  }));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function setOnline(value: boolean) {
  Object.defineProperty(window.navigator, "onLine", { configurable: true, value });
}

function memoryStore(initial: Record<string, string> = {}): KeyValueStore & { values: Map<string, string> } {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: vi.fn(async (key) => values.get(key) ?? null),
    setItem: vi.fn(async (key, value) => { values.set(key, value); }),
    removeItem: vi.fn(async (key) => { values.delete(key); }),
  };
}

function setNative() {
  Object.defineProperty(globalThis, "Capacitor", {
    configurable: true,
    value: { isNativePlatform: () => true },
  });
}

beforeEach(() => {
  resetPlatformStorageForTests();
  Reflect.deleteProperty(globalThis, "Capacitor");
  window.localStorage.clear();
  setOnline(true);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  resetPlatformStorageForTests();
  Reflect.deleteProperty(globalThis, "Capacitor");
  window.localStorage.clear();
  setOnline(true);
});

describe("useGroups account isolation", () => {
  it("discards a list response from the previous account", async () => {
    const first = deferred<Response>();
    const requestA = vi.fn(() => first.promise);
    const requestB = vi.fn(() => json([{ id: "group-b", name: "B", isWishlist: false, placeIds: [] }]));
    const { result, rerender } = renderHook(
      ({ identityKey, request }) => useGroups({
        apiBaseUrl: "https://api.example.test",
        authenticated: true,
        identityKey,
        places: [place],
        request,
      }),
      { initialProps: { identityKey: "account-a", request: requestA } },
    );
    await waitFor(() => expect(requestA).toHaveBeenCalled());

    rerender({ identityKey: "account-b", request: requestB });
    await waitFor(() => expect(result.current.groups.map((group) => group.id)).toEqual(["group-b"]));

    await act(async () => {
      first.resolve(await json([{ id: "group-a", name: "A", isWishlist: false, placeIds: [] }]));
      await first.promise;
    });
    expect(result.current.groups.map((group) => group.id)).toEqual(["group-b"]);
  });

  it("discards an in-flight membership mutation after account switch", async () => {
    const mutation = deferred<Response>();
    const requestA = vi.fn((path: string, init?: RequestInit) => init?.method === "POST"
      ? mutation.promise
      : json([{ id: "group-a", name: "A", isWishlist: false, placeIds: [] }]));
    const requestB = vi.fn(() => json([{ id: "group-b", name: "B", isWishlist: false, placeIds: [] }]));
    const { result, rerender } = renderHook(
      ({ identityKey, request }) => useGroups({
        apiBaseUrl: "https://api.example.test",
        authenticated: true,
        identityKey,
        places: [place],
        request,
      }),
      { initialProps: { identityKey: "account-a", request: requestA } },
    );
    await waitFor(() => expect(result.current.groups.map((group) => group.id)).toEqual(["group-a"]));

    let pending!: Promise<void>;
    act(() => { pending = result.current.addPlace("group-a", place.id); });
    await waitFor(() => expect(requestA).toHaveBeenCalledWith(
      "/api/groups/group-a/places",
      expect.objectContaining({ method: "POST" }),
    ));

    rerender({ identityKey: "account-b", request: requestB });
    await waitFor(() => expect(result.current.groups.map((group) => group.id)).toEqual(["group-b"]));
    expect(result.current.busy).toBe(false);
    await act(async () => {
      mutation.resolve(await json([{ id: "group-a", name: "A", isWishlist: false, placeIds: [place.id] }]));
      await pending;
    });
    expect(result.current.groups.map((group) => group.id)).toEqual(["group-b"]);
    expect(result.current.busy).toBe(false);
  });

  it("clears stale groups before reloading the empty Wishlist after a successful reset", async () => {
    const reload = deferred<Response>();
    let reads = 0;
    const request = vi.fn((path: string) => {
      expect(path).toBe("/api/groups");
      reads += 1;
      return reads === 1
        ? json([{ id: "old-group", name: "Old plans", isWishlist: false, placeIds: [place.id] }])
        : reload.promise;
    });
    const { result } = renderHook(() => useGroups({
      apiBaseUrl: "https://api.example.test",
      authenticated: true,
      identityKey: "account-a",
      places: [place],
      request,
    }));
    await waitFor(() => expect(result.current.groups.map((group) => group.id)).toEqual(["old-group"]));

    let refreshing!: Promise<void>;
    act(() => { refreshing = result.current.refreshAfterReset(); });
    await waitFor(() => expect(result.current.groups).toEqual([]));
    await act(async () => {
      reload.resolve(await json([{ id: "new-wishlist", name: "Wishlist", isWishlist: true, placeIds: [] }]));
      await refreshing;
    });
    expect(result.current.groups.map((group) => group.id)).toEqual(["new-wishlist"]);
    expect(result.current.selectedGroupId).toBeNull();
  });
});

describe("useGroups offline groups", () => {
  it("silently retries failed collection fetches with exponential backoff until one succeeds", async () => {
    vi.useFakeTimers();
    window.localStorage.setItem(accountGroupsCacheKey("account-a"), JSON.stringify([{ id: "coast", name: "Coastal plans", placeIds: [place.id] }]));
    const request = vi.fn()
      .mockImplementationOnce(() => failed(503, "temporarily unavailable"))
      .mockImplementationOnce(() => failed(503, "temporarily unavailable"))
      .mockImplementation(() => json([{ id: "coast", name: "Coastal plans", placeIds: [place.id] }]));
    const { result } = renderHook(() => useGroups({ apiBaseUrl: "https://api.example.test", authenticated: true, identityKey: "account-a", places: [place], request }));

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(request).toHaveBeenCalledTimes(1);
    expect(result.current.groups[0].places).toEqual([place]);
    expect(result.current.error).toBe("");
    expect(result.current.syncStatus).toBe("idle");
    expect(result.current.syncMessage).toBe("");
    expect(result.current.loading).toBe(false);
    expect(result.current.retrying).toBe(true);

    await act(async () => { await vi.advanceTimersByTimeAsync(999); });
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(request).toHaveBeenCalledTimes(2);
    expect(result.current.error).toBe("");
    expect(result.current.syncStatus).toBe("idle");
    expect(result.current.syncMessage).toBe("");
    expect(result.current.loading).toBe(false);
    expect(result.current.retrying).toBe(true);

    await act(async () => { await vi.advanceTimersByTimeAsync(1_999); });
    expect(request).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(request).toHaveBeenCalledTimes(3);
    expect(result.current.groups.map((group) => group.id)).toEqual(["coast"]);
    expect(result.current.offline).toBe(false);
    expect(result.current.syncStatus).toBe("idle");
    expect(result.current.syncMessage).toBe("");
    expect(result.current.error).toBe("");
    expect(result.current.loading).toBe(false);
    expect(result.current.retrying).toBe(false);
  });

  it("cancels a pending list retry immediately when the account changes", async () => {
    vi.useFakeTimers();
    const requestA = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const requestB = vi.fn(() => json([{ id: "group-b", name: "B", placeIds: [] }]));
    const { result, rerender } = renderHook(
      ({ identityKey, request }) => useGroups({ apiBaseUrl: "https://api.example.test", authenticated: true, identityKey, places: [place], request }),
      { initialProps: { identityKey: "account-a", request: requestA } },
    );

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(requestA).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    expect(result.current.retrying).toBe(true);

    rerender({ identityKey: "account-b", request: requestB });
    expect(vi.getTimerCount()).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(requestB).toHaveBeenCalledTimes(1);
    expect(result.current.groups.map((group) => group.id)).toEqual(["group-b"]);
    expect(result.current.retrying).toBe(false);

    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(requestA).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending list retry on unmount", async () => {
    vi.useFakeTimers();
    const request = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const { unmount } = renderHook(() => useGroups({ apiBaseUrl: "https://api.example.test", authenticated: true, identityKey: "account-a", places: [place], request }));

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(request).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);

    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("keeps the pending outbox notice visible while the initial collection fetch retries", async () => {
    vi.useFakeTimers();
    window.localStorage.setItem(accountGroupsCacheKey("account-a"), JSON.stringify([{ id: "coast", name: "Coastal plans", placeIds: [] }]));
    window.localStorage.setItem(accountGroupsOutboxKey("account-a"), JSON.stringify({ coast: { "park-1": { included: true, revision: 1 } } }));
    const request = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const { result } = renderHook(() => useGroups({ apiBaseUrl: "https://api.example.test", authenticated: true, identityKey: "account-a", places: [place], request }));

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(request).toHaveBeenCalledTimes(1);
    expect(result.current.retrying).toBe(true);
    expect(result.current.loading).toBe(false);
    expect(result.current.pendingMemberships).toBe(1);
    expect(result.current.syncStatus).toBe("syncing");
    expect(result.current.syncMessage).toBe("Your collection changes are saved on this device and waiting to sync.");
  });

  it("restores native async cache and outbox state after a runtime restart", async () => {
    const credentials = memoryStore();
    const journal = memoryStore({
      [accountGroupsCacheKey("account-a")]: JSON.stringify([{ id: "wishlist", name: "Wishlist", isWishlist: true, placeIds: [] }]),
    });
    setNative();
    registerNativePlatformStorage(async () => ({ credentials, journal }));
    setOnline(false);
    const request = vi.fn(() => json([]));
    const first = renderHook(() => useGroups({
      apiBaseUrl: "https://api.example.test",
      authenticated: true,
      identityKey: "account-a",
      places: [place],
      request,
    }));
    await waitFor(() => expect(first.result.current.groups.map((group) => group.id)).toEqual(["wishlist"]));
    await act(() => first.result.current.addPlace("wishlist", place.id));
    expect(first.result.current.pendingMemberships).toBe(1);
    first.unmount();

    resetPlatformStorageForTests();
    registerNativePlatformStorage(async () => ({ credentials, journal }));
    const restarted = renderHook(() => useGroups({
      apiBaseUrl: "https://api.example.test",
      authenticated: true,
      identityKey: "account-a",
      places: [place],
      request,
    }));

    await waitFor(() => expect(restarted.result.current.groups[0]?.places).toEqual([place]));
    expect(restarted.result.current.pendingMemberships).toBe(1);
    expect(request).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(accountGroupsOutboxKey("account-a"))).toBeNull();
    expect(JSON.parse(journal.values.get(accountGroupsOutboxKey("account-a")) ?? "null")).toEqual({
      wishlist: { "park-1": expect.objectContaining({ included: true }) },
    });
  });

  it("hydrates the last account snapshot, including Wishlist, while offline", async () => {
    window.localStorage.setItem(accountGroupsCacheKey("account-a"), JSON.stringify([
      { id: "wishlist", name: "Wishlist", isWishlist: true, placeIds: [place.id] },
      { id: "coast", name: "Coastal plans", placeIds: [] },
    ]));
    setOnline(false);
    const request = vi.fn(() => json([]));
    const { result } = renderHook(() => useGroups({
      apiBaseUrl: "https://api.example.test",
      authenticated: true,
      identityKey: "account-a",
      places: [place],
      request,
    }));

    await waitFor(() => expect(result.current.groups.map((group) => group.id)).toEqual(["wishlist", "coast"]));
    expect(request).not.toHaveBeenCalled();
    expect(result.current.groups.map((group) => group.id)).toEqual(["wishlist", "coast"]);
    expect(result.current.groups[0].places).toEqual([place]);
    expect(result.current.offline).toBe(true);
    expect(result.current.syncStatus).toBe("offline");
  });

  it("optimistically queues add/remove and persists one final desired state", async () => {
    window.localStorage.setItem(accountGroupsCacheKey("account-a"), JSON.stringify([
      { id: "coast", name: "Coastal plans", placeIds: [] },
    ]));
    setOnline(false);
    const { result } = renderHook(() => useGroups({
      apiBaseUrl: "https://api.example.test",
      authenticated: true,
      identityKey: "account-a",
      places: [place],
      request: vi.fn(() => json([])),
    }));
    await waitFor(() => expect(result.current.groups.map((group) => group.id)).toEqual(["coast"]));

    await act(async () => {
      await result.current.addPlace("coast", place.id);
      await result.current.removePlace("coast", place.id);
    });
    expect(result.current.groups[0].places).toEqual([]);
    expect(result.current.pendingMemberships).toBe(1);
    expect(JSON.parse(window.localStorage.getItem(accountGroupsOutboxKey("account-a")) ?? "null")).toEqual({
      coast: { "park-1": expect.objectContaining({ included: false }) },
    });
    expect(JSON.parse(window.localStorage.getItem(accountGroupsCacheKey("account-a")) ?? "null")[0].placeIds).toEqual([]);
    expect(result.current.syncMessage).toMatch(/waiting to sync/i);
  });

  it("keeps cached groups and pending memberships isolated across account switches", async () => {
    window.localStorage.setItem(accountGroupsCacheKey("account-a"), JSON.stringify([{ id: "a", name: "A", placeIds: [place.id] }]));
    window.localStorage.setItem(accountGroupsCacheKey("account-b"), JSON.stringify([{ id: "b", name: "B", placeIds: [] }]));
    window.localStorage.setItem(accountGroupsOutboxKey("account-a"), JSON.stringify({ a: { "park-1": { included: true, revision: 1 } } }));
    window.localStorage.setItem(accountGroupsOutboxKey("account-b"), JSON.stringify({ b: { "park-1": { included: false, revision: 1 } } }));
    setOnline(false);
    const { result, rerender } = renderHook(
      ({ identityKey }) => useGroups({ apiBaseUrl: "https://api.example.test", authenticated: true, identityKey, places: [place], request: vi.fn(() => json([])) }),
      { initialProps: { identityKey: "account-a" } },
    );
    await waitFor(() => expect(result.current.groups.map((group) => group.id)).toEqual(["a"]));
    expect(result.current.pendingMemberships).toBe(1);

    rerender({ identityKey: "account-b" });
    await waitFor(() => expect(result.current.groups.map((group) => group.id)).toEqual(["b"]));
    expect(result.current.groups[0].places).toEqual([]);
    expect(result.current.pendingMemberships).toBe(1);
    expect(JSON.parse(window.localStorage.getItem(accountGroupsOutboxKey("account-a")) ?? "null").a["park-1"].included).toBe(true);
  });

  it("drains a persisted membership on startup and removes it after acknowledgement", async () => {
    window.localStorage.setItem(accountGroupsCacheKey("account-a"), JSON.stringify([{ id: "coast", name: "Coastal plans", placeIds: [] }]));
    window.localStorage.setItem(accountGroupsOutboxKey("account-a"), JSON.stringify({ coast: { "park-1": { included: true, revision: 1 } } }));
    const request = vi.fn((path: string, init?: RequestInit) => {
      if (path === "/api/groups/coast/places") return json({ id: "coast", name: "Coastal plans", placeIds: [place.id] });
      expect(init?.cache).toBe("no-store");
      return json([{ id: "coast", name: "Coastal plans", placeIds: [] }]);
    });
    const { result } = renderHook(() => useGroups({ apiBaseUrl: "https://api.example.test", authenticated: true, identityKey: "account-a", places: [place], request }));
    await waitFor(() => expect(request).toHaveBeenCalledWith("/api/groups/coast/places", expect.objectContaining({ method: "POST" })));
    await waitFor(() => expect(result.current.pendingMemberships).toBe(0));
    expect(result.current.groups[0].places).toEqual([place]);
    expect(JSON.parse(window.localStorage.getItem(accountGroupsOutboxKey("account-a")) ?? "null")).toEqual({});
  });

  it("retains a failed membership for a later retry", async () => {
    window.localStorage.setItem(accountGroupsCacheKey("account-a"), JSON.stringify([{ id: "coast", name: "Coastal plans", placeIds: [] }]));
    setOnline(false);
    const request = vi.fn((path: string) => path === "/api/groups/coast/places"
      ? Promise.resolve(new Response(JSON.stringify({ detail: "temporarily unavailable" }), { status: 503, headers: { "Content-Type": "application/json" } }))
      : json([{ id: "coast", name: "Coastal plans", placeIds: [] }]));
    const { result } = renderHook(() => useGroups({ apiBaseUrl: "https://api.example.test", authenticated: true, identityKey: "account-a", places: [place], request }));
    await waitFor(() => expect(result.current.groups.length).toBe(1));
    await act(async () => { await result.current.addPlace("coast", place.id); });
    expect(result.current.pendingMemberships).toBe(1);

    setOnline(true);
    window.dispatchEvent(new Event("online"));
    await waitFor(() => expect(request).toHaveBeenCalledWith("/api/groups/coast/places", expect.objectContaining({ method: "POST" })));
    await waitFor(() => expect(result.current.pendingMemberships).toBe(1));
    expect(result.current.syncStatus).toBe("error");
    expect(JSON.parse(window.localStorage.getItem(accountGroupsOutboxKey("account-a")) ?? "null").coast["park-1"].included).toBe(true);
  });

  it("drops a permanently invalid membership and reconciles a group deleted elsewhere", async () => {
    window.localStorage.setItem(accountGroupsCacheKey("account-a"), JSON.stringify([{ id: "coast", name: "Coastal plans", placeIds: [place.id] }]));
    window.localStorage.setItem(accountGroupsOutboxKey("account-a"), JSON.stringify({ coast: { "park-1": { included: false, revision: 1 } } }));
    const request = vi.fn((path: string) => path === "/api/groups/coast/places"
      ? failed(404, "Collection not found")
      : json([]));

    const { result } = renderHook(() => useGroups({ apiBaseUrl: "https://api.example.test", authenticated: true, identityKey: "account-a", places: [place], request }));

    await waitFor(() => expect(request).toHaveBeenCalledWith("/api/groups/coast/places", expect.objectContaining({ method: "DELETE" })));
    await waitFor(() => expect(result.current.pendingMemberships).toBe(0));
    await waitFor(() => expect(result.current.groups).toEqual([]));
    expect(JSON.parse(window.localStorage.getItem(accountGroupsOutboxKey("account-a")) ?? "null")).toEqual({});
    expect(request.mock.calls.filter(([path]) => path === "/api/groups")).toHaveLength(2);
  });

  it("drops an invalid-place membership rather than retrying it forever", async () => {
    window.localStorage.setItem(accountGroupsCacheKey("account-a"), JSON.stringify([{ id: "coast", name: "Coastal plans", placeIds: [] }]));
    window.localStorage.setItem(accountGroupsOutboxKey("account-a"), JSON.stringify({ coast: { "park-1": { included: true, revision: 1 } } }));
    const request = vi.fn((path: string) => path === "/api/groups/coast/places"
      ? failed(400, "One or more places were not found or are inactive")
      : json([{ id: "coast", name: "Coastal plans", placeIds: [] }]));

    const { result } = renderHook(() => useGroups({ apiBaseUrl: "https://api.example.test", authenticated: true, identityKey: "account-a", places: [place], request }));

    await waitFor(() => expect(request).toHaveBeenCalledWith("/api/groups/coast/places", expect.objectContaining({ method: "POST" })));
    await waitFor(() => expect(result.current.pendingMemberships).toBe(0));
    await waitFor(() => expect(result.current.groups[0]?.places).toEqual([]));
    expect(JSON.parse(window.localStorage.getItem(accountGroupsOutboxKey("account-a")) ?? "null")).toEqual({});
  });

  it("refreshes after a rename discovers that the group was deleted elsewhere", async () => {
    let groupReads = 0;
    const request = vi.fn((path: string, init?: RequestInit) => {
      if (path === "/api/groups/coast" && init?.method === "PATCH") return failed(404, "Collection not found");
      groupReads += 1;
      return json(groupReads === 1 ? [{ id: "coast", name: "Coastal plans", placeIds: [] }] : []);
    });
    const { result } = renderHook(() => useGroups({ apiBaseUrl: "https://api.example.test", authenticated: true, identityKey: "account-a", places: [place], request }));
    await waitFor(() => expect(result.current.groups.map((group) => group.id)).toEqual(["coast"]));

    await act(async () => {
      await expect(result.current.rename("coast", "New name")).rejects.toMatchObject({ status: 404 });
    });

    expect(result.current.groups).toEqual([]);
    expect(request.mock.calls.filter(([path]) => path === "/api/groups")).toHaveLength(2);
    expect(JSON.parse(window.localStorage.getItem(accountGroupsCacheKey("account-a")) ?? "null")).toEqual([]);
  });

  it("treats deleting an already-deleted group as success after reconciliation", async () => {
    let groupReads = 0;
    const request = vi.fn((path: string, init?: RequestInit) => {
      if (path === "/api/groups/coast" && init?.method === "DELETE") return failed(404, "Collection not found");
      groupReads += 1;
      return json(groupReads === 1 ? [{ id: "coast", name: "Coastal plans", placeIds: [] }] : []);
    });
    const { result } = renderHook(() => useGroups({ apiBaseUrl: "https://api.example.test", authenticated: true, identityKey: "account-a", places: [place], request }));
    await waitFor(() => expect(result.current.groups.map((group) => group.id)).toEqual(["coast"]));

    await act(async () => { await result.current.remove("coast"); });

    expect(result.current.groups).toEqual([]);
    expect(result.current.pendingMemberships).toBe(0);
    expect(JSON.parse(window.localStorage.getItem(accountGroupsCacheKey("account-a")) ?? "null")).toEqual([]);
  });

  it("does not refresh or queue an invalid create request", async () => {
    const request = vi.fn((path: string, init?: RequestInit) => path === "/api/groups" && init?.method === "POST"
      ? failed(422, "Wishlist is reserved for the protected account collection")
      : json([{ id: "wishlist", name: "Wishlist", isWishlist: true, placeIds: [] }]));
    const { result } = renderHook(() => useGroups({ apiBaseUrl: "https://api.example.test", authenticated: true, identityKey: "account-a", places: [place], request }));
    await waitFor(() => expect(result.current.groups.map((group) => group.id)).toEqual(["wishlist"]));

    await act(async () => {
      await expect(result.current.create("Wishlist", [])).rejects.toMatchObject({ status: 422 });
    });

    expect(request.mock.calls.filter(([path, init]) => path === "/api/groups" && !init?.method)).toHaveLength(1);
    expect(result.current.pendingMemberships).toBe(0);
    expect(JSON.parse(window.localStorage.getItem(accountGroupsOutboxKey("account-a")) ?? "null")).toEqual({});
  });
});

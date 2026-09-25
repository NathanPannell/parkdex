// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const gatewayMock = vi.hoisted(() => ({
  fetchMap: vi.fn(),
  retryMap: vi.fn(),
  fetchSearch: vi.fn(),
  retrySearch: vi.fn(),
  fetchVisited: vi.fn(),
  retryVisited: vi.fn(),
  remember: vi.fn(),
  getOfflineStatus: vi.fn(),
  subscribeOfflineStatus: vi.fn(),
}));

vi.mock("./place-data-gateway", async (importOriginal) => ({
  ...await importOriginal<typeof import("./place-data-gateway")>(),
  createPlaceGateway: () => gatewayMock,
}));

import type { PlaceDataItem, PlaceDataResult, PlaceGatewayStatus } from "./place-data-gateway";
import { usePlaceData } from "./use-place-data";

type HookOptions = Parameters<typeof usePlaceData>[0];

const categories = new Set<PlaceDataItem["category"]>();
const authorities = new Set<string>();
const visitedIds = new Set<string>();
const viewport = { west: -139, south: 48, east: -114, north: 60, zoom: 5 };
const baseOptions: HookOptions = {
  apiBaseUrl: "https://api.example.test",
  ownerKey: "guest:test",
  headers: { "X-Collection-Key": "test-key" },
  viewport: null,
  selectedId: null,
  mapQuery: "",
  mapCategories: categories,
  collectionQuery: "",
  collectionCategories: categories,
  mapAuthorities: authorities,
  collectionAuthorities: authorities,
  visitFilter: "all",
  visitedIds,
  searchDraft: "",
  searchExpanded: false,
  view: "collection",
};

function place(id: string): PlaceDataItem {
  return {
    id,
    name: `Place ${id}`,
    category: "regional",
    latitude: 49,
    longitude: -124,
    region: "Coast",
    description: "",
    sourceUrl: "https://example.test/place",
    sourceName: "Example",
    visited: false,
    priorityTier: 2,
    priorityKey: id,
  };
}

function page(prefix: string, count: number, total = count, scope: "full" | "cached" = "full", offset = 0): PlaceDataResult {
  return {
    places: Array.from({ length: count }, (_, index) => place(`${prefix}-${offset + index}`)),
    total,
    limit: 50,
    offset,
    scope,
    partial: offset + count < total,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

let offlineStatus: PlaceGatewayStatus;
let offlineSubscriber: ((status: PlaceGatewayStatus) => void) | null;

function emitOffline(offline: boolean) {
  offlineStatus = { offline, message: offline ? "Offline" : null };
  offlineSubscriber?.(offlineStatus);
}

beforeEach(() => {
  offlineStatus = { offline: false, message: null };
  offlineSubscriber = null;
  gatewayMock.getOfflineStatus.mockImplementation(() => offlineStatus);
  gatewayMock.subscribeOfflineStatus.mockImplementation((listener: (status: PlaceGatewayStatus) => void) => {
    offlineSubscriber = listener;
    listener(offlineStatus);
    return () => { if (offlineSubscriber === listener) offlineSubscriber = null; };
  });
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("usePlaceData", () => {
  it("ignores a late collection page from an earlier filter", async () => {
    const oldPage = deferred<PlaceDataResult>();
    gatewayMock.fetchSearch.mockImplementation((query: { query?: string; offset?: number }) => {
      if (query.query === "old" && query.offset === 50) return oldPage.promise;
      return Promise.resolve(query.query === "old" ? page("old", 50, 100) : page("new", 1));
    });
    const { result, rerender } = renderHook(
      ({ collectionQuery }: { collectionQuery: string }) => usePlaceData({ ...baseOptions, collectionQuery }),
      { initialProps: { collectionQuery: "old" } },
    );
    await waitFor(() => expect(result.current.collection.places).toHaveLength(50));
    act(() => result.current.loadMoreCollection());
    await waitFor(() => expect(gatewayMock.fetchSearch).toHaveBeenCalledWith(expect.objectContaining({ query: "old", offset: 50 })));

    rerender({ collectionQuery: "new" });
    await waitFor(() => expect(result.current.collection.places.map((item) => item.id)).toEqual(["new-0"]));
    await act(async () => { oldPage.resolve(page("old", 50, 100, "full", 50)); await oldPage.promise; });
    expect(result.current.collection.places.map((item) => item.id)).toEqual(["new-0"]);
  });

  it("starts only one request for repeated load-more clicks at the same offset", async () => {
    const secondPage = deferred<PlaceDataResult>();
    gatewayMock.fetchSearch.mockImplementation((query: { offset?: number }) => query.offset === 50
      ? secondPage.promise
      : Promise.resolve(page("first", 50, 100)));
    const { result } = renderHook(() => usePlaceData(baseOptions));
    await waitFor(() => expect(result.current.collection.places).toHaveLength(50));

    act(() => { result.current.loadMoreCollection(); result.current.loadMoreCollection(); });
    expect(gatewayMock.fetchSearch.mock.calls.filter(([query]) => query.offset === 50)).toHaveLength(1);
    await act(async () => { secondPage.resolve(page("second", 50, 100, "full", 50)); await secondPage.promise; });
    expect(result.current.collection.places).toHaveLength(100);
    expect(new Set(result.current.collection.places.map((item) => item.id)).size).toBe(100);
  });

  it("replaces an online map sample with saved places when offline status changes", async () => {
    gatewayMock.fetchMap.mockImplementation(() => Promise.resolve(offlineStatus.offline
      ? page("saved", 1, 1, "cached")
      : page("online", 1)));
    const { result } = renderHook(() => usePlaceData({ ...baseOptions, viewport, view: "map" }));
    await waitFor(() => expect(result.current.map.places.map((item) => item.id)).toEqual(["online-0"]));

    act(() => emitOffline(true));
    expect(result.current.map.places).toEqual([]);
    await waitFor(() => expect(result.current.map.places.map((item) => item.id)).toEqual(["saved-0"]));
    expect(result.current.map.scope).toBe("cached");
    expect(gatewayMock.fetchMap).toHaveBeenCalledTimes(2);
  });

  it("keeps the last map sample visible through a viewport request and swaps it on success", async () => {
    const nextViewportResponse = deferred<PlaceDataResult>();
    gatewayMock.fetchMap.mockImplementation((query: { viewport: typeof viewport }) =>
      query.viewport.west === viewport.west ? Promise.resolve(page("first", 2)) : nextViewportResponse.promise,
    );
    const { result, rerender } = renderHook(
      ({ currentViewport }: { currentViewport: typeof viewport }) => usePlaceData({ ...baseOptions, viewport: currentViewport, view: "map" }),
      { initialProps: { currentViewport: viewport } },
    );

    await waitFor(() => expect(result.current.map.places.map((item) => item.id)).toEqual(["first-0", "first-1"]));
    const nextViewport = { ...viewport, west: -128, east: -113 };
    rerender({ currentViewport: nextViewport });
    await waitFor(() => expect(gatewayMock.fetchMap).toHaveBeenCalledTimes(2));
    expect(result.current.map.places.map((item) => item.id)).toEqual(["first-0", "first-1"]);

    await act(async () => { nextViewportResponse.resolve(page("second", 1)); await nextViewportResponse.promise; });
    expect(result.current.map.places.map((item) => item.id)).toEqual(["second-0"]);
  });

  it("clears a stale sample when the active map filter changes and keeps it cleared on failure", async () => {
    const filteredResponse = deferred<PlaceDataResult>();
    gatewayMock.fetchMap.mockImplementation((query: { categories: string[] }) => query.categories.includes("regional")
      ? filteredResponse.promise
      : Promise.resolve(page("provincial", 1)));
    const { result, rerender } = renderHook(
      ({ mapCategories }: { mapCategories: ReadonlySet<PlaceDataItem["category"]> }) => usePlaceData({
        ...baseOptions,
        viewport,
        view: "map",
        mapCategories,
      }),
      { initialProps: { mapCategories: new Set<PlaceDataItem["category"]>() } },
    );
    await waitFor(() => expect(result.current.map.places.map((item) => item.id)).toEqual(["provincial-0"]));

    rerender({ mapCategories: new Set<PlaceDataItem["category"]>(["regional"]) });
    expect(result.current.map.places).toEqual([]);
    await waitFor(() => expect(gatewayMock.fetchMap).toHaveBeenCalledTimes(2));
    await act(async () => { filteredResponse.reject(new Error("filtered query failed")); await Promise.resolve(); });
    expect(result.current.map.places).toEqual([]);
  });

  it("does not expose the prior owner map sample during an account transition", async () => {
    gatewayMock.fetchMap.mockResolvedValue(page("owner-a", 1));
    const { result, rerender } = renderHook(
      ({ ownerKey }: { ownerKey: string }) => usePlaceData({ ...baseOptions, ownerKey, viewport, view: "map" }),
      { initialProps: { ownerKey: "account:a" } },
    );
    await waitFor(() => expect(result.current.map.places.map((item) => item.id)).toEqual(["owner-a-0"]));

    gatewayMock.fetchMap.mockImplementation(() => new Promise(() => undefined));
    rerender({ ownerKey: "account:b" });
    expect(result.current.map.places).toEqual([]);
  });

  it("reuses the same map sample across views but forces Map on explicit retry", async () => {
    gatewayMock.fetchMap.mockResolvedValue(page("online", 1));
    gatewayMock.retryMap.mockResolvedValue(page("refreshed", 1));
    gatewayMock.fetchSearch.mockResolvedValue(page("list", 1));
    gatewayMock.fetchVisited.mockResolvedValue(page("visited", 1));
    const { result, rerender } = renderHook(
      ({ view }: { view: string }) => usePlaceData({ ...baseOptions, viewport, view }),
      { initialProps: { view: "map" } },
    );
    await waitFor(() => expect(result.current.map.places.map((item) => item.id)).toEqual(["online-0"]));
    rerender({ view: "collection" });
    await waitFor(() => expect(result.current.collection.places).toHaveLength(1));
    rerender({ view: "account" });
    await waitFor(() => expect(result.current.visited.places).toHaveLength(1));
    rerender({ view: "map" });
    expect(result.current.map.places.map((item) => item.id)).toEqual(["online-0"]);
    expect(gatewayMock.fetchMap).toHaveBeenCalledTimes(1);

    act(() => result.current.retry());
    await waitFor(() => expect(gatewayMock.retryMap).toHaveBeenCalledOnce());
    await waitFor(() => expect(result.current.map.places.map((item) => item.id)).toEqual(["refreshed-0"]));
  });

  it("retries the List online without requiring a map viewport", async () => {
    emitOffline(true);
    gatewayMock.fetchSearch.mockImplementation(() => Promise.resolve(offlineStatus.offline
      ? page("saved", 1, 1, "cached")
      : page("online", 1)));
    gatewayMock.retrySearch.mockImplementation(async () => {
      emitOffline(false);
      return page("online", 1);
    });
    const { result } = renderHook(() => usePlaceData({ ...baseOptions, viewport: null, view: "collection" }));
    await waitFor(() => expect(result.current.collection.scope).toBe("cached"));

    act(() => result.current.retry());
    await waitFor(() => expect(gatewayMock.retrySearch).toHaveBeenCalledOnce());
    await waitFor(() => expect(result.current.collection.places.map((item) => item.id)).toEqual(["online-0"]));
    expect(result.current.offline).toBe(false);
    expect(gatewayMock.retryMap).not.toHaveBeenCalled();
  });

  it("retries My Dex online without requiring a map viewport", async () => {
    emitOffline(true);
    gatewayMock.fetchVisited.mockImplementation(() => Promise.resolve(offlineStatus.offline
      ? page("saved", 1, 1, "cached")
      : page("online", 1)));
    gatewayMock.retryVisited.mockImplementation(async () => {
      emitOffline(false);
      return page("online", 1);
    });
    const { result } = renderHook(() => usePlaceData({ ...baseOptions, viewport: null, view: "account" }));
    await waitFor(() => expect(result.current.visited.scope).toBe("cached"));

    act(() => result.current.retry());
    await waitFor(() => expect(gatewayMock.retryVisited).toHaveBeenCalledOnce());
    await waitFor(() => expect(result.current.visited.places.map((item) => item.id)).toEqual(["online-0"]));
    expect(result.current.offline).toBe(false);
    expect(gatewayMock.retryMap).not.toHaveBeenCalled();
  });
});

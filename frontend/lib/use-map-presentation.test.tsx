// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const notificationMock = vi.hoisted(() => ({ notifyError: vi.fn() }));

vi.mock("@/lib/application-notifications", () => ({
  notifyError: notificationMock.notifyError,
}));

import {
  cachedViewportBoundaryAsset,
  paddedBoundaryViewport,
  resetMapPresentationAssetCache,
  useMapPresentation,
  viewportBoundaryRequestUrl,
  viewportWithinBoundaryCoverage,
} from "./use-map-presentation";
import type { MapViewport } from "./map-presentation";

const place = {
  id: "park-1",
  name: "Forest Park",
  category: "provincial" as const,
  latitude: 49,
  longitude: -124,
  region: "South",
  description: "Forest",
  sourceUrl: "https://example.test/park",
  sourceName: "BC Parks",
};

const secondPlace = {
  ...place,
  id: "park-2",
  name: "River Park",
  longitude: -123.5,
};

const testViewport: MapViewport = { west: -125, south: 48, east: -123, north: 50, zoom: 10 };

function collection(features: unknown[] = []) {
  return { type: "FeatureCollection", features };
}

function boundaryFeature(sourcePlace: typeof place = place) {
  const left = sourcePlace.longitude;
  return {
    type: "Feature",
    id: sourcePlace.id,
    properties: {
      id: sourcePlace.id,
      name: sourcePlace.name,
      category: sourcePlace.category,
      sourceName: sourcePlace.sourceName,
      sourceUrl: sourcePlace.sourceUrl,
      sourceId: null,
    },
    geometry: {
      type: "Polygon",
      coordinates: [[[left, 49], [left + 0.1, 49], [left + 0.1, 49.1], [left, 49.1], [left, 49]]],
    },
  };
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

describe("useMapPresentation viewport boundary requests", () => {
  let failBoundaryRequest = true;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    failBoundaryRequest = true;
    notificationMock.notifyError.mockReset();
    resetMapPresentationAssetCache();
    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void init;
      const url = new URL(String(input), window.location.href);
      if (url.pathname.endsWith("boundaries-index.v1.json")) {
        return response({
          version: 1,
          boundsById: {
            [place.id]: [[-125, 48], [-123, 50]],
            [secondPlace.id]: [[-124, 48], [-122, 50]],
          },
        });
      }
      if (url.pathname.endsWith("exploration-territories.v1.geojson")) return response(collection());
      if (url.pathname.endsWith("bc-focus-mask.v1.geojson")) return response(collection());
      if (url.pathname === "/api/map/boundaries") {
        if (failBoundaryRequest) return response({ error: "offline" }, 503);
        return response(collection([
          boundaryFeature(place),
          boundaryFeature(secondPlace),
          boundaryFeature({ ...place, id: "not-in-marker-sample", longitude: -124.25 }),
        ]));
      }
      throw new Error(`Unexpected map asset request: ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    resetMapPresentationAssetCache();
    vi.unstubAllGlobals();
  });

  it("requests every boundary in the viewport, preserves pins on failure, and retries on reconnection", async () => {
    const { result } = renderHook(() => useMapPresentation({
      apiBaseUrl: "https://api.example.test/",
      places: [place],
      visited: new Set<string>(),
      mode: "discover",
      selectedId: null,
      viewport: testViewport,
    }));

    await waitFor(() => expect(result.current.boundaryLoadState.status).toBe("failed"));
    expect(result.current.assets.status).toBe("ready");
    expect(result.current.placeData.features.map((feature) => feature.properties.id)).toEqual([place.id]);
    expect(result.current.boundaryData.features).toEqual([]);
    expect(notificationMock.notifyError).not.toHaveBeenCalled();

    const boundaryCall = fetchMock.mock.calls.find(([input]) => new URL(String(input), window.location.href).pathname === "/api/map/boundaries");
    expect(boundaryCall).toBeDefined();
    const requestedUrl = new URL(String(boundaryCall?.[0]), window.location.href);
    expect([...requestedUrl.searchParams.keys()].sort()).toEqual(["east", "north", "south", "west"]);
    expect(requestedUrl.searchParams.get("place_id")).toBeNull();
    expect(Number(requestedUrl.searchParams.get("west"))).toBeLessThan(testViewport.west);
    expect(Number(requestedUrl.searchParams.get("east"))).toBeGreaterThan(testViewport.east);
    expect(boundaryCall?.[1]?.cache).toBe("default");
    expect(boundaryCall?.[1]?.headers).toBeUndefined();

    failBoundaryRequest = false;
    await act(async () => { window.dispatchEvent(new Event("online")); });
    await waitFor(() => expect(result.current.boundaryLoadState.status).toBe("ready"));
    expect(result.current.boundaryData.features.map((feature) => feature.properties.id)).toEqual([
      place.id,
      secondPlace.id,
      "not-in-marker-sample",
    ]);
  });

  it("builds a bbox URL and recognizes padded antimeridian coverage", () => {
    const requestUrl = new URL(viewportBoundaryRequestUrl("https://api.example.test/", testViewport));
    expect(requestUrl.pathname).toBe("/api/map/boundaries");
    expect([...requestUrl.searchParams.keys()].sort()).toEqual(["east", "north", "south", "west"]);
    const wrapped = paddedBoundaryViewport({ west: 178, south: 48, east: -178, north: 50 });
    expect(wrapped.west).toBeGreaterThan(0);
    expect(wrapped.east).toBeLessThan(0);
    expect(viewportWithinBoundaryCoverage({ west: 179, south: 48.2, east: -179, north: 49.8 }, wrapped)).toBe(true);
    expect(viewportWithinBoundaryCoverage({ west: -170, south: 48.2, east: -168, north: 49.8 }, wrapped)).toBe(false);
  });

  it("starts viewport boundary loading while static map assets are still pending", async () => {
    const explorationAssets = deferred<Response>();
    const concurrentFetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.href);
      if (url.pathname.endsWith("boundaries-index.v1.json")) {
        return response({ version: 1, boundsById: { [place.id]: [[-125, 48], [-123, 50]] } });
      }
      if (url.pathname.endsWith("exploration-territories.v1.geojson")) return explorationAssets.promise;
      if (url.pathname.endsWith("bc-focus-mask.v1.geojson")) return response(collection());
      if (url.pathname === "/api/map/boundaries") return response(collection([boundaryFeature(place)]));
      throw new Error(`Unexpected map asset request: ${url.pathname}`);
    });
    vi.stubGlobal("fetch", concurrentFetchMock);

    const { result } = renderHook(() => useMapPresentation({
      apiBaseUrl: "https://api.example.test",
      places: [place],
      visited: new Set<string>(),
      mode: "discover",
      selectedId: null,
      viewport: testViewport,
    }));

    await waitFor(() => expect(concurrentFetchMock.mock.calls.some(([input]) =>
      new URL(String(input), window.location.href).pathname === "/api/map/boundaries",
    )).toBe(true));
    expect(result.current.assets.status).toBe("loading");

    await act(async () => { explorationAssets.resolve(response(collection())); });
    await waitFor(() => expect(result.current.boundaryLoadState.status).toBe("ready"));
    expect(result.current.boundaryData.features.map((feature) => feature.properties.id)).toEqual([place.id]);
  });

  it("keeps the viewport boundary request independent from marker sample changes", async () => {
    failBoundaryRequest = false;
    const { result, rerender } = renderHook(
      ({ currentPlaces }: { currentPlaces: typeof place[] }) => useMapPresentation({
        apiBaseUrl: "https://api.example.test",
        places: currentPlaces,
        visited: new Set<string>(),
        mode: "discover",
        selectedId: null,
        viewport: testViewport,
      }),
      { initialProps: { currentPlaces: [place] } },
    );

    const allViewportBoundaryIds = [place.id, secondPlace.id, "not-in-marker-sample"];
    await waitFor(() => expect(result.current.boundaryData.features.map((feature) => feature.properties.id)).toEqual(allViewportBoundaryIds));
    rerender({ currentPlaces: [place, secondPlace] });
    expect(result.current.boundaryData.features.map((feature) => feature.properties.id)).toEqual(allViewportBoundaryIds);

    const boundaryRequests = fetchMock.mock.calls
      .map(([input]) => new URL(String(input), window.location.href))
      .filter((url) => url.pathname === "/api/map/boundaries");
    expect(boundaryRequests).toHaveLength(1);
    expect(boundaryRequests[0].searchParams.get("place_id")).toBeNull();
  });

  it("holds the prior boundary wave while a viewport request is pending and ignores stale responses", async () => {
    resetMapPresentationAssetCache();
    const pendingViewport = deferred<Response>();
    let pendingSignal: AbortSignal | undefined;
    const thirdPlace = { ...place, id: "park-3", name: "Lake Park", longitude: -116 };
    const viewportTwo: MapViewport = { ...testViewport, west: -120, east: -118 };
    const viewportThree: MapViewport = { ...testViewport, west: -117, east: -115 };
    const staleFetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), window.location.href);
      if (url.pathname.endsWith("boundaries-index.v1.json")) {
        return response({
          version: 1,
          boundsById: {
            [place.id]: [[-125, 48], [-123, 50]],
            [secondPlace.id]: [[-124, 48], [-122, 50]],
          },
        });
      }
      if (url.pathname.endsWith("exploration-territories.v1.geojson") || url.pathname.endsWith("bc-focus-mask.v1.geojson")) return response(collection());
      if (url.pathname === "/api/map/boundaries") {
        const west = Number(url.searchParams.get("west"));
        if (west < -124) return response(collection([boundaryFeature(place)]));
        if (west < -119) {
          pendingSignal = init?.signal ?? undefined;
          return pendingViewport.promise;
        }
        return response(collection([boundaryFeature(thirdPlace)]));
      }
      throw new Error(`Unexpected map asset request: ${url.pathname}`);
    });
    vi.stubGlobal("fetch", staleFetchMock);

    const { result, rerender } = renderHook(
      ({ currentPlaces, currentViewport }: { currentPlaces: typeof place[]; currentViewport: MapViewport }) => useMapPresentation({
        apiBaseUrl: "https://api.example.test",
        places: currentPlaces,
        visited: new Set<string>(),
        mode: "discover",
        selectedId: null,
        viewport: currentViewport,
      }),
      { initialProps: { currentPlaces: [place], currentViewport: testViewport } },
    );

    await waitFor(() => expect(result.current.boundaryData.features.map((feature) => feature.properties.id)).toEqual([place.id]));
    rerender({ currentPlaces: [secondPlace], currentViewport: viewportTwo });
    await waitFor(() => expect(pendingSignal).toBeDefined());
    expect(result.current.boundaryData.features.map((feature) => feature.properties.id)).toEqual([place.id]);

    rerender({ currentPlaces: [thirdPlace], currentViewport: viewportThree });
    await waitFor(() => expect(result.current.boundaryData.features.map((feature) => feature.properties.id)).toEqual([thirdPlace.id]));
    expect(pendingSignal?.aborted).toBe(true);
    await act(async () => { pendingViewport.resolve(response(collection([boundaryFeature(secondPlace)]))); await pendingViewport.promise; });
    expect(result.current.boundaryData.features.map((feature) => feature.properties.id)).toEqual([thirdPlace.id]);
  });

  it("keeps sampled boundaries and a prior viewport wave for an offline pan back", async () => {
    resetMapPresentationAssetCache();
    const viewportTwo: MapViewport = { west: -120, south: 48, east: -118, north: 50, zoom: 10 };
    const secondMarker = { ...secondPlace, longitude: -119.5 };
    const wave = (prefix: string, west: number, marker: typeof place) => collection([
      ...Array.from({ length: 120 }, (_, index) => boundaryFeature({
        ...place,
        id: `${prefix}-${index}`,
        name: `${prefix} ${index}`,
        longitude: west + index * 0.003,
      })),
      boundaryFeature(marker),
    ]);
    let boundaryRequests = 0;
    const offlinePanBackFetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.href);
      if (url.pathname.endsWith("boundaries-index.v1.json")) {
        return response({ version: 1, boundsById: { [place.id]: [[-125, 48], [-123, 50]] } });
      }
      if (url.pathname.endsWith("exploration-territories.v1.geojson") || url.pathname.endsWith("bc-focus-mask.v1.geojson")) return response(collection());
      if (url.pathname === "/api/map/boundaries") {
        boundaryRequests += 1;
        if (boundaryRequests === 1) return response(wave("west", -124.9, place));
        if (boundaryRequests === 2) return response(wave("east", -119.9, secondMarker));
        return response({ error: "offline" }, 503);
      }
      throw new Error(`Unexpected map asset request: ${url.pathname}`);
    });
    vi.stubGlobal("fetch", offlinePanBackFetchMock);

    const { result, rerender } = renderHook(
      ({ currentPlaces, currentViewport }: { currentPlaces: typeof place[]; currentViewport: MapViewport }) => useMapPresentation({
        apiBaseUrl: "https://api.example.test",
        identityKey: "account:cache-test",
        places: currentPlaces,
        visited: new Set<string>(),
        mode: "discover",
        selectedId: null,
        viewport: currentViewport,
      }),
      { initialProps: { currentPlaces: [place], currentViewport: testViewport } },
    );

    await waitFor(() => expect(result.current.boundaryLoadState.status).toBe("ready"));
    const firstViewportCache = cachedViewportBoundaryAsset("https://api.example.test", "account:cache-test", testViewport);
    expect(firstViewportCache.features.map((feature) => feature.properties.id)).toContain(place.id);
    expect(firstViewportCache.features.length).toBeLessThanOrEqual(100);

    rerender({ currentPlaces: [secondMarker], currentViewport: viewportTwo });
    await waitFor(() => expect(result.current.boundaryLoadState.status).toBe("ready"));
    const secondViewportCache = cachedViewportBoundaryAsset("https://api.example.test", "account:cache-test", viewportTwo);
    expect(secondViewportCache.features.map((feature) => feature.properties.id)).toContain(secondMarker.id);
    expect(secondViewportCache.features.length).toBeLessThanOrEqual(100);

    rerender({ currentPlaces: [place], currentViewport: testViewport });
    await waitFor(() => expect(result.current.boundaryLoadState.status).toBe("failed"));
    expect(result.current.boundaryData.features.map((feature) => feature.properties.id)).toContain(place.id);
    expect(boundaryRequests).toBe(3);
  });

  it("keeps cached boundaries scoped to the current identity", async () => {
    failBoundaryRequest = false;
    const { result, rerender } = renderHook(
      ({ identityKey }: { identityKey: string }) => useMapPresentation({
        apiBaseUrl: "https://api.example.test",
        identityKey,
        places: [place],
        visited: new Set<string>(),
        mode: "discover",
        selectedId: null,
        viewport: testViewport,
      }),
      { initialProps: { identityKey: "account:a" } },
    );
    await waitFor(() => expect(result.current.boundaryData.features).toHaveLength(3));
    expect(cachedViewportBoundaryAsset("https://api.example.test", "account:a", testViewport).features.length).toBeGreaterThan(0);

    rerender({ identityKey: "account:b" });
    expect(result.current.boundaryData.features).toEqual([]);
  });
});

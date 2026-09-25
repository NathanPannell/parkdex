// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const notificationMock = vi.hoisted(() => ({ notifyError: vi.fn() }));

vi.mock("@/lib/application-notifications", () => ({
  notifyError: notificationMock.notifyError,
}));

import { resetMapPresentationAssetCache, useMapPresentation, mapBoundaryRequestUrl } from "./use-map-presentation";

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

describe("useMapPresentation sampled boundary requests", () => {
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
        const requestedIds = new Set(url.searchParams.getAll("place_id"));
        return response(collection([
          ...(requestedIds.has(place.id) ? [boundaryFeature(place)] : []),
          ...(requestedIds.has(secondPlace.id) ? [boundaryFeature(secondPlace)] : []),
          boundaryFeature({ ...place, id: "not-requested" }),
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

  it("requests only sampled boundary IDs, preserves pins on failure, and retries on reconnection", async () => {
    const { result } = renderHook(() => useMapPresentation({
      apiBaseUrl: "https://api.example.test/",
      places: [place],
      visited: new Set<string>(),
      mode: "discover",
      selectedId: null,
      viewport: null,
    }));

    await waitFor(() => expect(result.current.boundaryLoadState.status).toBe("failed"));
    expect(result.current.assets.status).toBe("ready");
    expect(result.current.placeData.features.map((feature) => feature.properties.id)).toEqual([place.id]);
    expect(result.current.boundaryData.features).toEqual([]);
    expect(notificationMock.notifyError).not.toHaveBeenCalled();

    const boundaryCall = fetchMock.mock.calls.find(([input]) => new URL(String(input), window.location.href).pathname === "/api/map/boundaries");
    expect(boundaryCall).toBeDefined();
    const requestedUrl = new URL(String(boundaryCall?.[0]), window.location.href);
    expect(requestedUrl.searchParams.getAll("place_id")).toEqual([place.id]);
    expect(boundaryCall?.[1]?.cache).toBe("default");
    expect(boundaryCall?.[1]?.headers).toBeUndefined();
    expect(fetchMock.mock.calls.some(([input]) => new URL(String(input), window.location.href).pathname.endsWith("boundaries-display.v1.geojson"))).toBe(false);

    failBoundaryRequest = false;
    await act(async () => { window.dispatchEvent(new Event("online")); });
    await waitFor(() => expect(result.current.boundaryLoadState.status).toBe("ready"));
    expect(result.current.boundaryData.features.map((feature) => feature.properties.id)).toEqual([place.id]);
  });

  it("builds a stable repeated-ID URL and refuses requests above the backend limit", () => {
    const requestUrl = new URL(mapBoundaryRequestUrl("https://api.example.test/", ["park-z", "park-a", "park-z"]));
    expect(requestUrl.pathname).toBe("/api/map/boundaries");
    expect(requestUrl.searchParams.getAll("place_id")).toEqual(["park-a", "park-z"]);
    expect(() => mapBoundaryRequestUrl("https://api.example.test", Array.from({ length: 51 }, (_, index) => `park-${index}`)))
      .toThrow("At most 50 map boundaries can be requested");
  });

  it("starts sampled boundary loading while the static map assets are still pending", async () => {
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
      viewport: null,
    }));

    await waitFor(() => expect(concurrentFetchMock.mock.calls.some(([input]) =>
      new URL(String(input), window.location.href).pathname === "/api/map/boundaries",
    )).toBe(true));
    expect(result.current.assets.status).toBe("loading");

    await act(async () => { explorationAssets.resolve(response(collection())); });
    await waitFor(() => expect(result.current.boundaryLoadState.status).toBe("ready"));
    expect(result.current.boundaryData.features.map((feature) => feature.properties.id)).toEqual([place.id]);
  });

  it("reuses boundary features for overlapping samples and requests only missing IDs", async () => {
    failBoundaryRequest = false;
    const { result, rerender } = renderHook(
      ({ currentPlaces }: { currentPlaces: typeof place[] }) => useMapPresentation({
        apiBaseUrl: "https://api.example.test",
        places: currentPlaces,
        visited: new Set<string>(),
        mode: "discover",
        selectedId: null,
        viewport: null,
      }),
      { initialProps: { currentPlaces: [place] } },
    );

    await waitFor(() => expect(result.current.boundaryData.features.map((feature) => feature.properties.id)).toEqual([place.id]));
    rerender({ currentPlaces: [place, secondPlace] });
    await waitFor(() => expect(result.current.boundaryData.features.map((feature) => feature.properties.id)).toEqual([place.id, secondPlace.id]));

    const requestedIdSets = fetchMock.mock.calls
      .map(([input]) => new URL(String(input), window.location.href))
      .filter((url) => url.pathname === "/api/map/boundaries")
      .map((url) => url.searchParams.getAll("place_id"));
    expect(requestedIdSets).toEqual([[place.id], [secondPlace.id]]);
  });

  it("ignores a late boundary response after the sampled IDs change", async () => {
    resetMapPresentationAssetCache();
    const oldBoundary = deferred<Response>();
    let oldSignal: AbortSignal | undefined;
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
      if (url.pathname === "/api/map/boundaries" && url.searchParams.getAll("place_id").includes(place.id)) {
        oldSignal = init?.signal ?? undefined;
        return oldBoundary.promise;
      }
      if (url.pathname === "/api/map/boundaries") return response(collection([boundaryFeature(secondPlace)]));
      throw new Error(`Unexpected map asset request: ${url.pathname}`);
    });
    vi.stubGlobal("fetch", staleFetchMock);

    const { result, rerender } = renderHook(
      ({ currentPlaces }: { currentPlaces: typeof place[] }) => useMapPresentation({
        apiBaseUrl: "https://api.example.test",
        places: currentPlaces,
        visited: new Set<string>(),
        mode: "discover",
        selectedId: null,
        viewport: null,
      }),
      { initialProps: { currentPlaces: [place] } },
    );

    await waitFor(() => expect(staleFetchMock.mock.calls.some(([input]) => new URL(String(input), window.location.href).searchParams.get("place_id") === place.id)).toBe(true));
    await act(async () => { rerender({ currentPlaces: [secondPlace] }); });
    await waitFor(() => expect(result.current.boundaryData.features.map((feature) => feature.properties.id)).toEqual([secondPlace.id]));
    expect(oldSignal?.aborted).toBe(true);

    await act(async () => { oldBoundary.resolve(response(collection([boundaryFeature(place)]))); });
    expect(result.current.boundaryData.features.map((feature) => feature.properties.id)).toEqual([secondPlace.id]);
  });
});

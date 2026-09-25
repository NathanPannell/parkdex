// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const notificationMock = vi.hoisted(() => ({ notifyError: vi.fn() }));

vi.mock("@/lib/application-notifications", () => ({
  notifyError: notificationMock.notifyError,
}));

import { resetMapPresentationAssetCache, useMapPresentation } from "./use-map-presentation";

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

function collection() {
  return { type: "FeatureCollection", features: [] };
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("useMapPresentation asset recovery", () => {
  let failDisplayAsset = true;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    failDisplayAsset = true;
    notificationMock.notifyError.mockReset();
    resetMapPresentationAssetCache();
    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void init;
      const url = new URL(String(input), window.location.href);
      if (url.pathname.endsWith("boundaries-index.v1.json")) {
        return response({ version: 1, boundsById: { [place.id]: [[-125, 48], [-123, 50]] } });
      }
      if (url.pathname.endsWith("boundaries-display.v1.geojson") && failDisplayAsset) {
        return response({ error: "offline" }, 503);
      }
      if (url.pathname.endsWith("boundaries-display.v1.geojson")) return response(collection());
      if (url.pathname.endsWith("exploration-territories.v1.geojson")) return response(collection());
      if (url.pathname.endsWith("bc-focus-mask.v1.geojson")) return response(collection());
      throw new Error(`Unexpected map asset request: ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    resetMapPresentationAssetCache();
    vi.unstubAllGlobals();
  });

  it("keeps application-supplied pins on an asset failure and retries after connectivity returns", async () => {
    const { result } = renderHook(() => useMapPresentation({
      places: [place],
      visited: new Set<string>(),
      mode: "discover",
      selectedId: null,
      viewport: null,
    }));

    await waitFor(() => expect(result.current.assets.status).toBe("failed"));
    expect(result.current.placeData.features.map((feature) => feature.properties.id)).toEqual([place.id]);
    expect(result.current.boundaryData.features).toEqual([]);
    expect(notificationMock.notifyError).toHaveBeenCalledWith(
      expect.any(Error),
      "Map detail could not load. Reconnect to load park boundaries.",
    );

    failDisplayAsset = false;
    await act(async () => { window.dispatchEvent(new Event("online")); });
    await waitFor(() => expect(result.current.assets.status).toBe("ready"));
    expect(fetchMock.mock.calls.some(([input, init]) => {
      const url = new URL(String(input), window.location.href);
      return url.pathname.endsWith("boundaries-display.v1.geojson") && init?.cache === "no-store";
    })).toBe(true);
  });
});

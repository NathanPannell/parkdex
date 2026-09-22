import { afterEach, describe, expect, it, vi } from "vitest";
import type { Map as MapLibreMap } from "maplibre-gl";

import { cameraPaddingWithContentMargin } from "@/lib/map-fit";
import {
  cameraViewDiffers,
  loadPostcardPhotoUrl,
  postcardMarkerCoordinates,
  postcardPhotoKey,
  POSTCARD_MARKER_FOOTPRINT,
  POSTCARD_MARKER_MIN_ZOOM,
  projectPostcardMarker,
  type MapCameraSnapshot,
} from "./park-map";

const overview: MapCameraSnapshot = {
  longitude: -125.25,
  latitude: 49.65,
  zoom: 5.55,
  bearing: 0,
  pitch: 0,
};

const place = {
  id: "park-1",
  name: "Forest Park",
  category: "provincial" as const,
  latitude: 49,
  longitude: -124,
  region: "South",
  description: "Forest",
  sourceUrl: "https://example.test",
  sourceName: "BC Parks",
};

const visit = {
  placeId: place.id,
  visitedAt: "2026-09-08T12:00:00Z",
  claim: {
    claimedAt: "2026-09-08T12:00:00Z",
    capturedAt: "2026-09-08T12:00:00Z",
    coordinates: { latitude: place.latitude, longitude: place.longitude },
    accuracyMeters: 8,
    boundaryVersion: "v1",
    matchKind: "exact" as const,
    distanceMeters: 0,
    hasPhoto: true,
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("map reset visibility state", () => {
  it("treats meaningful pan, zoom, rotation, and pitch changes as moved away", () => {
    expect(cameraViewDiffers({ ...overview, longitude: -125.2 }, overview)).toBe(true);
    expect(cameraViewDiffers({ ...overview, zoom: 6 }, overview)).toBe(true);
    expect(cameraViewDiffers({ ...overview, bearing: 2 }, overview)).toBe(true);
    expect(cameraViewDiffers({ ...overview, pitch: 2 }, overview)).toBe(true);
  });

  it("ignores sub-pixel camera settling around the overview", () => {
    expect(cameraViewDiffers({
      ...overview,
      longitude: overview.longitude + 0.001,
      latitude: overview.latitude - 0.001,
      zoom: overview.zoom + 0.01,
    }, overview)).toBe(false);
  });

  it("adds ten percent breathing room on every side of the visible map area", () => {
    expect(cameraPaddingWithContentMargin(
      { width: 400, height: 600 },
      { top: 100, right: 20, bottom: 200, left: 20 },
      0.1,
    )).toEqual({ top: 130, right: 56, bottom: 230, left: 56 });
  });
});

describe("recent postcard marker projection", () => {
  it("uses verified visit coordinates and falls back to the catalogue center", () => {
    const visitedAtEdge = {
      ...visit,
      claim: {
        ...visit.claim,
        coordinates: { latitude: 49.21, longitude: -123.61 },
      },
    };
    expect(postcardMarkerCoordinates({ place, visit: visitedAtEdge })).toEqual({ latitude: 49.21, longitude: -123.61 });
    expect(postcardMarkerCoordinates({ place, visit: { ...visit, claim: null } })).toEqual({ latitude: place.latitude, longitude: place.longitude });
  });

  it("stays hidden at cluster zoom and never touches the camera", () => {
    const state = { zoom: POSTCARD_MARKER_MIN_ZOOM - 1, cameraCalls: 0 };
    const map = {
      getZoom: () => state.zoom,
      getContainer: () => ({ clientWidth: 400, clientHeight: 600 }),
      project: () => ({ x: 200, y: 300 }),
      fitBounds: () => { state.cameraCalls += 1; },
      easeTo: () => { state.cameraCalls += 1; },
    } as unknown as MapLibreMap;

    expect(projectPostcardMarker(map, place)).toBeNull();
    state.zoom = POSTCARD_MARKER_MIN_ZOOM;
    expect(projectPostcardMarker(map, place)).toEqual({ left: 200, top: 300 });
    expect(state.cameraCalls).toBe(0);
  });

  it("hides the print once its projected park leaves the map viewport", () => {
    const state = { x: -29, y: 300 };
    const map = {
      getZoom: () => POSTCARD_MARKER_MIN_ZOOM,
      getContainer: () => ({ clientWidth: 400, clientHeight: 600 }),
      project: () => ({ x: state.x, y: state.y }),
    } as unknown as MapLibreMap;

    expect(projectPostcardMarker(map, place)).toBeNull();
    state.x = 180;
    expect(projectPostcardMarker(map, place)).toEqual({ left: 180, top: 300 });
  });

  it("hides edge anchors when the compact print footprint would be clipped", () => {
    const state = { x: 200, y: POSTCARD_MARKER_FOOTPRINT.height + POSTCARD_MARKER_FOOTPRINT.anchorGap - 1 };
    const map = {
      getZoom: () => POSTCARD_MARKER_MIN_ZOOM,
      getContainer: () => ({ clientWidth: 400, clientHeight: 600 }),
      project: () => ({ x: state.x, y: state.y }),
    } as unknown as MapLibreMap;

    expect(projectPostcardMarker(map, place)).toBeNull();
    state.y += 1;
    expect(projectPostcardMarker(map, place)).toEqual({ left: 200, top: 248 });
    state.x = POSTCARD_MARKER_FOOTPRINT.halfWidth - 1;
    expect(projectPostcardMarker(map, place)).toBeNull();
  });
});

describe("recent postcard photo lifecycle", () => {
  it("scopes private photo URLs to the owner and revokes them on cleanup", async () => {
    const create = vi.fn(() => "blob:postcard");
    const revoke = vi.fn();
    vi.stubGlobal("URL", { createObjectURL: create, revokeObjectURL: revoke });
    const postcard = { place, visit };
    const firstKey = postcardPhotoKey("account:first", postcard);
    const secondKey = postcardPhotoKey("account:second", postcard);
    expect(firstKey).not.toBe(secondKey);

    const onLoaded = vi.fn();
    const onFailed = vi.fn();
    const cleanup = loadPostcardPhotoUrl(
      vi.fn().mockResolvedValue(new Blob(["photo"], { type: "image/jpeg" })),
      place.id,
      firstKey,
      onLoaded,
      onFailed,
    );
    await Promise.resolve();
    expect(onLoaded).toHaveBeenCalledWith("blob:postcard", firstKey);
    expect(onFailed).not.toHaveBeenCalled();

    cleanup();
    expect(revoke).toHaveBeenCalledWith("blob:postcard");
  });
});

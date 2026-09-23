import { afterEach, describe, expect, it, vi } from "vitest";
import type { Map as MapLibreMap } from "maplibre-gl";

import { cameraPaddingWithContentMargin } from "@/lib/map-fit";
import {
  cameraViewDiffers,
  collectionData,
  loadPostcardPhotoUrl,
  measuredCameraPadding,
  postcardMarkerCoordinates,
  postcardPhotoKey,
  POSTCARD_MARKER_FOOTPRINT,
  POSTCARD_MARKER_MIN_ZOOM,
  projectPostcardMarker,
  visiblePlaces,
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

describe("map place visibility and progress mode", () => {
  const unvisited = {
    ...place,
    id: "park-2",
    name: "Unvisited Park",
    longitude: -124.5,
  };
  const places = [place, unvisited];
  const visited = new Set([place.id]);

  it.each(["explored", "discover"] as const)("keeps unvisited markers in %s mode", (mode) => {
    expect(visiblePlaces(places, visited, mode)).toEqual(places);
    expect(collectionData(places, visited, mode, new Set()).features.map((feature) => feature.properties?.id)).toEqual([
      place.id,
      unvisited.id,
    ]);
  });

  it("honors the externally supplied place subset in either mode", () => {
    const suppliedFilter = [unvisited];

    expect(collectionData(suppliedFilter, visited, "explored", new Set()).features.map((feature) => feature.properties?.id)).toEqual([unvisited.id]);
    expect(collectionData(suppliedFilter, visited, "discover", new Set()).features.map((feature) => feature.properties?.id)).toEqual([unvisited.id]);
  });
});

describe("field guide map camera overlays", () => {
  type Rect = { top: number; left: number; width: number; height: number };

  function overlayElement(rect: Rect) {
    return {
      getBoundingClientRect: () => ({ top: rect.top, left: rect.left, right: rect.left + rect.width, bottom: rect.top + rect.height, width: rect.width, height: rect.height }),
      offsetParent: { getBoundingClientRect: () => ({ top: 0, left: 0 }) },
      offsetTop: rect.top,
      offsetLeft: rect.left,
      offsetWidth: rect.width,
      offsetHeight: rect.height,
    } as unknown as HTMLElement;
  }

  function mapElement(width: number, height: number) {
    return {
      getBoundingClientRect: () => ({ top: 0, left: 0, right: width, bottom: height, width, height }),
    } as unknown as HTMLElement;
  }

  it("reserves the new view switch, map utility, and bottom navigation when fitting the map", () => {
    const overlays = new Map([
      [".guide-view-switch", overlayElement({ top: 12, left: 12, width: 366, height: 54 })],
      [".map-utility", overlayElement({ top: 76, left: 12, width: 366, height: 50 })],
      [".map-visit-filter", overlayElement({ top: 134, left: 12, width: 366, height: 46 })],
      [".global-progress", overlayElement({ top: 698, left: 250, width: 128, height: 44 })],
      [".thumb-nav", overlayElement({ top: 770, left: 12, width: 366, height: 64 })],
    ]);
    vi.stubGlobal("document", { querySelector: (selector: string) => overlays.get(selector) ?? null });

    expect(measuredCameraPadding(mapElement(390, 844), false)).toEqual({
      top: 192,
      right: 24,
      bottom: 92,
      left: 24,
    });
  });

  it("reserves the desktop field guide collection beside the map", () => {
    const overlays = new Map([
      [".guide-view-switch", overlayElement({ top: 20, left: 24, width: 370, height: 54 })],
      [".map-utility", overlayElement({ top: 84, left: 24, width: 370, height: 50 })],
      [".feature-collection", overlayElement({ top: 84, left: 24, width: 410, height: 728 })],
      [".thumb-nav", overlayElement({ top: 826, left: 24, width: 500, height: 64 })],
    ]);
    vi.stubGlobal("document", { querySelector: (selector: string) => overlays.get(selector) ?? null });

    expect(measuredCameraPadding(mapElement(1200, 900), false)).toMatchObject({ left: 452, bottom: 32 });
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

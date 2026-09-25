"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import type { GeoJSONSource, Map as MapLibreMap, MapLayerMouseEvent, PaddingOptions, StyleSpecification } from "maplibre-gl";

import { PostcardPrint } from "@/components/postcard-print";
import { postcardMarkerCoordinates } from "@/lib/use-map-presentation";
import {
  boundsForPlace,
  pickBoundaryPlace,
  type BoundaryCollection,
  type BoundaryIndex,
  type BoundaryLoadState,
} from "@/lib/boundaries";
import { BOUNDARY_DISPLAY_SOURCE_ID, BOUNDARY_SOURCE_ID, boundaryLayerSpecifications } from "@/lib/boundary-style";
import {
  CURRENT_LOCATION_SOURCE_ID,
  currentLocationLayerSpecifications,
  EXPLORATION_TERRITORY_SOURCE_ID,
  explorationLayerSpecifications,
} from "@/lib/exploration-map-style";
import { VANCOUVER_ISLAND_OVERVIEW_BOUNDS, cameraOffsetForPadding, cameraPaddingForOverlays, cameraPaddingWithContentMargin, hasUsableCameraViewport, type CameraPadding, type LayoutRect } from "@/lib/map-fit";
import { placeMarkerLayerSpecifications, placeNameLayerSpecifications } from "@/lib/place-marker-style";
import { normalizeMapViewport, type MapViewport, type ParkMapMode, type RecentPostcard } from "@/lib/map-presentation";
import type { UseMapPresentationResult } from "@/lib/use-map-presentation";
import type { Place } from "@/lib/places";
import { distanceKm } from "@/lib/discovery";

const BOUNDARY_SOURCE = BOUNDARY_SOURCE_ID;
const BOUNDARY_SELECTED_LAYERS = ["boundary-selected-fill", "boundary-selected-halo", "boundary-selected-line"] as const;
const BOUNDARY_VISIBLE_LAYERS = [
  "boundary-island-buffer",
  "boundary-island-fill",
  "boundary-island-line",
  "boundary-park-buffer",
  "boundary-park-fill",
  "boundary-park-line",
] as const;

export const POSTCARD_MARKER_MIN_ZOOM = 11;
/**
 * Approximate the compact print's rendered footprint, including its seal and
 * dismiss control. The map anchor stays at the visit coordinate; these
 * bounds only decide whether the complete marker can be reached on screen.
 */
export const POSTCARD_MARKER_FOOTPRINT = {
  halfWidth: 76,
  height: 220,
  anchorGap: 28,
} as const;

const EMPTY_CAMERA_PLACES: readonly Place[] = [];

export { postcardMarkerCoordinates, postcardPhotoKey, loadPostcardPhotoUrl } from "@/lib/use-map-presentation";
export type { RecentPostcard } from "@/lib/map-presentation";

export type ParkMapProps = {
  places: Place[];
  /** Camera targets can extend beyond the sampled marker and boundary set. */
  cameraPlace?: Place | null;
  groupCameraPlaces?: readonly Place[];
  visited: Set<string>;
  mode?: ParkMapMode;
  presentation: UseMapPresentationResult;
  currentLocation?: MapLocation | null;
  selectedId: string | null;
  selectedIds?: ReadonlySet<string>;
  resetViewRequest?: number;
  showZoomControls?: boolean;
  onSelect: (id: string) => void;
  onBoundaryLoadState?: (state: BoundaryLoadState) => void;
  onViewportChange?: (viewport: MapViewport) => void;
  recentPostcard?: RecentPostcard;
  onOpenPostcard?: () => void;
  onDismissPostcard?: () => void;
};

export type { ParkMapMode } from "@/lib/map-presentation";
export type MapLocation = {
  latitude: number;
  longitude: number;
  accuracyMeters?: number | null;
  heading?: number | null;
};

export type MapCameraSnapshot = {
  longitude: number;
  latitude: number;
  zoom: number;
  bearing: number;
  pitch: number;
};

export function cameraViewDiffers(current: MapCameraSnapshot, overview: MapCameraSnapshot) {
  return Math.abs(current.longitude - overview.longitude) > 0.005
    || Math.abs(current.latitude - overview.latitude) > 0.005
    || Math.abs(current.zoom - overview.zoom) > 0.05
    || Math.abs(current.bearing - overview.bearing) > 0.1
    || Math.abs(current.pitch - overview.pitch) > 0.1;
}

const FIELD_GUIDE_STYLE: StyleSpecification = {
  version: 8,
  glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
  sources: {
    shadedRelief: { type: "raster", tiles: ["https://tiles.openfreemap.org/natural_earth/ne2sr/{z}/{x}/{y}.png"], tileSize: 256, maxzoom: 6 },
    openmaptiles: { type: "vector", url: "https://tiles.openfreemap.org/planet" },
    focusMask: { type: "geojson", data: { type: "FeatureCollection", features: [] }, tolerance: 0 },
  },
  layers: [
    { id: "paper", type: "background", paint: { "background-color": "#f6f0dc" } },
    { id: "relief", type: "raster", source: "shadedRelief", paint: { "raster-opacity": 0.38, "raster-saturation": -0.45, "raster-contrast": 0.12 } },
    { id: "wild-land", type: "fill", source: "openmaptiles", "source-layer": "landcover", filter: ["in", ["get", "class"], ["literal", ["wood", "grass", "scrub"]]], paint: { "fill-color": "#c9dfa1", "fill-opacity": 0.78 } },
    { id: "parks", type: "fill", source: "openmaptiles", "source-layer": "landuse", filter: ["in", ["get", "class"], ["literal", ["park", "national_park", "nature_reserve"]]], paint: { "fill-color": "#a7cf7d", "fill-opacity": 0.82 } },
    { id: "water", type: "fill", source: "openmaptiles", "source-layer": "water", paint: { "fill-color": "#78cad0", "fill-outline-color": "#2b7a78" } },
    { id: "waterways", type: "line", source: "openmaptiles", "source-layer": "waterway", paint: { "line-color": "#2b7a78", "line-width": ["interpolate", ["linear"], ["zoom"], 6, 0.5, 13, 2], "line-opacity": 0.75 } },
    { id: "boundaries", type: "line", source: "openmaptiles", "source-layer": "boundary", paint: { "line-color": "#6e977c", "line-width": 1, "line-dasharray": [3, 3], "line-opacity": 0.45 } },
    { id: "roads", type: "line", source: "openmaptiles", "source-layer": "transportation", filter: ["in", ["get", "class"], ["literal", ["motorway", "trunk", "primary", "secondary"]]], paint: { "line-color": "#d2ae72", "line-width": ["interpolate", ["linear"], ["zoom"], 6, 0.45, 12, 2.5], "line-opacity": 0.78 } },
    { id: "water-labels", type: "symbol", source: "openmaptiles", "source-layer": "water_name", minzoom: 5, layout: { "text-field": ["coalesce", ["get", "name:latin"], ["get", "name"]], "text-font": ["Noto Sans Italic"], "text-size": 11 }, paint: { "text-color": "#226c70", "text-halo-color": "#bce4e0", "text-halo-width": 1.5 } },
    { id: "place-labels", type: "symbol", source: "openmaptiles", "source-layer": "place", layout: { "text-field": ["coalesce", ["get", "name:latin"], ["get", "name"]], "text-font": ["Noto Sans Bold"], "text-size": ["interpolate", ["linear"], ["zoom"], 5, 10, 11, 14], "text-padding": 5 }, paint: { "text-color": "#173d32", "text-halo-color": "#f6f0dc", "text-halo-width": 2 } },
    { id: "focus-mask", type: "fill", source: "focusMask", paint: { "fill-color": "#6f7773", "fill-opacity": 0.58 } },
  ],
};

function locationData(location: MapLocation | null): GeoJSON.FeatureCollection<GeoJSON.Point> {
  if (!location || !Number.isFinite(location.longitude) || !Number.isFinite(location.latitude)) {
    return { type: "FeatureCollection", features: [] };
  }
  const heading = location.heading != null && Number.isFinite(location.heading)
    ? ((location.heading % 360) + 360) % 360
    : undefined;
  return {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      properties: {
        ...(heading == null ? {} : { heading }),
        ...(location.accuracyMeters == null ? {} : { accuracyMeters: location.accuracyMeters }),
      },
      geometry: { type: "Point", coordinates: [location.longitude, location.latitude] },
    }],
  };
}

function fitOverview(map: MapLibreMap, animated: boolean) {
  const padding = measuredCameraPadding(map.getContainer(), false);
  map.fitBounds(
    VANCOUVER_ISLAND_OVERVIEW_BOUNDS,
    { padding, maxZoom: 8, duration: animated ? 520 : 0 },
  );
}

function overviewCameraSnapshot(map: MapLibreMap): MapCameraSnapshot | null {
  const camera = map.cameraForBounds(VANCOUVER_ISLAND_OVERVIEW_BOUNDS, {
    padding: measuredCameraPadding(map.getContainer(), false),
    maxZoom: 8,
  });
  if (!camera?.center || camera.zoom == null) return null;
  const center = Array.isArray(camera.center)
    ? { longitude: camera.center[0], latitude: camera.center[1] }
    : { longitude: "lng" in camera.center ? camera.center.lng : camera.center.lon, latitude: camera.center.lat };
  return {
    longitude: center.longitude,
    latitude: center.latitude,
    zoom: camera.zoom,
    bearing: camera.bearing ?? 0,
    pitch: 0,
  };
}

function fitBoundary(map: MapLibreMap, index: BoundaryIndex, placeId: string, animated: boolean, padding: PaddingOptions) {
  const bounds = boundsForPlace(index, placeId);
  if (!bounds) return false;
  map.fitBounds(bounds, {
    padding,
    maxZoom: map.getMaxZoom(),
    duration: animated ? 560 : 0,
  });
  return true;
}

function layoutRect(element: HTMLElement): LayoutRect {
  const rect = element.getBoundingClientRect();
  if (!element.offsetParent) return rect;
  const parent = element.offsetParent.getBoundingClientRect();
  return {
    top: parent.top + element.offsetTop,
    right: parent.left + element.offsetLeft + element.offsetWidth,
    bottom: parent.top + element.offsetTop + element.offsetHeight,
    left: parent.left + element.offsetLeft,
    width: element.offsetWidth,
    height: element.offsetHeight,
  };
}

function measuredSelectionPadding(container: HTMLElement) {
  const mapRect = container.getBoundingClientRect();
  return cameraPaddingWithContentMargin(mapRect, measuredCameraPadding(container, true), 0.1);
}

function cameraSnapshot(map: MapLibreMap): MapCameraSnapshot {
  const center = map.getCenter();
  return {
    longitude: center.lng,
    latitude: center.lat,
    zoom: map.getZoom(),
    bearing: map.getBearing(),
    pitch: map.getPitch(),
  };
}

export function mapViewportSnapshot(map: MapLibreMap): MapViewport {
  const bounds = map.getBounds();
  return normalizeMapViewport({
    west: bounds.getWest(),
    south: bounds.getSouth(),
    east: bounds.getEast(),
    north: bounds.getNorth(),
    zoom: map.getZoom(),
  });
}

export function measuredCameraPadding(container: HTMLElement, includeSheet: boolean, base?: CameraPadding) {
  const selectors = [
    ".guide-view-switch",
    ".map-utility",
    ".map-visit-filter",
    ".search-dock",
    ".filter-tray",
    ".search-results",
    ".nearby-strip",
    ".global-progress",
    ".thumb-nav",
    ".feature-collection",
    ...(includeSheet ? [".place-sheet"] : []),
  ];
  const overlays = selectors.flatMap((selector) => {
    const element = document.querySelector<HTMLElement>(selector);
    return element && element.offsetParent ? [layoutRect(element)] : [];
  });
  return cameraPaddingForOverlays(
    container.getBoundingClientRect(),
    overlays,
    base,
  );
}

type PostcardMarkerPosition = {
  left: number;
  top: number;
};

export function projectPostcardMarker(map: MapLibreMap, place: Pick<Place, "longitude" | "latitude">): PostcardMarkerPosition | null {
  if (!Number.isFinite(place.longitude) || !Number.isFinite(place.latitude) || map.getZoom() < POSTCARD_MARKER_MIN_ZOOM) {
    return null;
  }

  const container = map.getContainer();
  const width = container.clientWidth;
  const height = container.clientHeight;
  if (width <= 0 || height <= 0) return null;

  try {
    const point = map.project([place.longitude, place.latitude]);
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;

    const { halfWidth, height: markerHeight, anchorGap } = POSTCARD_MARKER_FOOTPRINT;
    // The print is translated up from its coordinate by its full height and
    // the stem gap. Hide it when that footprint would be clipped at an edge,
    // which prevents an offscreen card from remaining keyboard-focusable.
    if (point.x < halfWidth || point.x > width - halfWidth || point.y < markerHeight + anchorGap || point.y > height + anchorGap) return null;
    return { left: point.x, top: point.y };
  } catch {
    // MapLibre can be between remove() and the next React cleanup during a
    // fast account transition. The marker simply waits for the next frame.
    return null;
  }
}

function addBoundaryLayers(map: MapLibreMap, boundaryData: BoundaryCollection) {
  map.addSource(BOUNDARY_SOURCE, {
    type: "geojson",
    data: boundaryData,
    promoteId: "id",
    attribution: "Boundary geometry: sourced map datasets",
  });
  map.addSource(BOUNDARY_DISPLAY_SOURCE_ID, {
    type: "geojson",
    data: boundaryData,
    promoteId: "id",
  });
  const beforeId = "place-hit-targets";
  boundaryLayerSpecifications(BOUNDARY_DISPLAY_SOURCE_ID).forEach((layer) => map.addLayer(layer, beforeId));
}

type BoundaryMapFilters = Pick<UseMapPresentationResult, "boundaryFilter" | "islandBoundaryFilter" | "parkBoundaryFilter" | "selectedBoundaryFilter">;

function updateBoundaryFilters(map: MapLibreMap, presentation: BoundaryMapFilters) {
  if (!map.getSource(BOUNDARY_SOURCE)) return;
  BOUNDARY_VISIBLE_LAYERS.forEach((layer) => {
    map.setFilter(layer, layer.includes("island") ? presentation.islandBoundaryFilter : presentation.parkBoundaryFilter);
  });
  map.setFilter("boundary-hit", presentation.boundaryFilter);
  BOUNDARY_SELECTED_LAYERS.forEach((layer) => map.setFilter(layer, presentation.selectedBoundaryFilter));
}

export function ParkMap({
  places,
  cameraPlace = null,
  groupCameraPlaces = EMPTY_CAMERA_PLACES,
  visited,
  mode = "explored",
  presentation,
  currentLocation = null,
  selectedId,
  selectedIds = new Set<string>(),
  resetViewRequest = 0,
  onSelect,
  onBoundaryLoadState,
  onViewportChange,
  recentPostcard,
  onOpenPostcard,
  onDismissPostcard,
}: ParkMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const dataRef = useRef({ places, visited, mode, currentLocation, selectedIds, presentation });
  const selectedRef = useRef(selectedId);
  const selectRef = useRef(onSelect);
  const boundaryStateRef = useRef(onBoundaryLoadState);
  const viewportChangeRef = useRef(onViewportChange);
  const boundaryVisitedRef = useRef<Set<string>>(new Set());
  const overviewCameraRef = useRef<MapCameraSnapshot | null>(null);
  const resetOverviewRef = useRef<(() => void) | null>(null);
  const handledResetRequestRef = useRef(resetViewRequest);
  const viewDiffersRef = useRef(false);
  const displayedLocationRef = useRef<MapLocation | null>(currentLocation);
  const locationAnimationRef = useRef(0);
  const [mapFailed, setMapFailed] = useState(false);
  const [explorationFailed, setExplorationFailed] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const [postcardMarkerPosition, setPostcardMarkerPosition] = useState<PostcardMarkerPosition | null>(null);

  const markerCoordinates = postcardMarkerCoordinates(recentPostcard);
  const postcardMarkerLatitude = markerCoordinates?.latitude;
  const postcardMarkerLongitude = markerCoordinates?.longitude;
  const boundaryStatus = presentation.boundaryLoadState.status;
  const boundaryPlaceIdsKey = [...presentation.boundaryLoadState.placeIds].sort().join("\u0000");
  const boundaryLoadState = useMemo(() => ({
    status: boundaryStatus,
    placeIds: new Set(boundaryPlaceIdsKey ? boundaryPlaceIdsKey.split("\u0000") : []),
  }), [boundaryStatus, boundaryPlaceIdsKey]);
  const {
    placeData,
    boundaryData,
    boundaryIds,
    explorationData,
    focusMaskData,
    placeNameData,
    explorationFilter,
    explorationEdgeFilter,
    boundaryFilter,
    islandBoundaryFilter,
    parkBoundaryFilter,
    selectedBoundaryFilter: selectedBoundaryFilterValue,
    boundaryIndex,
  } = presentation;

  useEffect(() => { dataRef.current = { places, visited, mode, currentLocation, selectedIds, presentation }; }, [places, visited, mode, currentLocation, selectedIds, presentation]);
  useEffect(() => { selectedRef.current = selectedId; }, [selectedId]);
  useEffect(() => { selectRef.current = onSelect; }, [onSelect]);
  useEffect(() => { boundaryStateRef.current = onBoundaryLoadState; }, [onBoundaryLoadState]);
  useEffect(() => { viewportChangeRef.current = onViewportChange; }, [onViewportChange]);
  useEffect(() => {
    boundaryStateRef.current?.(boundaryLoadState);
  }, [boundaryLoadState, onBoundaryLoadState]);
  useEffect(() => {
    if (handledResetRequestRef.current === resetViewRequest) return;
    handledResetRequestRef.current = resetViewRequest;
    resetOverviewRef.current?.();
  }, [resetViewRequest]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    let disposed = false;
    let loadDeadline: number | undefined;
    let resizeFrame = 0;
    let mapResizeObserver: ResizeObserver | undefined;
    void import("maplibre-gl").then((maplibregl) => {
      if (disposed || !containerRef.current) return;
      maplibregl.setWorkerUrl("/maplibre/maplibre-gl-worker.mjs");
      const map = new maplibregl.Map({
        container: containerRef.current,
        style: FIELD_GUIDE_STYLE,
        center: [-125.8, 49.8],
        zoom: 6,
        minZoom: 3.4,
        maxZoom: 15,
        fadeDuration: 0,
        attributionControl: false,
        transformRequest: (url: string) => ({ url, cache: "no-store" }),
      });
      mapRef.current = map;
      setMapReady(true);
      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const setViewDiffers = (differs: boolean) => { viewDiffersRef.current = differs; };
      const reportViewport = () => viewportChangeRef.current?.(mapViewportSnapshot(map));
      const moveToOverview = (animated: boolean) => {
        overviewCameraRef.current = overviewCameraSnapshot(map);
        setViewDiffers(false);
        fitOverview(map, animated);
      };
      resetOverviewRef.current = () => moveToOverview(!reduceMotion);
      map.on("moveend", () => {
        const overview = overviewCameraRef.current;
        if (overview) setViewDiffers(cameraViewDiffers(cameraSnapshot(map), overview));
        reportViewport();
      });
      map.on("resize", reportViewport);
      loadDeadline = window.setTimeout(() => {
        if (!map.isStyleLoaded()) setMapFailed(true);
      }, 12_000);
      let collectionReady = false;
      let boundarySetup = false;

      const setupBoundaries = () => {
        if (boundarySetup || !map.getLayer("place-points")) return;
        boundarySetup = true;
        const current = dataRef.current;
        addBoundaryLayers(map, current.presentation.boundaryData);
        updateBoundaryFilters(map, current.presentation);
        current.visited.forEach((id) => {
          if (current.presentation.boundaryIds.has(id)) map.setFeatureState({ source: BOUNDARY_DISPLAY_SOURCE_ID, id }, { visited: true });
        });
        boundaryVisitedRef.current = new Set([...current.visited].filter((id) => current.presentation.boundaryIds.has(id)));
        map.on("click", "boundary-hit", (event: MapLayerMouseEvent) => {
          if (map.queryRenderedFeatures(event.point, { layers: ["place-hit-targets", "place-name-labels"] }).length) return;
          const features = map.queryRenderedFeatures(event.point, { layers: ["boundary-hit"] });
          const currentData = dataRef.current;
          const id = pickBoundaryPlace(features, currentData.places, event.lngLat);
          if (id) selectRef.current(id);
        });
        map.on("mouseenter", "boundary-hit", () => { map.getCanvas().style.cursor = "pointer"; });
        map.on("mouseleave", "boundary-hit", () => { map.getCanvas().style.cursor = ""; });
        const selected = selectedRef.current;
        if (selected && current.places.some((place) => place.id === selected) && containerRef.current) {
          const index = current.presentation.boundaryIndex;
          if (index) fitBoundary(map, index, selected, !reduceMotion, measuredSelectionPadding(containerRef.current));
        }
      };

      map.on("error", (event) => {
        const sourceId = (event as typeof event & { sourceId?: string }).sourceId;
        if (sourceId === EXPLORATION_TERRITORY_SOURCE_ID) setExplorationFailed(true);
        if (sourceId === BOUNDARY_SOURCE || sourceId === BOUNDARY_DISPLAY_SOURCE_ID) {
          boundaryStateRef.current?.({ status: "failed", placeIds: new Set() });
        }
      });

      const setupCollection = () => {
        if (collectionReady) return;
        try {
          collectionReady = true;
          window.clearTimeout(loadDeadline);
          setMapFailed(false);
          const current = dataRef.current;
          map.addSource(EXPLORATION_TERRITORY_SOURCE_ID, { type: "geojson", data: current.presentation.explorationData });
          explorationLayerSpecifications().forEach((layer) => map.addLayer(layer));
          map.addSource("places", { type: "geojson", promoteId: "id", data: current.presentation.placeData });
          placeMarkerLayerSpecifications().forEach((layer) => map.addLayer(layer));
          map.addSource("place-names", { type: "geojson", data: current.presentation.placeNameData });
          placeNameLayerSpecifications().forEach((layer) => map.addLayer(layer));
          map.addSource(CURRENT_LOCATION_SOURCE_ID, { type: "geojson", data: locationData(current.currentLocation) });
          currentLocationLayerSpecifications().forEach((layer) => map.addLayer(layer));
          (map.getSource("focusMask") as GeoJSONSource).setData(current.presentation.focusMaskData);
          map.setFilter("exploration-fill", current.presentation.explorationFilter);
          map.setFilter("exploration-edge-glow", current.presentation.explorationEdgeFilter);
          map.setFilter("exploration-edge", current.presentation.explorationEdgeFilter);

          map.on("click", "place-hit-targets", (event: MapLayerMouseEvent) => {
            const id = event.features?.[0]?.properties?.id;
            if (typeof id === "string") selectRef.current(id);
          });
          map.on("click", "place-name-labels", (event: MapLayerMouseEvent) => {
            const id = event.features?.[0]?.properties?.id;
            if (typeof id === "string") selectRef.current(id);
          });
          ["place-hit-targets", "place-name-labels"].forEach((layer) => {
            map.on("mouseenter", layer, () => { map.getCanvas().style.cursor = "pointer"; });
            map.on("mouseleave", layer, () => { map.getCanvas().style.cursor = ""; });
          });

          const labelledPlaceIds = new Set<string>();
          const syncLabelVisibility = () => {
            if (!map.getLayer("place-name-labels") || !map.getSource("places")) return;
            const sampledIds = new Set(dataRef.current.presentation.placeData.features.map((feature) => feature.properties.id));
            const renderedNameIds = new Set(map.queryRenderedFeatures({ layers: ["place-name-labels"] })
              .map((feature) => feature.properties.id)
              .filter((id): id is string => typeof id === "string" && sampledIds.has(id)));

            labelledPlaceIds.forEach((id) => {
              if (renderedNameIds.has(id)) return;
              if (sampledIds.has(id)) map.setFeatureState({ source: "places", id }, { nameVisible: false });
              labelledPlaceIds.delete(id);
            });
            renderedNameIds.forEach((id) => {
              if (labelledPlaceIds.has(id)) return;
              map.setFeatureState({ source: "places", id }, { nameVisible: true });
              labelledPlaceIds.add(id);
            });
          };
          map.on("render", syncLabelVisibility);

          setupBoundaries();
          moveToOverview(false);
          mapResizeObserver = new ResizeObserver(() => {
            window.cancelAnimationFrame(resizeFrame);
            resizeFrame = window.requestAnimationFrame(() => {
              map.resize();
              if (!selectedRef.current && !dataRef.current.selectedIds.size && !viewDiffersRef.current && map.isStyleLoaded()) {
                moveToOverview(!reduceMotion);
              }
              reportViewport();
            });
          });
          mapResizeObserver.observe(map.getContainer());
        } catch {
          collectionReady = false;
          setMapFailed(true);
        }
      };
      map.on("style.load", setupCollection);
      window.setTimeout(setupCollection, 0);
    }).catch(() => setMapFailed(true));
    return () => {
      disposed = true;
      window.cancelAnimationFrame(resizeFrame);
      mapResizeObserver?.disconnect();
      if (loadDeadline) window.clearTimeout(loadDeadline);
      mapRef.current?.remove();
      mapRef.current = null;
      setMapReady(false);
      resetOverviewRef.current = null;
      overviewCameraRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const latitude = postcardMarkerLatitude;
    const longitude = postcardMarkerLongitude;
    if (!map || latitude == null || longitude == null) {
      setPostcardMarkerPosition(null);
      return;
    }

    const updateMarkerPosition = () => {
      setPostcardMarkerPosition(projectPostcardMarker(map, { latitude, longitude }));
    };
    updateMarkerPosition();
    map.on("move", updateMarkerPosition);
    map.on("resize", updateMarkerPosition);
    return () => {
      map.off("move", updateMarkerPosition);
      map.off("resize", updateMarkerPosition);
      setPostcardMarkerPosition(null);
    };
  }, [mapReady, postcardMarkerLatitude, postcardMarkerLongitude]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    (map.getSource("places") as GeoJSONSource | undefined)?.setData(placeData);
    (map.getSource("place-names") as GeoJSONSource | undefined)?.setData(placeNameData);
    (map.getSource(EXPLORATION_TERRITORY_SOURCE_ID) as GeoJSONSource | undefined)?.setData(explorationData);
    (map.getSource("focusMask") as GeoJSONSource | undefined)?.setData(focusMaskData);
    const canonical = map.getSource(BOUNDARY_SOURCE) as GeoJSONSource | undefined;
    const display = map.getSource(BOUNDARY_DISPLAY_SOURCE_ID) as GeoJSONSource | undefined;
    canonical?.setData(boundaryData);
    display?.setData(boundaryData);
    if (map.getLayer("exploration-fill")) map.setFilter("exploration-fill", explorationFilter);
    if (map.getLayer("exploration-edge-glow")) map.setFilter("exploration-edge-glow", explorationEdgeFilter);
    if (map.getLayer("exploration-edge")) map.setFilter("exploration-edge", explorationEdgeFilter);
    updateBoundaryFilters(map, { boundaryFilter, islandBoundaryFilter, parkBoundaryFilter, selectedBoundaryFilter: selectedBoundaryFilterValue });
    if (!display) return;
    boundaryVisitedRef.current.forEach((id) => {
      if (!visited.has(id) || !boundaryIds.has(id)) {
        map.setFeatureState({ source: BOUNDARY_DISPLAY_SOURCE_ID, id }, { visited: false });
      }
    });
    visited.forEach((id) => {
      if (boundaryIds.has(id)) map.setFeatureState({ source: BOUNDARY_DISPLAY_SOURCE_ID, id }, { visited: true });
    });
    boundaryVisitedRef.current = new Set([...visited].filter((id) => boundaryIds.has(id)));
  }, [placeData, placeNameData, explorationData, focusMaskData, boundaryData, boundaryIds, explorationFilter, explorationEdgeFilter, boundaryFilter, islandBoundaryFilter, parkBoundaryFilter, selectedBoundaryFilterValue, visited]);

  useEffect(() => {
    const source = mapRef.current?.getSource(CURRENT_LOCATION_SOURCE_ID) as GeoJSONSource | undefined;
    if (!source) return;
    window.cancelAnimationFrame(locationAnimationRef.current);
    const previous = displayedLocationRef.current;
    if (!currentLocation || !previous) {
      displayedLocationRef.current = currentLocation;
      source.setData(locationData(currentLocation));
      return;
    }
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const jumpMeters = distanceKm(previous, currentLocation) * 1000;
    const plausibleMove = jumpMeters <= Math.max(500, (previous.accuracyMeters ?? 0) + (currentLocation.accuracyMeters ?? 0) + 100);
    if (reduceMotion || !plausibleMove) {
      displayedLocationRef.current = currentLocation;
      source.setData(locationData(currentLocation));
      return;
    }
    const startedAt = performance.now();
    const durationMs = 900;
    const animate = (now: number) => {
      const linear = Math.min(1, (now - startedAt) / durationMs);
      const progress = 1 - (1 - linear) ** 3;
      const frame = {
        ...currentLocation,
        latitude: previous.latitude + (currentLocation.latitude - previous.latitude) * progress,
        longitude: previous.longitude + (currentLocation.longitude - previous.longitude) * progress,
      };
      displayedLocationRef.current = frame;
      source.setData(locationData(frame));
      if (linear < 1) locationAnimationRef.current = window.requestAnimationFrame(animate);
    };
    locationAnimationRef.current = window.requestAnimationFrame(animate);
    return () => window.cancelAnimationFrame(locationAnimationRef.current);
  }, [currentLocation]);

  useEffect(() => {
    if ((!selectedId && !selectedIds.size) || !mapRef.current) return;
    const place = selectedId && cameraPlace?.id === selectedId ? cameraPlace : undefined;
    const groupPlaces = groupCameraPlaces.filter((candidate) => selectedIds.has(candidate.id));
    if (!place && !groupPlaces.length) return;
    const map = mapRef.current;
    const container = containerRef.current;
    if (!container) return;
    let animationFrame = 0;
    const fitSelected = () => {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(() => {
        map.resize();
        const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        const padding = measuredSelectionPadding(container);
        const mapRect = container.getBoundingClientRect();
        if (!hasUsableCameraViewport(mapRect, padding)) return;
        if (place && boundaryIndex && fitBoundary(map, boundaryIndex, place.id, !reduceMotion, padding)) return;
        if (place) {
          map.easeTo({ center: [place.longitude, place.latitude], offset: cameraOffsetForPadding(padding), zoom: Math.max(map.getZoom(), 9), duration: reduceMotion ? 0 : 500 });
          return;
        }
        const longitudes = groupPlaces.map((candidate) => candidate.longitude);
        const latitudes = groupPlaces.map((candidate) => candidate.latitude);
        if (!longitudes.length || !latitudes.length) return;
        const bounds: [[number, number], [number, number]] = [[Math.min(...longitudes), Math.min(...latitudes)], [Math.max(...longitudes), Math.max(...latitudes)]];
        if (bounds[0][0] === bounds[1][0] && bounds[0][1] === bounds[1][1]) {
          map.easeTo({ center: bounds[0], offset: cameraOffsetForPadding(padding), zoom: Math.max(map.getZoom(), 9), duration: reduceMotion ? 0 : 500 });
        } else {
          map.fitBounds(bounds, { padding, maxZoom: 12, duration: reduceMotion ? 0 : 520 });
        }
      });
    };
    fitSelected();
    const resizeObserver = new ResizeObserver(fitSelected);
    resizeObserver.observe(container);
    const sheet = document.querySelector<HTMLElement>(".place-sheet");
    if (sheet) resizeObserver.observe(sheet);
    window.addEventListener("resize", fitSelected);
    return () => {
      window.cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      window.removeEventListener("resize", fitSelected);
    };
  }, [selectedId, cameraPlace, groupCameraPlaces, boundaryIndex, selectedIds]);

  const postcard = recentPostcard && postcardMarkerPosition ? (
    <div
      className="map-postcard-marker"
      style={{ left: postcardMarkerPosition.left, top: postcardMarkerPosition.top }}
      data-place-id={recentPostcard.place.id}
    >
      <span className="map-postcard-marker__stem" aria-hidden="true" />
      <div
        className="map-postcard-marker__print"
        role={onOpenPostcard ? "button" : undefined}
        tabIndex={onOpenPostcard ? 0 : -1}
        aria-label={onOpenPostcard ? `Open your ${recentPostcard.place.name} postcard` : undefined}
        onClick={onOpenPostcard}
        onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
          if (!onOpenPostcard || (event.key !== "Enter" && event.key !== " ")) return;
          event.preventDefault();
          onOpenPostcard();
        }}
      >
        <PostcardPrint
          place={recentPostcard.place}
          photoUrl={presentation.postcardPhotoState.url}
          visitedAt={recentPostcard.visit.visitedAt}
          sealed
          compact
          photoState={presentation.postcardPhotoState.state}
        />
      </div>
      {onDismissPostcard && (
        <button
          type="button"
          className="map-postcard-marker__dismiss"
          aria-label="Dismiss postcard marker"
          onClick={(event) => {
            event.stopPropagation();
            onDismissPostcard();
          }}
        >
          <X size={14} aria-hidden="true" />
        </button>
      )}
    </div>
  ) : null;

  return (
    <div className="map-wrap">
      <div className="map" ref={containerRef} aria-label="Interactive map of British Columbia parks and major islands" />
      {postcard}
      {mode === "explored" && explorationFailed && (
        <div className="exploration-status-note" role="status">
          Completion map unavailable. Visited places are still marked.
        </div>
      )}
      {mapFailed && (
        <div className="map-fallback" role="status">
          <strong>The map could not load.</strong>
          <span>Your collection list is still ready below.</span>
        </div>
      )}
    </div>
  );
}

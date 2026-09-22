"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Focus, X } from "lucide-react";
import type { FilterSpecification, GeoJSONSource, Map as MapLibreMap, MapLayerMouseEvent, PaddingOptions, StyleSpecification } from "maplibre-gl";

import { PostcardPrint, type PostcardPhotoState } from "@/components/postcard-print";
import {
  boundaryFilter,
  boundaryPlaceIds,
  boundsForPlace,
  BOUNDARY_DATA_URL,
  loadBoundaryIndex,
  pickBoundaryPlace,
  selectedBoundaryFilter,
  type BoundaryIndex,
  type BoundaryLoadState,
} from "@/lib/boundaries";
import { BOUNDARY_DISPLAY_SOURCE_ID, BOUNDARY_SOURCE_ID, boundaryLayerSpecifications } from "@/lib/boundary-style";
import {
  initialBoundarySourceReadiness,
  settleBoundarySourceReadiness,
  type BoundarySourceKey,
} from "@/lib/boundary-source-status";
import { clusterFitForLeaves, fetchClusterLeaves } from "@/lib/cluster-fit";
import {
  CURRENT_LOCATION_SOURCE_ID,
  currentLocationLayerSpecifications,
  EXPLORATION_TERRITORY_DATA_URL,
  EXPLORATION_TERRITORY_SOURCE_ID,
  explorationLayerSpecifications,
  explorationBoundaryFilter,
  explorationVisitedFilter,
} from "@/lib/exploration-map-style";
import { cameraOffsetForPadding, cameraPaddingForOverlays, cameraPaddingWithContentMargin, hasUsableCameraViewport, VANCOUVER_ISLAND_OVERVIEW_BOUNDS, type CameraPadding, type LayoutRect } from "@/lib/map-fit";
import { placeMarkerLayerSpecifications } from "@/lib/place-marker-style";
import type { Visit } from "@/lib/account";
import type { Place } from "@/lib/places";
import { distanceKm } from "@/lib/discovery";

const BOUNDARY_SOURCE = BOUNDARY_SOURCE_ID;
const BOUNDARY_DISPLAY_DATA_URL = "/data/boundaries-display.v1.geojson";
const BOUNDARY_SELECTED_LAYERS = ["boundary-selected-fill", "boundary-selected-halo", "boundary-selected-line"] as const;
const BOUNDARY_VISIBLE_LAYERS = [
  "boundary-island-buffer",
  "boundary-island-fill",
  "boundary-island-line",
  "boundary-park-buffer",
  "boundary-park-fill",
  "boundary-park-line",
] as const;

/**
 * The receipt marker belongs to the close map view. At this zoom the normal
 * place source has expanded its clusters, while the wide map remains quiet.
 */
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

export type RecentPostcard = {
  place: Place;
  visit: Visit;
};

export function postcardPhotoKey(ownerKey: string, postcard?: RecentPostcard): string {
  const hasPhoto = postcard?.visit.claim?.hasPhoto === true;
  return `${ownerKey}:${postcard?.place.id ?? "none"}:${postcard?.visit.visitedAt ?? "none"}:${hasPhoto ? "photo" : "visit"}`;
}

export function postcardMarkerCoordinates(postcard?: RecentPostcard): Pick<Place, "latitude" | "longitude"> | null {
  if (!postcard) return null;
  const claimed = postcard.visit.claim?.coordinates;
  if (claimed && Number.isFinite(claimed.latitude) && Number.isFinite(claimed.longitude)) {
    return { latitude: claimed.latitude, longitude: claimed.longitude };
  }
  if (Number.isFinite(postcard.place.latitude) && Number.isFinite(postcard.place.longitude)) {
    return { latitude: postcard.place.latitude, longitude: postcard.place.longitude };
  }
  return null;
}

export function loadPostcardPhotoUrl(
  loadPhoto: (placeId: string) => Promise<Blob>,
  placeId: string,
  key: string,
  onLoaded: (url: string, key: string) => void,
  onFailed: (key: string) => void,
): () => void {
  let active = true;
  let objectUrl: string | null = null;
  void loadPhoto(placeId).then((blob) => {
    if (!active) return;
    objectUrl = URL.createObjectURL(blob);
    onLoaded(objectUrl, key);
  }).catch(() => {
    if (active) onFailed(key);
  });
  return () => {
    active = false;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  };
}

export type ParkMapProps = {
  places: Place[];
  visited: Set<string>;
  mode?: ParkMapMode;
  currentLocation?: MapLocation | null;
  selectedId: string | null;
  selectedIds?: ReadonlySet<string>;
  resetViewRequest?: number;
  showResetControl?: boolean;
  onSelect: (id: string) => void;
  onBoundaryLoadState?: (state: BoundaryLoadState) => void;
  recentPostcard?: RecentPostcard;
  loadPhoto?: (placeId: string) => Promise<Blob>;
  photoOwnerKey?: string;
  onOpenPostcard?: () => void;
  onDismissPostcard?: () => void;
};

export type ParkMapMode = "explored" | "discover";
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
    focusMask: { type: "geojson", data: "/data/vancouver-island-focus-mask.v1.geojson", tolerance: 0 },
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

function visiblePlaces(places: Place[], visited: Set<string>, mode: ParkMapMode) {
  return mode === "discover" ? places : places.filter((place) => visited.has(place.id));
}

function collectionData(places: Place[], visited: Set<string>, mode: ParkMapMode, selectedIds: ReadonlySet<string>): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: visiblePlaces(places, visited, mode).map((place) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [place.longitude, place.latitude] },
      properties: {
        id: place.id,
        name: place.name,
        category: place.category,
        visited: visited.has(place.id) ? 1 : 0,
        groupSelected: selectedIds.has(place.id) ? 1 : 0,
      },
    })),
  };
}

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
    { padding, maxZoom: 7, duration: animated ? 520 : 0 },
  );
}

function overviewCameraSnapshot(map: MapLibreMap): MapCameraSnapshot | null {
  const camera = map.cameraForBounds(VANCOUVER_ISLAND_OVERVIEW_BOUNDS, {
    padding: measuredCameraPadding(map.getContainer(), false),
    maxZoom: 7,
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

function measuredCameraPadding(container: HTMLElement, includeSheet: boolean, base?: CameraPadding) {
  const selectors = [
    ".expedition-header",
    ".map-utility",
    ".map-utility-bar",
    ".map-mode-switch",
    ".search-dock",
    ".filter-tray",
    ".search-results",
    ".nearby-strip",
    ".thumb-nav",
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

type PostcardPhoto = {
  key: string;
  url?: string;
  state: PostcardPhotoState;
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

function addBoundaryLayers(map: MapLibreMap) {
  map.addSource(BOUNDARY_SOURCE, {
    type: "geojson",
    data: BOUNDARY_DATA_URL,
    promoteId: "id",
    attribution: "Boundary geometry: sourced map datasets",
  });
  map.addSource(BOUNDARY_DISPLAY_SOURCE_ID, {
    type: "geojson",
    data: BOUNDARY_DISPLAY_DATA_URL,
    promoteId: "id",
  });
  const beforeId = "clusters";
  boundaryLayerSpecifications(BOUNDARY_DISPLAY_SOURCE_ID).forEach((layer) => map.addLayer(layer, beforeId));
}

function updateBoundaryFilters(map: MapLibreMap, places: Place[], selectedId: string | null, selectedIds: ReadonlySet<string> = new Set()) {
  if (!map.getSource(BOUNDARY_SOURCE)) return;
  const ids = places.map((place) => place.id);
  BOUNDARY_VISIBLE_LAYERS.forEach((layer) => {
    map.setFilter(layer, boundaryFilter(ids, layer.includes("island") ? "island" : "park"));
  });
  map.setFilter("boundary-hit", boundaryFilter(ids));
  const selected: FilterSpecification = selectedIds.size
    ? ["in", ["get", "id"], ["literal", [...selectedIds]]]
    : selectedBoundaryFilter(selectedId, ids);
  BOUNDARY_SELECTED_LAYERS.forEach((layer) => map.setFilter(layer, selected));
}

export function ParkMap({
  places,
  visited,
  mode = "explored",
  currentLocation = null,
  selectedId,
  selectedIds = new Set<string>(),
  resetViewRequest = 0,
  showResetControl = true,
  onSelect,
  onBoundaryLoadState,
  recentPostcard,
  loadPhoto,
  photoOwnerKey = "current",
  onOpenPostcard,
  onDismissPostcard,
}: ParkMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const loadPhotoRef = useRef(loadPhoto);
  const dataRef = useRef({ places, visited, mode, currentLocation, selectedIds });
  const selectedRef = useRef(selectedId);
  const selectRef = useRef(onSelect);
  const boundaryStateRef = useRef(onBoundaryLoadState);
  const boundaryDataRef = useRef<BoundaryIndex | null>(null);
  const boundaryVisitedRef = useRef<Set<string>>(new Set());
  const clusterFitRequestRef = useRef(0);
  const overviewCameraRef = useRef<MapCameraSnapshot | null>(null);
  const resetOverviewRef = useRef<(() => void) | null>(null);
  const handledResetRequestRef = useRef(resetViewRequest);
  const viewDiffersRef = useRef(false);
  const displayedLocationRef = useRef<MapLocation | null>(currentLocation);
  const locationAnimationRef = useRef(0);
  const [mapFailed, setMapFailed] = useState(false);
  const [explorationFailed, setExplorationFailed] = useState(false);
  const [boundaryRevision, setBoundaryRevision] = useState(0);
  const [viewDiffersFromDefault, setViewDiffersFromDefault] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const [postcardPhoto, setPostcardPhoto] = useState<PostcardPhoto>({ key: "", state: "empty" });
  const [postcardMarkerPosition, setPostcardMarkerPosition] = useState<PostcardMarkerPosition | null>(null);

  const postcardPlaceId = recentPostcard?.place.id;
  const postcardHasPhoto = recentPostcard?.visit.claim?.hasPhoto === true;
  const markerCoordinates = postcardMarkerCoordinates(recentPostcard);
  const postcardMarkerLatitude = markerCoordinates?.latitude;
  const postcardMarkerLongitude = markerCoordinates?.longitude;
  const currentPostcardPhotoKey = postcardPhotoKey(photoOwnerKey, recentPostcard);
  const matchingPostcardPhoto = postcardPhoto.key === currentPostcardPhotoKey ? postcardPhoto : null;
  const canCreatePhotoUrl = typeof URL !== "undefined" && typeof URL.createObjectURL === "function";
  const postcardPhotoUrl = matchingPostcardPhoto?.url;
  const postcardPhotoState: PostcardPhotoState = matchingPostcardPhoto?.state
    ?? (postcardHasPhoto && loadPhoto && canCreatePhotoUrl ? "loading" : postcardHasPhoto ? "failed" : "empty");

  useEffect(() => { dataRef.current = { places, visited, mode, currentLocation, selectedIds }; }, [places, visited, mode, currentLocation, selectedIds]);
  useEffect(() => { loadPhotoRef.current = loadPhoto; }, [loadPhoto]);
  useEffect(() => { selectedRef.current = selectedId; }, [selectedId]);
  useEffect(() => { selectRef.current = onSelect; }, [onSelect]);
  useEffect(() => { boundaryStateRef.current = onBoundaryLoadState; }, [onBoundaryLoadState]);
  useEffect(() => {
    if (handledResetRequestRef.current === resetViewRequest) return;
    handledResetRequestRef.current = resetViewRequest;
    resetOverviewRef.current?.();
  }, [resetViewRequest]);

  useEffect(() => {
    if (!postcardPlaceId || !postcardHasPhoto || !loadPhotoRef.current || !canCreatePhotoUrl) {
      return;
    }

    return loadPostcardPhotoUrl(
      loadPhotoRef.current,
      postcardPlaceId,
      currentPostcardPhotoKey,
      (url, key) => setPostcardPhoto({ key, url, state: "empty" }),
      (key) => setPostcardPhoto({ key, state: "failed" }),
    );
  }, [canCreatePhotoUrl, currentPostcardPhotoKey, postcardHasPhoto, postcardPlaceId]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    let disposed = false;
    let loadDeadline: number | undefined;
    let boundaryLoadDeadline: number | undefined;
    let resizeFrame = 0;
    let mapResizeObserver: ResizeObserver | undefined;
    void import("maplibre-gl").then((maplibregl) => {
      if (disposed || !containerRef.current) return;
      maplibregl.setWorkerUrl("/maplibre/maplibre-gl-worker.mjs");
      const map = new maplibregl.Map({
        container: containerRef.current,
        style: FIELD_GUIDE_STYLE,
        center: [-125.25, 49.65],
        zoom: 5.55,
        minZoom: 4.6,
        maxZoom: 15,
        fadeDuration: 0,
        attributionControl: false,
      });
      mapRef.current = map;
      setMapReady(true);
      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const setViewDiffers = (differs: boolean) => {
        viewDiffersRef.current = differs;
        setViewDiffersFromDefault(differs);
      };
      const moveToOverview = (animated: boolean) => {
        overviewCameraRef.current = overviewCameraSnapshot(map);
        setViewDiffers(false);
        fitOverview(map, animated);
      };
      resetOverviewRef.current = () => moveToOverview(!reduceMotion);
      map.on("moveend", () => {
        const overview = overviewCameraRef.current;
        if (overview) setViewDiffers(cameraViewDiffers(cameraSnapshot(map), overview));
      });
      loadDeadline = window.setTimeout(() => {
        if (!map.isStyleLoaded()) {
          setMapFailed(true);
        }
      }, 12_000);
      let collectionReady = false;
      let boundarySetup = false;
      let boundarySourceReadiness = initialBoundarySourceReadiness();
      let reportedBoundaryStatus: BoundaryLoadState["status"] = "loading";
      const reportBoundaryStatus = (source: BoundarySourceKey, signal: "ready" | "failed") => {
        const settled = settleBoundarySourceReadiness(boundarySourceReadiness, source, signal);
        boundarySourceReadiness = settled.sources;
        const status = settled.status;
        if (status === "loading") return;
        if (reportedBoundaryStatus === status) return;
        reportedBoundaryStatus = status;
        if (boundaryLoadDeadline) window.clearTimeout(boundaryLoadDeadline);
        boundaryStateRef.current?.({ status, placeIds: status === "ready" && boundaryDataRef.current ? boundaryPlaceIds(boundaryDataRef.current) : new Set() });
      };
      map.on("sourcedata", (event) => {
        if (event.sourceId === EXPLORATION_TERRITORY_SOURCE_ID && map.isSourceLoaded(EXPLORATION_TERRITORY_SOURCE_ID)) {
          setExplorationFailed(false);
        }
        if (event.sourceId === BOUNDARY_SOURCE && map.isSourceLoaded(BOUNDARY_SOURCE)) reportBoundaryStatus("canonical", "ready");
        if (event.sourceId === BOUNDARY_DISPLAY_SOURCE_ID && map.isSourceLoaded(BOUNDARY_DISPLAY_SOURCE_ID)) reportBoundaryStatus("display", "ready");
      });
      map.on("error", (event) => {
        const sourceId = (event as typeof event & { sourceId?: string }).sourceId;
        if (sourceId === EXPLORATION_TERRITORY_SOURCE_ID || event.error?.message.includes(EXPLORATION_TERRITORY_DATA_URL)) {
          setExplorationFailed(true);
        }
        if (sourceId === BOUNDARY_SOURCE || event.error?.message.includes(BOUNDARY_DATA_URL)) reportBoundaryStatus("canonical", "failed");
        if (sourceId === BOUNDARY_DISPLAY_SOURCE_ID || event.error?.message.includes(BOUNDARY_DISPLAY_DATA_URL)) reportBoundaryStatus("display", "failed");
      });
      const setupBoundaries = (index: BoundaryIndex) => {
        if (boundarySetup || !map.getLayer("clusters")) return;
        boundarySetup = true;
        addBoundaryLayers(map);
        boundaryLoadDeadline = window.setTimeout(() => {
          if (!map.isSourceLoaded(BOUNDARY_SOURCE)) reportBoundaryStatus("canonical", "failed");
          if (!map.isSourceLoaded(BOUNDARY_DISPLAY_SOURCE_ID)) reportBoundaryStatus("display", "failed");
        }, 12_000);
        const { places: currentPlaces, visited: currentVisited, mode: currentMode, selectedIds: currentSelectedIds } = dataRef.current;
        const currentVisiblePlaces = visiblePlaces(currentPlaces, currentVisited, currentMode);
        updateBoundaryFilters(map, currentVisiblePlaces, selectedRef.current, currentSelectedIds);
        const availableIds = boundaryPlaceIds(index);
        currentVisited.forEach((id) => {
          if (availableIds.has(id)) map.setFeatureState({ source: BOUNDARY_DISPLAY_SOURCE_ID, id }, { visited: true });
        });
        boundaryVisitedRef.current = new Set([...currentVisited].filter((id) => availableIds.has(id)));
        map.on("click", "boundary-hit", (event: MapLayerMouseEvent) => {
          if (map.queryRenderedFeatures(event.point, { layers: ["cluster-hit-targets", "place-hit-targets"] }).length) return;
          const features = map.queryRenderedFeatures(event.point, { layers: ["boundary-hit"] });
          const current = dataRef.current;
          const id = pickBoundaryPlace(features, visiblePlaces(current.places, current.visited, current.mode), event.lngLat);
          if (id) selectRef.current(id);
        });
        map.on("mouseenter", "boundary-hit", () => { map.getCanvas().style.cursor = "pointer"; });
        map.on("mouseleave", "boundary-hit", () => { map.getCanvas().style.cursor = ""; });
        const selected = selectedRef.current;
        if (selected && currentPlaces.some((place) => place.id === selected) && containerRef.current) {
          fitBoundary(map, index, selected, !reduceMotion, measuredSelectionPadding(containerRef.current));
        }
      };
      const setupCollection = () => {
        if (collectionReady) return;
        try {
        collectionReady = true;
        window.clearTimeout(loadDeadline);
        setMapFailed(false);
        const {
          places: currentPlaces,
          visited: currentVisited,
          mode: currentMode,
          currentLocation: initialLocation,
          selectedIds: initialSelectedIds,
        } = dataRef.current;
        const explorationIds = currentMode === "explored" ? [...currentVisited] : [];
        map.addSource(EXPLORATION_TERRITORY_SOURCE_ID, {
          type: "geojson",
          data: EXPLORATION_TERRITORY_DATA_URL,
        });
        explorationLayerSpecifications(explorationIds).forEach((layer) => map.addLayer(layer));
        map.addSource("places", {
          type: "geojson",
          data: collectionData(currentPlaces, currentVisited, currentMode, initialSelectedIds),
          cluster: true,
          clusterMaxZoom: 10,
          clusterRadius: 52,
        });
        placeMarkerLayerSpecifications().forEach((layer) => map.addLayer(layer));
        map.addSource(CURRENT_LOCATION_SOURCE_ID, {
          type: "geojson",
          data: locationData(initialLocation),
        });
        currentLocationLayerSpecifications().forEach((layer) => map.addLayer(layer));
        map.on("click", "cluster-hit-targets", async (event: MapLayerMouseEvent) => {
          const feature = map.queryRenderedFeatures(event.point, { layers: ["cluster-hit-targets"] })[0];
          const clusterId = Number(feature?.properties?.cluster_id);
          const pointCount = Number(feature?.properties?.point_count);
          if (!Number.isFinite(clusterId) || !Number.isFinite(pointCount) || pointCount < 1) return;
          const source = map.getSource("places") as GeoJSONSource;
          const coordinates = (feature.geometry as GeoJSON.Point).coordinates as [number, number];
          const request = ++clusterFitRequestRef.current;
          const requestIsCurrent = () => request === clusterFitRequestRef.current
            && mapRef.current === map
            && map.getSource("places") === source;
          try {
            const leaves = await fetchClusterLeaves(source, clusterId, pointCount);
            if (!requestIsCurrent()) return;
            const fit = clusterFitForLeaves(leaves);
            if (!fit) return;
            const overlayPadding = measuredCameraPadding(map.getContainer(), true);
            const mapRect = map.getContainer().getBoundingClientRect();
            const padding = cameraPaddingWithContentMargin(mapRect, overlayPadding);
            if (!hasUsableCameraViewport(mapRect, padding)) return;
            if (fit.coincident) {
              map.easeTo({ center: fit.center, offset: cameraOffsetForPadding(padding), zoom: map.getMaxZoom(), duration: reduceMotion ? 0 : 480 });
              return;
            }
            map.fitBounds(fit.bounds, { padding, maxZoom: map.getMaxZoom(), duration: reduceMotion ? 0 : 560 });
          } catch {
            if (!requestIsCurrent()) return;
            try {
              const zoom = await source.getClusterExpansionZoom(clusterId);
              if (requestIsCurrent()) {
                const mapRect = map.getContainer().getBoundingClientRect();
                const padding = cameraPaddingWithContentMargin(mapRect, measuredCameraPadding(map.getContainer(), true));
                map.easeTo({ center: coordinates, offset: cameraOffsetForPadding(padding), zoom, duration: reduceMotion ? 0 : 420 });
              }
            } catch {
              // The source changed while MapLibre was resolving this cluster.
            }
          }
        });
        map.on("click", "place-hit-targets", (event: MapLayerMouseEvent) => {
          const id = event.features?.[0]?.properties?.id;
          if (typeof id === "string") selectRef.current(id);
        });
        ["cluster-hit-targets", "place-hit-targets"].forEach((layer) => {
          map.on("mouseenter", layer, () => { map.getCanvas().style.cursor = "pointer"; });
          map.on("mouseleave", layer, () => { map.getCanvas().style.cursor = ""; });
        });
        moveToOverview(false);
        mapResizeObserver = new ResizeObserver(() => {
          window.cancelAnimationFrame(resizeFrame);
          resizeFrame = window.requestAnimationFrame(() => {
            map.resize();
            if (!selectedRef.current && !dataRef.current.selectedIds.size && !viewDiffersRef.current && map.isStyleLoaded()) {
              moveToOverview(!reduceMotion);
            }
          });
        });
        mapResizeObserver.observe(map.getContainer());
        if (boundaryDataRef.current) setupBoundaries(boundaryDataRef.current);
        } catch {
          collectionReady = false;
          setMapFailed(true);
        }
      };
      map.on("style.load", setupCollection);
      window.setTimeout(setupCollection, 0);
      void loadBoundaryIndex().then((index) => {
        if (disposed) return;
        boundaryDataRef.current = index;
        setupBoundaries(index);
        setBoundaryRevision((revision) => revision + 1);
      }).catch(() => {
        if (!disposed) reportBoundaryStatus("canonical", "failed");
      });
    }).catch(() => setMapFailed(true));
    return () => {
      disposed = true;
      clusterFitRequestRef.current += 1;
      window.cancelAnimationFrame(resizeFrame);
      mapResizeObserver?.disconnect();
      if (loadDeadline) window.clearTimeout(loadDeadline);
      if (boundaryLoadDeadline) window.clearTimeout(boundaryLoadDeadline);
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
    clusterFitRequestRef.current += 1;
    const source = map.getSource("places") as GeoJSONSource | undefined;
    source?.setData(collectionData(places, visited, mode, selectedIds));
    const explorationFilter = explorationVisitedFilter(mode === "explored" ? [...visited] : []);
    const explorationEdgeFilter = explorationBoundaryFilter(mode === "explored" ? [...visited] : []);
    if (map.getLayer("exploration-fill")) map.setFilter("exploration-fill", explorationFilter);
    if (map.getLayer("exploration-edge-glow")) map.setFilter("exploration-edge-glow", explorationEdgeFilter);
    if (map.getLayer("exploration-edge")) map.setFilter("exploration-edge", explorationEdgeFilter);
    if (!map.getSource(BOUNDARY_SOURCE)) return;
        updateBoundaryFilters(map, visiblePlaces(places, visited, mode), selectedId, selectedIds);
    const availableIds = boundaryDataRef.current ? boundaryPlaceIds(boundaryDataRef.current) : new Set<string>();
    boundaryVisitedRef.current.forEach((id) => {
      if (!visited.has(id)) map.setFeatureState({ source: BOUNDARY_DISPLAY_SOURCE_ID, id }, { visited: false });
    });
    visited.forEach((id) => {
      if (availableIds.has(id)) map.setFeatureState({ source: BOUNDARY_DISPLAY_SOURCE_ID, id }, { visited: true });
    });
    boundaryVisitedRef.current = new Set([...visited].filter((id) => availableIds.has(id)));
  }, [places, visited, mode, selectedId, selectedIds]);

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
    clusterFitRequestRef.current += 1;
    if ((!selectedId && !selectedIds.size) || !mapRef.current) return;
    const place = selectedId ? places.find((candidate) => candidate.id === selectedId) : undefined;
    const groupPlaces = places.filter((candidate) => selectedIds.has(candidate.id));
    if (!place && !groupPlaces.length) return;
    const map = mapRef.current;
    const container = containerRef.current;
    if (!container) return;
    updateBoundaryFilters(map, visiblePlaces(places, visited, mode), selectedId, selectedIds);
    let animationFrame = 0;
    const fitSelected = () => {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(() => {
        map.resize();
        const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        const padding = measuredSelectionPadding(container);
        const mapRect = container.getBoundingClientRect();
        if (!hasUsableCameraViewport(mapRect, padding)) return;
        if (place && boundaryDataRef.current && fitBoundary(map, boundaryDataRef.current, place.id, !reduceMotion, padding)) return;
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
  }, [selectedId, places, visited, mode, boundaryRevision, selectedIds]);

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
          photoUrl={postcardPhotoUrl ?? undefined}
          visitedAt={recentPostcard.visit.visitedAt}
          sealed
          compact
          photoState={postcardPhotoState}
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
      <div className="map" ref={containerRef} aria-label="Interactive map of Vancouver Island parks and major islands" />
      {postcard}
      {showResetControl && !selectedId && viewDiffersFromDefault && (
        <button
          type="button"
          className="map-reset-button"
          aria-label="Reset map view"
          title="Reset map view"
          onClick={() => resetOverviewRef.current?.()}
        >
          <Focus size={20} aria-hidden="true" />
        </button>
      )}
      {mode === "explored" && visited.size > 0 && (
        <div className="exploration-map-key">
          <span className="exploration-map-key__swatch" aria-hidden="true" />
          <span>Estimated explored area from your visits; open gaps mark parks still waiting.</span>
        </div>
      )}
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

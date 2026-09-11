"use client";

import { useEffect, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import type { FilterSpecification, GeoJSONSource, Map as MapLibreMap, MapLayerMouseEvent, PaddingOptions, StyleSpecification } from "maplibre-gl";

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
import { cameraPaddingForOverlays, cameraPaddingWithContentMargin, hasUsableCameraViewport, VANCOUVER_ISLAND_OVERVIEW_BOUNDS, type CameraPadding, type LayoutRect } from "@/lib/map-fit";
import { placeMarkerLayerSpecifications } from "@/lib/place-marker-style";
import type { Place } from "@/lib/places";

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

export function fitBoundary(map: MapLibreMap, index: BoundaryIndex, placeId: string, animated: boolean, padding: PaddingOptions) {
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
  onSelect,
  onBoundaryLoadState,
}: {
  places: Place[];
  visited: Set<string>;
  mode?: ParkMapMode;
  currentLocation?: MapLocation | null;
  selectedId: string | null;
  selectedIds?: ReadonlySet<string>;
  resetViewRequest?: number;
  onSelect: (id: string) => void;
  onBoundaryLoadState?: (state: BoundaryLoadState) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
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
  const [mapFailed, setMapFailed] = useState(false);
  const [explorationFailed, setExplorationFailed] = useState(false);
  const [boundaryRevision, setBoundaryRevision] = useState(0);
  const [viewDiffersFromDefault, setViewDiffersFromDefault] = useState(false);

  useEffect(() => { dataRef.current = { places, visited, mode, currentLocation, selectedIds }; }, [places, visited, mode, currentLocation, selectedIds]);
  useEffect(() => { selectedRef.current = selectedId; }, [selectedId]);
  useEffect(() => { selectRef.current = onSelect; }, [onSelect]);
  useEffect(() => { boundaryStateRef.current = onBoundaryLoadState; }, [onBoundaryLoadState]);
  useEffect(() => {
    if (handledResetRequestRef.current === resetViewRequest) return;
    handledResetRequestRef.current = resetViewRequest;
    resetOverviewRef.current?.();
  }, [resetViewRequest]);

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
              map.easeTo({ center: fit.center, padding, zoom: map.getMaxZoom(), duration: reduceMotion ? 0 : 480 });
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
                map.easeTo({ center: coordinates, padding, zoom, duration: reduceMotion ? 0 : 420 });
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
      resetOverviewRef.current = null;
      overviewCameraRef.current = null;
    };
  }, []);

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
    source?.setData(locationData(currentLocation));
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
          map.easeTo({ center: [place.longitude, place.latitude], padding, zoom: Math.max(map.getZoom(), 9), duration: reduceMotion ? 0 : 500 });
          return;
        }
        const longitudes = groupPlaces.map((candidate) => candidate.longitude);
        const latitudes = groupPlaces.map((candidate) => candidate.latitude);
        if (!longitudes.length || !latitudes.length) return;
        const bounds: [[number, number], [number, number]] = [[Math.min(...longitudes), Math.min(...latitudes)], [Math.max(...longitudes), Math.max(...latitudes)]];
        if (bounds[0][0] === bounds[1][0] && bounds[0][1] === bounds[1][1]) {
          map.easeTo({ center: bounds[0], padding, zoom: Math.max(map.getZoom(), 9), duration: reduceMotion ? 0 : 500 });
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

  return (
    <div className="map-wrap">
      <div className="map" ref={containerRef} aria-label="Interactive map of Vancouver Island parks and major islands" />
      {!selectedId && viewDiffersFromDefault && (
        <button
          type="button"
          className="map-reset-button"
          aria-label="Reset map view"
          title="Reset map view"
          onClick={() => resetOverviewRef.current?.()}
        >
          <RotateCcw size={20} aria-hidden="true" />
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

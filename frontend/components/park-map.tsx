"use client";

import { useEffect, useRef, useState } from "react";
import type { GeoJSONSource, Map as MapLibreMap, MapLayerMouseEvent, PaddingOptions, StyleSpecification } from "maplibre-gl";

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
import { buildExplorationCoverage } from "@/lib/exploration-geometry";
import {
  CURRENT_LOCATION_SOURCE_ID,
  currentLocationLayerSpecifications,
  EXPLORATION_SOURCE_ID,
  explorationLayerSpecifications,
} from "@/lib/exploration-map-style";
import { hasUsableCameraViewport, selectedPlacePadding, type LayoutRect } from "@/lib/map-fit";
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

const FIELD_GUIDE_STYLE: StyleSpecification = {
  version: 8,
  glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
  sources: {
    shadedRelief: { type: "raster", tiles: ["https://tiles.openfreemap.org/natural_earth/ne2sr/{z}/{x}/{y}.png"], tileSize: 256, maxzoom: 6 },
    openmaptiles: { type: "vector", url: "https://tiles.openfreemap.org/planet" },
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
  ],
};

function visiblePlaces(places: Place[], visited: Set<string>, mode: ParkMapMode) {
  return mode === "discover" ? places : places.filter((place) => visited.has(place.id));
}

function collectionData(places: Place[], visited: Set<string>, mode: ParkMapMode): GeoJSON.FeatureCollection {
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
      },
    })),
  };
}

function explorationData(places: Place[], visited: Set<string>, mode: ParkMapMode) {
  if (mode === "discover") return buildExplorationCoverage([]);
  const geometryPoints = places.map((place) => ({ id: place.id, longitude: place.longitude, latitude: place.latitude }));
  return buildExplorationCoverage(
    geometryPoints.filter((place) => visited.has(place.id)),
    { gapPoints: geometryPoints.filter((place) => !visited.has(place.id)) },
  );
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

function fitOverview(map: MapLibreMap, places: Place[], animated: boolean) {
  if (!places.length) return;
  const longitudes = places.map((place) => place.longitude);
  const latitudes = places.map((place) => place.latitude);
  map.fitBounds(
    [[Math.min(...longitudes), Math.min(...latitudes)], [Math.max(...longitudes), Math.max(...latitudes)]],
    { padding: { top: 180, right: 32, bottom: 96, left: 32 }, maxZoom: 7, duration: animated ? 520 : 0 },
  );
}

function fitBoundary(map: MapLibreMap, index: BoundaryIndex, placeId: string, animated: boolean, padding: PaddingOptions) {
  const bounds = boundsForPlace(index, placeId);
  if (!bounds) return false;
  map.fitBounds(bounds, {
    padding,
    maxZoom: 12,
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
  const sheet = document.querySelector<HTMLElement>(".place-sheet");
  const overlayBottom = [".expedition-header", ".search-dock", ".filter-tray"]
    .map((selector) => document.querySelector<HTMLElement>(selector)?.getBoundingClientRect().bottom ?? mapRect.top)
    .reduce((largest, value) => Math.max(largest, value), mapRect.top);
  return selectedPlacePadding(mapRect, sheet ? layoutRect(sheet) : null, overlayBottom);
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

function updateBoundaryFilters(map: MapLibreMap, places: Place[], selectedId: string | null) {
  if (!map.getSource(BOUNDARY_SOURCE)) return;
  const ids = places.map((place) => place.id);
  BOUNDARY_VISIBLE_LAYERS.forEach((layer) => {
    map.setFilter(layer, boundaryFilter(ids, layer.includes("island") ? "island" : "park"));
  });
  map.setFilter("boundary-hit", boundaryFilter(ids));
  const selected = selectedBoundaryFilter(selectedId, ids);
  BOUNDARY_SELECTED_LAYERS.forEach((layer) => map.setFilter(layer, selected));
}

export function ParkMap({
  places,
  visited,
  mode = "explored",
  currentLocation = null,
  selectedId,
  onSelect,
  onBoundaryLoadState,
}: {
  places: Place[];
  visited: Set<string>;
  mode?: ParkMapMode;
  currentLocation?: MapLocation | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onBoundaryLoadState?: (state: BoundaryLoadState) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const dataRef = useRef({ places, visited, mode, currentLocation });
  const selectedRef = useRef(selectedId);
  const selectRef = useRef(onSelect);
  const boundaryStateRef = useRef(onBoundaryLoadState);
  const boundaryDataRef = useRef<BoundaryIndex | null>(null);
  const boundaryVisitedRef = useRef<Set<string>>(new Set());
  const [mapFailed, setMapFailed] = useState(false);
  const [boundaryRevision, setBoundaryRevision] = useState(0);

  useEffect(() => { dataRef.current = { places, visited, mode, currentLocation }; }, [places, visited, mode, currentLocation]);
  useEffect(() => { selectedRef.current = selectedId; }, [selectedId]);
  useEffect(() => { selectRef.current = onSelect; }, [onSelect]);
  useEffect(() => { boundaryStateRef.current = onBoundaryLoadState; }, [onBoundaryLoadState]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    let disposed = false;
    let loadDeadline: number | undefined;
    let boundaryLoadDeadline: number | undefined;
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
        attributionControl: false,
      });
      mapRef.current = map;
      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      loadDeadline = window.setTimeout(() => {
        if (!map.isStyleLoaded()) {
          setMapFailed(true);
        }
      }, 12_000);
      map.addControl(
        new maplibregl.AttributionControl({
          compact: true,
          customAttribution: [
            "Parkdex field guide",
            '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a>',
          ],
        }),
        "bottom-right",
      );
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
        if (event.sourceId === BOUNDARY_SOURCE && map.isSourceLoaded(BOUNDARY_SOURCE)) reportBoundaryStatus("canonical", "ready");
        if (event.sourceId === BOUNDARY_DISPLAY_SOURCE_ID && map.isSourceLoaded(BOUNDARY_DISPLAY_SOURCE_ID)) reportBoundaryStatus("display", "ready");
      });
      map.on("error", (event) => {
        const sourceId = (event as typeof event & { sourceId?: string }).sourceId;
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
        const { places: currentPlaces, visited: currentVisited, mode: currentMode } = dataRef.current;
        const currentVisiblePlaces = visiblePlaces(currentPlaces, currentVisited, currentMode);
        updateBoundaryFilters(map, currentVisiblePlaces, selectedRef.current);
        const availableIds = boundaryPlaceIds(index);
        currentVisited.forEach((id) => {
          if (availableIds.has(id)) map.setFeatureState({ source: BOUNDARY_DISPLAY_SOURCE_ID, id }, { visited: true });
        });
        boundaryVisitedRef.current = new Set([...currentVisited].filter((id) => availableIds.has(id)));
        map.on("click", "boundary-hit", (event: MapLayerMouseEvent) => {
          if (map.queryRenderedFeatures(event.point, { layers: ["clusters", "place-hit-targets"] }).length) return;
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
        } = dataRef.current;
        map.addSource(EXPLORATION_SOURCE_ID, {
          type: "geojson",
          data: explorationData(currentPlaces, currentVisited, currentMode),
        });
        explorationLayerSpecifications().forEach((layer) => map.addLayer(layer));
        map.addSource("places", {
          type: "geojson",
          data: collectionData(currentPlaces, currentVisited, currentMode),
          cluster: true,
          clusterMaxZoom: 10,
          clusterRadius: 52,
        });
        map.addLayer({
          id: "clusters",
          type: "circle",
          source: "places",
          filter: ["has", "point_count"],
          paint: {
            "circle-color": ["step", ["get", "point_count"], "#ffd862", 12, "#b9ea55", 35, "#78cad0"],
            "circle-radius": ["step", ["get", "point_count"], 20, 12, 25, 35, 30],
            "circle-stroke-color": "#173d32",
            "circle-stroke-width": 3,
          },
        });
        map.addSource(CURRENT_LOCATION_SOURCE_ID, {
          type: "geojson",
          data: locationData(initialLocation),
        });
        currentLocationLayerSpecifications().forEach((layer) => map.addLayer(layer));
        map.addLayer({
          id: "cluster-count",
          type: "symbol",
          source: "places",
          filter: ["has", "point_count"],
          layout: { "text-field": ["get", "point_count_abbreviated"], "text-font": ["Noto Sans Bold"], "text-size": 14 },
          paint: { "text-color": "#173d32" },
        });
        map.addLayer({
          id: "place-hit-targets",
          type: "circle",
          source: "places",
          filter: ["!", ["has", "point_count"]],
          paint: { "circle-radius": 24, "circle-color": "rgba(0,0,0,0)" },
        });
        map.addLayer({
          id: "place-points",
          type: "circle",
          source: "places",
          filter: ["!", ["has", "point_count"]],
          paint: {
            "circle-color": [
              "case",
              ["==", ["get", "visited"], 1],
              "#b9ea55",
              ["match", ["get", "category"], "national", "#ffd862", "provincial", "#78cad0", "regional", "#ef755f", "#f6f0dc"],
            ],
            "circle-radius": ["case", ["==", ["get", "visited"], 1], 13, 10],
            "circle-stroke-color": "#173d32",
            "circle-stroke-width": 3,
          },
        });
        map.addLayer({
          id: "place-checks",
          type: "symbol",
          source: "places",
          filter: ["all", ["!", ["has", "point_count"]], ["==", ["get", "visited"], 1]],
          layout: { "text-field": "✓", "text-size": 15, "text-font": ["Noto Sans Bold"] },
          paint: { "text-color": "#173d32" },
        });

        map.on("click", "clusters", async (event: MapLayerMouseEvent) => {
          const feature = map.queryRenderedFeatures(event.point, { layers: ["clusters"] })[0];
          const clusterId = Number(feature?.properties?.cluster_id);
          if (!Number.isFinite(clusterId)) return;
          const source = map.getSource("places") as GeoJSONSource;
          const zoom = await source.getClusterExpansionZoom(clusterId);
          const coordinates = (feature.geometry as GeoJSON.Point).coordinates as [number, number];
          map.easeTo({ center: coordinates, zoom, duration: reduceMotion ? 0 : 420 });
        });
        map.on("click", "place-hit-targets", (event: MapLayerMouseEvent) => {
          const id = event.features?.[0]?.properties?.id;
          if (typeof id === "string") selectRef.current(id);
        });
        ["clusters", "place-hit-targets"].forEach((layer) => {
          map.on("mouseenter", layer, () => { map.getCanvas().style.cursor = "pointer"; });
          map.on("mouseleave", layer, () => { map.getCanvas().style.cursor = ""; });
        });
        const overviewPlaces = visiblePlaces(currentPlaces, currentVisited, currentMode);
        fitOverview(map, overviewPlaces.length ? overviewPlaces : currentPlaces, false);
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
      if (loadDeadline) window.clearTimeout(loadDeadline);
      if (boundaryLoadDeadline) window.clearTimeout(boundaryLoadDeadline);
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const source = map.getSource("places") as GeoJSONSource | undefined;
    source?.setData(collectionData(places, visited, mode));
    const explorationSource = map.getSource(EXPLORATION_SOURCE_ID) as GeoJSONSource | undefined;
    explorationSource?.setData(explorationData(places, visited, mode));
    if (!map.getSource(BOUNDARY_SOURCE)) return;
    updateBoundaryFilters(map, visiblePlaces(places, visited, mode), selectedId);
    const availableIds = boundaryDataRef.current ? boundaryPlaceIds(boundaryDataRef.current) : new Set<string>();
    boundaryVisitedRef.current.forEach((id) => {
      if (!visited.has(id)) map.setFeatureState({ source: BOUNDARY_DISPLAY_SOURCE_ID, id }, { visited: false });
    });
    visited.forEach((id) => {
      if (availableIds.has(id)) map.setFeatureState({ source: BOUNDARY_DISPLAY_SOURCE_ID, id }, { visited: true });
    });
    boundaryVisitedRef.current = new Set([...visited].filter((id) => availableIds.has(id)));
  }, [places, visited, mode, selectedId]);

  useEffect(() => {
    const source = mapRef.current?.getSource(CURRENT_LOCATION_SOURCE_ID) as GeoJSONSource | undefined;
    source?.setData(locationData(currentLocation));
  }, [currentLocation]);

  useEffect(() => {
    if (!selectedId || !mapRef.current) return;
    const place = places.find((candidate) => candidate.id === selectedId);
    if (!place) return;
    const map = mapRef.current;
    const container = containerRef.current;
    if (!container) return;
    updateBoundaryFilters(map, visiblePlaces(places, visited, mode), selectedId);
    let animationFrame = 0;
    const fitSelected = () => {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(() => {
        map.resize();
        const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        const padding = measuredSelectionPadding(container);
        const mapRect = container.getBoundingClientRect();
        if (!hasUsableCameraViewport(mapRect, padding)) return;
        if (boundaryDataRef.current && fitBoundary(map, boundaryDataRef.current, selectedId, !reduceMotion, padding)) return;
        map.easeTo({ center: [place.longitude, place.latitude], padding, zoom: Math.max(map.getZoom(), 9), duration: reduceMotion ? 0 : 500 });
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
  }, [selectedId, places, visited, mode, boundaryRevision]);

  return (
    <div className="map-wrap">
      <div className="map" ref={containerRef} aria-label="Interactive map of Vancouver Island parks and major islands" />
      {mode === "explored" && visited.size > 0 && (
        <div className="exploration-map-key">
          <span className="exploration-map-key__swatch" aria-hidden="true" />
          <span>Estimated explored area from your visits; open gaps mark parks still waiting.</span>
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

"use client";

import { useEffect, useRef, useState } from "react";
import type { GeoJSONSource, Map as MapLibreMap, MapLayerMouseEvent, StyleSpecification } from "maplibre-gl";

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
import { BOUNDARY_SOURCE_ID, boundaryLayerSpecifications } from "@/lib/boundary-style";
import type { Place } from "@/lib/places";

const BOUNDARY_SOURCE = BOUNDARY_SOURCE_ID;
const BOUNDARY_SELECTED_LAYERS = ["boundary-selected-fill", "boundary-selected-halo", "boundary-selected-line"] as const;

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

function collectionData(places: Place[], visited: Set<string>): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: places.map((place) => ({
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

function fitOverview(map: MapLibreMap, places: Place[], animated: boolean) {
  if (!places.length) return;
  const longitudes = places.map((place) => place.longitude);
  const latitudes = places.map((place) => place.latitude);
  map.fitBounds(
    [[Math.min(...longitudes), Math.min(...latitudes)], [Math.max(...longitudes), Math.max(...latitudes)]],
    { padding: { top: 180, right: 32, bottom: 96, left: 32 }, maxZoom: 7, duration: animated ? 520 : 0 },
  );
}

function fitBoundary(map: MapLibreMap, index: BoundaryIndex, placeId: string, animated: boolean) {
  const bounds = boundsForPlace(index, placeId);
  if (!bounds) return false;
  map.fitBounds(bounds, {
    padding: { top: 180, right: 32, bottom: 230, left: 32 },
    maxZoom: 12,
    duration: animated ? 560 : 0,
  });
  return true;
}

function addBoundaryLayers(map: MapLibreMap) {
  map.addSource(BOUNDARY_SOURCE, {
    type: "geojson",
    data: BOUNDARY_DATA_URL,
    promoteId: "id",
    attribution: "Boundary geometry: sourced map datasets",
  });
  const beforeId = "clusters";
  boundaryLayerSpecifications().forEach((layer) => map.addLayer(layer, beforeId));
}

function updateBoundaryFilters(map: MapLibreMap, places: Place[], selectedId: string | null) {
  if (!map.getSource(BOUNDARY_SOURCE)) return;
  const ids = places.map((place) => place.id);
  map.setFilter("boundary-island-fill", boundaryFilter(ids, "island"));
  map.setFilter("boundary-island-line", boundaryFilter(ids, "island"));
  map.setFilter("boundary-park-fill", boundaryFilter(ids, "park"));
  map.setFilter("boundary-park-line", boundaryFilter(ids, "park"));
  map.setFilter("boundary-hit", boundaryFilter(ids));
  const selected = selectedBoundaryFilter(selectedId, ids);
  BOUNDARY_SELECTED_LAYERS.forEach((layer) => map.setFilter(layer, selected));
}

export function ParkMap({
  places,
  visited,
  selectedId,
  onSelect,
  onBoundaryLoadState,
}: {
  places: Place[];
  visited: Set<string>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onBoundaryLoadState?: (state: BoundaryLoadState) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const dataRef = useRef({ places, visited });
  const selectedRef = useRef(selectedId);
  const selectRef = useRef(onSelect);
  const boundaryStateRef = useRef(onBoundaryLoadState);
  const boundaryDataRef = useRef<BoundaryIndex | null>(null);
  const boundaryVisitedRef = useRef<Set<string>>(new Set());
  const [mapFailed, setMapFailed] = useState(false);
  const [boundaryRevision, setBoundaryRevision] = useState(0);

  useEffect(() => { dataRef.current = { places, visited }; }, [places, visited]);
  useEffect(() => { selectedRef.current = selectedId; }, [selectedId]);
  useEffect(() => { selectRef.current = onSelect; }, [onSelect]);
  useEffect(() => { boundaryStateRef.current = onBoundaryLoadState; }, [onBoundaryLoadState]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    let disposed = false;
    let loadDeadline: number | undefined;
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
      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
      map.addControl(
        new maplibregl.AttributionControl({
          compact: true,
          customAttribution: [
            "Every Park field guide",
            '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a>',
          ],
        }),
        "bottom-right",
      );
      let collectionReady = false;
      let boundaryReady = false;
      const setupBoundaries = (index: BoundaryIndex) => {
        if (boundaryReady || !map.getLayer("clusters")) return;
        boundaryReady = true;
        addBoundaryLayers(map);
        const { places: currentPlaces, visited: currentVisited } = dataRef.current;
        updateBoundaryFilters(map, currentPlaces, selectedRef.current);
        const availableIds = boundaryPlaceIds(index);
        currentVisited.forEach((id) => {
          if (availableIds.has(id)) map.setFeatureState({ source: BOUNDARY_SOURCE, id }, { visited: true });
        });
        boundaryVisitedRef.current = new Set([...currentVisited].filter((id) => availableIds.has(id)));
        map.on("click", "boundary-hit", (event: MapLayerMouseEvent) => {
          if (map.queryRenderedFeatures(event.point, { layers: ["clusters", "place-hit-targets"] }).length) return;
          const features = map.queryRenderedFeatures(event.point, { layers: ["boundary-hit"] });
          const id = pickBoundaryPlace(features, dataRef.current.places, event.lngLat);
          if (id) selectRef.current(id);
        });
        map.on("mouseenter", "boundary-hit", () => { map.getCanvas().style.cursor = "pointer"; });
        map.on("mouseleave", "boundary-hit", () => { map.getCanvas().style.cursor = ""; });
        const selected = selectedRef.current;
        if (selected && currentPlaces.some((place) => place.id === selected)) {
          fitBoundary(map, index, selected, !reduceMotion);
        }
      };
      const setupCollection = () => {
        if (collectionReady) return;
        try {
        collectionReady = true;
        window.clearTimeout(loadDeadline);
        setMapFailed(false);
        const { places: currentPlaces, visited: currentVisited } = dataRef.current;
        map.addSource("places", {
          type: "geojson",
          data: collectionData(currentPlaces, currentVisited),
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
        fitOverview(map, currentPlaces, false);
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
        boundaryStateRef.current?.({ status: "ready", placeIds: boundaryPlaceIds(index) });
        setupBoundaries(index);
        setBoundaryRevision((revision) => revision + 1);
      }).catch(() => {
        if (!disposed) boundaryStateRef.current?.({ status: "failed", placeIds: new Set() });
      });
    }).catch(() => setMapFailed(true));
    return () => {
      disposed = true;
      if (loadDeadline) window.clearTimeout(loadDeadline);
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const source = mapRef.current?.getSource("places") as GeoJSONSource | undefined;
    source?.setData(collectionData(places, visited));
    const map = mapRef.current;
    if (!map?.getSource(BOUNDARY_SOURCE)) return;
    updateBoundaryFilters(map, places, selectedId);
    const availableIds = boundaryDataRef.current ? boundaryPlaceIds(boundaryDataRef.current) : new Set<string>();
    boundaryVisitedRef.current.forEach((id) => {
      if (!visited.has(id)) map.setFeatureState({ source: BOUNDARY_SOURCE, id }, { visited: false });
    });
    visited.forEach((id) => {
      if (availableIds.has(id)) map.setFeatureState({ source: BOUNDARY_SOURCE, id }, { visited: true });
    });
    boundaryVisitedRef.current = new Set([...visited].filter((id) => availableIds.has(id)));
  }, [places, visited, selectedId]);

  useEffect(() => {
    if (!selectedId || !mapRef.current) return;
    const place = places.find((candidate) => candidate.id === selectedId);
    if (!place) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    updateBoundaryFilters(mapRef.current, places, selectedId);
    if (boundaryDataRef.current && fitBoundary(mapRef.current, boundaryDataRef.current, selectedId, !reduceMotion)) return;
    mapRef.current.easeTo({ center: [place.longitude, place.latitude], zoom: Math.max(mapRef.current.getZoom(), 9), duration: reduceMotion ? 0 : 500 });
  }, [selectedId, places, boundaryRevision]);

  return (
    <div className="map-wrap">
      <div className="map" ref={containerRef} aria-label="Interactive map of Vancouver Island parks and major islands" />
      <button className="overview-button" type="button" onClick={() => {
        const map = mapRef.current;
        if (!map) return;
        fitOverview(map, dataRef.current.places, !window.matchMedia("(prefers-reduced-motion: reduce)").matches);
      }}>Overview</button>
      {mapFailed && (
        <div className="map-fallback" role="status">
          <strong>The map could not load.</strong>
          <span>Your collection list is still ready below.</span>
        </div>
      )}
    </div>
  );
}

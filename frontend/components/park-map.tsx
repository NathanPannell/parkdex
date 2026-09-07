"use client";

import { useEffect, useRef, useState } from "react";
import type { GeoJSONSource, Map as MapLibreMap, MapLayerMouseEvent } from "maplibre-gl";

import type { Place } from "@/lib/places";

const STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";

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

export function ParkMap({
  places,
  visited,
  selectedId,
  onSelect,
}: {
  places: Place[];
  visited: Set<string>;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const dataRef = useRef({ places, visited });
  const selectRef = useRef(onSelect);
  const [mapFailed, setMapFailed] = useState(false);

  useEffect(() => { dataRef.current = { places, visited }; }, [places, visited]);
  useEffect(() => { selectRef.current = onSelect; }, [onSelect]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    let disposed = false;
    let loadDeadline: number | undefined;
    void import("maplibre-gl").then((maplibregl) => {
      if (disposed || !containerRef.current) return;
      const map = new maplibregl.Map({
        container: containerRef.current,
        style: STYLE_URL,
        center: [-125.25, 49.65],
        zoom: 5.55,
        minZoom: 4.6,
        maxZoom: 15,
        attributionControl: false,
      });
      mapRef.current = map;
      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      loadDeadline = window.setTimeout(() => {
        if (!map.isStyleLoaded()) setMapFailed(true);
      }, 12_000);
      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
      map.addControl(
        new maplibregl.AttributionControl({ compact: true, customAttribution: "Every Park field guide" }),
        "bottom-right",
      );
      map.on("load", () => {
        window.clearTimeout(loadDeadline);
        setMapFailed(false);
        // Repaint the public basemap as a simplified field-guide chart while
        // retaining its real coastline, roads, labels, and attribution.
        for (const layer of map.getStyle().layers ?? []) {
          try {
            const id = layer.id.toLowerCase();
            if (layer.type === "background") map.setPaintProperty(layer.id, "background-color", "#f6f0dc");
            if (layer.type === "fill") {
              if (id.includes("water") || id.includes("ocean")) map.setPaintProperty(layer.id, "fill-color", "#78cad0");
              else if (id.includes("park") || id.includes("wood") || id.includes("landcover")) map.setPaintProperty(layer.id, "fill-color", "#b8d691");
              else map.setPaintProperty(layer.id, "fill-color", "#f6f0dc");
              map.setPaintProperty(layer.id, "fill-opacity", id.includes("building") ? 0.35 : 0.88);
            }
            if (layer.type === "line") {
              if (id.includes("boundary")) map.setPaintProperty(layer.id, "line-color", "#5d8f77");
              else if (id.includes("water")) map.setPaintProperty(layer.id, "line-color", "#2b7a78");
              else map.setPaintProperty(layer.id, "line-color", "#bd9d69");
              map.setPaintProperty(layer.id, "line-opacity", id.includes("motorway") ? 0.72 : 0.48);
            }
            if (layer.type === "symbol") {
              map.setPaintProperty(layer.id, "text-color", "#173d32");
              map.setPaintProperty(layer.id, "text-halo-color", "#f6f0dc");
              map.setPaintProperty(layer.id, "text-halo-width", 1.5);
            }
          } catch { /* Some source layers intentionally omit a paint property. */ }
        }
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
          layout: { "text-field": ["get", "point_count_abbreviated"], "text-size": 14 },
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
  }, [places, visited]);

  useEffect(() => {
    if (!selectedId || !mapRef.current) return;
    const place = places.find((candidate) => candidate.id === selectedId);
    if (!place) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    mapRef.current.easeTo({ center: [place.longitude, place.latitude], zoom: Math.max(mapRef.current.getZoom(), 9), duration: reduceMotion ? 0 : 500 });
  }, [selectedId, places]);

  return (
    <div className="map-wrap">
      <div className="map" ref={containerRef} aria-label="Interactive map of Vancouver Island parks and major islands" />
      {mapFailed && (
        <div className="map-fallback" role="status">
          <strong>The map could not load.</strong>
          <span>Your collection list is still ready below.</span>
        </div>
      )}
    </div>
  );
}

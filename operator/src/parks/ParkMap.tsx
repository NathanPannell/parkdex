import { LngLatBounds, Map as MapLibreMap, NavigationControl, setWorkerUrl, type GeoJSONSource, type LngLatBoundsLike, type MapLayerMouseEvent, type MapMouseEvent } from "maplibre-gl";
import type { Feature, FeatureCollection } from "geojson";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef, useState } from "react";
import type { MultiPolygon, Position } from "./types";

/**
 * An embedded map for park work. It draws, in order: park pins, a park boundary, a player's
 * sketch, an in-progress drawing and the park or player pin. The base map is OpenFreeMap's
 * colour style, with Esri satellite imagery slotted under its labels for a hybrid view. Neither
 * needs a key.
 */

export type MapPoint = { id: string; name: string; lng: number; lat: number; status?: string };
export type Basemap = "satellite" | "streets";

type Props = {
  className?: string;
  pin?: Position | null;
  sketch?: Position[] | null;
  boundary?: MultiPolygon | null;
  points?: MapPoint[];
  selectedPointId?: string | null;
  onPointClick?(id: string): void;
  /** Vertices of a boundary being drawn; shown as a dashed line with handles. */
  drawing?: Position[] | null;
  /** Left clicks that did not hit a park pin. Drags pan the map and never arrive here. */
  onMapClick?(position: Position): void;
  /** Right clicks, used to drop a pin. */
  onMapRightClick?(position: Position): void;
  /** Change this to refit the view to the current shapes. */
  fitKey?: string;
  /** Zoom used when there is only a pin to show. */
  pinZoom?: number;
  crosshair?: boolean;
  basemap?: Basemap;
  /** Fly here when the key changes, for search results and list picks. */
  flyTarget?: { position: Position; zoom?: number; key: string } | null;
};

const STYLE = "https://tiles.openfreemap.org/styles/liberty";
const SATELLITE_TILES = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";

// The worker is copied into public/ by scripts/copy-maplibre-worker.mjs.
let workerReady = false;
function ensureWorker() {
  if (workerReady) return;
  setWorkerUrl(`${location.origin}/maplibre/maplibre-gl-worker.mjs`);
  workerReady = true;
}
const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

function featureCollection(features: Feature[]): FeatureCollection {
  return { type: "FeatureCollection", features };
}

function extend(bounds: LngLatBounds | null, position: Position): LngLatBounds {
  return bounds ? bounds.extend(position) : new LngLatBounds(position, position);
}

function addSatellite(instance: MapLibreMap) {
  instance.addSource("satellite", {
    type: "raster", tiles: [SATELLITE_TILES], tileSize: 256, maxzoom: 19,
    attribution: "Imagery &copy; Esri, Maxar, Earthstar Geographics",
  });
  // Below the first label layer, so street and place names stay readable on the imagery.
  const firstLabel = instance.getStyle().layers.find((layer) => layer.type === "symbol")?.id;
  instance.addLayer({ id: "satellite", type: "raster", source: "satellite", paint: { "raster-fade-duration": 150 } }, firstLabel);
}

function applyBasemap(instance: MapLibreMap, basemap: Basemap) {
  const satellite = basemap === "satellite";
  instance.setLayoutProperty("satellite", "visibility", satellite ? "visible" : "none");
  // Extruded buildings would sit on top of the imagery as grey blocks.
  for (const layer of instance.getStyle().layers) {
    if (layer.type === "fill-extrusion") instance.setLayoutProperty(layer.id, "visibility", satellite ? "none" : "visible");
  }
}

export function ParkMap({
  className, pin, sketch, boundary, points, selectedPointId, onPointClick, drawing, onMapClick, onMapRightClick,
  fitKey, pinZoom = 14, crosshair, basemap = "satellite", flyTarget,
}: Props) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const [ready, setReady] = useState(false);
  const handlers = useRef({ onPointClick, onMapClick, onMapRightClick });
  handlers.current = { onPointClick, onMapClick, onMapRightClick };

  useEffect(() => {
    if (!container.current) return;
    ensureWorker();
    const instance = new MapLibreMap({
      container: container.current,
      style: STYLE,
      center: pin ?? [-123.37, 48.43],
      zoom: pin ? pinZoom : 9,
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
    });
    instance.addControl(new NavigationControl({ showCompass: false }), "top-right");
    instance.on("load", () => {
      addSatellite(instance);
      for (const id of ["points", "boundary", "sketch", "drawing", "drawing-vertices", "pin"]) instance.addSource(id, { type: "geojson", data: EMPTY });
      instance.addLayer({ id: "boundary-fill", type: "fill", source: "boundary", paint: { "fill-color": "#2f9e6b", "fill-opacity": 0.3 } });
      instance.addLayer({ id: "boundary-casing", type: "line", source: "boundary", paint: { "line-color": "#ffffff", "line-width": 5, "line-opacity": 0.85 } });
      instance.addLayer({ id: "boundary-line", type: "line", source: "boundary", paint: { "line-color": "#1c5b43", "line-width": 2.5 } });
      instance.addLayer({ id: "sketch-fill", type: "fill", source: "sketch", paint: { "fill-color": "#ff5a1f", "fill-opacity": 0.14 } });
      instance.addLayer({ id: "sketch-line", type: "line", source: "sketch", paint: { "line-color": "#ff5a1f", "line-width": 2.5, "line-dasharray": [2, 1.5] } });
      instance.addLayer({
        id: "points", type: "circle", source: "points",
        paint: {
          "circle-radius": ["case", ["boolean", ["get", "selected"], false], 9, 6],
          "circle-color": ["match", ["get", "status"], "in-parkdex", "#7a8a80", "draft", "#e0a800", "live", "#2f9e6b", "#22b3c5"],
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": ["case", ["boolean", ["get", "selected"], false], 3, 1.5],
        },
      });
      instance.addLayer({
        id: "point-labels", type: "symbol", source: "points", minzoom: 11,
        layout: { "text-field": ["get", "name"], "text-size": 12, "text-offset": [0, 1.2], "text-anchor": "top", "text-font": ["Noto Sans Bold"] },
        paint: { "text-color": "#14231c", "text-halo-color": "#fff8ec", "text-halo-width": 1.6 },
      });
      instance.addLayer({ id: "drawing-line", type: "line", source: "drawing", paint: { "line-color": "#ffffff", "line-width": 3, "line-dasharray": [1.5, 1] } });
      instance.addLayer({ id: "drawing-vertices", type: "circle", source: "drawing-vertices", paint: { "circle-radius": 5, "circle-color": "#7b61ff", "circle-stroke-color": "#ffffff", "circle-stroke-width": 2.5 } });
      instance.addLayer({ id: "pin", type: "circle", source: "pin", paint: { "circle-radius": 9, "circle-color": "#ff5a1f", "circle-stroke-color": "#ffffff", "circle-stroke-width": 3 } });
      instance.on("click", "points", (event: MapLayerMouseEvent) => {
        const id = event.features?.[0]?.properties?.id;
        if (typeof id === "string") handlers.current.onPointClick?.(id);
      });
      instance.on("mouseenter", "points", () => { instance.getCanvas().style.cursor = "pointer"; });
      instance.on("mouseleave", "points", () => { instance.getCanvas().style.cursor = ""; });
      instance.on("click", (event: MapMouseEvent) => {
        const hit = instance.queryRenderedFeatures(event.point, { layers: ["points"] });
        if (!hit.length) handlers.current.onMapClick?.([event.lngLat.lng, event.lngLat.lat]);
      });
      instance.on("contextmenu", (event: MapMouseEvent) => {
        if (!handlers.current.onMapRightClick) return;
        event.preventDefault();
        handlers.current.onMapRightClick([event.lngLat.lng, event.lngLat.lat]);
      });
      setReady(true);
    });
    // Keep the browser menu away from the map, where right click drops a pin.
    const canvas = container.current;
    const blockMenu = (event: MouseEvent) => { if (handlers.current.onMapRightClick) event.preventDefault(); };
    canvas.addEventListener("contextmenu", blockMenu);
    // Full screen and panel changes resize the frame without resizing the window.
    const observer = new ResizeObserver(() => instance.resize());
    observer.observe(canvas);
    map.current = instance;
    return () => {
      observer.disconnect();
      canvas.removeEventListener("contextmenu", blockMenu);
      instance.remove();
      map.current = null;
    };
    // The map is created once; the effects below keep its data current.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const instance = map.current;
    if (ready && instance) applyBasemap(instance, basemap);
  }, [ready, basemap]);

  useEffect(() => {
    const instance = map.current;
    if (!ready || !instance) return;
    const source = (id: string) => instance.getSource(id) as GeoJSONSource;
    source("pin").setData(featureCollection(pin ? [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: pin } }] : []));
    source("sketch").setData(featureCollection(sketch && sketch.length >= 2 ? [{
      type: "Feature", properties: {},
      geometry: sketch.length >= 3 ? { type: "Polygon", coordinates: [[...sketch, sketch[0]]] } : { type: "LineString", coordinates: sketch },
    }] : []));
    source("boundary").setData(featureCollection(boundary ? [{ type: "Feature", properties: {}, geometry: boundary }] : []));
    source("points").setData(featureCollection((points ?? []).map((point) => ({
      type: "Feature", properties: { id: point.id, name: point.name, status: point.status ?? "available", selected: point.id === selectedPointId },
      geometry: { type: "Point", coordinates: [point.lng, point.lat] },
    }))));
    source("drawing").setData(featureCollection(drawing && drawing.length >= 2 ? [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: drawing } }] : []));
    source("drawing-vertices").setData(featureCollection((drawing ?? []).map((position) => ({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: position } }))));
  }, [ready, pin, sketch, boundary, points, selectedPointId, drawing]);

  // Fit the view to the shapes when asked; a lone pin gets a fixed zoom.
  useEffect(() => {
    const instance = map.current;
    if (!ready || !instance) return;
    let bounds: LngLatBounds | null = null;
    for (const polygon of boundary?.coordinates ?? []) for (const ring of polygon) for (const position of ring) bounds = extend(bounds, position);
    for (const position of sketch ?? []) bounds = extend(bounds, position);
    if (pin) bounds = extend(bounds, pin);
    // With nothing else to show, frame every park pin.
    if (!bounds) for (const point of points ?? []) bounds = extend(bounds, [point.lng, point.lat]);
    if (!bounds) return;
    const sw = bounds.getSouthWest(), ne = bounds.getNorthEast();
    if (sw.lng === ne.lng && sw.lat === ne.lat) instance.jumpTo({ center: bounds.getCenter(), zoom: pinZoom });
    else instance.fitBounds(bounds as LngLatBoundsLike, { padding: 48, maxZoom: 17, duration: 0 });
    // Only refit on an explicit request, not on every data change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, fitKey]);

  useEffect(() => {
    const instance = map.current;
    if (!ready || !instance || !flyTarget) return;
    instance.flyTo({ center: flyTarget.position, zoom: flyTarget.zoom ?? Math.max(instance.getZoom(), 12), duration: 600 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, flyTarget?.key]);

  return <div ref={container} className={`park-map${crosshair ? " park-map--crosshair" : ""}${className ? ` ${className}` : ""}`} />;
}

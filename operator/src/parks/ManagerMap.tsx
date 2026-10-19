import { LngLatBounds, Map as MapLibreMap, NavigationControl, Popup, type GeoJSONSource, type LngLatBoundsLike, type MapLayerMouseEvent } from "maplibre-gl";
import type { Feature, FeatureCollection } from "geojson";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { addSatellite, applyBasemap, ensureWorker, STYLE, type Basemap } from "./ParkMap";
import { CATEGORY_COLORS, osmKey, type OsmOutline, type ParkOutline, type ParkRow } from "./types";

/**
 * The park manager's map. Pins for every park the list shows, outlines for the parks in view,
 * and optional layers: hidden parks, founded parks (cover on hover) and OpenStreetMap outlines
 * from kip_osm.parks. Outlines load from the server for the current view only, never all at once.
 */

export type Layers = { outlines: boolean; hidden: boolean; founded: boolean; osm: boolean; osmMissingOnly: boolean };
export type View = { center: [number, number]; zoom: number };
export type OsmState = { status: "off" | "zoom" | "loading" | "ready" | "error"; outlines: OsmOutline[]; truncated: boolean; message?: string };

/** Park outlines appear from this zoom; below it a province of outlines would be one huge response. */
export const OUTLINE_ZOOM = 10;
export const OSM_ZOOM = 11.5;

type Props = {
  parks: ParkRow[];
  hoverId: string | null;
  layers: Layers;
  basemap: Basemap;
  initialView: View | null;
  /** Change the key to fly somewhere, for a list pick or a search. */
  flyTo: { center: [number, number]; zoom: number; key: string } | null;
  /** Change the key to frame every pin the list shows. */
  fitKey: string;
  onOpen(id: string): void;
  onHover(id: string | null): void;
  onOsmPick(outline: OsmOutline): void;
  onOsm(state: OsmState): void;
  onView(view: View): void;
};

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };
const categoryColor = ["match", ["get", "category"], ...Object.entries(CATEGORY_COLORS).flat(), "#9fd8ff"] as unknown as string;

function collection(features: Feature[]): FeatureCollection {
  return { type: "FeatureCollection", features };
}

function bboxOf(instance: MapLibreMap): string {
  const bounds = instance.getBounds();
  const clamp = (value: number, limit: number) => Math.max(-limit, Math.min(limit, value));
  return [clamp(bounds.getWest(), 180), clamp(bounds.getSouth(), 90), clamp(bounds.getEast(), 180), clamp(bounds.getNorth(), 90)]
    .map((value) => value.toFixed(5))
    .join(",");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

export function ManagerMap({ parks, hoverId, layers, basemap, initialView, flyTo, fitKey, onOpen, onHover, onOsmPick, onOsm, onView }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const [ready, setReady] = useState(false);
  const [zoom, setZoom] = useState(initialView?.zoom ?? 7);
  const [bbox, setBbox] = useState("");
  const [outlines, setOutlines] = useState<ParkOutline[]>([]);
  const [osm, setOsm] = useState<OsmState>({ status: "off", outlines: [], truncated: false });
  const parksById = useRef(new Map<string, ParkRow>());
  parksById.current = new Map(parks.map((park) => [park.id, park]));
  const osmByKey = useRef(new Map<string, OsmOutline>());
  const handlers = useRef({ onOpen, onHover, onOsmPick, onView });
  handlers.current = { onOpen, onHover, onOsmPick, onView };
  const layerState = useRef(layers);
  layerState.current = layers;
  const hovered = useRef<string | null>(null);
  const setParkHover = useRef<(id: string | null) => void>(() => undefined);

  useEffect(() => {
    if (!container.current) return;
    ensureWorker();
    const instance = new MapLibreMap({
      container: container.current,
      style: STYLE,
      center: initialView?.center ?? [-124.6, 49.4],
      zoom: initialView?.zoom ?? 6.4,
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
    });
    instance.addControl(new NavigationControl({ showCompass: false }), "top-right");
    const popup = new Popup({ closeButton: false, closeOnClick: false, offset: 14, className: "pm-popup", maxWidth: "240px" });
    instance.on("load", () => {
      addSatellite(instance);
      instance.addSource("osm", { type: "geojson", data: EMPTY, promoteId: "key" });
      instance.addSource("outlines", { type: "geojson", data: EMPTY, promoteId: "id" });
      instance.addSource("parks", { type: "geojson", data: EMPTY, promoteId: "id" });
      instance.addLayer({
        id: "osm-fill",
        type: "fill",
        source: "osm",
        paint: {
          "fill-color": ["case", ["get", "matched"], "#8a978f", "#ff5a1f"],
          "fill-opacity": ["case", ["boolean", ["feature-state", "hover"], false], 0.34, ["get", "matched"], 0.06, 0.16],
        },
      });
      instance.addLayer({
        id: "osm-line",
        type: "line",
        source: "osm",
        paint: {
          "line-color": ["case", ["get", "matched"], "#55665c", "#c9400f"],
          "line-width": ["case", ["get", "matched"], 1, 1.8],
          "line-dasharray": [2, 1.4],
        },
      });
      instance.addLayer({
        id: "outline-fill",
        type: "fill",
        source: "outlines",
        paint: {
          "fill-color": ["case", ["get", "hidden"], "#8a978f", categoryColor],
          "fill-opacity": ["case", ["boolean", ["feature-state", "hover"], false], 0.45, ["get", "hidden"], 0.12, 0.24],
        },
      });
      instance.addLayer({
        id: "outline-line",
        type: "line",
        source: "outlines",
        paint: {
          "line-color": ["case", ["get", "hidden"], "#55665c", "#14231c"],
          "line-width": ["case", ["boolean", ["feature-state", "hover"], false], 2.6, 1.3],
          "line-opacity": 0.8,
        },
      });
      instance.addLayer({
        id: "outline-hidden",
        type: "line",
        source: "outlines",
        filter: ["get", "hidden"],
        paint: { "line-color": "#14231c", "line-width": 1.2, "line-dasharray": [1, 1.5] },
      });
      instance.addLayer({
        id: "founded-ring",
        type: "circle",
        source: "parks",
        filter: ["get", "founded"],
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 6, 5.5, 12, 10],
          "circle-color": "rgba(0,0,0,0)",
          "circle-stroke-color": "#14231c",
          "circle-stroke-width": 2.2,
        },
      });
      instance.addLayer({
        id: "parks",
        type: "circle",
        source: "parks",
        paint: {
          "circle-radius": [
            "interpolate",
            ["linear"],
            ["zoom"],
            6,
            ["case", ["boolean", ["feature-state", "hover"], false], 6, 2.8],
            12,
            ["case", ["boolean", ["feature-state", "hover"], false], 10, 6.5],
          ],
          "circle-color": ["case", ["get", "hidden"], "#c5ccc7", categoryColor],
          "circle-stroke-color": ["case", ["boolean", ["feature-state", "hover"], false], "#14231c", "#ffffff"],
          "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 6, 0.6, 12, 1.6],
          "circle-opacity": ["case", ["get", "hidden"], 0.85, 1],
        },
      });
      instance.addLayer({
        id: "park-labels",
        type: "symbol",
        source: "parks",
        minzoom: 12,
        layout: {
          "text-field": ["get", "name"],
          "text-size": 12,
          "text-offset": [0, 1.1],
          "text-anchor": "top",
          "text-font": ["Noto Sans Bold"],
          "text-optional": true,
        },
        paint: { "text-color": "#14231c", "text-halo-color": "#fff8ec", "text-halo-width": 1.6 },
      });

      const setHover = (id: string | null) => {
        if (hovered.current === id) return;
        if (hovered.current) {
          instance.setFeatureState({ source: "parks", id: hovered.current }, { hover: false });
          instance.setFeatureState({ source: "outlines", id: hovered.current }, { hover: false });
        }
        hovered.current = id;
        if (id) {
          instance.setFeatureState({ source: "parks", id }, { hover: true });
          instance.setFeatureState({ source: "outlines", id }, { hover: true });
        }
      };
      setParkHover.current = setHover;

      const parkAt = (event: MapLayerMouseEvent) => {
        const id = event.features?.[0]?.properties?.id;
        return typeof id === "string" ? id : null;
      };
      for (const layer of ["parks", "outline-fill"]) {
        instance.on("click", layer, (event) => {
          const id = parkAt(event);
          if (id) handlers.current.onOpen(id);
        });
        instance.on("mousemove", layer, (event) => {
          const id = parkAt(event);
          instance.getCanvas().style.cursor = "pointer";
          setHover(id);
          handlers.current.onHover(id);
          const park = id ? parksById.current.get(id) : null;
          if (park && layer === "parks") {
            const founder =
              park.founder && layerState.current.founded
                ? `<img src="/api/parks/${encodeURIComponent(park.id)}/cover?v=${park.founder.photoSha256.slice(0, 12)}" alt="" width="220" height="140" /><span>Founded by @${escapeHtml(park.founder.handle ?? "deleted")}</span>`
                : "";
            popup
              .setLngLat([park.lng, park.lat])
              .setHTML(`<strong>${escapeHtml(park.name)}</strong>${park.hidden ? "<em>Hidden</em>" : ""}${founder}`)
              .addTo(instance);
          }
        });
        instance.on("mouseleave", layer, () => {
          instance.getCanvas().style.cursor = "";
          setHover(null);
          handlers.current.onHover(null);
          popup.remove();
        });
      }
      instance.on("click", "osm-fill", (event) => {
        // A park pin or outline on top wins.
        if (instance.queryRenderedFeatures(event.point, { layers: ["parks", "outline-fill"] }).length) return;
        const key = event.features?.[0]?.properties?.key;
        const outline = typeof key === "string" ? osmByKey.current.get(key) : undefined;
        if (outline) handlers.current.onOsmPick(outline);
      });
      let osmHover: string | null = null;
      instance.on("mousemove", "osm-fill", (event) => {
        const key = event.features?.[0]?.properties?.key;
        if (typeof key !== "string" || key === osmHover) return;
        if (osmHover) instance.setFeatureState({ source: "osm", id: osmHover }, { hover: false });
        osmHover = key;
        instance.setFeatureState({ source: "osm", id: key }, { hover: true });
        if (!instance.queryRenderedFeatures(event.point, { layers: ["parks"] }).length) instance.getCanvas().style.cursor = "pointer";
      });
      instance.on("mouseleave", "osm-fill", () => {
        if (osmHover) instance.setFeatureState({ source: "osm", id: osmHover }, { hover: false });
        osmHover = null;
        instance.getCanvas().style.cursor = "";
      });
      const moved = () => {
        setZoom(instance.getZoom());
        setBbox(bboxOf(instance));
        const center = instance.getCenter();
        handlers.current.onView({ center: [center.lng, center.lat], zoom: instance.getZoom() });
      };
      instance.on("moveend", moved);
      moved();
      setReady(true);
    });
    const observer = new ResizeObserver(() => instance.resize());
    observer.observe(container.current);
    map.current = instance;
    return () => {
      observer.disconnect();
      popup.remove();
      instance.remove();
      map.current = null;
    };
    // The map is created once; the effects below keep it current.
  }, []);

  useEffect(() => {
    if (ready && map.current) applyBasemap(map.current, basemap);
  }, [ready, basemap]);

  // Pins: every park the list shows. Hidden parks only with the hidden layer on.
  useEffect(() => {
    const instance = map.current;
    if (!ready || !instance) return;
    const shown = parks.filter((park) => layers.hidden || !park.hidden);
    (instance.getSource("parks") as GeoJSONSource).setData(
      collection(
        shown.map((park) => ({
          type: "Feature",
          properties: { id: park.id, name: park.name, category: park.category, hidden: Boolean(park.hidden), founded: Boolean(park.founder) && layers.founded },
          geometry: { type: "Point", coordinates: [park.lng, park.lat] },
        })),
      ),
    );
  }, [ready, parks, layers.hidden, layers.founded]);

  // Outlines of parks in view, from the server.
  useEffect(() => {
    if (!ready || !bbox || !layers.outlines || zoom < OUTLINE_ZOOM) {
      setOutlines([]);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      api<{ outlines: ParkOutline[] }>(`/api/parks/outlines?bbox=${bbox}`, { signal: controller.signal })
        .then((result) => setOutlines(result.outlines))
        .catch(() => {
          if (!controller.signal.aborted) setOutlines([]);
        });
    }, 200);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [ready, bbox, zoom >= OUTLINE_ZOOM, layers.outlines]);

  useEffect(() => {
    const instance = map.current;
    if (!ready || !instance) return;
    const visible = new Set(parks.filter((park) => layers.hidden || !park.hidden).map((park) => park.id));
    (instance.getSource("outlines") as GeoJSONSource).setData(
      collection(
        outlines
          .filter((outline) => visible.has(outline.id))
          .map((outline) => ({
            type: "Feature",
            properties: { id: outline.id, category: outline.category, hidden: outline.hidden },
            geometry: outline.geometry,
          })),
      ),
    );
  }, [ready, outlines, parks, layers.hidden]);

  // OpenStreetMap outlines in view, matched against the catalogue by the server.
  useEffect(() => {
    if (!layers.osm) {
      setOsm({ status: "off", outlines: [], truncated: false });
      return;
    }
    if (!ready || !bbox) return;
    if (zoom < OSM_ZOOM) {
      setOsm({ status: "zoom", outlines: [], truncated: false });
      return;
    }
    const controller = new AbortController();
    setOsm((current) => ({ ...current, status: "loading" }));
    const timer = window.setTimeout(() => {
      api<{ outlines: OsmOutline[]; truncated: boolean }>(`/api/parks/osm?bbox=${bbox}`, { signal: controller.signal })
        .then((result) => setOsm({ status: "ready", outlines: result.outlines, truncated: result.truncated }))
        .catch((reason: unknown) => {
          if (controller.signal.aborted) return;
          setOsm({
            status: "error",
            outlines: [],
            truncated: false,
            message: reason instanceof ApiError ? reason.message : "Could not load OpenStreetMap outlines.",
          });
        });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [ready, bbox, zoom >= OSM_ZOOM, layers.osm]);

  useEffect(() => {
    onOsm(osm);
  }, [osm, onOsm]);

  useEffect(() => {
    const instance = map.current;
    if (!ready || !instance) return;
    const shown = osm.outlines.filter((outline) => !layers.osmMissingOnly || !outline.inParkdex);
    osmByKey.current = new Map(shown.map((outline) => [osmKey(outline), outline]));
    (instance.getSource("osm") as GeoJSONSource).setData(
      collection(
        shown.map((outline) => ({
          type: "Feature",
          properties: { key: osmKey(outline), matched: Boolean(outline.inParkdex) },
          geometry: outline.geometry,
        })),
      ),
    );
  }, [ready, osm.outlines, layers.osmMissingOnly]);

  // A hovered list row lights up its pin and outline.
  useEffect(() => {
    if (ready) setParkHover.current(hoverId);
  }, [ready, hoverId]);

  useEffect(() => {
    const instance = map.current;
    if (!ready || !instance || !flyTo) return;
    instance.flyTo({ center: flyTo.center, zoom: flyTo.zoom, duration: 700 });
  }, [ready, flyTo?.key]);

  useEffect(() => {
    const instance = map.current;
    if (!ready || !instance || fitKey === "initial" || !parks.length) return;
    let bounds: LngLatBounds | null = null;
    for (const park of parks) bounds = bounds ? bounds.extend([park.lng, park.lat]) : new LngLatBounds([park.lng, park.lat], [park.lng, park.lat]);
    if (!bounds) return;
    const sw = bounds.getSouthWest(),
      ne = bounds.getNorthEast();
    if (sw.lng === ne.lng && sw.lat === ne.lat) instance.flyTo({ center: bounds.getCenter(), zoom: 14, duration: 500 });
    else instance.fitBounds(bounds as LngLatBoundsLike, { padding: 60, maxZoom: 15, duration: 500 });
  }, [ready, fitKey]);

  return <div ref={container} className="park-map pm-map" />;
}

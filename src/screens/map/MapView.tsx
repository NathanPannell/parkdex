import { AttributionControl, Map as MLMap, Marker, type ExpressionSpecification, type GeoJSONSource, type MapMouseEvent } from "maplibre-gl";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { BoundaryCollection } from "../../lib/boundaries";
import type { LngLat } from "../../lib/geo";
import { mapStyle } from "../../lib/mapStyle";
import { configureMapLibreWorker } from "../../lib/mapStartup";
import { BUILD_MAP_KEY, flushPendingDetailedMapSourceRefresh, registerBuildMapProtocols, retryUnavailableBuildMap, subscribeMapCoverage } from "../../lib/offlineTiles";
import { createLongPress, type ScreenPoint } from "../../lib/longPress";
import type { Park } from "../../lib/parks";
import { useContent, useContentRuntime } from "../../lib/content/provider";
import type { ParkFlag } from "../../lib/game/client";
import { PIN_POLE_X } from "../../lib/game/flag";
import { buildPins, PIN_PIXEL_RATIO, pinImageSvg, type PinImage } from "../../lib/game/mapPins";

type Tier = "far" | "mid" | "near";
// Pins stay dots until the map is zoomed to a town, so dense areas stay readable.
const FAR_ZOOM = 10.5;
const tierOf = (z: number): Tier => (z < FAR_ZOOM ? "far" : z < 12 ? "mid" : "near");
const PIN_LAYERS = ["park-flag", "park-dot"];

type Props = {
  mapRef: RefObject<MLMap | null>;
  user: LngLat;
  /** False until a real location is known, so no pin appears at a placeholder spot. */
  showUser: boolean;
  /** Where the camera opens when this map instance is first created. */
  initialView: { center: LngLat; zoom: number };
  fc: BoundaryCollection | undefined;
  /** Every park that can carry a flag. */
  parks: readonly Park[];
  /** Flags flying now; null while unknown or offline, which shows every park as empty. */
  flags: ReadonlyMap<string, ParkFlag> | null;
  /** The server's clock when the flags were read, for flag ages. */
  flagsNow: number;
  selectedId: string | null;
  tripId: string | null;
  arrivedId: string | null;
  route: LngLat[] | null;
  onSelect: (id: string | null) => void;
  /** A press and hold on the map outside any pinned park. */
  onLongPress?: (press: MapLongPress) => void;
  /** False while a full-screen view covers the map, so map animations pause. */
  visible: boolean;
};

export type MapLongPress = { lngLat: LngLat; point: ScreenPoint };

const BIOME_FILL = [
  "match",
  ["get", "biome"],
  "coast", "#5CC6D6",
  "mountain", "#7C8BE8",
  "lake", "#3DB2E0",
  "waterfall", "#8B7BE6",
  "river", "#4FB8D9",
  "cave", "#6D5BD0",
  "marsh", "#72B865",
  "heritage", "#C9774C",
  "#3FA66F",
] as unknown as string;

export function MapView({ mapRef, user, showUser, initialView, fc, parks, flags, flagsNow, selectedId, tripId, arrivedId, route, onSelect, onLongPress, visible }: Props) {
  const content = useContent();
  const runtime = useContentRuntime();
  const container = useRef<HTMLDivElement>(null);
  const userMarker = useRef<Marker | null>(null);
  const camera = useRef<{ center: LngLat; zoom: number; bearing: number; pitch: number } | null>(null);
  const pendingDetailReload = useRef(false);
  const styleReady = useRef(false);
  const pinImages = useRef(new Map<string, Promise<void>>());
  const [userHost, setUserHost] = useState<HTMLElement | null>(null);
  const [tier, setTier] = useState<Tier>("near");
  const [styleIsReady, setStyleIsReady] = useState(false);
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;
  const longPressRef = useRef(onLongPress);
  longPressRef.current = onLongPress;
  const pinnedIds = useRef(new Set<string>());
  pinnedIds.current = useMemo(() => new Set(parks.map((park) => park.id)), [parks]);
  const focusedId = tripId ?? selectedId ?? null;
  const focusRef = useRef(focusedId);
  focusRef.current = focusedId;
  const hasReadyMapContent = !!content?.releaseId;
  const pins = useMemo(() => buildPins(hasReadyMapContent ? parks : [], flags, flagsNow), [hasReadyMapContent, parks, flags, flagsNow]);
  // The style never changes after creation, so the map draws its detail once.
  const loaded = styleIsReady;

  useEffect(() => {
    styleReady.current = false;
    setStyleIsReady(false);
    setUserHost(null);
    const savedCamera = camera.current;
    const zoom = savedCamera?.zoom ?? initialView.zoom;
    configureMapLibreWorker();
    const cleanupBuildMap = registerBuildMapProtocols(runtime);
    const map = new MLMap({
      container: container.current!,
      style: mapStyle(BUILD_MAP_KEY),
      minZoom: 2.5,
      center: savedCamera?.center ?? initialView.center,
      zoom,
      bearing: savedCamera?.bearing ?? 0,
      pitch: savedCamera?.pitch ?? 0,
      attributionControl: false,
      pitchWithRotate: false,
      dragRotate: false,
      fadeDuration: 150,
    });
    map.touchZoomRotate.disableRotation();
    map.addControl(new AttributionControl({ compact: true }), "top-left");
    mapRef.current = map;
    setTier(tierOf(zoom));

    const uEl = document.createElement("div");
    uEl.className = "user-host";
    userMarker.current = new Marker({ element: uEl }).setLngLat(user).addTo(map);
    setUserHost(uEl);

    map.on("zoom", () => setTier(tierOf(map.getZoom())));
    map.on("click", (e: MapMouseEvent) => {
      selectRef.current(parkAtPoint(map, [e.point.x, e.point.y], pinnedIds.current));
    });
    const removeLongPress = listenForLongPress(map, (point) => {
      const handler = longPressRef.current;
      if (!handler || parkAtPoint(map, [point.x, point.y], pinnedIds.current)) return;
      const lngLat = map.unproject([point.x, point.y]);
      handler({ lngLat: [lngLat.lng, lngLat.lat], point });
    });
    const markStyleReady = () => {
      styleReady.current = true;
      setStyleIsReady(true);
      if (pendingDetailReload.current) flushPendingDetailedMapSourceRefresh(map, pendingDetailReload);
    };
    map.on("style.load", markStyleReady);
    map.on("load", markStyleReady);

    return () => {
      const center = map.getCenter();
      camera.current = {
        center: [center.lng, center.lat],
        zoom: map.getZoom(),
        bearing: map.getBearing(),
        pitch: map.getPitch(),
      };
      removeLongPress();
      map.remove();
      if (mapRef.current === map) mapRef.current = null;
      cleanupBuildMap();
      pinImages.current.clear();
      userMarker.current = null;
      pendingDetailReload.current = false;
      styleReady.current = false;
    };
  }, []);

  useEffect(() => subscribeMapCoverage(BUILD_MAP_KEY, () => {
    pendingDetailReload.current = true;
    const map = mapRef.current;
    if (!map || !styleReady.current) return;
    flushPendingDetailedMapSourceRefresh(map, pendingDetailReload);
  }), []);

  // Tiles that failed offline are retried once, when the network returns or
  // saved map files become readable, rather than on every status change.
  useEffect(() => {
    let connected = runtime.isConnected?.() ?? true;
    let hasSnapshot = !!runtime.getStatus().snapshot;
    return runtime.subscribe(() => {
      const nowConnected = runtime.isConnected?.() ?? true;
      const nowSnapshot = !!runtime.getStatus().snapshot;
      if ((nowConnected && !connected) || (nowSnapshot && !hasSnapshot)) retryUnavailableBuildMap();
      connected = nowConnected;
      hasSnapshot = nowSnapshot;
    });
  }, [runtime]);

  useEffect(() => {
    userMarker.current?.setLngLat(user);
  }, [user]);

  // Park and route overlays are restored after a content style transition.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded || !fc) return;
    const parksSource = map.getSource("parks") as GeoJSONSource | undefined;
    if (parksSource) parksSource.setData(fc);
    else map.addSource("parks", { type: "geojson", data: fc });
    if (!map.getSource("route")) map.addSource("route", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    const before = map.getLayer("water_waterway_label") ? "water_waterway_label" : undefined;
    const addLayer = (layer: Parameters<MLMap["addLayer"]>[0]) => {
      if (!map.getLayer(layer.id)) map.addLayer(layer, before);
    };
    addLayer({
      id: "park-fill",
      type: "fill",
      source: "parks",
      paint: { "fill-color": BIOME_FILL, "fill-opacity": ["interpolate", ["linear"], ["zoom"], 7, 0.12, 12, 0.22] },
    });
    addLayer({
      id: "park-line",
      type: "line",
      source: "parks",
      minzoom: 9,
      paint: { "line-color": BIOME_FILL, "line-width": 1.6, "line-dasharray": [2, 2], "line-opacity": 0.7 },
    });
    addLayer({
      id: "park-glow",
      type: "line",
      source: "parks",
      filter: ["==", ["get", "id"], ""],
      paint: { "line-color": "#FFC93C", "line-width": 14, "line-blur": 8, "line-opacity": 0.9 },
    });
    addLayer({
      id: "park-selected",
      type: "line",
      source: "parks",
      filter: ["==", ["get", "id"], ""],
      paint: { "line-color": "#14231C", "line-width": 3, "line-dasharray": [1.5, 1.2] },
    });
    addLayer({ id: "route-casing", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#FFF8EC", "line-width": 10 } });
    addLayer({
      id: "route-line",
      type: "line",
      source: "route",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#FF5A1F", "line-width": 5, "line-dasharray": [0.1, 2] },
    });
  }, [loaded, fc]);

  // Flag pins live in one symbol layer rather than one DOM marker per park, so a thousand
  // parks stay smooth: dots when zoomed out, flags on poles from town level in.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    let live = true;
    const missing = [...pins.images].filter(([id]) => !map.hasImage(id));
    void Promise.allSettled(missing.map(([id, image]) => ensurePinImage(map, pinImages.current, id, image))).then(() => {
      if (!live || mapRef.current !== map) return;
      const source = map.getSource("park-pins") as GeoJSONSource | undefined;
      if (source) source.setData(pins.collection);
      else map.addSource("park-pins", { type: "geojson", data: pins.collection });
      if (!map.getLayer("park-dot")) {
        map.addLayer({
          id: "park-dot",
          type: "circle",
          source: "park-pins",
          maxzoom: FAR_ZOOM,
          paint: {
            "circle-radius": ["interpolate", ["linear"], ["zoom"], 5, ["case", ["==", ["get", "held"], 1], 4, 2.5], FAR_ZOOM, ["case", ["==", ["get", "held"], 1], 7, 4.5]],
            "circle-color": ["get", "dot"],
            "circle-stroke-color": ["case", ["==", ["get", "held"], 1], "#14231C", "#5B6B62"],
            "circle-stroke-width": ["case", ["==", ["get", "held"], 1], 1.8, 1.2],
          },
        });
      }
      if (!map.getLayer("park-flag")) {
        map.addLayer({
          id: "park-flag",
          type: "symbol",
          source: "park-pins",
          minzoom: FAR_ZOOM,
          layout: {
            "icon-image": ["get", "icon"],
            "icon-anchor": "bottom-left",
            "icon-offset": [-PIN_POLE_X, 0],
            "icon-allow-overlap": true,
            "icon-ignore-placement": true,
            "icon-size": pinSize(focusRef.current),
            // Held parks draw above empty ones where pins overlap.
            "symbol-sort-key": ["get", "sort"],
          },
        });
      }
    });
    return () => { live = false; };
  }, [loaded, pins]);

  useEffect(() => {
    const map = mapRef.current;
    if (map?.getLayer("park-flag")) map.setLayoutProperty("park-flag", "icon-size", pinSize(focusedId));
    if (!map?.getLayer("park-selected")) return;
    map.setFilter("park-selected", ["==", ["get", "id"], focusedId ?? ""]);
    map.setFilter("park-glow", ["==", ["get", "id"], arrivedId ?? ""]);
  }, [focusedId, arrivedId, loaded, fc, pins]);

  // Gently breathe the arrival glow so the boundary feels alive.
  useEffect(() => {
    const map = mapRef.current;
    // Each paint-property change redraws the whole WebGL map, so only breathe while it is on screen.
    if (!arrivedId || !map || !visible) return;
    let raf = 0;
    const tick = (t: number) => {
      if (map.getLayer("park-glow")) map.setPaintProperty("park-glow", "line-width", 12 + Math.sin(t / 260) * 7);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [arrivedId, visible]);

  useEffect(() => {
    const src = mapRef.current?.getSource("route") as GeoJSONSource | undefined;
    src?.setData(
      route
        ? { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: route } }
        : { type: "FeatureCollection", features: [] },
    );
  }, [route, loaded, fc]);

  return (
    <div className={`mapview tier-${tier} ${selectedId || tripId ? "has-focus" : ""}`}>
      <div ref={container} className="mapview__canvas" />
      {userHost && showUser && createPortal(<UserDot moving={!!tripId} />, userHost)}
    </div>
  );
}

// A tap on a flag pin, or inside a pinned park's boundary, opens that park. Pins win over
// boundaries, and the topmost boundary wins where they overlap.
function parkAtPoint(map: MLMap, point: [number, number], pinned: ReadonlySet<string>): string | null {
  const pinLayers = PIN_LAYERS.filter((id) => map.getLayer(id));
  // A small box around the tap makes thin poles and small dots easy to hit.
  const box: [[number, number], [number, number]] = [[point[0] - 8, point[1] - 8], [point[0] + 8, point[1] + 8]];
  const hits = [
    ...(pinLayers.length ? map.queryRenderedFeatures(box, { layers: pinLayers }) : []),
    ...(map.getLayer("park-fill") ? map.queryRenderedFeatures(point, { layers: ["park-fill"] }) : []),
  ];
  for (const feature of hits) {
    const id = feature.properties?.id;
    if (typeof id === "string" && pinned.has(id)) return id;
  }
  return null;
}

function pinSize(focusedId: string | null): ExpressionSpecification {
  const focused: ExpressionSpecification = ["==", ["get", "id"], focusedId ?? ""];
  return ["interpolate", ["linear"], ["zoom"], FAR_ZOOM, ["case", focused, 0.95, 0.62], 13, ["case", focused, 1.3, 0.9], 16, ["case", focused, 1.45, 1.05]];
}

function loadSvgImage(svg: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("The flag pin could not be drawn."));
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
}

// Each pin image is drawn once per map; later refreshes reuse it.
function ensurePinImage(map: MLMap, pending: Map<string, Promise<void>>, id: string, image: PinImage): Promise<void> {
  const existing = pending.get(id);
  if (existing) return existing;
  const work = loadSvgImage(pinImageSvg(image)).then((element) => {
    if (!map.hasImage(id)) map.addImage(id, element, { pixelRatio: PIN_PIXEL_RATIO });
  }).catch((error: unknown) => {
    // Let a later refresh try this image again.
    pending.delete(id);
    throw error;
  });
  pending.set(id, work);
  return work;
}

// Touch holds use a timer; a mouse right-click opens the same menu on desktop.
function listenForLongPress(map: MLMap, onPress: (point: ScreenPoint) => void): () => void {
  const container = map.getCanvasContainer();
  let lastPressAt = 0;
  const fire = (point: ScreenPoint) => {
    // Android can report one hold as both a touch press and a contextmenu event.
    const now = Date.now();
    if (now - lastPressAt < 800) return;
    lastPressAt = now;
    onPress(point);
  };
  const press = createLongPress(fire);
  const local = (x: number, y: number): ScreenPoint => {
    const rect = container.getBoundingClientRect();
    return { x: x - rect.left, y: y - rect.top };
  };
  const touchStart = (event: TouchEvent) => {
    press.start(local(event.touches[0].clientX, event.touches[0].clientY), event.touches.length);
  };
  const touchMove = (event: TouchEvent) => {
    const touch = event.touches[0];
    if (touch) press.move(local(touch.clientX, touch.clientY), event.touches.length);
  };
  const touchEnd = (event: TouchEvent) => {
    // The lifted finger would otherwise send a click that closes the menu straight away.
    if (press.end() && event.cancelable) event.preventDefault();
  };
  const contextMenu = (event: MouseEvent) => {
    event.preventDefault();
    fire(local(event.clientX, event.clientY));
  };
  container.addEventListener("touchstart", touchStart, { passive: true });
  container.addEventListener("touchmove", touchMove, { passive: true });
  container.addEventListener("touchend", touchEnd, { passive: false });
  container.addEventListener("touchcancel", touchEnd, { passive: false });
  container.addEventListener("contextmenu", contextMenu);
  return () => {
    press.end();
    container.removeEventListener("touchstart", touchStart);
    container.removeEventListener("touchmove", touchMove);
    container.removeEventListener("touchend", touchEnd);
    container.removeEventListener("touchcancel", touchEnd);
    container.removeEventListener("contextmenu", contextMenu);
  };
}

function UserDot({ moving }: { moving: boolean }) {
  return (
    <div className={`user-dot ${moving ? "user-dot--moving" : ""}`}>
      <span className="user-dot__pulse" />
      <span className="user-dot__pulse user-dot__pulse--2" />
      <span className="user-dot__core" />
    </div>
  );
}

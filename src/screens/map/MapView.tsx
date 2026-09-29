import { AttributionControl, Map as MLMap, Marker, type GeoJSONSource, type MapMouseEvent } from "maplibre-gl";
import { motion } from "motion/react";
import { memo, useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Badge } from "../../components/Badge";
import { EarnedBadge } from "../../components/EarnedBadge";
import { Icon } from "../../components/Icon";
import type { BoundaryCollection } from "../../lib/boundaries";
import type { LngLat } from "../../lib/geo";
import { ISLAND_BOUNDS, mapStyle } from "../../lib/mapStyle";
import { configureMapLibreWorker, watchBundledOverviewReadiness } from "../../lib/mapStartup";
import { flushPendingDetailedMapSourceRefresh, registerContentMapProtocols, subscribeMapCoverage } from "../../lib/offlineTiles";
import { isLive, type Park } from "../../lib/parks";
import { UNAVAILABLE_ELIGIBILITY, getParkRarityEligibility, type ParkRarityEligibility, type RarityProgress } from "../../lib/progression";
import { rarityAccessibleStatus } from "../../lib/rarityUi";
import type { Claim } from "../../lib/store";
import { useContent, useContentRuntime } from "../../lib/content/provider";

type Tier = "far" | "mid" | "near";
const tierOf = (z: number): Tier => (z < 8.6 ? "far" : z < 10.4 ? "mid" : "near");

type Props = {
  mapRef: RefObject<MLMap | null>;
  user: LngLat;
  fc: BoundaryCollection | undefined;
  /** Parks to pin: those with a badge to earn, plus any already in the Dex. */
  parks: readonly Park[];
  claims: Readonly<Record<string, Claim>>;
  rarityProgress: RarityProgress;
  progressReady: boolean;
  selectedId: string | null;
  tripId: string | null;
  arrivedId: string | null;
  route: LngLat[] | null;
  onSelect: (id: string | null) => void;
};

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

export function MapView({ mapRef, user, fc, parks, claims, rarityProgress, progressReady, selectedId, tripId, arrivedId, route, onSelect }: Props) {
  const content = useContent();
  const runtime = useContentRuntime();
  const container = useRef<HTMLDivElement>(null);
  const userMarker = useRef<Marker | null>(null);
  const camera = useRef<{ center: LngLat; zoom: number; bearing: number; pitch: number } | null>(null);
  const parkMarkers = useRef(new Map<string, { park: Park; el: HTMLElement; marker: Marker; rank: number }>());
  const protocolCleanups = useRef(new Map<string, () => void>());
  const styleRelease = useRef<string | null>(null);
  const styleGeneration = useRef(0);
  const pendingDetailReload = useRef(false);
  const styleReady = useRef(false);
  const [hosts, setHosts] = useState<{ park: Park; el: HTMLElement; rank: number }[]>([]);
  const [userHost, setUserHost] = useState<HTMLElement | null>(null);
  const [tier, setTier] = useState<Tier>("near");
  const [overviewReadyMap, setOverviewReadyMap] = useState<MLMap | null>(null);
  const [loadedRelease, setLoadedRelease] = useState<string | null>(null);
  const [initialStyleLoaded, setInitialStyleLoaded] = useState(false);
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;
  const releaseId = content?.releaseId;
  const hasReadyMapContent = !!content && !!releaseId;
  const loaded = releaseId !== undefined && loadedRelease === releaseId;

  useEffect(() => {
    if (!content || !releaseId) return;
    setLoadedRelease(null);
    setInitialStyleLoaded(false);
    styleReady.current = false;
    setOverviewReadyMap(null);
    setHosts([]);
    setUserHost(null);
    const unregisterProtocols = registerContentMapProtocols(runtime, content);
    protocolCleanups.current.set(releaseId, unregisterProtocols);
    styleRelease.current = releaseId;
    const savedCamera = camera.current;
    const zoom = savedCamera?.zoom ?? 10.7;
    configureMapLibreWorker();
    const map = new MLMap({
      container: container.current!,
      style: mapStyle(releaseId),
      minZoom: 6.5,
      maxBounds: [
        [ISLAND_BOUNDS[0] - 1.5, ISLAND_BOUNDS[1] - 0.8],
        [ISLAND_BOUNDS[2] + 1.5, ISLAND_BOUNDS[3] + 0.8],
      ],
      center: savedCamera?.center ?? user,
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
    const stopOverviewReadiness = watchBundledOverviewReadiness(map, () => setOverviewReadyMap(map));

    const uEl = document.createElement("div");
    uEl.className = "user-host";
    userMarker.current = new Marker({ element: uEl }).setLngLat(user).addTo(map);
    setUserHost(uEl);

    map.on("zoom", () => setTier(tierOf(map.getZoom())));
    map.on("click", (e: MapMouseEvent) => {
      if ((e.originalEvent.target as HTMLElement).closest(".pm")) return;
      selectRef.current(null);
    });
    const markStyleReady = () => {
      const currentRelease = styleRelease.current;
      if (!currentRelease || !map.getStyle().glyphs?.includes(`${encodeURIComponent(currentRelease)}/`)) return;
      styleReady.current = true;
      setInitialStyleLoaded(true);
      setLoadedRelease(currentRelease);
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
      stopOverviewReadiness();
      map.remove();
      if (mapRef.current === map) mapRef.current = null;
      for (const cleanup of protocolCleanups.current.values()) cleanup();
      protocolCleanups.current.clear();
      parkMarkers.current.clear();
      userMarker.current = null;
      styleRelease.current = null;
      styleGeneration.current += 1;
      pendingDetailReload.current = false;
      styleReady.current = false;
    };
  }, [hasReadyMapContent]);

  useEffect(() => {
    if (!content || !releaseId) return;
    if (!initialStyleLoaded) return;
    const map = mapRef.current;
    if (!map || styleRelease.current === releaseId) return;

    if (!protocolCleanups.current.has(releaseId)) {
      protocolCleanups.current.set(releaseId, registerContentMapProtocols(runtime, content));
    }
    setLoadedRelease(null);
    styleRelease.current = releaseId;
    const generation = ++styleGeneration.current;
    map.once("style.load", () => {
      if (styleGeneration.current !== generation) return;
      for (const [registeredRelease, cleanup] of protocolCleanups.current) {
        if (registeredRelease === releaseId) continue;
        cleanup();
        protocolCleanups.current.delete(registeredRelease);
      }
    });
    styleReady.current = false;
    map.setStyle(mapStyle(releaseId), { diff: true });
  }, [releaseId, initialStyleLoaded]);

  useEffect(() => {
    if (!content || !releaseId) return;
    const map = mapRef.current;
    if (!map) return;
    if (overviewReadyMap !== map) {
      setHosts([]);
      return;
    }
    const ranked = [...parks].sort(
      (a, b) => Math.hypot(a.lng - user[0], a.lat - user[1]) - Math.hypot(b.lng - user[0], b.lat - user[1]),
    );
    const wanted = new Set(ranked.map((park) => park.id));
    for (const [id, record] of parkMarkers.current) {
      if (wanted.has(id)) continue;
      record.marker.remove();
      parkMarkers.current.delete(id);
    }
    setHosts(ranked.map((park, rank) => {
      const current = parkMarkers.current.get(park.id);
      if (current) {
        current.park = park;
        current.rank = rank;
        current.marker.setLngLat([park.lng, park.lat]);
        return { park, el: current.el, rank };
      }
      const el = document.createElement("div");
      el.className = "pm-host";
      const marker = new Marker({ element: el, anchor: "bottom" }).setLngLat([park.lng, park.lat]).addTo(map);
      parkMarkers.current.set(park.id, { park, el, marker, rank });
      return { park, el, rank };
    }));
  }, [parks, hasReadyMapContent, overviewReadyMap]);

  useEffect(() => {
    if (!releaseId) return;
    return subscribeMapCoverage(releaseId, () => {
      pendingDetailReload.current = true;
      const map = mapRef.current;
      if (!map || !styleReady.current) return;
      flushPendingDetailedMapSourceRefresh(map, pendingDetailReload);
    });
  }, [releaseId]);

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

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.getLayer("park-selected")) return;
    map.setFilter("park-selected", ["==", ["get", "id"], tripId ?? selectedId ?? ""]);
    map.setFilter("park-glow", ["==", ["get", "id"], arrivedId ?? ""]);
  }, [selectedId, tripId, arrivedId, loaded, fc]);

  // Gently breathe the arrival glow so the boundary feels alive.
  useEffect(() => {
    const map = mapRef.current;
    if (!arrivedId || !map) return;
    let raf = 0;
    const tick = (t: number) => {
      if (map.getLayer("park-glow")) map.setPaintProperty("park-glow", "line-width", 12 + Math.sin(t / 260) * 7);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [arrivedId]);

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
      {hosts.map(({ park, el, rank }) =>
        createPortal(
          <ParkMarker
            park={park}
            tier={tier}
            rank={rank}
            claim={claims[park.id]}
            eligibility={progressReady
              ? getParkRarityEligibility(park, rarityProgress, !!claims[park.id])
              : UNAVAILABLE_ELIGIBILITY}
            focused={park.id === (tripId ?? selectedId)}
            onSelect={onSelect}
          />,
          el,
          park.id,
        ),
      )}
      {userHost && createPortal(<UserDot moving={!!tripId} />, userHost)}
    </div>
  );
}

const ParkMarker = memo(function ParkMarker({
  park,
  tier,
  rank,
  claim,
  eligibility,
  focused,
  onSelect,
}: {
  park: Park;
  tier: Tier;
  rank: number;
  claim?: Claim;
  eligibility: ParkRarityEligibility;
  focused: boolean;
  onSelect: (id: string) => void;
}) {
  const live = isLive(park);
  const claimed = !!claim;
  const locked = eligibility.reason === "locked" || eligibility.reason === "unsupported-rarity";
  const size = !live ? (tier === "near" ? 30 : 22) : tier === "near" ? 50 : 38;
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const host = ref.current?.parentElement;
    if (host) host.style.zIndex = focused ? "20" : claimed ? "3" : live ? "2" : "1";
  }, [focused, claimed]);

  return (
    <motion.button
      ref={ref}
      className={`pm ${claimed ? "pm--claimed" : ""} ${focused ? "pm--focused" : ""} ${live ? "" : "pm--soon"} ${locked ? "pm--locked" : ""}`}
      aria-label={`${park.name}. ${rarityAccessibleStatus(park, eligibility, !live)}`}
      initial={{ scale: 0, y: 24 }}
      animate={{ scale: focused ? 1.4 : 1, y: focused ? -6 : 0 }}
      whileHover={{ scale: focused ? 1.45 : 1.12 }}
      whileTap={{ scale: 0.9 }}
      transition={{ type: "spring", stiffness: 420, damping: 18, delay: focused ? 0 : Math.min(rank * 0.012, 1.1) }}
      onClick={() => onSelect(park.id)}
    >
      {tier === "far" ? (
        <span className="pm__dot" />
      ) : (
        <>
          <span className="pm__badge">
            {claim
              ? <EarnedBadge park={park} claim={claim} size={size} showName={false} state="earned" />
              : <Badge park={park} size={size} showName={false} state="preview" />}
          </span>
          {claimed && (
            <span className="pm__check">
              <Icon name="check" size={12} stroke={3.4} />
            </span>
          )}
          {locked && <span className="pm__lock" aria-hidden="true"><Icon name="lock" size={10} stroke={2.8} /></span>}
          <span className="pm__stem" />
        </>
      )}
    </motion.button>
  );
});

function UserDot({ moving }: { moving: boolean }) {
  return (
    <div className={`user-dot ${moving ? "user-dot--moving" : ""}`}>
      <span className="user-dot__pulse" />
      <span className="user-dot__pulse user-dot__pulse--2" />
      <span className="user-dot__core" />
    </div>
  );
}

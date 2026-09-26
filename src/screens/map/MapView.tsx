import { AttributionControl, Map as MLMap, Marker, setWorkerUrl, type GeoJSONSource, type MapMouseEvent } from "maplibre-gl";

setWorkerUrl(`${location.origin}/maplibre/maplibre-gl-worker.mjs`);
registerOfflineTiles(location.origin);
import { motion } from "motion/react";
import { memo, useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Badge } from "../../components/Badge";
import { Icon } from "../../components/Icon";
import type { BoundaryCollection } from "../../lib/boundaries";
import type { LngLat } from "../../lib/geo";
import { ISLAND_BOUNDS, mapStyle } from "../../lib/mapStyle";
import { registerOfflineTiles } from "../../lib/offlineTiles";
import { isLive, PARKS, type Park } from "../../lib/parks";

type Tier = "far" | "mid" | "near";
const tierOf = (z: number): Tier => (z < 8.6 ? "far" : z < 10.4 ? "mid" : "near");

type Props = {
  mapRef: RefObject<MLMap | null>;
  user: LngLat;
  fc: BoundaryCollection | undefined;
  claims: Record<string, unknown>;
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

export function MapView({ mapRef, user, fc, claims, selectedId, tripId, arrivedId, route, onSelect }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const userMarker = useRef<Marker | null>(null);
  const [hosts, setHosts] = useState<{ park: Park; el: HTMLElement; rank: number }[]>([]);
  const [userHost, setUserHost] = useState<HTMLElement | null>(null);
  const [tier, setTier] = useState<Tier>("near");
  const [loaded, setLoaded] = useState(false);
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;

  useEffect(() => {
    const map = new MLMap({
      container: container.current!,
      style: mapStyle(location.origin),
      minZoom: 6.5,
      maxBounds: [
        [ISLAND_BOUNDS[0] - 1.5, ISLAND_BOUNDS[1] - 0.8],
        [ISLAND_BOUNDS[2] + 1.5, ISLAND_BOUNDS[3] + 0.8],
      ],
      center: user,
      zoom: 10.7,
      attributionControl: false,
      pitchWithRotate: false,
      dragRotate: false,
      fadeDuration: 150,
    });
    map.touchZoomRotate.disableRotation();
    map.addControl(new AttributionControl({ compact: true }), "top-left");
    mapRef.current = map;

    const ranked = [...PARKS].sort(
      (a, b) => Math.hypot(a.lng - user[0], a.lat - user[1]) - Math.hypot(b.lng - user[0], b.lat - user[1]),
    );
    setHosts(
      ranked.map((park, rank) => {
        const el = document.createElement("div");
        el.className = "pm-host";
        new Marker({ element: el, anchor: "bottom" }).setLngLat([park.lng, park.lat]).addTo(map);
        return { park, el, rank };
      }),
    );

    const uEl = document.createElement("div");
    uEl.className = "user-host";
    userMarker.current = new Marker({ element: uEl }).setLngLat(user).addTo(map);
    setUserHost(uEl);

    map.on("zoom", () => setTier(tierOf(map.getZoom())));
    map.on("click", (e: MapMouseEvent) => {
      if ((e.originalEvent.target as HTMLElement).closest(".pm")) return;
      selectRef.current(null);
    });
    map.on("load", () => setLoaded(true));

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    userMarker.current?.setLngLat(user);
  }, [user]);

  // Park boundary layers go in once both the style and the data are ready.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded || !fc || map.getSource("parks")) return;
    map.addSource("parks", { type: "geojson", data: fc });
    map.addSource("route", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    const before = "water_waterway_label";
    map.addLayer(
      {
        id: "park-fill",
        type: "fill",
        source: "parks",
        paint: { "fill-color": BIOME_FILL, "fill-opacity": ["interpolate", ["linear"], ["zoom"], 7, 0.12, 12, 0.22] },
      },
      before,
    );
    map.addLayer(
      {
        id: "park-line",
        type: "line",
        source: "parks",
        minzoom: 9,
        paint: { "line-color": BIOME_FILL, "line-width": 1.6, "line-dasharray": [2, 2], "line-opacity": 0.7 },
      },
      before,
    );
    map.addLayer(
      {
        id: "park-glow",
        type: "line",
        source: "parks",
        filter: ["==", ["get", "id"], ""],
        paint: { "line-color": "#FFC93C", "line-width": 14, "line-blur": 8, "line-opacity": 0.9 },
      },
      before,
    );
    map.addLayer(
      {
        id: "park-selected",
        type: "line",
        source: "parks",
        filter: ["==", ["get", "id"], ""],
        paint: { "line-color": "#14231C", "line-width": 3, "line-dasharray": [1.5, 1.2] },
      },
      before,
    );
    map.addLayer({ id: "route-casing", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#FFF8EC", "line-width": 10 } }, before);
    map.addLayer(
      {
        id: "route-line",
        type: "line",
        source: "route",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#FF5A1F", "line-width": 5, "line-dasharray": [0.1, 2] },
      },
      before,
    );
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
            claimed={!!claims[park.id]}
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
  claimed,
  focused,
  onSelect,
}: {
  park: Park;
  tier: Tier;
  rank: number;
  claimed: boolean;
  focused: boolean;
  onSelect: (id: string) => void;
}) {
  const live = isLive(park);
  const size = !live ? (tier === "near" ? 30 : 22) : tier === "near" ? 50 : 38;
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const host = ref.current?.parentElement;
    if (host) host.style.zIndex = focused ? "20" : claimed ? "3" : live ? "2" : "1";
  }, [focused, claimed]);

  return (
    <motion.button
      ref={ref}
      className={`pm ${claimed ? "pm--claimed" : ""} ${focused ? "pm--focused" : ""} ${live ? "" : "pm--soon"}`}
      aria-label={park.name}
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
            <Badge park={park} size={size} showName={false} state={claimed ? "earned" : "preview"} />
          </span>
          {claimed && (
            <span className="pm__check">
              <Icon name="check" size={12} stroke={3.4} />
            </span>
          )}
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

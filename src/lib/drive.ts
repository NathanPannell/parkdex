import raw from "../data/drive.json";
import { distanceKm, type LngLat } from "./geo";
import type { Park } from "./parks";

// Precomputed by scripts/drive-times.mjs: OSRM driving routes from a few origin hubs.
type DriveData = {
  hubs: { name: string; lng: number; lat: number }[];
  parks: Record<string, { drive: ([number, number] | null)[]; walkM: number }>;
};
const DATA = raw as unknown as DriveData;

export type Trip = {
  mode: "walk" | "drive" | "boat";
  km: number;
  minutes: number;
};

const WALK_KM = 1.2;

// Estimates the trip from where the visitor is now. The nearest hub's real route tells us
// how much the roads detour and how fast they are for this park; we scale that by the
// visitor's own straight-line distance. Good enough offline until a live router is wired in.
export function estimateTrip(from: LngLat, park: Park): Trip {
  const straight = distanceKm(from, [park.lng, park.lat]);
  if (straight < WALK_KM) {
    const km = straight * 1.25;
    return { mode: "walk", km, minutes: Math.max(1, Math.round((km * 1000) / 80)) };
  }
  const routes = DATA.parks[park.id]?.drive ?? [];
  let bestIndex = -1;
  let hubKm = Infinity;
  DATA.hubs.forEach((hub, i) => {
    const d = distanceKm(from, [hub.lng, hub.lat]);
    if (routes[i] && d < hubKm) {
      hubKm = d;
      bestIndex = i;
    }
  });
  if (bestIndex < 0) return { mode: "boat", km: straight, minutes: 0 };
  const route = routes[bestIndex]!;
  const hub = DATA.hubs[bestIndex];
  const hubStraight = Math.max(0.5, distanceKm([hub.lng, hub.lat], [park.lng, park.lat]));
  // Far from every hub, fall back to a generic island road factor.
  const detour = hubKm > 45 ? 1.4 : Math.min(3, Math.max(1.15, route[0] / hubStraight));
  const kmPerMin = hubKm > 45 ? 0.9 : Math.max(0.35, route[0] / Math.max(1, route[1]));
  const km = straight * detour;
  return { mode: "drive", km, minutes: Math.max(3, Math.round(km / kmPerMin + 2)) };
}

// Walk from the nearest drivable road into the park boundary.
export function finalWalk(park: Park) {
  const m = DATA.parks[park.id]?.walkM ?? 0;
  return m < 60 ? { label: "Roadside", minutes: 0 } : { label: `${Math.max(1, Math.round(m / 75))} min`, minutes: Math.round(m / 75) };
}

export function formatTrip(t: Trip) {
  if (t.mode === "boat") return "Boat access";
  const time = t.minutes < 60 ? `${t.minutes} min` : `${Math.floor(t.minutes / 60)} h ${t.minutes % 60 ? `${t.minutes % 60} min` : ""}`.trim();
  return `${time} ${t.mode}`;
}

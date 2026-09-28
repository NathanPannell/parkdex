import { distanceKm, type LngLat } from "./geo";
import type { DriveData } from "./content/contracts";
import type { Park } from "./parks";

export type Trip = {
  mode: "walk" | "drive" | "boat";
  km: number;
  minutes: number;
};

const WALK_KM = 1.2;

// Estimates a trip from the active release's precomputed route table. The
// catalog and route data always come from the same versioned snapshot.
export function estimateTrip(from: LngLat, park: Park, data?: DriveData): Trip {
  const straight = distanceKm(from, [park.lng, park.lat]);
  if (straight < WALK_KM) {
    const km = straight * 1.25;
    return { mode: "walk", km, minutes: Math.max(1, Math.round((km * 1000) / 80)) };
  }
  if (!data) return { mode: "boat", km: straight, minutes: 0 };
  const routes = data.parks[park.id]?.drive ?? [];
  let bestIndex = -1;
  let hubKm = Infinity;
  data.hubs.forEach((hub, i) => {
    const distance = distanceKm(from, [hub.lng, hub.lat]);
    if (routes[i] && distance < hubKm) {
      hubKm = distance;
      bestIndex = i;
    }
  });
  if (bestIndex < 0) return { mode: "boat", km: straight, minutes: 0 };
  const route = routes[bestIndex]!;
  const hub = data.hubs[bestIndex];
  const hubStraight = Math.max(0.5, distanceKm([hub.lng, hub.lat], [park.lng, park.lat]));
  // Far from every hub, fall back to a generic island road factor.
  const detour = hubKm > 45 ? 1.4 : Math.min(3, Math.max(1.15, route[0] / hubStraight));
  const kmPerMin = hubKm > 45 ? 0.9 : Math.max(0.35, route[0] / Math.max(1, route[1]));
  const km = straight * detour;
  return { mode: "drive", km, minutes: Math.max(3, Math.round(km / kmPerMin + 2)) };
}

// Walk from the nearest drivable road into the park boundary.
export function finalWalk(park: Park, data?: DriveData) {
  const m = data?.parks[park.id]?.walkM ?? 0;
  return m < 60 ? { label: "Roadside", minutes: 0 } : { label: `${Math.max(1, Math.round(m / 75))} min`, minutes: Math.round(m / 75) };
}

export function formatTrip(t: Trip) {
  if (t.mode === "boat") return "Boat access";
  const time = t.minutes < 60 ? `${t.minutes} min` : `${Math.floor(t.minutes / 60)} h ${t.minutes % 60 ? `${t.minutes % 60} min` : ""}`.trim();
  return `${time} ${t.mode}`;
}

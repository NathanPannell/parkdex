import type { Boundary, LngLat } from "./geo";

const EARTH_RADIUS_M = 6378137;

// Spherical excess approximation (as in turf/area); accurate to well under 1% at park scale.
function ringAreaM2(ring: readonly LngLat[]) {
  if (ring.length < 3) return 0;
  const r = Math.PI / 180;
  let total = 0;
  for (let i = 0; i < ring.length; i++) {
    const [lng1, lat1] = ring[i];
    const [lng2, lat2] = ring[(i + 1) % ring.length];
    total += (lng2 - lng1) * r * (2 + Math.sin(lat1 * r) + Math.sin(lat2 * r));
  }
  return Math.abs((total * EARTH_RADIUS_M * EARTH_RADIUS_M) / 2);
}

/** Total area of every region in the boundary, with holes removed. */
export function boundaryAreaKm2(boundary: Boundary) {
  let m2 = 0;
  for (const [outer, ...holes] of boundary.coordinates) {
    if (!outer) continue;
    m2 += ringAreaM2(outer) - holes.reduce((sum, hole) => sum + ringAreaM2(hole), 0);
  }
  return Math.max(0, m2) / 1e6;
}

// Small neighbourhood parks keep two decimals so they never read as "0.0 km²".
export function formatArea(km2: number) {
  if (km2 < 1) return `${Math.max(km2, 0.01).toFixed(2)} km²`;
  return `${km2 < 10 ? km2.toFixed(1) : Math.round(km2).toLocaleString("en-CA")} km²`;
}

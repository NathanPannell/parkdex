export type LngLat = [number, number];

export function distanceKm([aLng, aLat]: LngLat, [bLng, bLat]: LngLat) {
  const r = Math.PI / 180;
  const dLat = (bLat - aLat) * r;
  const dLng = (bLng - aLng) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

export function formatDistance(km: number) {
  if (km < 1) return `${Math.round(km * 1000)} m`;
  if (km < 10) return `${km.toFixed(1)} km`;
  return `${Math.round(km)} km`;
}

// Rough travel estimates for the mockup; a real build would ask a routing service.
export function travelEstimate(km: number) {
  const road = km * 1.35;
  const driveMin = Math.max(4, Math.round((road / 55) * 60 + 3));
  const walkMin = Math.round((km * 1000) / 80);
  return { driveMin, walkMin };
}

export function formatMinutes(min: number) {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

function inRing(point: LngLat, ring: LngLat[]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > point[1] !== yj > point[1] && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export type Boundary = { type: "MultiPolygon"; coordinates: LngLat[][][] };

export function insideBoundary(point: LngLat, boundary?: Boundary) {
  if (!boundary) return false;
  return boundary.coordinates.some((poly) => inRing(point, poly[0]));
}

// Picks a spot just inside the park's largest ring: the centroid if it is inside,
// otherwise the ring vertex nearest the visitor nudged toward the centroid.
export function arrivalPoint(boundary: Boundary, from: LngLat): LngLat {
  const ring = boundary.coordinates[0][0];
  const cx = ring.reduce((s, p) => s + p[0], 0) / ring.length;
  const cy = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  if (inRing([cx, cy], ring)) {
    const near = nearestVertex(ring, from);
    const blend: LngLat = [near[0] * 0.55 + cx * 0.45, near[1] * 0.55 + cy * 0.45];
    return inRing(blend, ring) ? blend : [cx, cy];
  }
  for (const v of [...ring].sort((a, b) => distanceKm(a, from) - distanceKm(b, from))) {
    const probe: LngLat = [v[0] * 0.9 + cx * 0.1, v[1] * 0.9 + cy * 0.1];
    if (inRing(probe, ring)) return probe;
  }
  return ring[0];
}

function nearestVertex(ring: LngLat[], from: LngLat) {
  return ring.reduce((best, p) => (distanceKm(p, from) < distanceKm(best, from) ? p : best), ring[0]);
}

export function ringBounds(boundary: Boundary): [LngLat, LngLat] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const poly of boundary.coordinates)
    for (const [x, y] of poly[0]) {
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
  return [[minX, minY], [maxX, maxY]];
}

// A gently curved path between two points, used for the route preview and the demo walk.
export function arcPath(a: LngLat, b: LngLat, steps = 48, bend = 0.18): LngLat[] {
  const mx = (a[0] + b[0]) / 2;
  const my = (a[1] + b[1]) / 2;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const cx = mx - dy * bend;
  const cy = my + dx * bend;
  return Array.from({ length: steps + 1 }, (_, i) => {
    const t = i / steps;
    const u = 1 - t;
    return [u * u * a[0] + 2 * u * t * cx + t * t * b[0], u * u * a[1] + 2 * u * t * cy + t * t * b[1]] as LngLat;
  });
}

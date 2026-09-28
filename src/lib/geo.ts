export type LngLat = [number, number];

export function isUsableGpsAccuracy(accuracy: number | null | undefined): accuracy is number {
  return accuracy !== null && accuracy !== undefined && Number.isFinite(accuracy) && accuracy > 0 && accuracy <= 100;
}

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

const POINT_ON_SEGMENT_EPSILON = 1e-10;

function isLngLat(point: unknown): point is LngLat {
  return Array.isArray(point) && point.length >= 2 && Number.isFinite(point[0]) && Number.isFinite(point[1]);
}

function pointOnSegment(point: LngLat, a: LngLat, b: LngLat) {
  if (
    (point[0] < a[0] - POINT_ON_SEGMENT_EPSILON && point[0] < b[0] - POINT_ON_SEGMENT_EPSILON) ||
    (point[0] > a[0] + POINT_ON_SEGMENT_EPSILON && point[0] > b[0] + POINT_ON_SEGMENT_EPSILON) ||
    (point[1] < a[1] - POINT_ON_SEGMENT_EPSILON && point[1] < b[1] - POINT_ON_SEGMENT_EPSILON) ||
    (point[1] > a[1] + POINT_ON_SEGMENT_EPSILON && point[1] > b[1] + POINT_ON_SEGMENT_EPSILON)
  ) return false;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point[0] - a[0], point[1] - a[1]) <= POINT_ON_SEGMENT_EPSILON;
  const t = Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / lengthSquared));
  return Math.hypot(point[0] - (a[0] + t * dx), point[1] - (a[1] + t * dy)) <= POINT_ON_SEGMENT_EPSILON;
}

// Boundary points count as being in the ring. Callers can exclude them when
// checking holes, since a hole edge is excluded from the park area.
function inRing(point: LngLat, ring: LngLat[], includeBoundary = true) {
  if (!isLngLat(point) || !Array.isArray(ring) || ring.length < 3) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (!isLngLat(a) || !isLngLat(b)) continue;
    const [xi, yi] = a;
    const [xj, yj] = b;
    if (pointOnSegment(point, b, a)) return includeBoundary;
    if (yi > point[1] !== yj > point[1] && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export type Boundary = { type: "MultiPolygon"; coordinates: LngLat[][][] };

function inPolygon(point: LngLat, polygon: LngLat[][]) {
  const [outer, ...holes] = polygon;
  if (!outer || !inRing(point, outer)) return false;
  return !holes.some((hole) => inRing(point, hole));
}

function strictlyInPolygon(point: LngLat, polygon: LngLat[][]) {
  const [outer, ...holes] = polygon;
  if (!outer || !inRing(point, outer, false)) return false;
  return !holes.some((hole) => inRing(point, hole));
}

export function insideBoundary(point: LngLat, boundary?: Boundary) {
  if (!boundary) return false;
  return boundary.coordinates.some((polygon) => inPolygon(point, polygon));
}

type EdgeProjection = { point: LngLat; distanceM: number; normalX: number; normalY: number };

const MAX_ARRIVAL_EDGE_CANDIDATES = 12;
const ARRIVAL_NUDGE_METRES = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 35, 50, 100, 250, 500];

function metresPerDegree(point: LngLat): [number, number] {
  return [111320 * Math.cos((point[1] * Math.PI) / 180), 110540];
}

function nearestEdgeProjections(point: LngLat, polygon: LngLat[][], limit = MAX_ARRIVAL_EDGE_CANDIDATES): EdgeProjection[] {
  const [rawKx, ky] = metresPerDegree(point);
  const kx = Math.abs(rawKx) < 1e-6 ? (rawKx < 0 ? -1e-6 : 1e-6) : rawKx;
  const nearest: EdgeProjection[] = [];
  for (const ring of polygon) {
    if (!Array.isArray(ring) || ring.length < 2) continue;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      if (!isLngLat(a) || !isLngLat(b)) continue;
      const ax = (a[0] - point[0]) * kx;
      const ay = (a[1] - point[1]) * ky;
      const bx = (b[0] - point[0]) * kx;
      const by = (b[1] - point[1]) * ky;
      const dx = bx - ax;
      const dy = by - ay;
      const length = Math.hypot(dx, dy);
      if (length === 0) continue;
      const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (length * length)));
      const x = ax + t * dx;
      const y = ay + t * dy;
      const candidate: EdgeProjection = {
        point: [point[0] + x / kx, point[1] + y / ky],
        distanceM: Math.hypot(x, y),
        normalX: -dy / length,
        normalY: dx / length,
      };
      let index = nearest.findIndex((entry) => candidate.distanceM < entry.distanceM);
      if (index < 0) index = nearest.length;
      nearest.splice(index, 0, candidate);
      if (nearest.length > limit) nearest.pop();
    }
  }
  return nearest;
}

function nudgedInteriorPoint(from: LngLat, polygon: LngLat[][], projections: EdgeProjection[]): LngLat | null {
  const [rawKx, ky] = metresPerDegree(from);
  const kx = Math.abs(rawKx) < 1e-6 ? (rawKx < 0 ? -1e-6 : 1e-6) : rawKx;
  const candidates: { point: LngLat; distance: number; order: number }[] = [];
  let order = 0;
  for (const edge of projections) {
    for (const metres of ARRIVAL_NUDGE_METRES) {
      for (const side of [-1, 1]) {
        const candidate: LngLat = [
          edge.point[0] + (edge.normalX * metres * side) / kx,
          edge.point[1] + (edge.normalY * metres * side) / ky,
        ];
        const distance = distanceKm(candidate, from);
        if (Number.isFinite(distance)) candidates.push({ point: candidate, distance, order });
        order++;
      }
    }
  }
  candidates.sort((a, b) => a.distance - b.distance || a.order - b.order);
  return candidates.find(({ point }) => strictlyInPolygon(point, polygon))?.point ?? null;
}

function fallbackInteriorPoint(from: LngLat, polygon: LngLat[][]): LngLat | null {
  const outer = polygon[0];
  if (!outer?.length) return null;
  let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
  let sumLng = 0, sumLat = 0, count = 0;
  for (const point of outer) {
    if (!isLngLat(point)) continue;
    minLng = Math.min(minLng, point[0]); maxLng = Math.max(maxLng, point[0]);
    minLat = Math.min(minLat, point[1]); maxLat = Math.max(maxLat, point[1]);
    sumLng += point[0]; sumLat += point[1]; count++;
  }
  if (!count) return null;
  const points: LngLat[] = [[sumLng / count, sumLat / count]];
  const gridSize = 32;
  for (let y = 0; y < gridSize; y++) {
    for (let x = 0; x < gridSize; x++) {
      points.push([
        minLng + ((x + 0.5) / gridSize) * (maxLng - minLng),
        minLat + ((y + 0.5) / gridSize) * (maxLat - minLat),
      ]);
    }
  }
  const candidates = points
    .map((point, order) => ({ point, distance: distanceKm(point, from), order }))
    .filter((candidate) => Number.isFinite(candidate.distance))
    .sort((a, b) => a.distance - b.distance || a.order - b.order);
  return candidates.find(({ point }) => strictlyInPolygon(point, polygon))?.point ?? null;
}

// Select the polygon part nearest the visitor, then return a nearby point strictly
// inside its outer ring and outside every hole.
export function arrivalPoint(boundary: Boundary, from: LngLat): LngLat {
  const candidates = boundary.coordinates
    .map((polygon, index) => {
      if (!polygon?.[0] || polygon[0].length < 4) return null;
      const projections = nearestEdgeProjections(from, polygon);
      if (!projections.length) return null;
      const isInside = strictlyInPolygon(from, polygon);
      return { polygon, index, projections, distanceM: isInside ? 0 : projections[0].distanceM };
    })
    .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
    .sort((a, b) => a.distanceM - b.distanceM || a.index - b.index);
  const nearest = candidates[0];
  if (!nearest) throw new Error("Boundary must contain a polygon with a valid outer ring");
  if (strictlyInPolygon(from, nearest.polygon)) return [from[0], from[1]];
  const point = nudgedInteriorPoint(from, nearest.polygon, nearest.projections)
    ?? fallbackInteriorPoint(from, nearest.polygon);
  if (!point) throw new Error("Unable to find an interior point for boundary polygon");
  return point;
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

// Metres from a point to the nearest boundary edge, using a local flat projection
// (accurate to well under a metre at park scale).
export function distanceToBoundaryM(point: LngLat, boundary: Boundary) {
  const [rawKx, ky] = metresPerDegree(point);
  const kx = Math.abs(rawKx) < 1e-6 ? (rawKx < 0 ? -1e-6 : 1e-6) : rawKx;
  let best = Infinity;
  for (const polygon of boundary.coordinates) {
    for (const ring of polygon) {
      if (!Array.isArray(ring) || ring.length < 2) continue;
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        if (!isLngLat(a) || !isLngLat(b)) continue;
        const ax = (a[0] - point[0]) * kx;
        const ay = (a[1] - point[1]) * ky;
        const bx = (b[0] - point[0]) * kx;
        const by = (b[1] - point[1]) * ky;
        const dx = bx - ax;
        const dy = by - ay;
        const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)));
        best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
      }
    }
  }
  return best;
}

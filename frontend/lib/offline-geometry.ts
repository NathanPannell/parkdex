import type { BoundaryFeature, BoundaryGeometry } from "./boundaries";

export type OfflineLocation = {
  latitude: number;
  longitude: number;
  accuracy: number;
  timestamp: number;
};

export type OfflineLocationValidation =
  | { status: "inside" }
  | { status: "outside" }
  | { status: "invalid-location" }
  | { status: "stale" }
  | { status: "inaccurate" }
  | { status: "missing-boundary" }
  | { status: "invalid-boundary" };

export const OFFLINE_LOCATION_MAX_AGE_MS = 20_000;
export const OFFLINE_LOCATION_MAX_ACCURACY_METERS = 50;

const COORDINATE_EPSILON = 1e-10;
const CROSS_PRODUCT_EPSILON = 1e-12;
const geometryValidity = new WeakMap<object, boolean>();

type Position = readonly number[];
type Point = readonly [number, number];
type Ring = readonly Position[];
type PolygonCoordinates = readonly Ring[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function samePoint(left: Position, right: Position) {
  return Math.abs(left[0] - right[0]) <= COORDINATE_EPSILON
    && Math.abs(left[1] - right[1]) <= COORDINATE_EPSILON;
}

function onSegment(point: Point, start: Point, end: Point) {
  const cross = (point[0] - start[0]) * (end[1] - start[1])
    - (point[1] - start[1]) * (end[0] - start[0]);
  if (Math.abs(cross) > CROSS_PRODUCT_EPSILON) return false;
  return point[0] >= Math.min(start[0], end[0]) - COORDINATE_EPSILON
    && point[0] <= Math.max(start[0], end[0]) + COORDINATE_EPSILON
    && point[1] >= Math.min(start[1], end[1]) - COORDINATE_EPSILON
    && point[1] <= Math.max(start[1], end[1]) + COORDINATE_EPSILON;
}

/** Returns -1 outside, 0 on the edge, and 1 inside. */
function locatePointInRing(point: Point, ring: Ring): -1 | 0 | 1 {
  let inside = false;
  for (let index = 0, previous = ring.length - 2; index < ring.length - 1; previous = index, index += 1) {
    const currentPosition = ring[index];
    const previousPosition = ring[previous];
    const current: Point = [currentPosition[0], currentPosition[1]];
    const prior: Point = [previousPosition[0], previousPosition[1]];
    if (onSegment(point, prior, current)) return 0;

    const crossesLatitude = (current[1] > point[1]) !== (prior[1] > point[1]);
    if (!crossesLatitude) continue;
    const crossingLongitude = current[0]
      + ((point[1] - current[1]) * (prior[0] - current[0])) / (prior[1] - current[1]);
    if (crossingLongitude > point[0]) inside = !inside;
  }
  return inside ? 1 : -1;
}

function cross(start: Point, end: Point, point: Point) {
  return (end[0] - start[0]) * (point[1] - start[1])
    - (end[1] - start[1]) * (point[0] - start[0]);
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point) {
  const abC = cross(a, b, c);
  const abD = cross(a, b, d);
  const cdA = cross(c, d, a);
  const cdB = cross(c, d, b);
  if (((abC > CROSS_PRODUCT_EPSILON && abD < -CROSS_PRODUCT_EPSILON)
      || (abC < -CROSS_PRODUCT_EPSILON && abD > CROSS_PRODUCT_EPSILON))
    && ((cdA > CROSS_PRODUCT_EPSILON && cdB < -CROSS_PRODUCT_EPSILON)
      || (cdA < -CROSS_PRODUCT_EPSILON && cdB > CROSS_PRODUCT_EPSILON))) return true;
  return (Math.abs(abC) <= CROSS_PRODUCT_EPSILON && onSegment(c, a, b))
    || (Math.abs(abD) <= CROSS_PRODUCT_EPSILON && onSegment(d, a, b))
    || (Math.abs(cdA) <= CROSS_PRODUCT_EPSILON && onSegment(a, c, d))
    || (Math.abs(cdB) <= CROSS_PRODUCT_EPSILON && onSegment(b, c, d));
}

type Segment = {
  index: number;
  start: Point;
  end: Point;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
};

function segmentsFor(ring: Ring): Segment[] {
  return ring.slice(0, -1).map((position, index) => {
    const next = ring[index + 1];
    const start: Point = [position[0], position[1]];
    const end: Point = [next[0], next[1]];
    return {
      index,
      start,
      end,
      minX: Math.min(start[0], end[0]),
      maxX: Math.max(start[0], end[0]),
      minY: Math.min(start[1], end[1]),
      maxY: Math.max(start[1], end[1]),
    };
  });
}

function edgesOverlap(left: Segment, right: Segment) {
  return left.maxX >= right.minX - COORDINATE_EPSILON
    && right.maxX >= left.minX - COORDINATE_EPSILON
    && left.maxY >= right.minY - COORDINATE_EPSILON
    && right.maxY >= left.minY - COORDINATE_EPSILON;
}

function ringsIntersect(left: Ring, right: Ring) {
  const leftSegments = segmentsFor(left);
  const rightSegments = segmentsFor(right);
  const ordered = [
    ...leftSegments.map((segment) => ({ ...segment, ring: 0 })),
    ...rightSegments.map((segment) => ({ ...segment, ring: 1 })),
  ].sort((a, b) => a.minX - b.minX);
  const active: typeof ordered = [];

  for (const segment of ordered) {
    for (let index = active.length - 1; index >= 0; index -= 1) {
      if (active[index].maxX < segment.minX - COORDINATE_EPSILON) active.splice(index, 1);
    }
    for (const candidate of active) {
      if (candidate.ring === segment.ring || !edgesOverlap(candidate, segment)) continue;
      if (segmentsIntersect(candidate.start, candidate.end, segment.start, segment.end)) return true;
    }
    active.push(segment);
  }
  return false;
}

/**
 * Shapely treats one point of contact between a hole and the exterior as valid.
 * Crossings, shared boundary segments, and multiple contact points remain invalid.
 */
function ringsCrossOrOverlap(left: Ring, right: Ring) {
  const contacts: Point[] = [];
  const leftSegments = segmentsFor(left);
  const rightSegments = segmentsFor(right);
  for (const leftSegment of leftSegments) {
    for (const rightSegment of rightSegments) {
      if (!edgesOverlap(leftSegment, rightSegment)) continue;
      const { start: a, end: b } = leftSegment;
      const { start: c, end: d } = rightSegment;
      const abC = cross(a, b, c);
      const abD = cross(a, b, d);
      const cdA = cross(c, d, a);
      const cdB = cross(c, d, b);
      const crossesProperly = ((abC > CROSS_PRODUCT_EPSILON && abD < -CROSS_PRODUCT_EPSILON)
          || (abC < -CROSS_PRODUCT_EPSILON && abD > CROSS_PRODUCT_EPSILON))
        && ((cdA > CROSS_PRODUCT_EPSILON && cdB < -CROSS_PRODUCT_EPSILON)
          || (cdA < -CROSS_PRODUCT_EPSILON && cdB > CROSS_PRODUCT_EPSILON));
      if (crossesProperly) return true;

      const collinear = Math.abs(abC) <= CROSS_PRODUCT_EPSILON
        && Math.abs(abD) <= CROSS_PRODUCT_EPSILON
        && Math.abs(cdA) <= CROSS_PRODUCT_EPSILON
        && Math.abs(cdB) <= CROSS_PRODUCT_EPSILON;
      if (collinear) {
        const useLongitude = Math.abs(a[0] - b[0]) >= Math.abs(a[1] - b[1]);
        const overlap = Math.min(
          Math.max(useLongitude ? a[0] : a[1], useLongitude ? b[0] : b[1]),
          Math.max(useLongitude ? c[0] : c[1], useLongitude ? d[0] : d[1]),
        ) - Math.max(
          Math.min(useLongitude ? a[0] : a[1], useLongitude ? b[0] : b[1]),
          Math.min(useLongitude ? c[0] : c[1], useLongitude ? d[0] : d[1]),
        );
        if (overlap > COORDINATE_EPSILON) return true;
      }

      const candidates: Point[] = [];
      if (Math.abs(abC) <= CROSS_PRODUCT_EPSILON && onSegment(c, a, b)) candidates.push(c);
      if (Math.abs(abD) <= CROSS_PRODUCT_EPSILON && onSegment(d, a, b)) candidates.push(d);
      if (Math.abs(cdA) <= CROSS_PRODUCT_EPSILON && onSegment(a, c, d)) candidates.push(a);
      if (Math.abs(cdB) <= CROSS_PRODUCT_EPSILON && onSegment(b, c, d)) candidates.push(b);
      for (const candidate of candidates) {
        if (!contacts.some((contact) => samePoint(contact, candidate))) contacts.push(candidate);
        if (contacts.length > 1) return true;
      }
    }
  }
  return false;
}

function ringHasSelfIntersection(ring: Ring) {
  const segments = segmentsFor(ring).sort((a, b) => a.minX - b.minX);
  const active: Segment[] = [];
  const count = segments.length;

  for (const segment of segments) {
    for (let index = active.length - 1; index >= 0; index -= 1) {
      if (active[index].maxX < segment.minX - COORDINATE_EPSILON) active.splice(index, 1);
    }
    for (const candidate of active) {
      const distance = Math.abs(candidate.index - segment.index);
      if (distance === 1 || distance === count - 1 || !edgesOverlap(candidate, segment)) continue;
      if (segmentsIntersect(candidate.start, candidate.end, segment.start, segment.end)) return true;
    }
    active.push(segment);
  }
  return false;
}

function signedRingArea(ring: Ring) {
  const origin = ring[0];
  let twiceArea = 0;
  for (let index = 0; index < ring.length - 1; index += 1) {
    const current = ring[index];
    const next = ring[index + 1];
    twiceArea += (current[0] - origin[0]) * (next[1] - origin[1])
      - (next[0] - origin[0]) * (current[1] - origin[1]);
  }
  return twiceArea / 2;
}

function collapseRepeatedVertices(ring: Ring): Ring {
  const distinct: Position[] = [];
  for (const position of ring.slice(0, -1)) {
    if (!distinct.length || !samePoint(distinct[distinct.length - 1], position)) distinct.push(position);
  }
  if (distinct.length) distinct.push(distinct[0]);
  return distinct;
}

function isValidRing(value: unknown): value is Ring {
  if (!Array.isArray(value) || value.length < 4) return false;
  if (!value.every((position) => Array.isArray(position)
      && position.length >= 2
      && position.every((axis) => typeof axis === "number" && Number.isFinite(axis))
      && Math.abs(position[0]) <= 180
      && Math.abs(position[1]) <= 90)) return false;
  const ring = value as Ring;
  if (!samePoint(ring[0], ring[ring.length - 1])) return false;
  const distinctVertices = collapseRepeatedVertices(ring);
  return distinctVertices.length >= 4
    && Math.abs(signedRingArea(distinctVertices)) > 1e-18
    && !ringHasSelfIntersection(distinctVertices);
}

function isValidPolygon(value: unknown): value is PolygonCoordinates {
  if (!Array.isArray(value) || value.length === 0 || !value.every(isValidRing)) return false;
  const polygon = value as PolygonCoordinates;
  const outer = polygon[0];
  for (let holeIndex = 1; holeIndex < polygon.length; holeIndex += 1) {
    const hole = polygon[holeIndex];
    const holePositions = hole.slice(0, -1).map((position): Point => [position[0], position[1]]);
    const outerLocations = holePositions.map((position) => locatePointInRing(position, outer));
    if (ringsCrossOrOverlap(outer, hole)
      || outerLocations.some((position) => position < 0)
      || !outerLocations.some((position) => position === 1)) return false;
    for (let otherIndex = 1; otherIndex < holeIndex; otherIndex += 1) {
      const otherHole = polygon[otherIndex];
      if (ringsIntersect(otherHole, hole)
        || locatePointInRing([hole[0][0], hole[0][1]], otherHole) !== -1
        || locatePointInRing([otherHole[0][0], otherHole[0][1]], hole) !== -1) return false;
    }
  }
  return true;
}

function isValidGeometry(value: unknown): value is BoundaryGeometry {
  if (!isRecord(value)) return false;
  const cached = geometryValidity.get(value);
  if (cached !== undefined) return cached;
  let valid = false;
  if (value.type === "Polygon") {
    valid = isValidPolygon(value.coordinates);
  } else if (value.type === "MultiPolygon" && Array.isArray(value.coordinates) && value.coordinates.length > 0) {
    valid = value.coordinates.every(isValidPolygon);
  }
  geometryValidity.set(value, valid);
  return valid;
}

function isValidBoundary(value: unknown): value is BoundaryFeature {
  return isRecord(value)
    && value.type === "Feature"
    && isValidGeometry(value.geometry);
}

function pointInPolygon(point: Point, polygon: PolygonCoordinates) {
  const outerPosition = locatePointInRing(point, polygon[0]);
  if (outerPosition < 0) return false;
  for (let index = 1; index < polygon.length; index += 1) {
    // Exterior edges count as inside, while a hole's interior and edge are excluded.
    if (locatePointInRing(point, polygon[index]) >= 0) return false;
  }
  return true;
}

function pointInGeometry(point: Point, geometry: BoundaryGeometry) {
  if (geometry.type === "Polygon") return pointInPolygon(point, geometry.coordinates as PolygonCoordinates);
  return geometry.coordinates.some((polygon) => pointInPolygon(point, polygon as PolygonCoordinates));
}

/** Checks the original Polygon or MultiPolygon coordinates, including holes. */
export function isPointInBoundary(
  point: Pick<OfflineLocation, "longitude" | "latitude">,
  boundary: BoundaryFeature | null | undefined,
): boolean {
  if (!isRecord(point) || !Number.isFinite(point.longitude) || !Number.isFinite(point.latitude)
    || Math.abs(point.longitude) > 180 || Math.abs(point.latitude) > 90
    || !isValidBoundary(boundary)) return false;
  return pointInGeometry([point.longitude, point.latitude], boundary.geometry);
}

/** Applies GPS freshness and accuracy checks before exact local boundary containment. */
export function validateOfflineLocation(
  location: OfflineLocation,
  boundary: BoundaryFeature | null | undefined,
  now = Date.now(),
): OfflineLocationValidation {
  if (!isRecord(location) || !Number.isFinite(location.latitude) || !Number.isFinite(location.longitude)
    || Math.abs(location.latitude) > 90 || Math.abs(location.longitude) > 180
    || !Number.isFinite(location.accuracy) || location.accuracy <= 0
    || !Number.isFinite(location.timestamp) || !Number.isFinite(now)) return { status: "invalid-location" };
  if (location.timestamp > now || now - location.timestamp > OFFLINE_LOCATION_MAX_AGE_MS) return { status: "stale" };
  if (location.accuracy > OFFLINE_LOCATION_MAX_ACCURACY_METERS) return { status: "inaccurate" };
  if (boundary == null) return { status: "missing-boundary" };
  if (!isValidBoundary(boundary)) return { status: "invalid-boundary" };
  return isPointInBoundary(location, boundary) ? { status: "inside" } : { status: "outside" };
}

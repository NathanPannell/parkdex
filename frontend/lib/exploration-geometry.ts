import polygonClipping from "polygon-clipping";
import type { MultiPolygon, Pair, Polygon } from "polygon-clipping";

export type ExplorationPoint = {
  id: string;
  longitude: number;
  latitude: number;
};

export type ExplorationGeometryOptions = {
  footprintRadiusKm?: number;
  maxLinkKm?: number;
  circleSteps?: number;
  gapPoints?: readonly ExplorationPoint[];
  gapRadiusKm?: number;
};

type CoverageProperties = { kind: "estimated-exploration"; visitedCount: number };

const EARTH_RADIUS_KM = 6371.0088;
const DEFAULT_FOOTPRINT_RADIUS_KM = 4;
const DEFAULT_MAX_LINK_KM = 24;
const DEFAULT_CIRCLE_STEPS = 28;
const DEFAULT_GAP_RADIUS_KM = 0.8;

function radians(degrees: number) {
  return degrees * Math.PI / 180;
}

function degrees(radiansValue: number) {
  return radiansValue * 180 / Math.PI;
}

export function distanceKm(a: Pick<ExplorationPoint, "longitude" | "latitude">, b: Pick<ExplorationPoint, "longitude" | "latitude">) {
  const latitudeDelta = radians(b.latitude - a.latitude);
  const longitudeDelta = radians(b.longitude - a.longitude);
  const latitudeA = radians(a.latitude);
  const latitudeB = radians(b.latitude);
  const haversine = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(latitudeA) * Math.cos(latitudeB) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(haversine)));
}

function destination(point: ExplorationPoint, bearingDegrees: number, distance: number): [number, number] {
  const angularDistance = distance / EARTH_RADIUS_KM;
  const bearing = radians(bearingDegrees);
  const latitude = radians(point.latitude);
  const longitude = radians(point.longitude);
  const nextLatitude = Math.asin(
    Math.sin(latitude) * Math.cos(angularDistance)
      + Math.cos(latitude) * Math.sin(angularDistance) * Math.cos(bearing),
  );
  const nextLongitude = longitude + Math.atan2(
    Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(latitude),
    Math.cos(angularDistance) - Math.sin(latitude) * Math.sin(nextLatitude),
  );
  return [degrees(nextLongitude), degrees(nextLatitude)];
}

function footprintCoordinates(point: ExplorationPoint, radiusKm: number, steps: number): Polygon {
  const ring = Array.from({ length: steps }, (_, index) => destination(point, index * 360 / steps, radiusKm));
  ring.push(ring[0]);
  return [ring];
}

function initialBearing(a: ExplorationPoint, b: ExplorationPoint) {
  const latitudeA = radians(a.latitude);
  const latitudeB = radians(b.latitude);
  const longitudeDelta = radians(b.longitude - a.longitude);
  return (degrees(Math.atan2(
    Math.sin(longitudeDelta) * Math.cos(latitudeB),
    Math.cos(latitudeA) * Math.sin(latitudeB)
      - Math.sin(latitudeA) * Math.cos(latitudeB) * Math.cos(longitudeDelta),
  )) + 360) % 360;
}

function capsuleCoordinates(a: ExplorationPoint, b: ExplorationPoint, radiusKm: number, steps: number): Polygon {
  const bearing = initialBearing(a, b);
  const halfSteps = Math.max(6, Math.round(steps / 2));
  const ring: Pair[] = [];
  for (let index = 0; index <= halfSteps; index += 1) {
    ring.push(destination(b, bearing - 90 + index * 180 / halfSteps, radiusKm));
  }
  for (let index = 0; index <= halfSteps; index += 1) {
    ring.push(destination(a, bearing + 90 + index * 180 / halfSteps, radiusKm));
  }
  ring.push(ring[0]);
  return [ring];
}

type Edge = { a: number; b: number; distance: number };

function boundedMinimumSpanningLinks(points: ExplorationPoint[], maxLinkKm: number) {
  const edges: Edge[] = [];
  for (let a = 0; a < points.length; a += 1) {
    for (let b = a + 1; b < points.length; b += 1) {
      const distance = distanceKm(points[a], points[b]);
      if (distance <= maxLinkKm) edges.push({ a, b, distance });
    }
  }
  edges.sort((left, right) => left.distance - right.distance || left.a - right.a || left.b - right.b);
  const parent = points.map((_, index) => index);
  const find = (value: number): number => {
    if (parent[value] !== value) parent[value] = find(parent[value]);
    return parent[value];
  };
  const links: Edge[] = [];
  edges.forEach((edge) => {
    const rootA = find(edge.a);
    const rootB = find(edge.b);
    if (rootA === rootB) return;
    parent[rootA] = rootB;
    links.push(edge);
  });
  return links;
}

/**
 * Builds a display-only estimate of explored territory. Each visit gets a local
 * footprint, and a minimum spanning forest joins nearby visits. The hard link
 * limit prevents distant visits from claiming the unvisited country between them.
 */
export function buildExplorationCoverage(
  input: readonly ExplorationPoint[],
  options: ExplorationGeometryOptions = {},
): GeoJSON.FeatureCollection<GeoJSON.Polygon | GeoJSON.MultiPolygon, CoverageProperties> {
  const radiusKm = Math.max(0.1, options.footprintRadiusKm ?? DEFAULT_FOOTPRINT_RADIUS_KM);
  const maxLinkKm = Math.max(0, options.maxLinkKm ?? DEFAULT_MAX_LINK_KM);
  const circleSteps = Math.max(12, Math.round(options.circleSteps ?? DEFAULT_CIRCLE_STEPS));
  const validPoints = input.filter((point) => (
    point.id.length > 0
    && Number.isFinite(point.longitude)
    && Number.isFinite(point.latitude)
    && point.latitude >= -90
    && point.latitude <= 90
    && point.longitude >= -180
    && point.longitude <= 180
  ));
  const seenIds = new Set<string>();
  const seenCoordinates = new Set<string>();
  const points = validPoints.filter((point) => {
    const coordinateKey = `${point.longitude.toFixed(7)},${point.latitude.toFixed(7)}`;
    if (seenIds.has(point.id) || seenCoordinates.has(coordinateKey)) return false;
    seenIds.add(point.id);
    seenCoordinates.add(coordinateKey);
    return true;
  });
  if (!points.length) return { type: "FeatureCollection", features: [] };
  const polygons: Polygon[] = points.map((point) => footprintCoordinates(point, radiusKm, circleSteps));
  boundedMinimumSpanningLinks(points, maxLinkKm).forEach((edge) => {
    polygons.push(capsuleCoordinates(points[edge.a], points[edge.b], radiusKm, circleSteps));
  });
  let coverage: MultiPolygon = polygonClipping.union(polygons[0], ...polygons.slice(1));
  const gapRadiusKm = Math.max(0, options.gapRadiusKm ?? DEFAULT_GAP_RADIUS_KM);
  const nearbyGapPolygons = gapRadiusKm === 0 ? [] : (options.gapPoints ?? [])
    .filter((gap) => Number.isFinite(gap.longitude) && Number.isFinite(gap.latitude))
    .filter((gap) => points.some((visitedPoint) => distanceKm(gap, visitedPoint) <= maxLinkKm + radiusKm))
    .map((gap) => footprintCoordinates(gap, gapRadiusKm, circleSteps));
  if (nearbyGapPolygons.length) {
    coverage = polygonClipping.difference(coverage, ...nearbyGapPolygons);
  }
  if (!coverage.length) return { type: "FeatureCollection", features: [] };
  const geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon = coverage.length === 1
    ? { type: "Polygon", coordinates: coverage[0] }
    : { type: "MultiPolygon", coordinates: coverage };
  return {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      properties: { kind: "estimated-exploration", visitedCount: points.length },
      geometry,
    }],
  };
}

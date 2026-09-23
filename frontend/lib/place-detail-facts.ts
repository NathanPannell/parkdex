import catalogue from "./place-areas.catalogue.json";
import type { Place } from "./places";

/**
 * `place-areas.catalogue.json` contains square-kilometre areas derived from
 * the canonical WGS84 polygons in `data/boundaries.geojson`. The calculation
 * uses the spherical geodesic ring-area integral
 *   R² / 2 * |Σ Δlongitude * (2 + sin(latitude₁) + sin(latitude₂))|
 * with the IUGG mean Earth radius (6,371,008.8 m), subtracts interior rings,
 * and sums disjoint polygon parts. Values are rounded to 0.000001 km² in the
 * static catalogue; the UI rounds them to a few meaningful digits.
 *
 * These are approximate mapped-footprint areas, not official acreage or an
 * access measure. The boundary source is heterogeneous and compacted to a
 * 0.00004 degree tolerance where valid; spherical versus WGS84 ellipsoid area
 * differs by at most about 0.36% across the current 198 features.
 */
const placeAreas = catalogue as Record<string, number>;
const EARTH_MEAN_RADIUS_METERS = 6_371_008.8;

/**
 * Returns a short, stable origin label for the place detail summary.
 * For regional parks this combines the serving district with a familiar
 * locality. The ACRD Mount Arrowsmith record is explicitly identified in the
 * catalogue because its mapped geometry and source are shared with the RDN.
 */
export function shortOriginForPlace(place: Pick<Place, "id" | "category" | "region" | "sourceName">): string | null {
  if (place.category === "national") return "Parks Canada";
  if (place.category === "provincial") return "BC Parks";
  if (place.category === "island") return "BC Geographical Names";

  if (place.id === "regional-mount-arrowsmith-regional-park-acrd") return "Alberni-Clayoquot";
  if (place.sourceName.includes("Capital Regional District")) return "Capital Region";
  if (place.sourceName.includes("Regional District of Nanaimo")) return "Nanaimo";
  if (place.sourceName.includes("Alberni-Clayoquot Regional District")) return "Alberni-Clayoquot";
  if (place.sourceName.includes("Cowichan Valley Regional District")) return "Cowichan Valley";
  if (place.sourceName.includes("Regional District of Mount Waddington")) return "Mount Waddington";

  const region = place.region.trim();
  return region || null;
}

type Position = readonly [number, number, ...number[]];
type LinearRing = readonly Position[];
type PolygonCoordinates = readonly LinearRing[];

function isValidPosition(position: readonly number[]): position is Position {
  return position.length >= 2
    && Number.isFinite(position[0])
    && Number.isFinite(position[1])
    && position[0] >= -180
    && position[0] <= 180
    && position[1] >= -90
    && position[1] <= 90;
}

function normalizedLongitudeDelta(deltaDegrees: number): number {
  let delta = deltaDegrees;
  while (delta > 180) delta -= 360;
  while (delta < -180) delta += 360;
  return delta;
}

function sphericalRingAreaKm2(ring: LinearRing): number | null {
  if (ring.length < 3 || !ring.every(isValidPosition)) return null;

  let sum = 0;
  for (let index = 0; index < ring.length; index += 1) {
    const current = ring[index];
    const next = ring[(index + 1) % ring.length];
    const longitudeDelta = normalizedLongitudeDelta(next[0] - current[0]) * Math.PI / 180;
    const currentLatitude = current[1] * Math.PI / 180;
    const nextLatitude = next[1] * Math.PI / 180;
    sum += longitudeDelta * (2 + Math.sin(currentLatitude) + Math.sin(nextLatitude));
  }

  return Math.abs(sum) * EARTH_MEAN_RADIUS_METERS ** 2 / 2 / 1_000_000;
}

function sphericalPolygonAreaKm2(polygon: PolygonCoordinates): number | null {
  if (!polygon.length) return null;
  const outerArea = sphericalRingAreaKm2(polygon[0]);
  if (outerArea === null || outerArea <= 0) return null;

  let holeArea = 0;
  for (const hole of polygon.slice(1)) {
    const area = sphericalRingAreaKm2(hole);
    if (area === null) return null;
    holeArea += area;
  }

  if (holeArea > outerArea) return null;
  return outerArea - holeArea;
}

/**
 * Calculate spherical geodesic area for a WGS84 GeoJSON polygon geometry.
 * This matches the method used for the precomputed catalogue and makes it
 * auditable in tests.
 */
export function calculateSphericalGeodesicAreaKm2(
  geometry: { type: "Polygon"; coordinates: PolygonCoordinates }
    | { type: "MultiPolygon"; coordinates: readonly PolygonCoordinates[] },
): number | null {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  let total = 0;
  for (const polygon of polygons) {
    const area = sphericalPolygonAreaKm2(polygon);
    if (area === null) return null;
    total += area;
  }
  return Number.isFinite(total) && total > 0 ? total : null;
}

/** Returns a compact approximate area from the reviewed boundary catalogue. */
export function formatPlaceArea(placeId: string): string | null {
  if (!Object.hasOwn(placeAreas, placeId)) return null;
  const areaKm2 = placeAreas[placeId];
  if (!Number.isFinite(areaKm2) || areaKm2 <= 0) return null;
  if (areaKm2 < 0.005) return "Approx. <0.01 km²";

  const fractionDigits = areaKm2 < 10 ? 2 : areaKm2 < 100 ? 1 : 0;
  const formatted = new Intl.NumberFormat("en-CA", {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(areaKm2);
  return `Approx. ${formatted} km²`;
}

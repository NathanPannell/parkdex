import { interiorPoint, type MultiPolygon, type Position } from "./osmParks.js";

/** West, south, east, north in degrees. */
export type ProvinceBox = readonly [west: number, south: number, east: number, north: number];

/**
 * The provinces Parkdex supports, in the same order and with the same boxes as
 * CONTENT_AREAS in src/lib/content/contracts.ts. src/lib/content/provinces.test.ts keeps
 * the two lists equal. British Columbia comes first: it is the default.
 */
export const PROVINCES: readonly { name: string; box: ProvinceBox }[] = [
  { name: "British Columbia", box: [-139.1, 48.2, -114.0, 60.0] },
  { name: "Nova Scotia", box: [-66.5, 43.3, -59.6, 47.1] },
];

/**
 * The province whose box holds the point, else the one whose box is closest. Every
 * place belongs to exactly one, so two points can always be compared.
 */
export function provinceFor([lng, lat]: Position): string {
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return PROVINCES[0].name;
  let best = PROVINCES[0].name;
  let bestKm = Infinity;
  for (const { name, box: [west, south, east, north] } of PROVINCES) {
    const nearLng = Math.min(east, Math.max(west, lng));
    const nearLat = Math.min(north, Math.max(south, lat));
    const kx = 111.32 * Math.cos((((lat + nearLat) / 2) * Math.PI) / 180);
    const km = Math.hypot((lng - nearLng) * kx, (lat - nearLat) * 110.54);
    if (km < bestKm) [best, bestKm] = [name, km];
  }
  return best;
}

/** The province of a park outline, judged from a point inside it rather than the pin beside it. */
export function provinceOfOutline(outline: MultiPolygon): string {
  return provinceFor(interiorPoint(outline));
}

import { distanceKm, type LngLat } from "./geo";

/** The "Parks near you" list only shows parks within this straight-line distance of the player. */
export const NEARBY_LIST_KM = 15;
/** How many parks the "Parks near you" list shows at most. */
export const NEARBY_LIST_SIZE = 8;

type Located = { lng: number; lat: number };

/**
 * Parks nearest `from` first, by straight-line distance, keeping at most `limit`
 * and, when `maxKm` is set, only those within that many kilometres.
 */
export function nearestParks<T extends Located>(
  parks: readonly T[],
  from: LngLat,
  { limit, maxKm = Infinity }: { limit: number; maxKm?: number },
): Array<{ p: T; km: number }> {
  return parks
    .map((p) => ({ p, km: distanceKm(from, [p.lng, p.lat]) }))
    .filter(({ km }) => km <= maxKm)
    .sort((a, b) => a.km - b.km)
    .slice(0, limit);
}

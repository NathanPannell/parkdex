import type { FeatureCollection, MultiPolygon } from "geojson";
import { useMemo } from "react";
import { distanceKm, distanceToBoundaryM, insideBoundary, type Boundary, type LngLat } from "./geo";
import type { Park } from "./parks";
import { useContent } from "./content/provider";

export type BoundaryCollection = FeatureCollection<MultiPolygon, { id: string; biome: string }>;

export function useBoundaries() {
  const snapshot = useContent();
  return useMemo(() => {
    const fc = snapshot?.boundaries;
    if (!fc) return null;
    const byId = new Map<string, Boundary>(fc.features.map((f) => [f.properties.id, f.geometry as unknown as Boundary]));
    return { fc, byId };
  }, [snapshot?.boundaries]);
}

// GPS fixes wobble by tens of metres, so a visitor standing at the edge counts
// as inside when the boundary is within their reported accuracy.
export const MAX_TOLERANCE_M = 35;

export function parkContaining(point: LngLat, parks: readonly Park[], byId?: Map<string, Boundary>, toleranceM = 0) {
  if (!byId) return null;
  const inside = parks.find((park) => insideBoundary(point, byId.get(park.id)));
  if (inside || toleranceM <= 0) return inside ?? null;
  const tol = Math.min(toleranceM, MAX_TOLERANCE_M);
  let best: { park: Park; d: number } | null = null;
  for (const park of parks) {
    if (distanceKm(point, [park.lng, park.lat]) > 60) continue;
    const boundary = byId.get(park.id);
    if (!boundary) continue;
    const distance = distanceToBoundaryM(point, boundary);
    if (distance <= tol && (!best || distance < best.d)) best = { park, d: distance };
  }
  return best?.park ?? null;
}

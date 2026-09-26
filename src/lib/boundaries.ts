import type { FeatureCollection, MultiPolygon } from "geojson";
import { useEffect, useState } from "react";
import { distanceKm, distanceToBoundaryM, insideBoundary, type Boundary, type LngLat } from "./geo";
import { PARKS } from "./parks";

export type BoundaryCollection = FeatureCollection<MultiPolygon, { id: string; biome: string }>;

let cache: Promise<BoundaryCollection> | null = null;

export function loadBoundaries() {
  cache ??= fetch("/boundaries.geojson").then((r) => r.json());
  return cache;
}

export function useBoundaries() {
  const [data, setData] = useState<{ fc: BoundaryCollection; byId: Map<string, Boundary> } | null>(null);
  useEffect(() => {
    let live = true;
    loadBoundaries().then((fc) => {
      if (!live) return;
      const byId = new Map<string, Boundary>(fc.features.map((f) => [f.properties.id, f.geometry as unknown as Boundary]));
      setData({ fc, byId });
    });
    return () => {
      live = false;
    };
  }, []);
  return data;
}

// GPS fixes wobble by tens of metres, so a visitor standing at the edge counts
// as inside when the boundary is within their reported accuracy.
export const MAX_TOLERANCE_M = 35;

export function parkContaining(point: LngLat, byId?: Map<string, Boundary>, toleranceM = 0) {
  if (!byId) return null;
  const inside = PARKS.find((p) => insideBoundary(point, byId.get(p.id)));
  if (inside || toleranceM <= 0) return inside ?? null;
  const tol = Math.min(toleranceM, MAX_TOLERANCE_M);
  let best: { park: (typeof PARKS)[number]; d: number } | null = null;
  for (const park of PARKS) {
    if (distanceKm(point, [park.lng, park.lat]) > 60) continue;
    const b = byId.get(park.id);
    if (!b) continue;
    const d = distanceToBoundaryM(point, b);
    if (d <= tol && (!best || d < best.d)) best = { park, d };
  }
  return best?.park ?? null;
}

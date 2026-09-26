import type { FeatureCollection, MultiPolygon } from "geojson";
import { useEffect, useState } from "react";
import { insideBoundary, type Boundary, type LngLat } from "./geo";
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

export function parkContaining(point: LngLat, byId?: Map<string, Boundary>) {
  if (!byId) return null;
  return PARKS.find((p) => insideBoundary(point, byId.get(p.id))) ?? null;
}

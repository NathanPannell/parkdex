"use client";

import { Trees } from "lucide-react";
import { useEffect, useState } from "react";
import type { BoundaryCollection, BoundaryFeature, BoundaryGeometry } from "@/lib/boundaries";
import { BOUNDARY_DATA_URL, parseBoundaryCollection } from "@/lib/boundaries";
import type { Place } from "@/lib/places";

export type ParkSealProps = {
  place: Place;
  visitedAt?: string;
  sealed?: boolean;
  compact?: boolean;
  className?: string;
};

type BoundaryState = "loading" | "ready" | "fallback";

let boundaryCollectionPromise: Promise<BoundaryCollection | null> | null = null;
const boundaryPathCache = new Map<string, string | null>();

function loadBoundaryCollection(): Promise<BoundaryCollection | null> {
  if (!boundaryCollectionPromise) {
    boundaryCollectionPromise = fetch(BOUNDARY_DATA_URL, { cache: "force-cache" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Boundary data returned ${response.status}`);
        return parseBoundaryCollection(await response.json());
      })
      .catch(() => null);
  }
  return boundaryCollectionPromise;
}

/** Reset the module cache in tests after a mocked boundary response. */
export function resetParkSealBoundaryCache(): void {
  boundaryCollectionPromise = null;
  boundaryPathCache.clear();
}

export function boundaryFeatureForPlace(collection: BoundaryCollection | null, placeId: string): BoundaryFeature | null {
  return collection?.features.find((feature) => feature.properties.id === placeId) ?? null;
}

type Point = [number, number];

function geometryRings(geometry: BoundaryGeometry): Point[][] {
  if (geometry.type === "Polygon") return geometry.coordinates as Point[][];
  return (geometry.coordinates as Point[][][]).flat();
}

/**
 * Convert the catalogue geometry to a compact, viewBox-sized outline.
 * The projection is intentionally local to the seal. It preserves the
 * boundary's proportions and does not pretend to be a map projection.
 */
export function boundaryGeometryToPath(geometry: BoundaryGeometry): string | null {
  const rings = geometryRings(geometry)
    .filter((ring): ring is Point[] => Array.isArray(ring))
    .map((ring) => ring.filter((point): point is Point => Array.isArray(point) && point.length >= 2 && Number.isFinite(point[0]) && Number.isFinite(point[1])))
    .filter((ring) => ring.length >= 3);
  const points = rings.flat();
  if (!points.length) return null;

  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  for (const [longitude, latitude] of points) {
    west = Math.min(west, longitude);
    east = Math.max(east, longitude);
    south = Math.min(south, latitude);
    north = Math.max(north, latitude);
  }
  if (![west, east, south, north].every(Number.isFinite)) return null;

  const midLatitudeRadians = ((south + north) / 2) * Math.PI / 180;
  const longitudeScale = Math.max(Math.cos(midLatitudeRadians), 0.01);
  const width = Math.max((east - west) * longitudeScale, Number.EPSILON);
  const height = Math.max(north - south, Number.EPSILON);
  const scale = 86 / Math.max(width, height);
  const usedWidth = width * scale;
  const usedHeight = height * scale;
  const offsetX = (100 - usedWidth) / 2;
  const offsetY = (100 - usedHeight) / 2;

  const project = ([longitude, latitude]: Point): Point => [
    offsetX + (longitude - west) * longitudeScale * scale,
    offsetY + (north - latitude) * scale,
  ];

  return rings.map((ring) => {
    const path = ring.map((point, index) => {
      const [x, y] = project(point);
      return `${index === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`;
    }).join(" ");
    return `${path} Z`;
  }).join(" ");
}

export function boundaryPathForPlace(collection: BoundaryCollection | null, placeId: string): string | null {
  if (boundaryPathCache.has(placeId)) return boundaryPathCache.get(placeId) ?? null;
  const feature = boundaryFeatureForPlace(collection, placeId);
  const path = feature ? boundaryGeometryToPath(feature.geometry) : null;
  boundaryPathCache.set(placeId, path);
  return path;
}

function visitDate(value?: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return null;
  return new Intl.DateTimeFormat("en-CA", { day: "2-digit", month: "short", year: "numeric" }).format(date).toUpperCase();
}

export function ParkSeal({ place, visitedAt, sealed = false, compact = false, className = "" }: ParkSealProps) {
  const [result, setResult] = useState<{ placeId: string; path: string | null; state: BoundaryState }>({ placeId: "", path: null, state: "loading" });
  const date = visitDate(visitedAt);
  const current = result.placeId === place.id ? result : { placeId: place.id, path: null, state: "loading" as const };
  const path = current.path;
  const state = current.state;

  useEffect(() => {
    let active = true;
    void loadBoundaryCollection().then((collection) => {
      if (!active) return;
      const nextPath = boundaryPathForPlace(collection, place.id);
      setResult({ placeId: place.id, path: nextPath, state: nextPath ? "ready" : "fallback" });
    });
    return () => { active = false; };
  }, [place.id]);

  const classes = [
    "impression-seal",
    sealed ? "impression-seal--sealed" : "",
    compact ? "impression-seal--compact" : "",
    `impression-seal--${state}`,
    className,
  ].filter(Boolean).join(" ");

  return <span className={classes} data-boundary-state={state} role="img" aria-label={path ? `${place.name} park boundary seal` : `${place.name} park seal icon`}>
    <span className="impression-seal-ring" aria-hidden="true" />
    {path ? <svg className="impression-seal-geometry" viewBox="0 0 100 100" aria-hidden="true" fill="none" fillRule="evenodd">
      <path d={path} />
    </svg> : <span className="impression-seal-fallback" aria-hidden="true"><Trees size={compact ? 18 : 26} strokeWidth={1.5} /></span>}
    <span className="impression-seal-copy" aria-hidden="true">
      <span>{sealed ? "VISITED" : "PARK"}</span>
      {date && <small>{date}</small>}
    </span>
  </span>;
}

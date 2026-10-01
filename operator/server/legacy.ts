import { HttpError } from "../../worker/validation.js";

/**
 * Read-only access to the legacy map app's public park data (map.parkdex.app). The boundary
 * file carries each park's complete geometry and source grouping; the places API carries the
 * database record. Both are public, so no legacy database credentials are needed.
 */

export const DEFAULT_LEGACY_BOUNDARY_URL = "https://map.parkdex.app/data/boundaries.v1.geojson";
export const DEFAULT_LEGACY_PLACES_URL = "https://api-production-e72df.up.railway.app/api/places";
const CACHE_MS = 10 * 60 * 1000;

type Position = [number, number];
export type MultiPolygon = { type: "MultiPolygon"; coordinates: Position[][][] };

export interface LegacySummary {
  id: string;
  name: string;
  category: string;
  region: string;
  lat: number;
  lng: number;
  source: string;
}

export interface LegacyPark extends LegacySummary {
  /** The places database row and the boundary feature properties, exactly as served. */
  record: Record<string, unknown>;
  boundaryProperties: Record<string, unknown>;
  geometry: MultiPolygon;
  geometryStats: { polygons: number; holes: number; positions: number; bbox: [number, number, number, number] };
}

export interface LegacyEnv {
  LEGACY_BOUNDARY_URL?: string;
  LEGACY_PLACES_URL?: string;
}

type Catalogue = { fetchedAt: number; parks: Map<string, LegacyPark> };

function isPosition(value: unknown): value is Position {
  return Array.isArray(value) && value.length === 2 && value.every((item) => typeof item === "number" && Number.isFinite(item)) &&
    value[0] >= -180 && value[0] <= 180 && value[1] >= -90 && value[1] <= 90;
}

function validRing(ring: unknown): ring is Position[] {
  if (!Array.isArray(ring) || ring.length < 4 || !ring.every(isPosition)) return false;
  const first = ring[0], last = ring[ring.length - 1];
  return first[0] === last[0] && first[1] === last[1];
}

/** Polygon becomes a one-part MultiPolygon. Order, rings and positions are kept exactly. */
export function normalizeGeometry(geometry: unknown, label: string): MultiPolygon {
  const value = geometry as { type?: unknown; coordinates?: unknown };
  const polygons = value?.type === "Polygon" ? [value.coordinates] : value?.type === "MultiPolygon" ? value.coordinates : null;
  if (!Array.isArray(polygons) || polygons.length === 0 || !polygons.every((polygon) => Array.isArray(polygon) && polygon.length > 0 && polygon.every(validRing))) {
    throw new HttpError(422, "invalid_geometry", `${label} has a missing or malformed boundary.`);
  }
  return { type: "MultiPolygon", coordinates: polygons as Position[][][] };
}

export function geometryStats(geometry: MultiPolygon): LegacyPark["geometryStats"] {
  let holes = 0, positions = 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const polygon of geometry.coordinates) {
    holes += polygon.length - 1;
    for (const ring of polygon) {
      positions += ring.length;
      for (const [x, y] of ring) {
        minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      }
    }
  }
  return { polygons: geometry.coordinates.length, holes, positions, bbox: [minX, minY, maxX, maxY] };
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function buildCatalogue(boundaries: unknown, places: unknown): Map<string, LegacyPark> {
  const features = (boundaries as { type?: unknown; features?: unknown })?.features;
  if ((boundaries as { type?: unknown })?.type !== "FeatureCollection" || !Array.isArray(features)) {
    throw new HttpError(502, "legacy_unavailable", "The legacy boundary file is not a FeatureCollection.");
  }
  const rows = Array.isArray(places) ? places : (places as { places?: unknown })?.places;
  if (!Array.isArray(rows)) throw new HttpError(502, "legacy_unavailable", "The legacy places catalogue has no places array.");
  const records = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    if (row && typeof row === "object" && typeof (row as { id?: unknown }).id === "string") records.set((row as { id: string }).id, row as Record<string, unknown>);
  }
  // A park can span several features; group them in source order like the legacy map does.
  const grouped = new Map<string, { properties: Record<string, unknown>; geometries: unknown[] }>();
  for (const feature of features) {
    const properties = (feature as { properties?: unknown })?.properties as Record<string, unknown> | undefined;
    const id = typeof properties?.id === "string" ? properties.id : null;
    if (!id || !properties) continue;
    const group = grouped.get(id) ?? { properties, geometries: [] as unknown[] };
    group.geometries.push((feature as { geometry?: unknown }).geometry);
    grouped.set(id, group);
  }
  const parks = new Map<string, LegacyPark>();
  for (const [id, group] of grouped) {
    const record = records.get(id);
    if (!record) continue;
    let geometry: MultiPolygon;
    try {
      geometry = { type: "MultiPolygon", coordinates: group.geometries.flatMap((item) => normalizeGeometry(item, id).coordinates) };
    } catch {
      continue;
    }
    const lat = Number(record.latitude), lng = Number(record.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    parks.set(id, {
      id,
      name: text(record.name) || text(group.properties.name),
      category: text(record.category) || text(group.properties.category),
      region: text(record.region),
      lat,
      lng,
      source: text(record.sourceName) || text(group.properties.sourceName),
      record,
      boundaryProperties: group.properties,
      geometry,
      geometryStats: geometryStats(geometry),
    });
  }
  return parks;
}

export function createLegacySource(env: LegacyEnv, fetcher: typeof fetch = fetch, now: () => number = Date.now) {
  let cache: Catalogue | null = null;
  let pending: Promise<Catalogue> | null = null;

  async function fetchJson(url: string, label: string): Promise<unknown> {
    let response: Response;
    try {
      response = await fetcher(url, { headers: { accept: "application/json, application/geo+json" } });
    } catch {
      throw new HttpError(502, "legacy_unavailable", `Could not reach the legacy ${label}.`);
    }
    if (!response.ok) throw new HttpError(502, "legacy_unavailable", `The legacy ${label} returned HTTP ${response.status}.`);
    try {
      return await response.json();
    } catch {
      throw new HttpError(502, "legacy_unavailable", `The legacy ${label} is not valid JSON.`);
    }
  }

  async function load(): Promise<Catalogue> {
    if (cache && now() - cache.fetchedAt < CACHE_MS) return cache;
    pending ??= (async () => {
      try {
        const [boundaries, places] = await Promise.all([
          fetchJson(env.LEGACY_BOUNDARY_URL || DEFAULT_LEGACY_BOUNDARY_URL, "boundary file"),
          fetchJson(env.LEGACY_PLACES_URL || DEFAULT_LEGACY_PLACES_URL, "places catalogue"),
        ]);
        cache = { fetchedAt: now(), parks: buildCatalogue(boundaries, places) };
        return cache;
      } finally {
        pending = null;
      }
    })();
    return pending;
  }

  return {
    async list(): Promise<LegacySummary[]> {
      const { parks } = await load();
      return [...parks.values()]
        .map(({ id, name, category, region, lat, lng, source }) => ({ id, name, category, region, lat, lng, source }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
    async get(id: string): Promise<LegacyPark | null> {
      return (await load()).parks.get(id) ?? null;
    },
  };
}

export type LegacySource = ReturnType<typeof createLegacySource>;

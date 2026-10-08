import { HttpError } from "./validation.js";

/**
 * Park outlines from OpenStreetMap through the Overpass API, for the "propose a park" flow.
 * Searching asks Overpass twice: once for tags and bounding boxes, which is cheap and lets us
 * skip huge protected areas, then for the full geometry of the few candidates we keep.
 * Usage policy: https://dev.overpass-api.de/overpass-doc/en/preface/commons.html
 */

/** Tried in order; a busy or slow instance hands the request to the next. */
export const DEFAULT_OVERPASS_URLS = ["https://overpass.private.coffee/api/interpreter", "https://overpass-api.de/api/interpreter"] as const;
export const OSM_USER_AGENT = "Parkdex/1.0 (+https://parkdex.app; park proposals)";
export const OSM_ATTRIBUTION = "© OpenStreetMap contributors";
const SEARCH_RADIUS_M = 250;
const MAX_CANDIDATES = 6;
const MAX_BBOX_DIAGONAL_M = 20_000;
// Two attempts must fit in the function's time with the database work around them.
const REQUEST_TIMEOUT_MS = 5_000;
const CACHE_MS = 10 * 60 * 1000;
const CACHE_ENTRIES = 200;
const MAX_CONCURRENT = 2;

const LEISURE = ["park", "nature_reserve", "garden", "common", "dog_park"] as const;
const BOUNDARY = ["protected_area", "national_park"] as const;

export type Position = [number, number];
export type MultiPolygon = { type: "MultiPolygon"; coordinates: Position[][][] };
export type OsmType = "way" | "relation";
export interface OsmRef { type: OsmType; id: number }

export interface OsmFeature extends OsmRef {
  name: string | null;
  /** The tag that made it park-like, such as leisure=park. */
  kind: string;
  tags: Record<string, string>;
  geometry: MultiPolygon;
  areaM2: number;
}

export interface OsmCandidate extends OsmFeature {
  containsPin: boolean;
  distanceM: number;
}

/** Tags worth keeping for the operator and the moderation model. Everything else is dropped. */
const KEPT_TAGS = ["name", "leisure", "boundary", "protect_class", "protection_title", "access", "operator", "owner", "designation", "website", "wikidata", "garden:type", "landuse", "natural"];

// ---------------------------------------------------------------- geometry

const M_PER_DEG_LAT = 110_540;
const mPerDegLng = (lat: number) => 111_320 * Math.cos((lat * Math.PI) / 180);

function round7(value: number): number {
  return Math.round(value * 1e7) / 1e7;
}

function samePosition(a: Position, b: Position): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

/** Shoelace area in square metres on a local flat projection, fine at park scale. */
export function ringArea(ring: Position[]): number {
  if (ring.length < 4) return 0;
  const lat0 = ring[0][1];
  const kx = mPerDegLng(lat0);
  let sum = 0;
  for (let index = 0; index < ring.length - 1; index += 1) {
    const [x1, y1] = ring[index], [x2, y2] = ring[index + 1];
    sum += (x1 * kx) * (y2 * M_PER_DEG_LAT) - (x2 * kx) * (y1 * M_PER_DEG_LAT);
  }
  return Math.abs(sum) / 2;
}

export function multiPolygonArea(geometry: MultiPolygon): number {
  let area = 0;
  for (const [outer, ...holes] of geometry.coordinates) {
    area += ringArea(outer) - holes.reduce((total, hole) => total + ringArea(hole), 0);
  }
  return Math.max(0, area);
}

export function pointInRing(point: Position, ring: Position[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > point[1]) !== (yj > point[1]) && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** True when the point is inside an outer ring and outside that polygon's holes. */
export function pointInMultiPolygon(point: Position, geometry: MultiPolygon): boolean {
  return geometry.coordinates.some(([outer, ...holes]) => pointInRing(point, outer) && !holes.some((hole) => pointInRing(point, hole)));
}

function segmentDistanceM(point: Position, a: Position, b: Position): number {
  const kx = mPerDegLng(point[1]);
  const px = point[0] * kx, py = point[1] * M_PER_DEG_LAT;
  const ax = a[0] * kx, ay = a[1] * M_PER_DEG_LAT, bx = b[0] * kx, by = b[1] * M_PER_DEG_LAT;
  const dx = bx - ax, dy = by - ay;
  const length = dx * dx + dy * dy;
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Metres from the point to the nearest edge, or 0 when the point is inside. */
export function distanceToMultiPolygon(point: Position, geometry: MultiPolygon): number {
  if (pointInMultiPolygon(point, geometry)) return 0;
  let best = Infinity;
  for (const polygon of geometry.coordinates) {
    for (const ring of polygon) {
      for (let index = 0; index < ring.length - 1; index += 1) best = Math.min(best, segmentDistanceM(point, ring[index], ring[index + 1]));
    }
  }
  return best;
}

/** A point guaranteed to sit inside the first polygon: its centroid when inside, else a vertex midpoint scan. */
export function interiorPoint(geometry: MultiPolygon): Position {
  const [outer] = geometry.coordinates[0];
  const centroid: Position = [
    outer.slice(0, -1).reduce((sum, p) => sum + p[0], 0) / (outer.length - 1),
    outer.slice(0, -1).reduce((sum, p) => sum + p[1], 0) / (outer.length - 1),
  ];
  if (pointInMultiPolygon(centroid, geometry)) return centroid;
  // Concave shapes: try midpoints between vertex pairs until one lands inside.
  for (let i = 0; i < outer.length - 1; i += 1) {
    for (let j = i + 2; j < outer.length - 1; j += Math.max(1, Math.floor(outer.length / 12))) {
      const candidate: Position = [(outer[i][0] + outer[j][0]) / 2, (outer[i][1] + outer[j][1]) / 2];
      if (pointInMultiPolygon(candidate, geometry)) return candidate;
    }
  }
  return outer[0];
}

function simplifyRing(ring: Position[], toleranceM: number): Position[] {
  if (ring.length <= 5 || toleranceM <= 0) return ring;
  const keep = new Uint8Array(ring.length);
  keep[0] = keep[ring.length - 1] = 1;
  const stack: [number, number][] = [[0, ring.length - 1]];
  while (stack.length) {
    const [start, end] = stack.pop()!;
    let index = -1, farthest = 0;
    for (let i = start + 1; i < end; i += 1) {
      const distance = segmentDistanceM(ring[i], ring[start], ring[end]);
      if (distance > farthest) { farthest = distance; index = i; }
    }
    if (index !== -1 && farthest > toleranceM) {
      keep[index] = 1;
      stack.push([start, index], [index, end]);
    }
  }
  // The first split of a closed ring measures from its start point, which keeps the farthest vertex.
  const simplified = ring.filter((_, i) => keep[i]);
  return simplified.length >= 4 ? simplified : ring;
}

/** Thins every ring but never drops a polygon or a hole. */
export function simplifyMultiPolygon(geometry: MultiPolygon, toleranceM: number): MultiPolygon {
  return { type: "MultiPolygon", coordinates: geometry.coordinates.map((polygon) => polygon.map((ring) => simplifyRing(ring, toleranceM))) };
}

export function positionCount(geometry: MultiPolygon): number {
  return geometry.coordinates.reduce((total, polygon) => total + polygon.reduce((sum, ring) => sum + ring.length, 0), 0);
}

// ---------------------------------------------------------------- assembling Overpass elements

type OverpassPoint = { lat: number; lon: number };
type OverpassMember = { type: string; ref: number; role?: string; geometry?: (OverpassPoint | null)[] };
type OverpassElement = {
  type: string;
  id: number;
  tags?: Record<string, string>;
  bounds?: { minlat: number; minlon: number; maxlat: number; maxlon: number };
  geometry?: (OverpassPoint | null)[];
  members?: OverpassMember[];
};

function line(points: (OverpassPoint | null)[] | undefined): Position[] | null {
  if (!Array.isArray(points) || points.length < 2) return null;
  const positions: Position[] = [];
  for (const point of points) {
    // Overpass writes null for nodes outside a clipped area; a gap means the line is unusable.
    if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lon)) return null;
    positions.push([round7(point.lon), round7(point.lat)]);
  }
  return positions;
}

/** Joins way segments end to end into closed rings. Segments that never close are dropped. */
export function assembleRings(segments: Position[][]): Position[][] {
  const open = segments.filter((segment) => segment.length >= 2).map((segment) => [...segment]);
  const rings: Position[][] = [];
  while (open.length) {
    let ring = open.shift()!;
    let extended = true;
    while (!samePosition(ring[0], ring[ring.length - 1]) && extended) {
      extended = false;
      const tail = ring[ring.length - 1];
      for (let index = 0; index < open.length; index += 1) {
        const next = open[index];
        if (samePosition(next[0], tail)) ring = [...ring, ...next.slice(1)];
        else if (samePosition(next[next.length - 1], tail)) ring = [...ring, ...[...next].reverse().slice(1)];
        else continue;
        open.splice(index, 1);
        extended = true;
        break;
      }
    }
    if (ring.length >= 4 && samePosition(ring[0], ring[ring.length - 1])) rings.push(ring);
  }
  return rings;
}

/** Builds a MultiPolygon from an Overpass way or multipolygon relation with full geometry. */
export function elementGeometry(element: OverpassElement): MultiPolygon | null {
  if (element.type === "way") {
    const ring = line(element.geometry);
    if (!ring || ring.length < 4 || !samePosition(ring[0], ring[ring.length - 1])) return null;
    return { type: "MultiPolygon", coordinates: [[ring]] };
  }
  if (element.type !== "relation" || !Array.isArray(element.members)) return null;
  const outers: Position[][] = [], inners: Position[][] = [];
  for (const member of element.members) {
    if (member.type !== "way") continue;
    const segment = line(member.geometry);
    if (!segment) continue;
    // An empty role is an outer ring in old multipolygons.
    (member.role === "inner" ? inners : outers).push(segment);
  }
  const outerRings = assembleRings(outers);
  if (!outerRings.length) return null;
  const polygons: Position[][][] = outerRings
    .sort((a, b) => ringArea(b) - ringArea(a))
    .map((ring) => [ring]);
  for (const hole of assembleRings(inners)) {
    // A hole belongs to the smallest outer ring that contains it.
    const owner = [...polygons].reverse().find(([outer]) => pointInRing(hole[0], outer) || pointInRing(hole[Math.floor(hole.length / 2)], outer));
    owner?.push(hole);
  }
  return { type: "MultiPolygon", coordinates: polygons };
}

function parkKind(tags: Record<string, string>): string | null {
  if ((LEISURE as readonly string[]).includes(tags.leisure)) return `leisure=${tags.leisure}`;
  if ((BOUNDARY as readonly string[]).includes(tags.boundary)) return `boundary=${tags.boundary}`;
  return null;
}

function publicPlace(tags: Record<string, string>): boolean {
  if (["private", "no"].includes(tags.access ?? "")) return false;
  if (tags.leisure === "garden" && ["residential", "private"].includes(tags["garden:type"] ?? "")) return false;
  return true;
}

function keptTags(tags: Record<string, string>): Record<string, string> {
  return Object.fromEntries(KEPT_TAGS.filter((key) => typeof tags[key] === "string").map((key) => [key, tags[key].slice(0, 200)]));
}

function featureFrom(element: OverpassElement, toleranceM: number): OsmFeature | null {
  const tags = element.tags ?? {};
  const kind = parkKind(tags);
  if (!kind || (element.type !== "way" && element.type !== "relation") || !Number.isSafeInteger(element.id) || element.id <= 0) return null;
  const raw = elementGeometry(element);
  if (!raw) return null;
  const geometry = simplifyMultiPolygon(raw, toleranceM);
  const name = typeof tags.name === "string" && tags.name.trim() ? tags.name.trim().slice(0, 140) : null;
  return { type: element.type, id: element.id, name, kind, tags: keptTags(tags), geometry, areaM2: Math.round(multiPolygonArea(raw)) };
}

// ---------------------------------------------------------------- Overpass client

function overpassFilters(selector: string): string {
  return [
    `way${selector}[leisure~"^(${LEISURE.join("|")})$"];`,
    `relation${selector}[leisure~"^(${LEISURE.join("|")})$"];`,
    `way${selector}[boundary~"^(${BOUNDARY.join("|")})$"];`,
    `relation${selector}[boundary~"^(${BOUNDARY.join("|")})$"];`,
  ].join("\n  ");
}

/** Park-like areas the pin is inside, plus those within a short walk of it. */
export function searchQuery(lat: number, lng: number): string {
  return `[out:json][timeout:10];
is_in(${lat},${lng})->.inside;
(
  ${overpassFilters("(pivot.inside)")}
  ${overpassFilters(`(around:${SEARCH_RADIUS_M},${lat},${lng})`)}
);
out tags bb qt;`;
}

export function geometryQuery(refs: OsmRef[]): string {
  const ways = refs.filter((ref) => ref.type === "way").map((ref) => ref.id);
  const relations = refs.filter((ref) => ref.type === "relation").map((ref) => ref.id);
  const parts = [ways.length ? `way(id:${ways.join(",")});` : "", relations.length ? `relation(id:${relations.join(",")});` : ""].filter(Boolean);
  return `[out:json][timeout:15];
(
  ${parts.join("\n  ")}
);
out geom qt;`;
}

export interface OverpassEnv {
  /** Comma-separated endpoints, tried in order. */
  OVERPASS_URLS?: string;
  /** A single endpoint, kept for older configuration. OVERPASS_URLS wins when both are set. */
  OVERPASS_URL?: string;
}

/** The configured Overpass endpoints: OVERPASS_URLS, else OVERPASS_URL, else the defaults. Only https URLs count. */
export function overpassEndpoints(env: OverpassEnv): string[] {
  const configured = (env.OVERPASS_URLS ?? env.OVERPASS_URL ?? "").split(",").map((value) => value.trim()).filter((value) => {
    try {
      return new URL(value).protocol === "https:";
    } catch {
      return false;
    }
  });
  return configured.length ? [...new Set(configured)] : [...DEFAULT_OVERPASS_URLS];
}

/** Worth trying the next endpoint: timeouts, network errors, 429, 5xx, unreadable answers and Overpass runtime errors. */
class OverpassAttemptError extends Error {}

export interface OsmClient {
  search(lat: number, lng: number): Promise<OsmCandidate[]>;
  feature(ref: OsmRef): Promise<OsmFeature | null>;
}

function bboxDiagonalM(bounds: NonNullable<OverpassElement["bounds"]>): number {
  const midLat = (bounds.minlat + bounds.maxlat) / 2;
  return Math.hypot((bounds.maxlon - bounds.minlon) * mPerDegLng(midLat), (bounds.maxlat - bounds.minlat) * M_PER_DEG_LAT);
}

function bboxDistanceM(bounds: NonNullable<OverpassElement["bounds"]>, lat: number, lng: number): number {
  const dx = lng < bounds.minlon ? bounds.minlon - lng : lng > bounds.maxlon ? lng - bounds.maxlon : 0;
  const dy = lat < bounds.minlat ? bounds.minlat - lat : lat > bounds.maxlat ? lat - bounds.maxlat : 0;
  return Math.hypot(dx * mPerDegLng(lat), dy * M_PER_DEG_LAT);
}

/** Overpass client with a short in-memory cache and at most two requests in flight per instance. */
export function createOsmClient(env: OverpassEnv = {}, fetcher: typeof fetch = fetch, options: { now?: () => number; timeoutMs?: number } = {}): OsmClient {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const endpoints = overpassEndpoints(env);
  const cache = new Map<string, { at: number; value: OverpassElement[] }>();
  let active = 0;
  const waiting: (() => void)[] = [];

  async function slot<T>(work: () => Promise<T>): Promise<T> {
    if (active >= MAX_CONCURRENT) await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await work();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  }

  function attempt(endpoint: string, query: string): Promise<OverpassElement[]> {
    return slot(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        let response: Response;
        try {
          response = await fetcher(endpoint, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", "user-agent": OSM_USER_AGENT },
            body: `data=${encodeURIComponent(query)}`,
            signal: controller.signal,
          });
        } catch {
          throw new OverpassAttemptError(controller.signal.aborted ? "timeout" : "network");
        }
        if (response.status === 429 || response.status >= 500) throw new OverpassAttemptError(`http ${response.status}`);
        if (!response.ok) throw new HttpError(503, "osm_unavailable", "OpenStreetMap could not answer that search.");
        let body: { elements?: unknown; remark?: unknown };
        try {
          body = await response.json() as typeof body;
        } catch {
          // Also covers a body cut off by the timeout.
          throw new OverpassAttemptError("unreadable");
        }
        // Overpass reports its own timeouts as a remark on an otherwise successful response.
        if (typeof body.remark === "string" && /runtime error|timed out|out of memory/i.test(body.remark)) throw new OverpassAttemptError("remark");
        return Array.isArray(body.elements) ? body.elements as OverpassElement[] : [];
      } finally {
        clearTimeout(timer);
      }
    });
  }

  /** Runs the query on the first endpoint that answers, starting with `first`, and reports which one did. */
  async function run(query: string, first = endpoints[0]): Promise<{ elements: OverpassElement[]; endpoint: string }> {
    const hit = cache.get(query);
    if (hit && now() - hit.at < CACHE_MS) return { elements: hit.value, endpoint: first };
    const order = [first, ...endpoints.filter((endpoint) => endpoint !== first)];
    for (const endpoint of order) {
      try {
        const elements = await attempt(endpoint, query);
        if (cache.size >= CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
        cache.set(query, { at: now(), value: elements });
        return { elements, endpoint };
      } catch (error) {
        if (!(error instanceof OverpassAttemptError)) throw error;
      }
    }
    throw new HttpError(503, "osm_unavailable", "OpenStreetMap is busy right now. Try again in a minute.");
  }

  return {
    async search(lat, lng) {
      // About 10 m of rounding lets nearby retries share the cache.
      const rlat = Math.round(lat * 1e4) / 1e4, rlng = Math.round(lng * 1e4) / 1e4;
      const found = await run(searchQuery(rlat, rlng));
      const summaries = found.elements
        .filter((element) => (element.type === "way" || element.type === "relation") && element.bounds && parkKind(element.tags ?? {}) && publicPlace(element.tags ?? {}))
        .filter((element) => bboxDiagonalM(element.bounds!) <= MAX_BBOX_DIAGONAL_M);
      const unique = [...new Map(summaries.map((element) => [`${element.type}/${element.id}`, element])).values()]
        .sort((a, b) => bboxDistanceM(a.bounds!, rlat, rlng) - bboxDistanceM(b.bounds!, rlat, rlng) || bboxDiagonalM(a.bounds!) - bboxDiagonalM(b.bounds!))
        .slice(0, MAX_CANDIDATES);
      if (!unique.length) return [];
      const pin: Position = [lng, lat];
      // The instance that answered the search has the same data, so ask it for the geometry first.
      const detailed = await run(geometryQuery(unique.map((element) => ({ type: element.type as OsmType, id: element.id }))), found.endpoint);
      return detailed.elements
        .map((element) => featureFrom(element, 3))
        .filter((feature): feature is OsmFeature => feature !== null)
        .map((feature) => ({ ...feature, containsPin: pointInMultiPolygon(pin, feature.geometry), distanceM: Math.round(distanceToMultiPolygon(pin, feature.geometry)) }))
        // Inside first, then nearest, then the smaller (more specific) place.
        .sort((a, b) => Number(b.containsPin) - Number(a.containsPin) || a.distanceM - b.distanceM || a.areaM2 - b.areaM2);
    },
    async feature(ref) {
      const [element] = (await run(geometryQuery([ref]))).elements.filter((item) => item.type === ref.type && item.id === ref.id);
      // About 1 m keeps the boundary faithful for check-ins while trimming redundant nodes.
      return element ? featureFrom(element, 1) : null;
    },
  };
}

// ---------------------------------------------------------------- route

export interface OsmRouteHandlers {
  json(data: unknown, status?: number): Response;
  /** Resolves false when this client asked too often. */
  allow(): Promise<boolean>;
  osm(): OsmClient;
}

function coordinateParam(value: string | null, min: number, max: number): number {
  const number = value === null || value.trim() === "" ? NaN : Number(value);
  if (!Number.isFinite(number) || number < min || number > max) throw new HttpError(400, "invalid_location", "Send the pin's lat and lng.");
  return Math.round(number * 1e6) / 1e6;
}

/** `GET /api/osm/parks?lat=&lng=`: park outlines near a pin. Null for other paths. */
export async function handleOsmParksRequest(request: Request, handlers: OsmRouteHandlers): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/api/osm/parks") return null;
  if (request.method !== "GET") throw new HttpError(405, "method_not_allowed", "Use GET.");
  const lat = coordinateParam(url.searchParams.get("lat"), -90, 90);
  const lng = coordinateParam(url.searchParams.get("lng"), -180, 180);
  if (!await handlers.allow()) throw new HttpError(429, "rate_limited_osm", "Too many map searches. Wait a few minutes and try again.");
  const candidates = await handlers.osm().search(lat, lng);
  return handlers.json({
    attribution: OSM_ATTRIBUTION,
    parks: candidates.map(({ type, id, name, kind, areaM2, containsPin, distanceM, geometry }) => ({ type, id, name, kind, areaM2, containsPin, distanceM, geometry })),
  });
}

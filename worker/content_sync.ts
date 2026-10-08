import { database } from "./db.js";
import { createAnalyticsSink, withRequestAnalytics, type AnalyticsSink } from "./analyticsSink.js";
import { REQUEST_CONTEXT_HEADERS } from "./requestContext.js";

export const CONTENT_SYNC_SCHEMA = "parkdex.content-sync/v1" as const;
const CDN_ORIGIN = "https://kip-assets.parkdex.app";
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const SCENE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PARK_ID = /^[a-z0-9][a-z0-9-]*$/;
const SCENE_ASSET_ID = /^art\/badges\/scenes\/[a-z0-9]+(?:-[a-z0-9]+)*\.webp$/;
const PARK_FIELDS = [
  "id", "name", "short", "category", "region", "lat", "lng", "biome", "shape", "rarity", "scene", "seed", "blurb",
] as const;
const CATEGORIES = new Set(["national", "provincial", "regional", "municipal", "community"]);
const BIOMES = new Set(["coast", "forest", "mountain", "lake", "waterfall", "river", "cave", "marsh", "heritage"]);
const SHAPES = new Set(["circle", "hex", "shield", "arch", "seal"]);
const RARITIES = new Set(["common", "uncommon", "rare", "epic", "legendary"]);
// Builds installed before 2026-10-01 reject unknown park fields, so optional
// fields go only to clients that send at least this reader version.
const MAPS_LINK_READER = 2;
const ACCESS_FIELDS = ["googleMapsUrl", "trailheadLat", "trailheadLng"] as const;
// Matches content_parks_google_maps_url_check in content_003_park_maps_link.sql.
export const GOOGLE_MAPS_URL = /^https:\/\/(?:(?:www\.)?google\.[a-z]{2,3}(?:\.[a-z]{2})?\/maps(?:[/?#]\S*)?|maps\.google\.[a-z]{2,3}(?:\.[a-z]{2})?(?:[/?#]\S*)?|maps\.app\.goo\.gl\/\S+|goo\.gl\/maps\/\S+)$/;

type JsonRecord = Record<string, unknown>;
type RequestLike = {
  method?: string;
  query?: Record<string, string | string[] | undefined>;
  headers: Record<string, string | string[] | undefined> & { get?: (name: string) => string | null };
};
type ResponseLike = {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(body?: string): void;
};
type Park = {
  id: string; name: string; short: string; category: string; region: string;
  lat: number; lng: number; biome: string; shape: string; rarity: string;
  scene: string | null; seed: number; blurb: string;
  googleMapsUrl?: string | null;
  trailheadLat?: number | null;
  trailheadLng?: number | null;
};
type ContentFile = {
  path: string; key: string; url: string; sha256: string; byte_size: number; content_type: string;
};
type DriveEntry = { drive: ([number, number] | null)[]; walkM: number };
type MapPointer = { version: string; manifestUrl: string; manifestSha256: string };
type SyncRepository = {
  snapshot(): Promise<unknown>;
  changes(after: number, limit: number): Promise<unknown>;
  scene(releaseId: string, scene: string): Promise<unknown | null>;
};
type HandlerOptions = {
  env?: Record<string, string | undefined>;
  repository?: SyncRepository;
  /** Keeps the function alive for the analytics write after the response (Vercel waitUntil). */
  waitUntil?: (promise: Promise<unknown>) => void;
  analytics?: () => AnalyticsSink | null;
};
type NodeHandler = (request: RequestLike, response: ResponseLike) => Promise<void>;

declare const process: { env: Record<string, string | undefined> };

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly body?: JsonRecord) {
    super(message);
  }
}

function header(request: RequestLike, name: string): string | undefined {
  const fromGetter = request.headers.get?.(name);
  if (fromGetter !== null && fromGetter !== undefined) return fromGetter;
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function allowedOrigins(env: Record<string, string | undefined>): Set<string> {
  const allowed = new Set([
    "https://localhost",
    "http://localhost:5190",
    "http://127.0.0.1:5190",
    "https://staging.web.parkdex.app",
    "https://web.parkdex.app",
  ]);
  const vercelUrl = env.VERCEL_URL?.trim();
  if (vercelUrl && /^[A-Za-z0-9.-]+$/.test(vercelUrl)) allowed.add(`https://${vercelUrl}`);
  return allowed;
}

function setCors(request: RequestLike, response: ResponseLike, env: Record<string, string | undefined>) {
  response.setHeader("Vary", "Origin");
  response.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", ["Accept", ...REQUEST_CONTEXT_HEADERS].join(", "));
  response.setHeader("Access-Control-Expose-Headers", "Cache-Control");
  const origin = header(request, "origin");
  if (origin && allowedOrigins(env).has(origin)) response.setHeader("Access-Control-Allow-Origin", origin);
}

function exactKeys(value: JsonRecord, keys: readonly string[], label: string): void {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new Error(`${label} has unexpected or missing fields`);
  }
}

function record(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as JsonRecord;
}

function text(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.trim().length === 0)) throw new Error(`${label} must be a string`);
  return value;
}

function nonEmptyText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function finiteNumber(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${label} is outside its valid range`);
  }
  return value;
}

function safeInteger(value: unknown, label: string, min = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) throw new Error(`${label} must be a safe integer`);
  return value;
}

function validatePark(value: unknown, reader: number): Park {
  const park = record(value, "park");
  // Change rows written before the access columns existed have only the base fields.
  exactKeys(park, Object.hasOwn(park, "googleMapsUrl") ? [...PARK_FIELDS, ...ACCESS_FIELDS] : PARK_FIELDS, "park");
  const id = text(park.id, "park.id");
  if (!PARK_ID.test(id)) throw new Error("park.id is invalid");
  const name = nonEmptyText(park.name, "park.name");
  const short = nonEmptyText(park.short, "park.short");
  const category = text(park.category, "park.category");
  if (!CATEGORIES.has(category)) throw new Error(`park ${id} has an unsupported category`);
  text(park.region, "park.region", true);
  const biome = text(park.biome, "park.biome");
  if (!BIOMES.has(biome)) throw new Error(`park ${id} has an unsupported biome`);
  const shape = text(park.shape, "park.shape");
  if (!SHAPES.has(shape)) throw new Error(`park ${id} has an unsupported badge shape`);
  const rarity = text(park.rarity, "park.rarity");
  if (!RARITIES.has(rarity)) throw new Error(`park ${id} has an unsupported rarity`);
  const scene = park.scene;
  if (scene !== null && (typeof scene !== "string" || !SCENE_SLUG.test(scene))) throw new Error(`park ${id} has an invalid scene slug`);
  if (typeof park.blurb !== "string") throw new Error(`park ${id} blurb must be a string`);
  const googleMapsUrl = park.googleMapsUrl ?? null;
  if (googleMapsUrl !== null && (typeof googleMapsUrl !== "string" || googleMapsUrl.length > 2048 || !GOOGLE_MAPS_URL.test(googleMapsUrl))) {
    throw new Error(`park ${id} has an invalid Google Maps link`);
  }
  const trailheadLat = park.trailheadLat === null || park.trailheadLat === undefined ? null : finiteNumber(park.trailheadLat, `park ${id} trailhead latitude`, -90, 90);
  const trailheadLng = park.trailheadLng === null || park.trailheadLng === undefined ? null : finiteNumber(park.trailheadLng, `park ${id} trailhead longitude`, -180, 180);
  if ((trailheadLat === null) !== (trailheadLng === null)) throw new Error(`park ${id} trailhead needs both coordinates`);
  const checked: Park = {
    id, name, short, category, region: park.region as string,
    lat: finiteNumber(park.lat, `park ${id} latitude`, -90, 90),
    lng: finiteNumber(park.lng, `park ${id} longitude`, -180, 180),
    biome, shape, rarity, scene, seed: safeInteger(park.seed, `park ${id} seed`, -Number.MAX_SAFE_INTEGER),
    blurb: park.blurb,
  };
  if (reader >= MAPS_LINK_READER) Object.assign(checked, { googleMapsUrl, trailheadLat, trailheadLng });
  return checked;
}

function validateBoundary(value: unknown, expectedId?: string): JsonRecord {
  const feature = record(value, "boundary feature");
  exactKeys(feature, ["type", "properties", "geometry"], "boundary feature");
  if (feature.type !== "Feature") throw new Error("boundary must be a GeoJSON Feature");
  const properties = record(feature.properties, "boundary properties");
  exactKeys(properties, ["id", "biome"], "boundary properties");
  const id = text(properties.id, "boundary id");
  if (!PARK_ID.test(id)) throw new Error(`boundary ${id} has an invalid park id`);
  const biome = text(properties.biome, "boundary biome");
  if (expectedId !== undefined && id !== expectedId) throw new Error("boundary id does not match its catalogue key");
  if (!BIOMES.has(biome)) throw new Error(`boundary ${id} has an unsupported biome`);
  const geometry = record(feature.geometry, `boundary ${id} geometry`);
  exactKeys(geometry, ["type", "coordinates"], `boundary ${id} geometry`);
  if (geometry.type !== "MultiPolygon" || !Array.isArray(geometry.coordinates) || geometry.coordinates.length === 0) {
    throw new Error(`boundary ${id} must have non-empty MultiPolygon coordinates`);
  }
  geometry.coordinates.forEach((polygonValue, polygonIndex) => {
    if (!Array.isArray(polygonValue) || polygonValue.length === 0) throw new Error(`boundary ${id} polygon is empty`);
    polygonValue.forEach((ringValue, ringIndex) => {
      if (!Array.isArray(ringValue) || ringValue.length < 4) throw new Error(`boundary ${id} ring is too short`);
      const first = ringValue[0];
      const last = ringValue[ringValue.length - 1];
      if (!Array.isArray(first) || !Array.isArray(last) || first.length !== 2 || last.length !== 2 || first[0] !== last[0] || first[1] !== last[1]) {
        throw new Error(`boundary ${id} ring is not closed`);
      }
      ringValue.forEach((point, pointIndex) => {
        if (!Array.isArray(point) || point.length !== 2) throw new Error(`boundary ${id} coordinate is invalid`);
        finiteNumber(point[0], `boundary ${id} longitude`, -180, 180);
        finiteNumber(point[1], `boundary ${id} latitude`, -90, 90);
      });
    });
  });
  return feature;
}

function validateDriveEntry(value: unknown, label: string, hubCount?: number): DriveEntry {
  const entry = record(value, label);
  exactKeys(entry, ["drive", "walkM"], label);
  if (!Array.isArray(entry.drive)) throw new Error(`${label}.drive must be an array`);
  if (hubCount !== undefined && entry.drive.length !== hubCount) throw new Error(`${label}.drive does not match the hub list`);
  const drive = entry.drive.map((route, index): [number, number] | null => {
    if (route === null) return null;
    if (!Array.isArray(route) || route.length !== 2) throw new Error(`${label}.drive[${index}] is invalid`);
    return [finiteNumber(route[0], `${label}.drive[${index}] distance`, 0, Number.MAX_SAFE_INTEGER),
      finiteNumber(route[1], `${label}.drive[${index}] minutes`, 0, Number.MAX_SAFE_INTEGER)];
  });
  return { drive, walkM: finiteNumber(entry.walkM, `${label}.walkM`, 0, Number.MAX_SAFE_INTEGER) };
}

function validateHubs(value: unknown): { name: string; lng: number; lat: number }[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("drive hubs must be a non-empty array");
  return value.map((rawHub, index) => {
    const hub = record(rawHub, `drive.hubs[${index}]`);
    exactKeys(hub, ["name", "lng", "lat"], `drive.hubs[${index}]`);
    return { name: text(hub.name, `drive.hubs[${index}].name`),
      lng: finiteNumber(hub.lng, `drive.hubs[${index}].lng`, -180, 180),
      lat: finiteNumber(hub.lat, `drive.hubs[${index}].lat`, -90, 90) };
  });
}

function safeKey(key: string): boolean {
  return key.length > 0 && !key.startsWith("/") && !key.includes("\\")
    && key.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function validateContentFile(value: unknown, expectedPath?: string): ContentFile {
  const file = record(value, "content file");
  exactKeys(file, ["path", "key", "url", "sha256", "byte_size", "content_type"], "content file");
  const path = text(file.path, "content file path");
  const key = text(file.key, "content file key");
  if (expectedPath !== undefined && path !== expectedPath) throw new Error("asset id does not match descriptor path");
  if (!safeKey(key)) throw new Error("content file key is unsafe");
  const keyMatch = /^releases\/([a-f0-9]{64})\/(.+)$/.exec(key);
  if (!keyMatch || keyMatch[2] !== path) throw new Error("content file key is not a release-scoped immutable path");
  if (typeof file.url !== "string" || file.url !== `${CDN_ORIGIN}/${key}`) throw new Error("content file URL is outside the approved CDN");
  if (typeof file.sha256 !== "string" || !SHA256.test(file.sha256)) throw new Error("content file SHA-256 is invalid");
  const byte_size = safeInteger(file.byte_size, "content file byte_size", 1);
  if (byte_size > MAX_RESPONSE_BYTES) throw new Error("content file exceeds the supported scene asset size");
  const content_type = text(file.content_type, "content file content_type");
  if (!path.startsWith("art/badges/scenes/") || !SCENE_SLUG.test(path.slice("art/badges/scenes/".length).replace(/\.webp$/, "")) || !path.endsWith(".webp") || content_type !== "image/webp") {
    throw new Error("content file is not a badge scene WebP");
  }
  return { path, key, url: file.url, sha256: file.sha256, byte_size, content_type };
}

function validateMapPointer(value: unknown): MapPointer | null {
  if (value === null) return null;
  const pointer = record(value, "map pointer");
  exactKeys(pointer, ["version", "manifestUrl", "manifestSha256"], "map pointer");
  if (typeof pointer.version !== "string" || !SHA256.test(pointer.version)) throw new Error("map pointer version is invalid");
  const expectedUrl = `${CDN_ORIGIN}/releases/${pointer.version}/map/manifest.json`;
  if (pointer.manifestUrl !== expectedUrl) throw new Error("map pointer URL does not match its version");
  if (typeof pointer.manifestSha256 !== "string" || !SHA256.test(pointer.manifestSha256)) throw new Error("map pointer SHA-256 is invalid");
  return { version: pointer.version, manifestUrl: pointer.manifestUrl, manifestSha256: pointer.manifestSha256 };
}

function validateSnapshot(value: unknown, reader: number): JsonRecord {
  const snapshot = record(value, "content snapshot");
  exactKeys(snapshot, ["schema", "revision", "parks", "boundaries", "drive", "assets", "map"], "content snapshot");
  if (snapshot.schema !== CONTENT_SYNC_SCHEMA) throw new Error("content snapshot schema is unsupported");
  safeInteger(snapshot.revision, "content revision");
  if (!Array.isArray(snapshot.parks)) throw new Error("content snapshot parks must be an array");
  const parks = snapshot.parks.map((park) => validatePark(park, reader));
  const ids = parks.map((park) => park.id);
  if (new Set(ids).size !== ids.length) throw new Error("content snapshot has duplicate park ids");
  const parkById = new Map(parks.map((park) => [park.id, park]));

  const boundaries = record(snapshot.boundaries, "boundaries");
  exactKeys(boundaries, ["type", "features"], "boundaries");
  if (boundaries.type !== "FeatureCollection" || !Array.isArray(boundaries.features)) throw new Error("boundaries must be a FeatureCollection");
  const boundaryIds = boundaries.features.map((feature) => validateBoundary(feature).properties as JsonRecord).map((props) => props.id as string);
  if (boundaryIds.length !== ids.length || new Set(boundaryIds).size !== ids.length || ids.some((id) => !boundaryIds.includes(id))) {
    throw new Error("boundary ids do not match the park set");
  }
  boundaries.features.forEach((feature) => {
    const checked = validateBoundary(feature);
    const properties = checked.properties as JsonRecord;
    if (properties.biome !== parkById.get(properties.id as string)?.biome) throw new Error(`boundary ${properties.id} biome does not match its park`);
  });

  const driveValue = record(snapshot.drive, "drive");
  exactKeys(driveValue, ["hubs", "parks"], "drive");
  const hubs = validateHubs(driveValue.hubs);
  const driveParks = record(driveValue.parks, "drive.parks");
  if (Object.keys(driveParks).length !== ids.length || ids.some((id) => !Object.hasOwn(driveParks, id))) throw new Error("drive ids do not match the park set");
  for (const id of ids) validateDriveEntry(driveParks[id], `drive.parks.${id}`, hubs.length);

  if (!Array.isArray(snapshot.assets)) throw new Error("content snapshot assets must be an array");
  const assets = snapshot.assets.map((file) => validateContentFile(file));
  const assetPaths = assets.map((file) => file.path);
  if (new Set(assetPaths).size !== assetPaths.length) throw new Error("content snapshot has duplicate asset paths");
  const activeScenes = new Set<string>();
  for (const park of parks) if (park.scene) activeScenes.add(`art/badges/scenes/${park.scene}.webp`);
  if (activeScenes.size !== assets.length || assets.some((file) => !activeScenes.has(file.path))) throw new Error("active scene assets do not match live parks");
  for (const path of activeScenes) if (!assetPaths.includes(path)) throw new Error(`missing badge descriptor ${path}`);

  return {
    schema: CONTENT_SYNC_SCHEMA,
    revision: snapshot.revision,
    parks,
    boundaries: { type: "FeatureCollection", features: boundaries.features.map((feature) => validateBoundary(feature)) },
    drive: { hubs, parks: Object.fromEntries(ids.map((id) => [id, validateDriveEntry(driveParks[id], `drive.parks.${id}`, hubs.length)])) },
    assets,
    map: validateMapPointer(snapshot.map),
  };
}

type Entity = "park" | "boundary" | "drive" | "asset" | "hubs" | "map";
type Change = { entity: Entity; op: "upsert" | "delete"; id: string; value?: unknown };

function validateChange(value: unknown, reader: number): Change {
  const change = record(value, "content change");
  const entity = change.entity;
  if (!["park", "boundary", "drive", "asset", "hubs", "map"].includes(String(entity))) throw new Error("content change entity is invalid");
  if (change.op !== "upsert" && change.op !== "delete") throw new Error("content change operation is invalid");
  const id = text(change.id, "content change id");
  if ((entity === "park" || entity === "boundary" || entity === "drive") && !PARK_ID.test(id)) {
    throw new Error("content change park id is invalid");
  }
  if (entity === "asset" && !SCENE_ASSET_ID.test(id)) throw new Error("content change asset id is invalid");
  if (change.op === "delete") {
    exactKeys(change, ["entity", "op", "id"], "content delete change");
    if (entity === "hubs" || entity === "map") throw new Error("hubs and map use upsert changes");
    return { entity: entity as Entity, op: "delete", id };
  }
  exactKeys(change, ["entity", "op", "id", "value"], "content upsert change");
  let checked: unknown;
  if (entity === "park") {
    checked = validatePark(change.value, reader);
    if ((checked as Park).id !== id) throw new Error("park change id does not match its value");
  } else if (entity === "boundary") {
    checked = validateBoundary(change.value, id);
  } else if (entity === "drive") {
    checked = validateDriveEntry(change.value, `drive change ${id}`);
  } else if (entity === "asset") {
    checked = validateContentFile(change.value, id);
  } else if (entity === "hubs") {
    if (id !== "default") throw new Error("hub list id must be default");
    checked = validateHubs(change.value);
  } else {
    if (id !== "default") throw new Error("map pointer id must be default");
    checked = validateMapPointer(change.value);
  }
  return { entity: entity as Entity, op: "upsert", id, value: checked };
}

function validateChanges(value: unknown, reader: number): JsonRecord {
  const response = record(value, "content changes response");
  exactKeys(response, ["schema", "fromRevision", "throughRevision", "headRevision", "hasMore", "batches"], "content changes response");
  if (response.schema !== CONTENT_SYNC_SCHEMA) throw new Error("content changes schema is unsupported");
  const fromRevision = safeInteger(response.fromRevision, "fromRevision");
  const throughRevision = safeInteger(response.throughRevision, "throughRevision");
  const headRevision = safeInteger(response.headRevision, "headRevision");
  if (throughRevision < fromRevision || throughRevision > headRevision) throw new Error("content changes cursor range is invalid");
  if (typeof response.hasMore !== "boolean" || !Array.isArray(response.batches)) throw new Error("content changes response shape is invalid");
  let prior = fromRevision;
  const batches = response.batches.map((rawBatch) => {
    const batch = record(rawBatch, "content change batch");
    exactKeys(batch, ["revision", "changes"], "content change batch");
    const revision = safeInteger(batch.revision, "batch revision", 1);
    if (revision !== prior + 1 || revision > headRevision || !Array.isArray(batch.changes) || batch.changes.length === 0) throw new Error("content change batch is invalid or noncontiguous");
    prior = revision;
    const changes = batch.changes.map((change) => validateChange(change, reader));
    const keys = changes.map((change) => `${change.entity}\0${change.id}`);
    if (new Set(keys).size !== keys.length) throw new Error(`content batch ${revision} has duplicate entity keys`);
    return { revision, changes };
  });
  if (headRevision > fromRevision && batches.length === 0) throw new Error("content change batches are missing above the cursor");
  const expectedThrough = batches.length ? batches[batches.length - 1].revision : headRevision;
  if (throughRevision !== expectedThrough) throw new Error("throughRevision does not match the final batch");
  if (response.hasMore !== (throughRevision < headRevision)) throw new Error("hasMore does not match the remaining revision range");
  return { schema: CONTENT_SYNC_SCHEMA, fromRevision, throughRevision, headRevision, hasMore: response.hasMore, batches };
}

function numericDatabaseValue(value: unknown, label: string): number {
  const numeric = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(numeric) || numeric < 0) throw new Error(`${label} is outside JSON safe integer range`);
  return numeric;
}

function createNeonRepository(databaseUrl: string): SyncRepository {
  const sql = database(databaseUrl);
  return {
    async snapshot() {
      const results = await sql.transaction([
        sql`SELECT revision FROM public.content_clock WHERE singleton = true`,
        sql`SELECT id, name, short, category, region, lat, lng, biome, shape, rarity, scene, seed, blurb,
                   google_maps_url AS "googleMapsUrl", trailhead_lat AS "trailheadLat", trailhead_lng AS "trailheadLng"
              FROM public.parks ORDER BY id`,
        sql`SELECT park_id, feature FROM public.boundaries ORDER BY park_id`,
        sql`SELECT position, name, lng, lat FROM public.drive_hubs ORDER BY position`,
        sql`SELECT park_id, walk_m FROM public.park_drive_settings ORDER BY park_id`,
        sql`SELECT park_id, hub_position, distance_km, duration_min FROM public.park_drive ORDER BY park_id, hub_position`,
        sql`SELECT DISTINCT asset.logical_path AS path, asset.object_key AS key, asset.url, asset.sha256, asset.byte_size, asset.content_type
              FROM public.parks AS park
              JOIN public.r2_objects AS asset ON asset.logical_path = 'art/badges/scenes/' || park.scene || '.webp'
             WHERE park.scene IS NOT NULL
             ORDER BY asset.logical_path`,
        sql`SELECT version, manifest_url, manifest_sha256 FROM public.content_map WHERE singleton = true`,
      ], { isolationLevel: "RepeatableRead", readOnly: true });
      const [clockRows, parkRows, boundaryRows, hubRows, settingsRows, routeRows, assetRows, mapRows] = results as unknown as Record<string, unknown>[][];
      const clock = clockRows[0];
      if (!clock) throw new Error("content clock is not initialized");
      const parks = parkRows.map((row) => ({ ...row }));
      const parkIds = new Set(parks.map((row) => String(row.id)));
      const boundaries = boundaryRows.map((row) => ({ park_id: String(row.park_id), feature: row.feature }));
      const hubs = hubRows.map((row) => ({ position: numericDatabaseValue(row.position, "hub position"), name: row.name, lng: row.lng, lat: row.lat }));
      const settings = new Map(settingsRows.map((row) => [String(row.park_id), row.walk_m]));
      const routes = new Map<string, Map<number, [number, number] | null>>();
      for (const row of routeRows) {
        const parkId = String(row.park_id);
        const hubPosition = numericDatabaseValue(row.hub_position, "route hub position");
        const entry = routes.get(parkId) ?? new Map<number, [number, number] | null>();
        entry.set(hubPosition, row.distance_km === null || row.duration_min === null
          ? null
          : [Number(row.distance_km), Number(row.duration_min)]);
        routes.set(parkId, entry);
      }
      const driveParks: Record<string, DriveEntry> = {};
      for (const id of [...parkIds].sort()) {
        const byPosition = routes.get(id);
        if (!settings.has(id) || !byPosition || byPosition.size !== hubs.length) throw new Error(`drive rows are incomplete for park ${id}`);
        const drive = hubs.map((hub) => {
          const route = byPosition.get(hub.position);
          if (route === undefined) throw new Error(`drive hub positions are incomplete for park ${id}`);
          return route;
        });
        driveParks[id] = { drive, walkM: Number(settings.get(id)) };
      }
      if (routes.size !== parkIds.size || settings.size !== parkIds.size || boundaries.length !== parkIds.size) {
        throw new Error("park, boundary, and drive row sets do not match");
      }
      const assets = assetRows.map((row) => ({
        path: row.path, key: row.key, url: row.url, sha256: row.sha256,
        byte_size: numericDatabaseValue(row.byte_size, "asset byte_size"), content_type: row.content_type,
      }));
      const mapRow = mapRows[0];
      return {
        schema: CONTENT_SYNC_SCHEMA,
        revision: numericDatabaseValue(clock.revision, "content revision"),
        parks,
        boundaries: { type: "FeatureCollection", features: boundaries.map((row) => row.feature) },
        drive: { hubs: hubs.map(({ name, lng, lat }) => ({ name, lng, lat })), parks: driveParks },
        assets,
        map: mapRow ? { version: mapRow.version, manifestUrl: mapRow.manifest_url, manifestSha256: mapRow.manifest_sha256 } : null,
      };
    },
    async changes(after, limit) {
      const rows = await sql.query(
        `WITH state AS MATERIALIZED (
           SELECT revision, retention_floor FROM public.content_clock WHERE singleton = true
         ), selected AS MATERIALIZED (
           SELECT batch.revision
             FROM public.content_change_batches AS batch CROSS JOIN state
            WHERE batch.revision > $1 AND batch.revision <= state.revision
            ORDER BY batch.revision
            LIMIT $2
         ), more AS (
           SELECT EXISTS (
             SELECT 1 FROM public.content_change_batches AS batch CROSS JOIN state
              WHERE batch.revision > COALESCE((SELECT max(revision) FROM selected), $1)
                AND batch.revision <= state.revision
           ) AS has_more
         )
         SELECT state.revision AS head_revision, state.retention_floor,
                selected.revision AS batch_revision,
                change.entity, change.entity_id, change.operation, change.value,
                more.has_more
           FROM state CROSS JOIN more
           LEFT JOIN selected ON true
           LEFT JOIN public.content_changes AS change ON change.revision = selected.revision
          ORDER BY selected.revision, change.entity, change.entity_id`,
        [after, limit],
      ) as Record<string, unknown>[];
      if (!rows.length) throw new Error("content clock is not initialized");
      const headRevision = numericDatabaseValue(rows[0].head_revision, "head revision");
      const retentionFloor = numericDatabaseValue(rows[0].retention_floor, "retention floor");
      const batches: { revision: number; changes: Change[] }[] = [];
      for (const row of rows) {
        if (row.batch_revision === null || row.batch_revision === undefined) continue;
        const revision = numericDatabaseValue(row.batch_revision, "batch revision");
        let batch = batches[batches.length - 1];
        if (!batch || batch.revision !== revision) {
          batch = { revision, changes: [] };
          batches.push(batch);
        }
        const entity = text(row.entity, "change entity") as Entity;
        const id = text(row.entity_id, "change id");
        const op = text(row.operation, "change operation") as "upsert" | "delete";
        batch.changes.push(op === "delete" ? { entity, op, id } : { entity, op, id, value: row.value });
      }
      const hasMore = rows[0].has_more === true;
      return { headRevision, retentionFloor, batches, hasMore };
    },
    async scene(releaseId, scene) {
      const rows = await sql`
        SELECT logical_path AS path, object_key AS key, url, sha256, byte_size, content_type
          FROM public.r2_objects
         WHERE logical_path = ${`art/badges/scenes/${scene}.webp`}
           AND object_key = ${`releases/${releaseId}/art/badges/scenes/${scene}.webp`}
         LIMIT 1`;
      if (!rows.length) return null;
      const row = rows[0] as Record<string, unknown>;
      return {
        path: row.path, key: row.key, url: row.url, sha256: row.sha256,
        byte_size: numericDatabaseValue(row.byte_size, "scene asset byte_size"), content_type: row.content_type,
      };
    },
  };
}

// Clients that predate the reader parameter are reader 1.
function readerVersion(raw: string | null): number {
  if (raw === null) return 1;
  if (!/^\d{1,4}$/.test(raw) || Number(raw) < 1) throw new HttpError(400, "reader must be a positive integer");
  return Number(raw);
}

function sendJson(response: ResponseLike, status: number, body: JsonRecord, head = false): void {
  const serialized = JSON.stringify(body);
  const byteLength = new TextEncoder().encode(serialized).byteLength;
  response.statusCode = status;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", String(byteLength));
  if (!head) response.end(serialized);
  else response.end();
}

function sendFailure(response: ResponseLike, error: unknown, head = false): void {
  if (error instanceof HttpError) {
    sendJson(response, error.status, error.body ?? { error: error.message }, head);
    return;
  }
  sendJson(response, 503, { error: "Content sync is temporarily unavailable." }, head);
}

async function repositoryFor(options: HandlerOptions): Promise<SyncRepository> {
  if (options.repository) return options.repository;
  const databaseUrl = options.env?.DATABASE_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is missing");
  return createNeonRepository(databaseUrl);
}

/** Run a content handler inside a request analytics context, as the main API router does. */
function instrumented(options: HandlerOptions, path: string, handler: NodeHandler): NodeHandler {
  const env = options.env ?? process.env;
  return (request, response) => withRequestAnalytics({
    method: request.method,
    path,
    header: (name) => header(request, name) ?? null,
    env,
    sink: () => options.analytics ? options.analytics() : createAnalyticsSink(env),
    waitUntil: options.waitUntil,
  }, () => handler(request, response));
}

function createHandler(options: HandlerOptions, operation: "snapshot" | "changes") {
  const env = options.env ?? process.env;
  return instrumented(options, `/api/content/${operation}`, async (request: RequestLike, response: ResponseLike): Promise<void> => {
    setCors(request, response, env);
    const method = (request.method ?? "GET").toUpperCase();
    if (method === "OPTIONS") {
      response.statusCode = 204;
      response.setHeader("Cache-Control", "no-store");
      response.end();
      return;
    }
    if (method !== "GET" && method !== "HEAD") {
      response.setHeader("Allow", "GET, HEAD, OPTIONS");
      sendJson(response, 405, { error: "Method Not Allowed" }, method === "HEAD");
      return;
    }
    try {
      const repository = await repositoryFor({ ...options, env });
      const params = new URLSearchParams();
      const query = request.query ?? {};
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) value.forEach((item) => params.append(key, item));
        else params.set(key, value);
      }
      const reader = readerVersion(params.get("reader"));
      if (operation === "snapshot") {
        const body = validateSnapshot(await repository.snapshot(), reader);
        const serialized = JSON.stringify(body);
        if (new TextEncoder().encode(serialized).byteLength > MAX_RESPONSE_BYTES) {
          throw new HttpError(503, "snapshot exceeds supported response size");
        }
        sendJson(response, 200, body, method === "HEAD");
        return;
      }

      const rawAfter = params.get("after");
      if (rawAfter === null || !/^\d+$/.test(rawAfter)) throw new HttpError(400, "after must be a non-negative revision");
      const after = Number(rawAfter);
      if (!Number.isSafeInteger(after)) throw new HttpError(400, "after must be a JSON safe integer");
      const rawLimit = params.get("limit") ?? "50";
      if (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 50) {
        throw new HttpError(400, "limit must be between 1 and 50");
      }
      const rawResult = record(await repository.changes(after, Number(rawLimit)), "content changes query result");
      const headRevision = safeInteger(rawResult.headRevision, "head revision");
      const retentionFloor = safeInteger(rawResult.retentionFloor, "retention floor");
      if (after > headRevision) throw new HttpError(400, "after is newer than the content revision");
      if (after < retentionFloor) {
        throw new HttpError(410, "content history expired", { schema: CONTENT_SYNC_SCHEMA, resetRequired: true, headRevision });
      }
      if (!Array.isArray(rawResult.batches) || typeof rawResult.hasMore !== "boolean") throw new Error("content changes query result is malformed");
      let batches = rawResult.batches.map((rawBatch) => {
        const batch = record(rawBatch, "content batch");
        return {
          revision: safeInteger(batch.revision, "batch revision", 1),
          changes: Array.isArray(batch.changes) ? batch.changes.map((change) => validateChange(change, reader)) : (() => { throw new Error("batch changes must be an array"); })(),
        };
      });
      let hasMore = rawResult.hasMore;
      let body = validateChanges({
        schema: CONTENT_SYNC_SCHEMA, fromRevision: after,
        throughRevision: batches.length ? batches[batches.length - 1].revision : headRevision,
        headRevision, hasMore, batches,
      }, reader);
      while (new TextEncoder().encode(JSON.stringify(body)).byteLength > MAX_RESPONSE_BYTES) {
        if (batches.length <= 1) throw new HttpError(413, "one committed content batch exceeds supported response size; take a fresh snapshot");
        batches = batches.slice(0, -1);
        hasMore = true;
        body = validateChanges({
          schema: CONTENT_SYNC_SCHEMA, fromRevision: after,
          throughRevision: batches[batches.length - 1].revision,
          headRevision, hasMore, batches,
        }, reader);
      }
      sendJson(response, 200, body, method === "HEAD");
    } catch (error) {
      sendFailure(response, error, method === "HEAD");
    }
  });
}

export function createSnapshotHandler(options: HandlerOptions = {}) {
  return createHandler(options, "snapshot");
}

export function createChangesHandler(options: HandlerOptions = {}) {
  return createHandler(options, "changes");
}

export function createSceneHandler(options: HandlerOptions = {}) {
  const env = options.env ?? process.env;
  return instrumented(options, "/api/content/scene", async (request: RequestLike, response: ResponseLike): Promise<void> => {
    setCors(request, response, env);
    const method = (request.method ?? "GET").toUpperCase();
    if (method === "OPTIONS") {
      response.statusCode = 204;
      response.setHeader("Cache-Control", "no-store");
      response.end();
      return;
    }
    if (method !== "GET" && method !== "HEAD") {
      response.setHeader("Allow", "GET, HEAD, OPTIONS");
      sendJson(response, 405, { error: "Method Not Allowed" }, method === "HEAD");
      return;
    }
    try {
      const query = request.query ?? {};
      const readSingle = (key: string) => {
        const value = query[key];
        return typeof value === "string" ? value : undefined;
      };
      const releaseId = readSingle("releaseId");
      const scene = readSingle("scene");
      if (!releaseId || !SHA256.test(releaseId) || !scene || !SCENE_SLUG.test(scene)) {
        throw new HttpError(400, "releaseId and scene are invalid");
      }
      const repository = await repositoryFor({ ...options, env });
      const descriptor = await repository.scene(releaseId, scene);
      if (descriptor === null) throw new HttpError(404, "scene asset not found");
      const file = validateContentFile(descriptor, `art/badges/scenes/${scene}.webp`);
      if (file.key !== `releases/${releaseId}/art/badges/scenes/${scene}.webp` || file.byte_size > MAX_RESPONSE_BYTES) {
        throw new HttpError(404, "scene asset not found");
      }
      sendJson(response, 200, { schema: "parkdex.scene-asset/v1", file }, method === "HEAD");
    } catch (error) {
      sendFailure(response, error, method === "HEAD");
    }
  });
}

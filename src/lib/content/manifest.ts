import {
  CONTENT_CDN_ORIGIN,
  CONTENT_READER_VERSION,
  isMapChunkPath,
  isMapLayoutPath,
  isRemoteContentPath,
  mapChunkIndex,
  mapChunkPath,
  type CatalogueCache,
  type CatalogueChunkRef,
  type ContentBoundaries,
  type ContentChannel,
  type ContentEnvironment,
  type ContentFile,
  type ContentManifest,
  type ContentMapInventory,
  type MapManifest,
  type ContentMapPointer,
  type ContentPayload,
  type ContentSnapshot,
  type ContentSyncState,
  type ContentChangesResponse,
  type ContentChange,
  type ContentChangeBatch,
  type DriveData,
} from "./contracts";
import type { Park } from "../parks";

const PARK_FIELDS = [
  "id", "name", "short", "category", "region", "lat", "lng", "biome", "shape", "rarity", "scene", "seed", "blurb",
] as const;
const CATEGORIES = new Set(["national", "provincial", "regional", "municipal", "community"]);
const BIOMES = new Set(["coast", "forest", "mountain", "lake", "waterfall", "river", "cave", "marsh", "heritage"]);
const SHAPES = new Set(["circle", "hex", "shield", "arch", "seal"]);
const RARITIES = new Set(["common", "uncommon", "rare", "epic", "legendary"]);
const FALLBACK_CATEGORY = "community";
const FALLBACK_BIOME = "forest";
const FALLBACK_SHAPE = "circle";
const FALLBACK_RARITY = "common";
const SCENE_ASSET_PATH = /^art\/badges\/scenes\/[a-z0-9][a-z0-9-]*\.webp$/;
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40,64}$/;
const PARK_ID = /^[a-z0-9][a-z0-9-]*$/;
// Matches content_parks_google_maps_url_check in content_003_park_maps_link.sql.
const GOOGLE_MAPS_URL = /^https:\/\/(?:(?:www\.)?google\.[a-z]{2,3}(?:\.[a-z]{2})?\/maps(?:[/?#]\S*)?|maps\.google\.[a-z]{2,3}(?:\.[a-z]{2})?(?:[/?#]\S*)?|maps\.app\.goo\.gl\/\S+|goo\.gl\/maps\/\S+)$/;

export class ContentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContentValidationError";
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ContentValidationError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

// Installed builds must keep reading content published after them, so a record
// only needs the fields this reader uses. Fields added later are ignored.
function requireKeys(value: Record<string, unknown>, keys: readonly string[], label: string) {
  if (keys.some((key) => !Object.hasOwn(value, key))) {
    throw new ContentValidationError(`${label} has an unsupported shape`);
  }
}

// A value added to an enum after this build shipped falls back to a neutral
// presentation instead of rejecting the whole catalogue.
function knownOr<T extends string>(allowed: ReadonlySet<string>, value: string, fallback: T): T {
  return (allowed.has(value) ? value : fallback) as T;
}

function parkBiome(value: string): Park["biome"] {
  return knownOr<Park["biome"]>(BIOMES, value, FALLBACK_BIOME);
}

function string(value: unknown, label: string, nonEmpty = true): string {
  if (typeof value !== "string" || (nonEmpty && value.length === 0)) throw new ContentValidationError(`${label} must be a string`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new ContentValidationError(`${label} must be a positive integer`);
  return value;
}

function finiteNumber(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new ContentValidationError(`${label} must be a finite number in range`);
  }
  return value;
}

function uniqueStringArray(value: unknown, label: string, pattern?: RegExp): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new ContentValidationError(`${label} must be a non-empty array`);
  const result = value.map((entry, index) => {
    const item = string(entry, `${label}[${index}]`);
    if (pattern && !pattern.test(item)) throw new ContentValidationError(`${label}[${index}] has an invalid identifier`);
    return item;
  });
  if (new Set(result).size !== result.length) throw new ContentValidationError(`${label} contains duplicate identifiers`);
  return result;
}

function encodeLogicalPath(path: string) {
  return path.split("/").map((part) => encodeURIComponent(part)).join("/");
}

function assertSafeLogicalPath(path: string) {
  if (!path || path.startsWith("/") || path.includes("\\") || path.includes("?") || path.includes("#") || path.includes("%")) {
    throw new ContentValidationError("manifest contains an unsafe file path");
  }
  const segments = path.split("/");
  if (segments.some((part) => !part || part === "." || part === ".." || part.startsWith("."))) {
    throw new ContentValidationError("manifest contains an unsafe file path");
  }
  if (segments.some((part) => !/^[A-Za-z0-9._ -]+$/.test(part))) throw new ContentValidationError("manifest contains an unsupported file path");
}

function expectedContentType(path: string): string | null {
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".geojson")) return "application/geo+json";
  if (path.endsWith(".webp")) return "image/webp";
  if (path.endsWith(".pbf")) return "application/x-protobuf";
  if (path.endsWith(".bin")) return "application/octet-stream";
  return null;
}

function safeContentFileUrl(path: string, key: string, url: string, label: string) {
  assertSafeLogicalPath(key);
  if (!key.endsWith(`/${path}`) && key !== path) throw new ContentValidationError(`${label}.key does not name its logical path`);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ContentValidationError(`${label}.url is invalid`);
  }
  const expected = `${CONTENT_CDN_ORIGIN}/${encodeLogicalPath(key)}`;
  if (parsed.origin !== CONTENT_CDN_ORIGIN || parsed.href !== expected) {
    throw new ContentValidationError(`${label}.url is outside the approved immutable CDN object path`);
  }
}

function parseSyncFile(value: unknown, label: string, allowedPath: (path: string) => boolean): ContentFile {
  const entry = record(value, label);
  requireKeys(entry, ["path", "key", "url", "sha256", "byte_size", "content_type"], label);
  const path = string(entry.path, `${label}.path`);
  assertSafeLogicalPath(path);
  if (!allowedPath(path)) throw new ContentValidationError(`${label}.path is outside the supported content inventory`);
  const key = string(entry.key, `${label}.key`);
  const url = string(entry.url, `${label}.url`);
  safeContentFileUrl(path, key, url, label);
  const sha256 = string(entry.sha256, `${label}.sha256`);
  if (!SHA256.test(sha256)) throw new ContentValidationError(`${label}.sha256 is invalid`);
  const byte_size = positiveInteger(entry.byte_size, `${label}.byte_size`);
  const content_type = string(entry.content_type, `${label}.content_type`);
  if (content_type !== expectedContentType(path)) throw new ContentValidationError(`${label}.content_type does not match its path`);
  return { path, key, url, sha256, byte_size, content_type };
}

function nonNegativeSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ContentValidationError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function parseMapPointer(value: unknown): ContentMapPointer | null {
  if (value === null) return null;
  const pointer = record(value, "snapshot.map");
  requireKeys(pointer, ["version", "manifestUrl", "manifestSha256"], "snapshot.map");
  const version = string(pointer.version, "snapshot.map.version");
  if (!SHA256.test(version)) throw new ContentValidationError("snapshot.map.version is invalid");
  const manifestUrl = string(pointer.manifestUrl, "snapshot.map.manifestUrl");
  if (manifestUrl !== `${CONTENT_CDN_ORIGIN}/releases/${version}/map/manifest.json`) {
    throw new ContentValidationError("snapshot.map.manifestUrl is outside its immutable map inventory path");
  }
  const manifestSha256 = string(pointer.manifestSha256, "snapshot.map.manifestSha256");
  if (!SHA256.test(manifestSha256)) throw new ContentValidationError("snapshot.map.manifestSha256 is invalid");
  return { version, manifestUrl, manifestSha256 };
}

function parseMapManifestLayout(value: unknown, label: string): MapManifest {
  const map = record(value, label);
  requireKeys(map, ["size", "chunkBytes", "count"], label);
  const result = {
    size: positiveInteger(map.size, `${label}.size`),
    chunkBytes: positiveInteger(map.chunkBytes, `${label}.chunkBytes`),
    count: positiveInteger(map.count, `${label}.count`),
  };
  if (result.count !== Math.ceil(result.size / result.chunkBytes)) throw new ContentValidationError(`${label} chunk count does not match its size`);
  return result;
}

function isSupportedManifestPath(path: string): boolean {
  return path === "data/parks.json" || path === "data/drive.json" || path === "boundaries.geojson" ||
    /^art\/badges\/scenes\/[a-z0-9][a-z0-9-]*\.webp$/.test(path) ||
    /^art\/kip\/[A-Za-z0-9._ -]+(?:\/[A-Za-z0-9._ -]+)*\.webp$/.test(path) ||
    /^art\/products\/[A-Za-z0-9._ -]+\.webp$/.test(path) ||
    isMapLayoutPath(path) || isMapChunkPath(path) ||
    /^map\/fonts\/[A-Za-z0-9._ -]+(?:\/[A-Za-z0-9._ -]+)*\.pbf$/.test(path);
}

function expectedFileUrl(path: string, releaseId: string) {
  return `${CONTENT_CDN_ORIGIN}/releases/${releaseId}/${encodeLogicalPath(path)}`;
}

function parseFile(value: unknown, releaseId: string, index: number): ContentFile {
  const label = `manifest.files[${index}]`;
  const entry = record(value, label);
  requireKeys(entry, ["path", "key", "url", "sha256", "byte_size", "content_type"], label);
  const path = string(entry.path, `${label}.path`);
  assertSafeLogicalPath(path);
  if (!isSupportedManifestPath(path)) throw new ContentValidationError(`${label}.path is outside the supported content inventory`);
  const key = string(entry.key, `${label}.key`);
  if (key !== `releases/${releaseId}/${path}`) throw new ContentValidationError(`${label}.key is not release-scoped`);
  const url = string(entry.url, `${label}.url`);
  if (url !== expectedFileUrl(path, releaseId)) throw new ContentValidationError(`${label}.url is outside the approved CDN release path`);
  const sha256 = string(entry.sha256, `${label}.sha256`);
  if (!SHA256.test(sha256)) throw new ContentValidationError(`${label}.sha256 is invalid`);
  const byte_size = positiveInteger(entry.byte_size, `${label}.byte_size`);
  const content_type = string(entry.content_type, `${label}.content_type`);
  if (content_type !== expectedContentType(path)) throw new ContentValidationError(`${label}.content_type does not match its path`);
  return { path, key, url, sha256, byte_size, content_type };
}

export function parseContentChannel(value: unknown, environment: ContentEnvironment): ContentChannel {
  const channel = record(value, "content channel");
  requireKeys(channel, ["schema", "environment", "generation", "releaseId", "manifestUrl", "manifestSha256", "minimumReaderVersion"], "content channel");
  if (channel.schema !== "parkdex.content-channel/v1") throw new ContentValidationError("content channel schema is unsupported");
  if (channel.environment !== environment) throw new ContentValidationError("content channel environment does not match this build");
  const generation = positiveInteger(channel.generation, "content channel generation");
  const releaseId = string(channel.releaseId, "content channel releaseId");
  if (!SHA256.test(releaseId)) throw new ContentValidationError("content channel releaseId is invalid");
  const manifestUrl = string(channel.manifestUrl, "content channel manifestUrl");
  if (manifestUrl !== `${CONTENT_CDN_ORIGIN}/releases/${releaseId}/manifest.json`) {
    throw new ContentValidationError("content channel manifestUrl is outside the approved CDN release path");
  }
  const manifestSha256 = string(channel.manifestSha256, "content channel manifestSha256");
  if (!SHA256.test(manifestSha256)) throw new ContentValidationError("content channel manifestSha256 is invalid");
  const minimumReaderVersion = positiveInteger(channel.minimumReaderVersion, "content channel minimumReaderVersion");
  if (minimumReaderVersion > CONTENT_READER_VERSION) throw new ContentValidationError("content release requires a newer app version");
  return { schema: "parkdex.content-channel/v1", environment, generation, releaseId, manifestUrl, manifestSha256, minimumReaderVersion };
}

export function parseContentManifest(value: unknown, channel: ContentChannel): ContentManifest {
  const manifest = record(value, "content manifest");
  requireKeys(manifest, ["version", "sourceCommit", "cdnOrigin", "files", "parkIds", "boundaryIds", "mapManifest"], "content manifest");
  const version = string(manifest.version, "manifest.version");
  if (version !== channel.releaseId || !SHA256.test(version)) throw new ContentValidationError("manifest version does not match the published release");
  const sourceCommit = string(manifest.sourceCommit, "manifest.sourceCommit");
  if (!COMMIT.test(sourceCommit)) throw new ContentValidationError("manifest sourceCommit is invalid");
  if (manifest.cdnOrigin !== CONTENT_CDN_ORIGIN) throw new ContentValidationError("manifest CDN origin is not approved");
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) throw new ContentValidationError("manifest.files must be a non-empty array");
  const files = manifest.files.map((entry, index) => parseFile(entry, version, index));
  const paths = new Set(files.map((file) => file.path));
  if (paths.size !== files.length) throw new ContentValidationError("manifest contains duplicate file paths");
  const hashSizes = new Map<string, number>();
  for (const file of files) {
    const knownSize = hashSizes.get(file.sha256);
    if (knownSize !== undefined && knownSize !== file.byte_size) throw new ContentValidationError("one file hash is declared with multiple sizes");
    hashSizes.set(file.sha256, file.byte_size);
  }
  for (const required of ["data/parks.json", "data/drive.json", "boundaries.geojson"]) {
    if (!paths.has(required)) throw new ContentValidationError(`manifest is missing ${required}`);
  }
  if (!files.some((file) => isMapLayoutPath(file.path))) throw new ContentValidationError("manifest is missing its map chunk layout");
  const parkIds = uniqueStringArray(manifest.parkIds, "manifest.parkIds", PARK_ID);
  const boundaryIds = uniqueStringArray(manifest.boundaryIds, "manifest.boundaryIds", PARK_ID);
  const mapManifestValue = record(manifest.mapManifest, "manifest.mapManifest");
  requireKeys(mapManifestValue, ["size", "chunkBytes", "count"], "manifest.mapManifest");
  const mapManifest = {
    size: positiveInteger(mapManifestValue.size, "manifest.mapManifest.size"),
    chunkBytes: positiveInteger(mapManifestValue.chunkBytes, "manifest.mapManifest.chunkBytes"),
    count: positiveInteger(mapManifestValue.count, "manifest.mapManifest.count"),
  };
  if (mapManifest.count !== Math.ceil(mapManifest.size / mapManifest.chunkBytes)) throw new ContentValidationError("map manifest chunk count does not match its size");
  assertMapChunks(files, mapManifest, "map chunk inventory does not match its manifest");
  if (!files.some((file) => file.path.startsWith("map/fonts/") && file.path.endsWith(".pbf"))) {
    throw new ContentValidationError("manifest is missing map glyphs");
  }
  // The old release published copies of Kip and product artwork. Accept those
  // immutable inventory entries, while the runtime's remote path policy skips them.
  for (const file of files) {
    if (!isRemoteContentPath(file.path) && !file.path.startsWith("art/kip/") && !file.path.startsWith("art/products/")) {
      throw new ContentValidationError("manifest contains an unsupported non-runtime file");
    }
  }
  return { version, sourceCommit, cdnOrigin: CONTENT_CDN_ORIGIN, files, parkIds, boundaryIds, mapManifest };
}

export function parseJsonBytes(bytes: ArrayBuffer): unknown {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    throw new ContentValidationError("content file is not valid UTF-8 JSON");
  }
}

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function assertFileBytes(file: ContentFile, bytes: ArrayBuffer) {
  if (bytes.byteLength !== file.byte_size) throw new ContentValidationError(`${file.path} has an unexpected byte length`);
  if ((await sha256Hex(bytes)) !== file.sha256) throw new ContentValidationError(`${file.path} failed SHA-256 verification`);
}

function validatePark(value: unknown, index: number): Park {
  const label = `data/parks.json[${index}]`;
  const park = record(value, label);
  requireKeys(park, PARK_FIELDS, label);
  const id = string(park.id, `${label}.id`);
  if (!PARK_ID.test(id)) throw new ContentValidationError(`${label}.id is invalid`);
  const name = string(park.name, `${label}.name`);
  const short = string(park.short, `${label}.short`);
  const category = knownOr<Park["category"]>(CATEGORIES, string(park.category, `${label}.category`), FALLBACK_CATEGORY);
  const region = string(park.region, `${label}.region`, false);
  const biome = parkBiome(string(park.biome, `${label}.biome`));
  const shape = knownOr<Park["shape"]>(SHAPES, string(park.shape, `${label}.shape`), FALLBACK_SHAPE);
  const rarity = knownOr<Park["rarity"]>(RARITIES, string(park.rarity, `${label}.rarity`), FALLBACK_RARITY);
  const lat = finiteNumber(park.lat, `${label}.lat`, -90, 90);
  const lng = finiteNumber(park.lng, `${label}.lng`, -180, 180);
  if (typeof park.seed !== "number" || !Number.isSafeInteger(park.seed)) throw new ContentValidationError(`${label}.seed must be an integer`);
  const blurb = string(park.blurb, `${label}.blurb`, false);
  let scene: string | null;
  if (park.scene === null) scene = null;
  else {
    scene = string(park.scene, `${label}.scene`);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(scene)) throw new ContentValidationError(`${label}.scene is invalid`);
  }
  // Optional: older servers and cached rows omit it, and a bad link falls back to the pin.
  const link = park.googleMapsUrl;
  const googleMapsUrl = typeof link === "string" && link.length <= 2048 && GOOGLE_MAPS_URL.test(link) ? link : null;
  const coordinate = (value: unknown, limit: number) => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= limit ? value : null;
  let trailheadLat = coordinate(park.trailheadLat, 90);
  let trailheadLng = coordinate(park.trailheadLng, 180);
  if (trailheadLat === null || trailheadLng === null) trailheadLat = trailheadLng = null;
  const checked: Park = { id, name, short, category, region, lat, lng, biome, shape, rarity, seed: park.seed, blurb, scene };
  if (googleMapsUrl !== null) checked.googleMapsUrl = googleMapsUrl;
  if (trailheadLat !== null && trailheadLng !== null) Object.assign(checked, { trailheadLat, trailheadLng });
  return checked;
}

export function validateParkRecord(value: unknown, label = "park"): Park {
  void label;
  return validatePark(value, 0);
}

function validateCoordinates(value: unknown, label: string) {
  if (!Array.isArray(value) || value.length < 4) throw new ContentValidationError(`${label} must be a closed ring`);
  let first: unknown[] | null = null;
  let last: unknown[] | null = null;
  for (let index = 0; index < value.length; index++) {
    const position = value[index];
    if (!Array.isArray(position) || position.length < 2) throw new ContentValidationError(`${label}[${index}] is not a GeoJSON position`);
    finiteNumber(position[0], `${label}[${index}].longitude`, -180, 180);
    finiteNumber(position[1], `${label}[${index}].latitude`, -90, 90);
    for (let coordinate = 2; coordinate < position.length; coordinate++) {
      if (typeof position[coordinate] !== "number" || !Number.isFinite(position[coordinate])) throw new ContentValidationError(`${label}[${index}] has a non-finite coordinate`);
    }
    if (index === 0) first = position;
    if (index === value.length - 1) last = position;
  }
  if (!first || !last || first.length !== last.length || first.some((coordinate, index) => coordinate !== last![index])) {
    throw new ContentValidationError(`${label} is not closed`);
  }
}

function validateBoundaries(value: unknown, parks: Park[], manifest: ContentManifest, partial = false): ContentBoundaries {
  const collection = record(value, "boundaries.geojson");
  requireKeys(collection, ["type", "features"], "boundaries.geojson");
  if (collection.type !== "FeatureCollection" || !Array.isArray(collection.features)) {
    throw new ContentValidationError("boundaries.geojson must be a FeatureCollection");
  }
  const parkById = new Map(parks.map((park) => [park.id, park]));
  const seen = new Set<string>();
  const features = collection.features.map((rawFeature, index) => {
    const label = `boundaries.geojson.features[${index}]`;
    const feature = record(rawFeature, label);
    requireKeys(feature, ["type", "properties", "geometry"], label);
    if (feature.type !== "Feature") throw new ContentValidationError(`${label}.type is invalid`);
    const properties = record(feature.properties, `${label}.properties`);
    requireKeys(properties, ["id", "biome"], `${label}.properties`);
    const id = string(properties.id, `${label}.properties.id`);
    const biome = parkBiome(string(properties.biome, `${label}.properties.biome`));
    if (!parkById.has(id) || seen.has(id)) throw new ContentValidationError(`${label} references a missing or duplicate park`);
    if (parkById.get(id)!.biome !== biome) throw new ContentValidationError(`${label} biome does not match its park`);
    seen.add(id);
    const geometry = record(feature.geometry, `${label}.geometry`);
    requireKeys(geometry, ["type", "coordinates"], `${label}.geometry`);
    if (geometry.type !== "MultiPolygon" || !Array.isArray(geometry.coordinates) || geometry.coordinates.length === 0) {
      throw new ContentValidationError(`${label}.geometry must be a non-empty MultiPolygon`);
    }
    geometry.coordinates.forEach((polygon, polygonIndex) => {
      if (!Array.isArray(polygon) || polygon.length === 0) throw new ContentValidationError(`${label} has an empty polygon`);
      polygon.forEach((ring, ringIndex) => validateCoordinates(ring, `${label}.geometry.coordinates[${polygonIndex}][${ringIndex}]`));
    });
    // Rebuild from known fields so later additions never reach the map layers.
    return {
      type: "Feature",
      properties: { id, biome },
      geometry: { type: "MultiPolygon", coordinates: geometry.coordinates },
    } as ContentBoundaries["features"][number];
  });
  if (partial) {
    // A lean catalogue keeps some boundaries; they are stored in park order.
    const order = new Map(parks.map((park, index) => [park.id, index]));
    features.sort((a, b) => order.get(a.properties.id)! - order.get(b.properties.id)!);
    return { type: "FeatureCollection", features };
  }
  if (seen.size !== parks.length) throw new ContentValidationError("boundary park references do not match the catalog");
  if (!sameOrderedIds(features.map((feature) => feature.properties.id), manifest.boundaryIds)) {
    throw new ContentValidationError("boundary ids do not match the immutable manifest order");
  }
  return { type: "FeatureCollection", features };
}

export function validateBoundaryFeature(value: unknown, park: Park, label = "boundary"): ContentBoundaries["features"][number] {
  const manifest: ContentManifest = {
    version: "0".repeat(64), sourceCommit: "0".repeat(40), cdnOrigin: CONTENT_CDN_ORIGIN,
    files: [], parkIds: [park.id], boundaryIds: [park.id], mapManifest: { size: 1, chunkBytes: 1, count: 1 },
  };
  const parsed = validateBoundaries({ type: "FeatureCollection", features: [value] }, [park], manifest);
  const feature = parsed.features[0];
  if (!feature) throw new ContentValidationError(`${label} is missing`);
  return feature;
}

function validateDrive(value: unknown, parks: Park[]): DriveData {
  const drive = record(value, "data/drive.json");
  requireKeys(drive, ["hubs", "parks"], "data/drive.json");
  if (!Array.isArray(drive.hubs) || !drive.hubs.length) throw new ContentValidationError("data/drive.json hubs must be a non-empty array");
  const hubs = drive.hubs.map((rawHub, index) => {
    const label = `data/drive.json.hubs[${index}]`;
    const hub = record(rawHub, label);
    requireKeys(hub, ["name", "lng", "lat"], label);
    return { name: string(hub.name, `${label}.name`), lng: finiteNumber(hub.lng, `${label}.lng`, -180, 180), lat: finiteNumber(hub.lat, `${label}.lat`, -90, 90) };
  });
  const rawParks = record(drive.parks, "data/drive.json.parks");
  const parkIds = parks.map((park) => park.id);
  if (Object.keys(rawParks).length !== parkIds.length || parkIds.some((id) => !(id in rawParks))) {
    throw new ContentValidationError("drive park references do not match the catalog");
  }
  const driveParks: DriveData["parks"] = {};
  for (const id of parkIds) {
    const rawData = record(rawParks[id], `data/drive.json.parks.${id}`);
    requireKeys(rawData, ["drive", "walkM"], `data/drive.json.parks.${id}`);
    if (!Array.isArray(rawData.drive) || rawData.drive.length !== hubs.length) throw new ContentValidationError(`drive routes for ${id} do not match the hub count`);
    const routes = rawData.drive.map((route, index): [number, number] | null => {
      if (route === null) return null;
      if (!Array.isArray(route) || route.length !== 2) throw new ContentValidationError(`drive route ${id}[${index}] is invalid`);
      return [finiteNumber(route[0], `drive route ${id}[${index}].distance`, 0, Number.MAX_SAFE_INTEGER), finiteNumber(route[1], `drive route ${id}[${index}].minutes`, 0, Number.MAX_SAFE_INTEGER)];
    });
    driveParks[id] = { drive: routes, walkM: finiteNumber(rawData.walkM, `drive walk distance ${id}`, 0, Number.MAX_SAFE_INTEGER) };
  }
  return { hubs, parks: driveParks };
}

export function validateDriveEntry(value: unknown, hubCount: number, label = "drive entry"): DriveData["parks"][string] {
  const data = record(value, label);
  requireKeys(data, ["drive", "walkM"], label);
  if (!Array.isArray(data.drive) || data.drive.length !== hubCount) throw new ContentValidationError(`${label}.drive does not match the hub count`);
  const drive = data.drive.map((route, index): [number, number] | null => {
    if (route === null) return null;
    if (!Array.isArray(route) || route.length !== 2) throw new ContentValidationError(`${label}.drive[${index}] is invalid`);
    return [
      finiteNumber(route[0], `${label}.drive[${index}].distance`, 0, Number.MAX_SAFE_INTEGER),
      finiteNumber(route[1], `${label}.drive[${index}].minutes`, 0, Number.MAX_SAFE_INTEGER),
    ];
  });
  return { drive, walkM: finiteNumber(data.walkM, `${label}.walkM`, 0, Number.MAX_SAFE_INTEGER) };
}

export function validateHubs(value: unknown, label = "drive.hubs"): DriveData["hubs"] {
  if (!Array.isArray(value) || !value.length) throw new ContentValidationError(`${label} must be a non-empty array`);
  return value.map((rawHub, index) => {
    const hubLabel = `${label}[${index}]`;
    const hub = record(rawHub, hubLabel);
    requireKeys(hub, ["name", "lng", "lat"], hubLabel);
    return {
      name: string(hub.name, `${hubLabel}.name`),
      lng: finiteNumber(hub.lng, `${hubLabel}.lng`, -180, 180),
      lat: finiteNumber(hub.lat, `${hubLabel}.lat`, -90, 90),
    };
  });
}

function sameOrderedIds(left: string[], right: string[]) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

export function validateContentPayload(
  parksValue: unknown,
  boundariesValue: unknown,
  driveValue: unknown,
  manifest: ContentManifest,
  options: { partialBoundaries?: boolean } = {},
): ContentPayload {
  if (!Array.isArray(parksValue) || parksValue.length === 0) throw new ContentValidationError("data/parks.json must be a non-empty array");
  const parks = parksValue.map(validatePark);
  const parkIds = parks.map((park) => park.id);
  if (new Set(parkIds).size !== parkIds.length || !sameOrderedIds(parkIds, manifest.parkIds)) {
    throw new ContentValidationError("park ids do not match the immutable manifest order");
  }
  const files = new Set(manifest.files.map((file) => file.path));
  const scenes = new Set(manifest.files.filter((file) => file.path.startsWith("art/badges/scenes/")).map((file) => file.path));
  const referencedScenes = new Set<string>();
  for (const park of parks) {
    if (park.scene) {
      const path = `art/badges/scenes/${park.scene}.webp`;
      if (!files.has(path)) throw new ContentValidationError(`park ${park.id} references missing badge art`);
      referencedScenes.add(path);
    }
  }
  if (scenes.size !== referencedScenes.size || [...scenes].some((path) => !referencedScenes.has(path))) {
    throw new ContentValidationError("badge scene inventory does not match the park catalog");
  }
  const boundaries = validateBoundaries(boundariesValue, parks, manifest, options.partialBoundaries === true);
  const drive = validateDrive(driveValue, parks);
  return { parks, boundaries, drive };
}

function syncValidationManifest(assets: ContentFile[], parks: Park[]): ContentManifest {
  return {
    version: "0".repeat(64),
    sourceCommit: "0".repeat(40),
    cdnOrigin: CONTENT_CDN_ORIGIN,
    files: assets,
    parkIds: parks.map((park) => park.id),
    boundaryIds: parks.map((park) => park.id),
    mapManifest: { size: 1, chunkBytes: 1, count: 1 },
  };
}

export function validateContentSyncState(value: ContentSyncState): ContentSyncState {
  const revision = nonNegativeSafeInteger(value.revision, "sync revision");
  if (!Array.isArray(value.parks)) throw new ContentValidationError("snapshot.parks must be an array");
  const parks = value.parks.map((park, index) => validatePark(park, index));
  if (new Set(parks.map((park) => park.id)).size !== parks.length) throw new ContentValidationError("snapshot contains duplicate park ids");
  if (!Array.isArray(value.assets)) throw new ContentValidationError("snapshot.assets must be an array");
  const assets = value.assets.map((file, index) => parseSyncFile(file, `snapshot.assets[${index}]`, (path) => /^art\/badges\/scenes\/[a-z0-9][a-z0-9-]*\.webp$/.test(path)));
  if (new Set(assets.map((file) => file.path)).size !== assets.length) throw new ContentValidationError("snapshot.assets contains duplicate paths");
  let payload: ContentPayload;
  if (parks.length === 0) {
    const boundaries = record(value.boundaries, "snapshot.boundaries");
    requireKeys(boundaries, ["type", "features"], "snapshot.boundaries");
    if (boundaries.type !== "FeatureCollection" || !Array.isArray(boundaries.features) || boundaries.features.length !== 0) {
      throw new ContentValidationError("empty catalog boundaries must be an empty FeatureCollection");
    }
    const drive = record(value.drive, "snapshot.drive");
    requireKeys(drive, ["hubs", "parks"], "snapshot.drive");
    const hubs = validateHubs(drive.hubs, "snapshot.drive.hubs");
    const driveParks = record(drive.parks, "snapshot.drive.parks");
    if (Object.keys(driveParks).length !== 0 || assets.length !== 0) throw new ContentValidationError("empty catalog cannot contain drive rows or scene assets");
    payload = { parks: [], boundaries: { type: "FeatureCollection", features: [] }, drive: { hubs, parks: {} } };
  } else {
    payload = validateContentPayload(
      parks, value.boundaries, { hubs: value.drive?.hubs, parks: value.drive?.parks }, syncValidationManifest(assets, parks),
      { partialBoundaries: value.catalogue !== undefined },
    );
  }
  const map = parseMapPointer(value.map);
  const sourceId = value.sourceId === undefined ? undefined : string(value.sourceId, "sync source ID");
  const catalogue = value.catalogue === undefined ? undefined : parseCatalogueCache(value.catalogue, payload);
  return { revision, ...(sourceId ? { sourceId } : {}), parks: payload.parks, boundaries: payload.boundaries, drive: payload.drive, assets, map, ...(catalogue ? { catalogue } : {}) };
}

function parseBbox(value: unknown, label: string): [number, number, number, number] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length !== 4 || value.some((entry) => typeof entry !== "number" || !Number.isFinite(entry))) {
    throw new ContentValidationError(`${label} must be four finite numbers`);
  }
  const [west, south, east, north] = value as [number, number, number, number];
  if (west > east || south > north) throw new ContentValidationError(`${label} is inverted`);
  return [west, south, east, north];
}

function parseChunkRef(value: unknown, label: string): CatalogueChunkRef {
  const chunk = record(value, label);
  requireKeys(chunk, ["path", "url", "sha256", "byte_size", "parkIds", "bbox"], label);
  const path = string(chunk.path, `${label}.path`);
  if (!CATALOGUE_CHUNK_PATH.test(path)) throw new ContentValidationError(`${label}.path is not a boundary chunk`);
  const url = string(chunk.url, `${label}.url`);
  if (!url.startsWith(`${CONTENT_CDN_ORIGIN}/releases/`) || !url.endsWith(`/${path}`)) throw new ContentValidationError(`${label}.url is outside its release`);
  const sha256 = string(chunk.sha256, `${label}.sha256`);
  if (!SHA256.test(sha256)) throw new ContentValidationError(`${label}.sha256 is invalid`);
  const byteSize = positiveInteger(chunk.byte_size, `${label}.byte_size`);
  if (byteSize > MAX_CATALOGUE_FILE_BYTES) throw new ContentValidationError(`${label} is too large`);
  return { path, url, sha256, byte_size: byteSize, parkIds: uniqueStringArray(chunk.parkIds, `${label}.parkIds`, PARK_ID), bbox: parseBbox(chunk.bbox, `${label}.bbox`) };
}

/** A stored lean catalogue: its chunks, which of them are on the device, and the boundaries changes pinned. */
function parseCatalogueCache(value: unknown, payload: ContentPayload): CatalogueCache {
  const cache = record(value, "catalogue cache");
  requireKeys(cache, ["version", "revision", "chunks", "loaded", "pinned"], "catalogue cache");
  const version = string(cache.version, "catalogue cache version");
  if (!SHA256.test(version)) throw new ContentValidationError("catalogue cache version is invalid");
  const revision = nonNegativeSafeInteger(cache.revision, "catalogue cache revision");
  if (!Array.isArray(cache.chunks)) throw new ContentValidationError("catalogue cache chunks must be an array");
  const chunks = cache.chunks.map((chunk, index) => parseChunkRef(chunk, `catalogue cache chunks[${index}]`));
  const paths = new Set(chunks.map((chunk) => chunk.path));
  if (paths.size !== chunks.length) throw new ContentValidationError("catalogue cache lists a chunk twice");
  const loaded = Array.isArray(cache.loaded) && cache.loaded.length === 0 ? [] : uniqueStringArray(cache.loaded, "catalogue cache loaded");
  if (loaded.some((path) => !paths.has(path))) throw new ContentValidationError("catalogue cache loaded an unknown chunk");
  const parkIds = new Set(payload.parks.map((park) => park.id));
  const boundaryIds = new Set(payload.boundaries.features.map((feature) => feature.properties.id));
  // A pin only matters while its park and boundary exist.
  const pins = Array.isArray(cache.pinned) && cache.pinned.length === 0 ? [] : uniqueStringArray(cache.pinned, "catalogue cache pinned");
  const pinned = pins.filter((id) => parkIds.has(id) && boundaryIds.has(id));
  return { version, revision, chunks, loaded, pinned };
}

// A park this build cannot read is left out with its boundary, drive row and
// badge art, so one bad record never blanks the whole catalogue. A record
// without a readable id cannot be reconciled and still fails the sync.
function readableParks(values: unknown[], label: string): { parks: Park[]; skipped: Set<string> } {
  const parks: Park[] = [];
  const skipped = new Set<string>();
  values.forEach((value, index) => {
    try {
      parks.push(validatePark(value, index));
    } catch (error) {
      const id = value !== null && typeof value === "object" ? (value as Record<string, unknown>).id : undefined;
      if (!(error instanceof ContentValidationError) || typeof id !== "string" || !PARK_ID.test(id)) throw error;
      console.warn(`${label}[${index}] skipped: ${error.message}`);
      skipped.add(id);
    }
  });
  if (values.length > 0 && parks.length === 0) throw new ContentValidationError(`${label} has no readable parks`);
  return { parks, skipped };
}

function withoutSkippedParks(snapshot: Record<string, unknown>, parks: Park[], skipped: Set<string>) {
  const boundaries = snapshot.boundaries as ContentBoundaries;
  const drive = snapshot.drive as DriveData;
  const scenes = new Set(parks.flatMap((park) => park.scene ? [`art/badges/scenes/${park.scene}.webp`] : []));
  const assets = Array.isArray(snapshot.assets) ? snapshot.assets as ContentFile[] : [];
  if (skipped.size === 0) return { boundaries, drive, assets };
  return {
    boundaries: boundaries && Array.isArray(boundaries.features)
      ? { ...boundaries, features: boundaries.features.filter((feature) => !skipped.has(feature?.properties?.id)) }
      : boundaries,
    drive: drive && drive.parks && typeof drive.parks === "object"
      ? { ...drive, parks: Object.fromEntries(Object.entries(drive.parks).filter(([id]) => !skipped.has(id))) }
      : drive,
    assets: assets.filter((file) => scenes.has(file?.path)),
  };
}

export function parseContentSnapshot(value: unknown, catalogue?: CatalogueCache): ContentSyncState {
  const snapshot = record(value, "content snapshot");
  requireKeys(snapshot, ["schema", "revision", "parks", "boundaries", "drive", "assets", "map"], "content snapshot");
  if (snapshot.schema !== "parkdex.content-sync/v1") throw new ContentValidationError("content snapshot schema is unsupported");
  if (!Array.isArray(snapshot.parks)) throw new ContentValidationError("snapshot.parks must be an array");
  const { parks, skipped } = readableParks(snapshot.parks, "snapshot.parks");
  const rest = withoutSkippedParks(snapshot, parks, skipped);
  const state: ContentSyncState = {
    revision: nonNegativeSafeInteger(snapshot.revision, "snapshot.revision"),
    parks,
    boundaries: rest.boundaries,
    drive: rest.drive,
    // Later releases may publish other asset kinds; this build only stores badge scenes.
    assets: rest.assets.filter((file) => typeof file?.path === "string" && SCENE_ASSET_PATH.test(file.path)),
    map: parseMapPointer(snapshot.map),
    ...(catalogue ? { catalogue } : {}),
  };
  return validateContentSyncState(state);
}

const CATALOGUE_SCHEMA = "parkdex.content-catalogue/v1";
const BOUNDARY_CHUNK_SCHEMA = "parkdex.content-boundaries/v1";
const CATALOGUE_CHUNK_PATH = /^catalogue\/boundaries\/[a-z0-9-]+\.json$/;
const MAX_CATALOGUE_FILE_BYTES = 4 * 1024 * 1024;

/** A CDN catalogue release named by a reader 3 snapshot response. */
export type ContentCataloguePointer = {
  revision: number;
  version: string;
  indexUrl: string;
  indexSha256: string;
  indexBytes: number;
  parkCount: number;
};
export type ContentCatalogueChunk = ContentFile & { parkIds: string[]; bbox?: [number, number, number, number] | null };
export type ContentCatalogueIndex = {
  pointer: ContentCataloguePointer;
  body: Record<string, unknown>;
  chunks: ContentCatalogueChunk[];
};

/**
 * Newer readers may get a pointer to an immutable CDN catalogue instead of parks,
 * because the full catalogue is larger than one API response. Null means the
 * body is an ordinary snapshot.
 */
export function parseCatalogueSnapshotPointer(value: unknown): ContentCataloguePointer | null {
  const body = record(value, "content snapshot");
  if (!Object.hasOwn(body, "catalogue")) return null;
  if (body.schema !== "parkdex.content-sync/v1") throw new ContentValidationError("content snapshot schema is unsupported");
  const revision = nonNegativeSafeInteger(body.revision, "snapshot.revision");
  const catalogue = record(body.catalogue, "snapshot.catalogue");
  requireKeys(catalogue, ["schema", "version", "indexUrl", "indexSha256", "indexBytes", "parkCount"], "snapshot.catalogue");
  if (catalogue.schema !== CATALOGUE_SCHEMA) throw new ContentValidationError("content catalogue schema is unsupported");
  const version = string(catalogue.version, "snapshot.catalogue.version");
  if (!SHA256.test(version)) throw new ContentValidationError("snapshot.catalogue.version is invalid");
  const indexUrl = `${CONTENT_CDN_ORIGIN}/releases/${version}/catalogue/index.json`;
  if (catalogue.indexUrl !== indexUrl) throw new ContentValidationError("snapshot.catalogue.indexUrl is not the release index");
  const indexSha256 = string(catalogue.indexSha256, "snapshot.catalogue.indexSha256");
  if (!SHA256.test(indexSha256)) throw new ContentValidationError("snapshot.catalogue.indexSha256 is invalid");
  const indexBytes = positiveInteger(catalogue.indexBytes, "snapshot.catalogue.indexBytes");
  if (indexBytes > MAX_CATALOGUE_FILE_BYTES) throw new ContentValidationError("snapshot.catalogue index is too large");
  const parkCount = nonNegativeSafeInteger(catalogue.parkCount, "snapshot.catalogue.parkCount");
  return { revision, version, indexUrl, indexSha256, indexBytes, parkCount };
}

export function catalogueIndexFile(pointer: ContentCataloguePointer): ContentFile {
  return {
    path: "catalogue/index.json",
    key: `releases/${pointer.version}/catalogue/index.json`,
    url: pointer.indexUrl,
    sha256: pointer.indexSha256,
    byte_size: pointer.indexBytes,
    content_type: "application/json",
  };
}

export function parseCatalogueIndex(value: unknown, pointer: ContentCataloguePointer): ContentCatalogueIndex {
  const body = record(value, "catalogue index");
  requireKeys(body, ["schema", "revision", "parks", "drive", "assets", "map", "boundaryChunks"], "catalogue index");
  if (body.schema !== CATALOGUE_SCHEMA) throw new ContentValidationError("catalogue index schema is unsupported");
  if (body.revision !== pointer.revision) throw new ContentValidationError("catalogue index revision does not match its pointer");
  if (!Array.isArray(body.parks) || body.parks.length !== pointer.parkCount) throw new ContentValidationError("catalogue index park count does not match its pointer");
  if (!Array.isArray(body.boundaryChunks) || body.boundaryChunks.length === 0) throw new ContentValidationError("catalogue index has no boundary chunks");
  const seen = new Set<string>();
  const chunks = body.boundaryChunks.map((raw, index): ContentCatalogueChunk => {
    const label = `catalogue.boundaryChunks[${index}]`;
    const chunk = record(raw, label);
    requireKeys(chunk, ["path", "sha256", "byte_size", "parkIds"], label);
    const path = string(chunk.path, `${label}.path`);
    assertSafeLogicalPath(path);
    if (!CATALOGUE_CHUNK_PATH.test(path)) throw new ContentValidationError(`${label}.path is not a boundary chunk`);
    const sha256 = string(chunk.sha256, `${label}.sha256`);
    if (!SHA256.test(sha256)) throw new ContentValidationError(`${label}.sha256 is invalid`);
    const byteSize = positiveInteger(chunk.byte_size, `${label}.byte_size`);
    if (byteSize > MAX_CATALOGUE_FILE_BYTES) throw new ContentValidationError(`${label} is too large`);
    const parkIds = uniqueStringArray(chunk.parkIds, `${label}.parkIds`, PARK_ID);
    for (const id of parkIds) {
      if (seen.has(id)) throw new ContentValidationError(`catalogue boundary ${id} is in more than one chunk`);
      seen.add(id);
    }
    const key = `releases/${pointer.version}/${path}`;
    // Releases list each chunk's area. The app picks chunks by their parks, so a missing area is not an error.
    let bbox: [number, number, number, number] | null = null;
    try { bbox = parseBbox(chunk.bbox, `${label}.bbox`); } catch { bbox = null; }
    return { path, key, url: `${CONTENT_CDN_ORIGIN}/${encodeLogicalPath(key)}`, sha256, byte_size: byteSize, content_type: "application/json", parkIds, bbox };
  });
  return { pointer, body, chunks };
}

export function parseCatalogueChunk(value: unknown, chunk: ContentCatalogueChunk): unknown[] {
  const body = record(value, chunk.path);
  requireKeys(body, ["schema", "features"], chunk.path);
  if (body.schema !== BOUNDARY_CHUNK_SCHEMA) throw new ContentValidationError(`${chunk.path} schema is unsupported`);
  if (!Array.isArray(body.features) || body.features.length !== chunk.parkIds.length) throw new ContentValidationError(`${chunk.path} does not match its park list`);
  const expected = new Set(chunk.parkIds);
  for (const feature of body.features) {
    const id = record(record(feature, `${chunk.path} feature`).properties, `${chunk.path} feature properties`).id;
    if (typeof id !== "string" || !expected.delete(id)) throw new ContentValidationError(`${chunk.path} has an unexpected boundary`);
  }
  return body.features;
}

/** The catalogue as one snapshot, checked exactly as an API snapshot would be. */
export function assembleCatalogueSnapshot(index: ContentCatalogueIndex, chunkFeatures: unknown[][]): ContentSyncState {
  // Chunks group boundaries by area; a snapshot lists them in park order.
  const features = chunkFeatures.flat();
  const byId = new Map(features.map((feature) => [(feature as { properties: { id: string } }).properties.id, feature]));
  const ordered = (index.body.parks as unknown[]).map((park) => byId.get(String(record(park, "catalogue park").id)));
  const used = new Set(ordered);
  const leftover = features.filter((feature) => !used.has(feature));
  return parseContentSnapshot({
    schema: "parkdex.content-sync/v1",
    revision: index.pointer.revision,
    parks: index.body.parks,
    boundaries: { type: "FeatureCollection", features: [...ordered.filter((feature) => feature !== undefined), ...leftover] },
    drive: index.body.drive,
    assets: index.body.assets,
    map: index.body.map,
  });
}

/**
 * The catalogue with only some boundary chunks: every park, drive time and badge
 * descriptor from the index, and the boundaries of the chunks given. The other chunks
 * are remembered so their boundaries can load later.
 */
export function assembleLeanCatalogue(index: ContentCatalogueIndex, loaded: ReadonlyMap<string, unknown[]>): ContentSyncState {
  const chunks: CatalogueChunkRef[] = index.chunks.map((chunk) => ({
    path: chunk.path, url: chunk.url, sha256: chunk.sha256, byte_size: chunk.byte_size, parkIds: [...chunk.parkIds], bbox: chunk.bbox ?? null,
  }));
  const catalogue: CatalogueCache = {
    version: index.pointer.version,
    revision: index.pointer.revision,
    chunks,
    loaded: chunks.filter((chunk) => loaded.has(chunk.path)).map((chunk) => chunk.path),
    pinned: [],
  };
  const parkIds = new Set((index.body.parks as unknown[]).map((park) => String(record(park, "catalogue park").id)));
  const features = [...loaded.values()].flat().filter((feature) => parkIds.has(featureId(feature)));
  return parseContentSnapshot({
    schema: "parkdex.content-sync/v1",
    revision: index.pointer.revision,
    parks: index.body.parks,
    boundaries: { type: "FeatureCollection", features },
    drive: index.body.drive,
    assets: index.body.assets,
    map: index.body.map,
  }, catalogue);
}

function featureId(feature: unknown): string {
  return String((feature as { properties?: { id?: unknown } } | null)?.properties?.id);
}

/**
 * Add the boundaries of chunks loaded on demand and mark them, and every chunk in
 * `used`, as just used. A boundary already on the device is kept, because it is at
 * least as new as the release's copy (it may have changed after the release).
 */
export function mergeCatalogueChunks(state: ContentSyncState, loaded: ReadonlyMap<string, unknown[]>, used: readonly string[] = []): ContentSyncState {
  const catalogue = state.catalogue;
  if (!catalogue) throw new ContentValidationError("only a lean catalogue loads boundaries by chunk");
  const known = new Set(catalogue.chunks.map((chunk) => chunk.path));
  const parks = new Map(state.parks.map((park) => [park.id, park]));
  const present = new Set(state.boundaries.features.map((feature) => feature.properties.id));
  const added: ContentBoundaries["features"] = [];
  for (const [path, features] of loaded) {
    if (!known.has(path)) throw new ContentValidationError(`${path} is not part of this catalogue`);
    for (const raw of features) {
      const id = featureId(raw);
      const park = parks.get(id);
      if (!park || present.has(id)) continue;
      added.push(validateBoundaryFeature(raw, park, `${path} boundary ${id}`));
      present.add(id);
    }
  }
  const stored = new Set([...catalogue.loaded, ...loaded.keys()]);
  const touched = [...new Set([...used, ...loaded.keys()])].filter((path) => stored.has(path));
  const touchedSet = new Set(touched);
  const order = [...catalogue.loaded.filter((path) => !touchedSet.has(path)), ...touched];
  return validateContentSyncState({
    ...state,
    boundaries: { type: "FeatureCollection", features: [...state.boundaries.features, ...added] },
    catalogue: { ...catalogue, loaded: order },
  });
}

/** Drop the boundaries of the given chunks from the device, except pinned ones. */
export function evictCatalogueChunks(state: ContentSyncState, paths: readonly string[]): ContentSyncState {
  const catalogue = state.catalogue;
  if (!catalogue || paths.length === 0) return state;
  const evict = new Set(paths);
  const stillLoaded = catalogue.loaded.filter((path) => !evict.has(path));
  const keepIds = new Set(catalogue.pinned);
  const kept = new Set(stillLoaded);
  for (const chunk of catalogue.chunks) if (kept.has(chunk.path)) for (const id of chunk.parkIds) keepIds.add(id);
  const dropIds = new Set(catalogue.chunks.filter((chunk) => evict.has(chunk.path)).flatMap((chunk) => chunk.parkIds).filter((id) => !keepIds.has(id)));
  return {
    ...state,
    boundaries: { type: "FeatureCollection", features: state.boundaries.features.filter((feature) => !dropIds.has(feature.properties.id)) },
    catalogue: { ...catalogue, loaded: stillLoaded },
  };
}

/**
 * A map has one chunk layout file and every chunk beside it, in map/island/ for
 * releases before the combined map and map/detail/ from it (see mapFolder).
 */
function assertMapChunks(files: readonly ContentFile[], mapManifest: MapManifest, mismatch: string): void {
  const layouts = files.filter((file) => isMapLayoutPath(file.path));
  if (layouts.length !== 1) throw new ContentValidationError(mismatch);
  const folder = layouts[0]!.path.split("/")[1]!;
  const chunks = files.filter((file) => isMapChunkPath(file.path));
  if (chunks.length !== mapManifest.count) throw new ContentValidationError(mismatch);
  const byPath = new Map(chunks.map((file) => [file.path, file]));
  for (let index = 0; index < mapManifest.count; index += 1) {
    const path = mapChunkPath(index, folder);
    const chunk = byPath.get(path);
    const expectedSize = Math.min(mapManifest.chunkBytes, mapManifest.size - index * mapManifest.chunkBytes);
    if (!chunk || chunk.byte_size !== expectedSize) throw new ContentValidationError(`map chunk ${path} has an unexpected size`);
  }
}

export function parseContentMapInventory(value: unknown, expectedVersion: string): ContentMapInventory {
  const manifest = record(value, "content map manifest");
  requireKeys(manifest, ["schema", "version", "mapManifest", "files"], "content map manifest");
  if (manifest.schema !== "parkdex.content-map/v1") throw new ContentValidationError("content map manifest schema is unsupported");
  const version = string(manifest.version, "map manifest.version");
  if (!SHA256.test(version) || version !== expectedVersion) throw new ContentValidationError("map manifest version does not match its pointer");
  const mapManifest = parseMapManifestLayout(manifest.mapManifest, "map manifest.mapManifest");
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) throw new ContentValidationError("map manifest.files must be a non-empty array");
  const files = manifest.files.map((file, index) => parseSyncFile(file, `map manifest.files[${index}]`, (path) =>
    isMapLayoutPath(path) || isMapChunkPath(path) || /^map\/fonts\/[A-Za-z0-9._ -]+(?:\/[A-Za-z0-9._ -]+)*\.pbf$/.test(path)));
  if (new Set(files.map((file) => file.path)).size !== files.length) throw new ContentValidationError("map manifest contains duplicate paths");
  if (files.some((file) => isMapChunkPath(file.path) && mapChunkIndex(file.path)! >= mapManifest.count)) {
    throw new ContentValidationError("map manifest contains an out-of-range chunk");
  }
  assertMapChunks(files, mapManifest, "map manifest chunk inventory does not match its layout");
  if (!files.some((file) => file.path.startsWith("map/fonts/") && file.path.endsWith(".pbf"))) {
    throw new ContentValidationError("map manifest is missing map glyphs");
  }
  return { schema: "parkdex.content-map/v1", version, mapManifest, files };
}

const CHANGE_ENTITIES = new Set(["park", "boundary", "drive", "asset", "hubs", "map"]);

// Returns null for a change this build does not understand (a newer entity or
// operation) so it is skipped instead of stopping every later update.
function parseChange(value: unknown, index: number): ContentChange | null {
  const label = `changes.batches[].changes[${index}]`;
  const change = record(value, label);
  const entity = string(change.entity, `${label}.entity`, false);
  const op = string(change.op, `${label}.op`, false);
  const id = string(change.id, `${label}.id`);
  if (!CHANGE_ENTITIES.has(entity) || (op !== "upsert" && op !== "delete")) return null;
  if (entity === "asset" && !SCENE_ASSET_PATH.test(id)) return null;
  if (op === "delete") {
    requireKeys(change, ["entity", "op", "id"], label);
    if (entity === "hubs" || entity === "map") throw new ContentValidationError(`${label} cannot delete shared content settings`);
    if (entity === "park" && !PARK_ID.test(id)) throw new ContentValidationError(`${label}.id is invalid`);
    return { entity: entity as "park" | "boundary" | "drive" | "asset", op, id };
  }
  requireKeys(change, ["entity", "op", "id", "value"], label);
  if (!("value" in change)) throw new ContentValidationError(`${label}.value is required`);
  switch (entity) {
    case "park": {
      if (!PARK_ID.test(id)) throw new ContentValidationError(`${label}.id is invalid`);
      const park = validateParkRecord(change.value, label);
      if (park.id !== id) throw new ContentValidationError(`${label}.id does not match its value`);
      return { entity, op, id, value: park };
    }
    case "boundary": {
      const feature = record(change.value, `${label}.value`);
      const properties = record(feature.properties, `${label}.value.properties`);
      if (properties.id !== id) throw new ContentValidationError(`${label}.id does not match its value`);
      return { entity, op, id, value: change.value as ContentBoundaries["features"][number] };
    }
    case "drive": {
      if (!PARK_ID.test(id)) throw new ContentValidationError(`${label}.id is invalid`);
      const data = record(change.value, `${label}.value`);
      if (!Array.isArray(data.drive)) throw new ContentValidationError(`${label}.value.drive must be an array`);
      const drive = validateDriveEntry(change.value, data.drive.length, `${label}.value`);
      return { entity, op, id, value: drive };
    }
    case "asset": {
      if (id !== record(change.value, `${label}.value`).path) throw new ContentValidationError(`${label}.id does not match its value`);
      const file = parseSyncFile(change.value, `${label}.value`, (path) => /^art\/badges\/scenes\/[a-z0-9][a-z0-9-]*\.webp$/.test(path));
      return { entity, op, id, value: file };
    }
    case "hubs": {
      if (id !== "default") throw new ContentValidationError(`${label}.id must be default`);
      return { entity, op, id, value: validateHubs(change.value, `${label}.value`) };
    }
    case "map": {
      if (id !== "default") throw new ContentValidationError(`${label}.id must be default`);
      return { entity, op, id, value: parseMapPointer(change.value) };
    }
  }
  throw new ContentValidationError(`${label} has an unsupported entity`);
}

function batchChanges(values: unknown[], label: string): ContentChange[] {
  const skippedParks = new Set<string>();
  const changes: ContentChange[] = [];
  values.forEach((value, index) => {
    try {
      const change = parseChange(value, index);
      if (change) changes.push(change);
    } catch (error) {
      const raw = value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
      if (!(error instanceof ContentValidationError) || raw.entity !== "park" || raw.op !== "upsert" ||
        typeof raw.id !== "string" || !PARK_ID.test(raw.id)) throw error;
      // Keep the version already on the device; its boundary and drive rows stay with it.
      console.warn(`${label} park ${raw.id} skipped: ${error.message}`);
      skippedParks.add(raw.id);
    }
  });
  return changes.filter((change) => !(skippedParks.has(change.id) && (change.entity === "boundary" || change.entity === "drive")));
}

export function parseContentChanges(value: unknown, requestedAfter: number): ContentChangesResponse {
  const response = record(value, "content changes");
  requireKeys(response, ["schema", "fromRevision", "throughRevision", "headRevision", "hasMore", "batches"], "content changes");
  if (response.schema !== "parkdex.content-sync/v1") throw new ContentValidationError("content changes schema is unsupported");
  const fromRevision = nonNegativeSafeInteger(response.fromRevision, "changes.fromRevision");
  const throughRevision = nonNegativeSafeInteger(response.throughRevision, "changes.throughRevision");
  const headRevision = nonNegativeSafeInteger(response.headRevision, "changes.headRevision");
  if (fromRevision !== requestedAfter) throw new ContentValidationError("changes.fromRevision does not match the requested cursor");
  if (headRevision < fromRevision || throughRevision < fromRevision || throughRevision > headRevision) throw new ContentValidationError("changes revision range is invalid");
  if (typeof response.hasMore !== "boolean") throw new ContentValidationError("changes.hasMore must be a boolean");
  if (!Array.isArray(response.batches) || response.batches.length > 50) throw new ContentValidationError("changes.batches must contain at most 50 revisions");
  const batches = response.batches.map((rawBatch, batchIndex) => {
    const label = `changes.batches[${batchIndex}]`;
    const batch = record(rawBatch, label);
    requireKeys(batch, ["revision", "changes"], label);
    const revision = nonNegativeSafeInteger(batch.revision, `${label}.revision`);
    if (!Array.isArray(batch.changes) || batch.changes.length === 0) throw new ContentValidationError(`${label}.changes must be a non-empty array`);
    const changes = batchChanges(batch.changes, label);
    const keys = changes.map((change) => `${change.entity}:${change.id}`);
    if (new Set(keys).size !== keys.length) throw new ContentValidationError(`${label} contains duplicate entity rows`);
    return { revision, changes };
  });
  if (batches.length) {
    if (batches[0]!.revision !== fromRevision + 1 || batches.some((batch, index) => index > 0 && batch.revision !== batches[index - 1]!.revision + 1)) {
      throw new ContentValidationError("changes revision batches are not contiguous");
    }
    if (throughRevision !== batches[batches.length - 1]!.revision) throw new ContentValidationError("changes.throughRevision does not match the last batch");
  } else if (throughRevision !== fromRevision || headRevision !== fromRevision) {
    throw new ContentValidationError("empty changes response cannot skip revisions");
  }
  if (response.hasMore !== (throughRevision < headRevision)) throw new ContentValidationError("changes.hasMore does not match the revision range");
  return { schema: "parkdex.content-sync/v1", fromRevision, throughRevision, headRevision, hasMore: response.hasMore, batches };
}

export function applyContentChangeBatch(state: ContentSyncState, batch: ContentChangeBatch): ContentSyncState {
  const parks = new Map(state.parks.map((park) => [park.id, park]));
  const boundaries = new Map(state.boundaries.features.map((feature) => [feature.properties.id, feature]));
  const drives = new Map(Object.entries(state.drive.parks));
  const assets = new Map(state.assets.map((file) => [file.path, file]));
  let hubs = state.drive.hubs;
  let map = state.map;
  for (const change of batch.changes) {
    const deleting = change.op === "delete";
    switch (change.entity) {
      case "park": if (deleting) parks.delete(change.id); else parks.set(change.id, change.value); break;
      case "boundary": if (deleting) boundaries.delete(change.id); else boundaries.set(change.id, change.value); break;
      case "drive": if (deleting) drives.delete(change.id); else drives.set(change.id, change.value); break;
      case "asset": if (deleting) assets.delete(change.id); else assets.set(change.id, change.value); break;
      case "hubs": if (!deleting) hubs = change.value; break;
      case "map": if (!deleting) map = change.value; break;
    }
  }
  // In a lean catalogue a boundary changed after the release stays on the device even
  // when its chunk is evicted, because the release only has the older copy.
  const catalogue = state.catalogue
    ? {
      ...state.catalogue,
      pinned: [...new Set([
        ...state.catalogue.pinned,
        ...batch.changes.filter((change) => change.entity === "boundary" && change.op === "upsert").map((change) => change.id),
      ])],
    }
    : undefined;
  const candidate: ContentSyncState = {
    revision: batch.revision,
    ...(state.sourceId ? { sourceId: state.sourceId } : {}),
    parks: [...parks.values()],
    boundaries: { type: "FeatureCollection", features: [...boundaries.values()] },
    drive: { hubs, parks: Object.fromEntries(drives) },
    // The server retains immutable historical descriptors for archive lookup.
    // The active client catalogue stores only descriptors referenced by current parks.
    assets: [...assets.values()].filter((file) => parksHasScenePath(parks, file.path)),
    map,
    ...(catalogue ? { catalogue } : {}),
  };
  return validateContentSyncState(candidate);
}

function parksHasScenePath(parks: Map<string, Park>, path: string): boolean {
  for (const park of parks.values()) if (park.scene && path === `art/badges/scenes/${park.scene}.webp`) return true;
  return false;
}

export function remoteFiles(manifest: ContentManifest): ContentFile[] {
  return manifest.files.filter((file) => isRemoteContentPath(file.path));
}

export function coreFiles(manifest: ContentManifest): ContentFile[] {
  return remoteFiles(manifest).filter((file) => !isMapChunkPath(file.path));
}

export function mapChunkFiles(manifest: ContentManifest): ContentFile[] {
  return manifest.files.filter((file) => isMapChunkPath(file.path));
}

export function fileByPath(manifest: ContentManifest, path: string): ContentFile {
  const file = manifest.files.find((entry) => entry.path === path);
  if (!file || !isRemoteContentPath(path)) throw new ContentValidationError(`content file is not part of this release: ${path}`);
  return file;
}

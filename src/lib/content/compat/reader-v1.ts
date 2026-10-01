// FROZEN COPY of the content reader shipped in installed Android builds up to
// staging 964350c (2026-09-30). It rejects any field or value it does not know.
// The contract test replays API responses through it so the server never sends
// something those builds cannot read. Do not edit; delete this file (and its
// test entry) only once no supported build still uses this reader.
const CONTENT_READER_VERSION = 1;

import {
  CONTENT_CDN_ORIGIN,
  isRemoteContentPath,
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
} from "../contracts";
import type { Park } from "../../parks";

const PARK_FIELDS = [
  "id", "name", "short", "category", "region", "lat", "lng", "biome", "shape", "rarity", "scene", "seed", "blurb",
] as const;
const CATEGORIES = new Set(["national", "provincial", "regional", "municipal", "community"]);
const BIOMES = new Set(["coast", "forest", "mountain", "lake", "waterfall", "river", "cave", "marsh", "heritage"]);
const SHAPES = new Set(["circle", "hex", "shield", "arch", "seal"]);
const RARITIES = new Set(["common", "uncommon", "rare", "epic", "legendary"]);
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40,64}$/;
const PARK_ID = /^[a-z0-9][a-z0-9-]*$/;

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

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new ContentValidationError(`${label} has an unsupported shape`);
  }
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
  exactKeys(entry, ["path", "key", "url", "sha256", "byte_size", "content_type"], label);
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
  exactKeys(pointer, ["version", "manifestUrl", "manifestSha256"], "snapshot.map");
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
  exactKeys(map, ["size", "chunkBytes", "count"], label);
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
    /^map\/island\/manifest\.json$/.test(path) || /^map\/island\/\d{3,}\.bin$/.test(path) ||
    /^map\/fonts\/[A-Za-z0-9._ -]+(?:\/[A-Za-z0-9._ -]+)*\.pbf$/.test(path);
}

function expectedFileUrl(path: string, releaseId: string) {
  return `${CONTENT_CDN_ORIGIN}/releases/${releaseId}/${encodeLogicalPath(path)}`;
}

function parseFile(value: unknown, releaseId: string, index: number): ContentFile {
  const label = `manifest.files[${index}]`;
  const entry = record(value, label);
  exactKeys(entry, ["path", "key", "url", "sha256", "byte_size", "content_type"], label);
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
  exactKeys(channel, ["schema", "environment", "generation", "releaseId", "manifestUrl", "manifestSha256", "minimumReaderVersion"], "content channel");
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
  exactKeys(manifest, ["version", "sourceCommit", "cdnOrigin", "files", "parkIds", "boundaryIds", "mapManifest"], "content manifest");
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
  for (const required of ["data/parks.json", "data/drive.json", "boundaries.geojson", "map/island/manifest.json"]) {
    if (!paths.has(required)) throw new ContentValidationError(`manifest is missing ${required}`);
  }
  const parkIds = uniqueStringArray(manifest.parkIds, "manifest.parkIds", PARK_ID);
  const boundaryIds = uniqueStringArray(manifest.boundaryIds, "manifest.boundaryIds", PARK_ID);
  const mapManifestValue = record(manifest.mapManifest, "manifest.mapManifest");
  exactKeys(mapManifestValue, ["size", "chunkBytes", "count"], "manifest.mapManifest");
  const mapManifest = {
    size: positiveInteger(mapManifestValue.size, "manifest.mapManifest.size"),
    chunkBytes: positiveInteger(mapManifestValue.chunkBytes, "manifest.mapManifest.chunkBytes"),
    count: positiveInteger(mapManifestValue.count, "manifest.mapManifest.count"),
  };
  if (mapManifest.count !== Math.ceil(mapManifest.size / mapManifest.chunkBytes)) throw new ContentValidationError("map manifest chunk count does not match its size");
  const chunks = files.filter((file) => /^map\/island\/\d{3,}\.bin$/.test(file.path));
  if (chunks.length !== mapManifest.count) throw new ContentValidationError("map chunk inventory does not match its manifest");
  for (let index = 0; index < mapManifest.count; index++) {
    const path = `map/island/${String(index).padStart(3, "0")}.bin`;
    const chunk = files.find((file) => file.path === path);
    const expectedSize = Math.min(mapManifest.chunkBytes, mapManifest.size - index * mapManifest.chunkBytes);
    if (!chunk || chunk.byte_size !== expectedSize) throw new ContentValidationError(`map chunk ${path} has an unexpected size`);
  }
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
  exactKeys(park, PARK_FIELDS, label);
  const id = string(park.id, `${label}.id`);
  if (!PARK_ID.test(id)) throw new ContentValidationError(`${label}.id is invalid`);
  const name = string(park.name, `${label}.name`);
  const short = string(park.short, `${label}.short`);
  const category = string(park.category, `${label}.category`);
  const region = string(park.region, `${label}.region`, false);
  const biome = string(park.biome, `${label}.biome`);
  const shape = string(park.shape, `${label}.shape`);
  const rarity = string(park.rarity, `${label}.rarity`);
  if (!CATEGORIES.has(category) || !BIOMES.has(biome) || !SHAPES.has(shape) || !RARITIES.has(rarity)) {
    throw new ContentValidationError(`${label} has an unsupported Park enum value`);
  }
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
  return { id, name, short, category: category as Park["category"], region, lat, lng, biome: biome as Park["biome"], shape: shape as Park["shape"], rarity: rarity as Park["rarity"], seed: park.seed, blurb, scene };
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

function validateBoundaries(value: unknown, parks: Park[], manifest: ContentManifest): ContentBoundaries {
  const collection = record(value, "boundaries.geojson");
  exactKeys(collection, ["type", "features"], "boundaries.geojson");
  if (collection.type !== "FeatureCollection" || !Array.isArray(collection.features)) {
    throw new ContentValidationError("boundaries.geojson must be a FeatureCollection");
  }
  const parkById = new Map(parks.map((park) => [park.id, park]));
  const seen = new Set<string>();
  const features = collection.features.map((rawFeature, index) => {
    const label = `boundaries.geojson.features[${index}]`;
    const feature = record(rawFeature, label);
    exactKeys(feature, ["type", "properties", "geometry"], label);
    if (feature.type !== "Feature") throw new ContentValidationError(`${label}.type is invalid`);
    const properties = record(feature.properties, `${label}.properties`);
    exactKeys(properties, ["id", "biome"], `${label}.properties`);
    const id = string(properties.id, `${label}.properties.id`);
    const biome = string(properties.biome, `${label}.properties.biome`);
    if (!parkById.has(id) || seen.has(id)) throw new ContentValidationError(`${label} references a missing or duplicate park`);
    if (parkById.get(id)!.biome !== biome) throw new ContentValidationError(`${label} biome does not match its park`);
    seen.add(id);
    const geometry = record(feature.geometry, `${label}.geometry`);
    exactKeys(geometry, ["type", "coordinates"], `${label}.geometry`);
    if (geometry.type !== "MultiPolygon" || !Array.isArray(geometry.coordinates) || geometry.coordinates.length === 0) {
      throw new ContentValidationError(`${label}.geometry must be a non-empty MultiPolygon`);
    }
    geometry.coordinates.forEach((polygon, polygonIndex) => {
      if (!Array.isArray(polygon) || polygon.length === 0) throw new ContentValidationError(`${label} has an empty polygon`);
      polygon.forEach((ring, ringIndex) => validateCoordinates(ring, `${label}.geometry.coordinates[${polygonIndex}][${ringIndex}]`));
    });
    return rawFeature;
  });
  if (seen.size !== parks.length) throw new ContentValidationError("boundary park references do not match the catalog");
  if (!sameOrderedIds(features.map((feature) => (feature as { properties: { id: string } }).properties.id), manifest.boundaryIds)) {
    throw new ContentValidationError("boundary ids do not match the immutable manifest order");
  }
  return collection as unknown as ContentBoundaries;
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
  exactKeys(drive, ["hubs", "parks"], "data/drive.json");
  if (!Array.isArray(drive.hubs) || !drive.hubs.length) throw new ContentValidationError("data/drive.json hubs must be a non-empty array");
  const hubs = drive.hubs.map((rawHub, index) => {
    const label = `data/drive.json.hubs[${index}]`;
    const hub = record(rawHub, label);
    exactKeys(hub, ["name", "lng", "lat"], label);
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
    exactKeys(rawData, ["drive", "walkM"], `data/drive.json.parks.${id}`);
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
  exactKeys(data, ["drive", "walkM"], label);
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
    exactKeys(hub, ["name", "lng", "lat"], hubLabel);
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
  const boundaries = validateBoundaries(boundariesValue, parks, manifest);
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
    exactKeys(boundaries, ["type", "features"], "snapshot.boundaries");
    if (boundaries.type !== "FeatureCollection" || !Array.isArray(boundaries.features) || boundaries.features.length !== 0) {
      throw new ContentValidationError("empty catalog boundaries must be an empty FeatureCollection");
    }
    const drive = record(value.drive, "snapshot.drive");
    exactKeys(drive, ["hubs", "parks"], "snapshot.drive");
    const hubs = validateHubs(drive.hubs, "snapshot.drive.hubs");
    const driveParks = record(drive.parks, "snapshot.drive.parks");
    if (Object.keys(driveParks).length !== 0 || assets.length !== 0) throw new ContentValidationError("empty catalog cannot contain drive rows or scene assets");
    payload = { parks: [], boundaries: { type: "FeatureCollection", features: [] }, drive: { hubs, parks: {} } };
  } else {
    payload = validateContentPayload(parks, value.boundaries, { hubs: value.drive?.hubs, parks: value.drive?.parks }, syncValidationManifest(assets, parks));
  }
  const map = parseMapPointer(value.map);
  const sourceId = value.sourceId === undefined ? undefined : string(value.sourceId, "sync source ID");
  return { revision, ...(sourceId ? { sourceId } : {}), parks: payload.parks, boundaries: payload.boundaries, drive: payload.drive, assets, map };
}

export function parseContentSnapshot(value: unknown): ContentSyncState {
  const snapshot = record(value, "content snapshot");
  exactKeys(snapshot, ["schema", "revision", "parks", "boundaries", "drive", "assets", "map"], "content snapshot");
  if (snapshot.schema !== "parkdex.content-sync/v1") throw new ContentValidationError("content snapshot schema is unsupported");
  if (!Array.isArray(snapshot.parks)) throw new ContentValidationError("snapshot.parks must be an array");
  const parks = snapshot.parks.map((park, index) => validatePark(park, index));
  const state: ContentSyncState = {
    revision: nonNegativeSafeInteger(snapshot.revision, "snapshot.revision"),
    parks,
    boundaries: snapshot.boundaries as ContentBoundaries,
    drive: snapshot.drive as DriveData,
    assets: Array.isArray(snapshot.assets) ? snapshot.assets as ContentFile[] : [],
    map: parseMapPointer(snapshot.map),
  };
  return validateContentSyncState(state);
}

export function parseContentMapInventory(value: unknown, expectedVersion: string): ContentMapInventory {
  const manifest = record(value, "content map manifest");
  exactKeys(manifest, ["schema", "version", "mapManifest", "files"], "content map manifest");
  if (manifest.schema !== "parkdex.content-map/v1") throw new ContentValidationError("content map manifest schema is unsupported");
  const version = string(manifest.version, "map manifest.version");
  if (!SHA256.test(version) || version !== expectedVersion) throw new ContentValidationError("map manifest version does not match its pointer");
  const mapManifest = parseMapManifestLayout(manifest.mapManifest, "map manifest.mapManifest");
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) throw new ContentValidationError("map manifest.files must be a non-empty array");
  const files = manifest.files.map((file, index) => parseSyncFile(file, `map manifest.files[${index}]`, (path) =>
    path === "map/island/manifest.json" || /^map\/island\/\d{3,}\.bin$/.test(path) || /^map\/fonts\/[A-Za-z0-9._ -]+(?:\/[A-Za-z0-9._ -]+)*\.pbf$/.test(path)));
  if (new Set(files.map((file) => file.path)).size !== files.length) throw new ContentValidationError("map manifest contains duplicate paths");
  const mapFile = files.find((file) => file.path === "map/island/manifest.json");
  const chunks = files.filter((file) => /^map\/island\/\d{3,}\.bin$/.test(file.path));
  if (!mapFile || chunks.length !== mapManifest.count) throw new ContentValidationError("map manifest chunk inventory does not match its layout");
  for (let index = 0; index < mapManifest.count; index += 1) {
    const path = `map/island/${String(index).padStart(3, "0")}.bin`;
    const chunk = files.find((file) => file.path === path);
    const expectedSize = Math.min(mapManifest.chunkBytes, mapManifest.size - index * mapManifest.chunkBytes);
    if (!chunk || chunk.byte_size !== expectedSize) throw new ContentValidationError(`map chunk ${path} has an unexpected size`);
  }
  if (chunks.some((file) => Number(file.path.match(/\/(\d+)\.bin$/)?.[1]) >= mapManifest.count)) {
    throw new ContentValidationError("map manifest contains an out-of-range chunk");
  }
  if (!files.some((file) => file.path.startsWith("map/fonts/") && file.path.endsWith(".pbf"))) {
    throw new ContentValidationError("map manifest is missing map glyphs");
  }
  return { schema: "parkdex.content-map/v1", version, mapManifest, files };
}

function parseChange(value: unknown, index: number): ContentChange {
  const label = `changes.batches[].changes[${index}]`;
  const change = record(value, label);
  const entity = string(change.entity, `${label}.entity`, false);
  const op = string(change.op, `${label}.op`, false);
  const id = string(change.id, `${label}.id`);
  const validEntity = ["park", "boundary", "drive", "asset", "hubs", "map"].includes(entity);
  if (!validEntity || (op !== "upsert" && op !== "delete")) throw new ContentValidationError(`${label} has an unsupported entity or operation`);
  if (op === "delete") {
    exactKeys(change, ["entity", "op", "id"], label);
    if (entity === "hubs" || entity === "map") throw new ContentValidationError(`${label} cannot delete shared content settings`);
    if (entity === "park" && !PARK_ID.test(id)) throw new ContentValidationError(`${label}.id is invalid`);
    if (entity === "asset" && !/^art\/badges\/scenes\/[a-z0-9][a-z0-9-]*\.webp$/.test(id)) throw new ContentValidationError(`${label}.id is invalid`);
    return { entity: entity as "park" | "boundary" | "drive" | "asset", op, id };
  }
  exactKeys(change, ["entity", "op", "id", "value"], label);
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

export function parseContentChanges(value: unknown, requestedAfter: number): ContentChangesResponse {
  const response = record(value, "content changes");
  exactKeys(response, ["schema", "fromRevision", "throughRevision", "headRevision", "hasMore", "batches"], "content changes");
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
    exactKeys(batch, ["revision", "changes"], label);
    const revision = nonNegativeSafeInteger(batch.revision, `${label}.revision`);
    if (!Array.isArray(batch.changes) || batch.changes.length === 0) throw new ContentValidationError(`${label}.changes must be a non-empty array`);
    const changes = batch.changes.map((change, index) => parseChange(change, index));
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
  return remoteFiles(manifest).filter((file) => !/^map\/island\/\d{3,}\.bin$/.test(file.path));
}

export function mapChunkFiles(manifest: ContentManifest): ContentFile[] {
  return manifest.files.filter((file) => /^map\/island\/\d{3,}\.bin$/.test(file.path));
}

export function fileByPath(manifest: ContentManifest, path: string): ContentFile {
  const file = manifest.files.find((entry) => entry.path === path);
  if (!file || !isRemoteContentPath(path)) throw new ContentValidationError(`content file is not part of this release: ${path}`);
  return file;
}

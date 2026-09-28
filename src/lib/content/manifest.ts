import {
  CONTENT_CDN_ORIGIN,
  CONTENT_READER_VERSION,
  isRemoteContentPath,
  type ContentBoundaries,
  type ContentChannel,
  type ContentEnvironment,
  type ContentFile,
  type ContentManifest,
  type ContentPayload,
  type DriveData,
} from "./contracts";
import type { Park } from "../parks";

const PARK_FIELDS = [
  "id", "name", "short", "category", "region", "lat", "lng", "biome", "shape", "rarity", "scene", "seed", "blurb",
] as const;
const CATEGORIES = new Set(["national", "provincial", "regional"]);
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

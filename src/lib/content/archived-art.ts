import { CONTENT_CDN_ORIGIN, type ArchivedScene, type ContentChannel, type ContentFile, type ContentStore } from "./contracts";
import { ContentValidationError, assertFileBytes, parseContentManifest, parseJsonBytes, sha256Hex } from "./manifest";

const RELEASE_ID = /^[a-f0-9]{64}$/;
const SCENE_ID = /^[a-z0-9][a-z0-9-]{0,127}$/;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_SCENE_BYTES = 8 * 1024 * 1024;

function manifestUrl(releaseId: string) {
  return `${CONTENT_CDN_ORIGIN}/releases/${releaseId}/manifest.json`;
}

function scenePath(scene: string) {
  return `art/badges/scenes/${scene}.webp`;
}

function sceneUrl(releaseId: string, path: string) {
  return `${CONTENT_CDN_ORIGIN}/releases/${releaseId}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

export function assertArchivedSceneIdentity(releaseId: string, scene: string) {
  if (!RELEASE_ID.test(releaseId)) throw new ContentValidationError("Archived release ID is invalid");
  if (!SCENE_ID.test(scene)) throw new ContentValidationError("Archived scene ID is invalid");
}

export function archivedSceneStorageKey(releaseId: string, scene: string) {
  assertArchivedSceneIdentity(releaseId, scene);
  return `${releaseId}:${scene}`;
}

export function assertArchivedSceneDescriptor(value: unknown): asserts value is ArchivedScene {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ContentValidationError("Archived scene descriptor must be an object");
  const descriptor = value as Record<string, unknown>;
  const keys = Object.keys(descriptor).sort();
  if (keys.length !== 3 || keys[0] !== "file" || keys[1] !== "releaseId" || keys[2] !== "scene") throw new ContentValidationError("Archived scene descriptor has an unsupported shape");
  if (typeof descriptor.releaseId !== "string" || typeof descriptor.scene !== "string") throw new ContentValidationError("Archived scene identifiers are invalid");
  const releaseId = descriptor.releaseId;
  const scene = descriptor.scene;
  assertArchivedSceneIdentity(releaseId, scene);
  const file = descriptor.file as Record<string, unknown> | null;
  if (!file || typeof file !== "object" || Array.isArray(file)) throw new ContentValidationError("Archived scene file is invalid");
  const fileKeys = Object.keys(file).sort();
  if (fileKeys.join("\0") !== ["byte_size", "content_type", "key", "path", "sha256", "url"].join("\0")) throw new ContentValidationError("Archived scene file has an unsupported shape");
  const path = scenePath(scene);
  if (file.path !== path || file.key !== `releases/${releaseId}/${path}` || file.url !== sceneUrl(releaseId, path) || file.content_type !== "image/webp") {
    throw new ContentValidationError("Archived scene file is outside its immutable release path");
  }
  if (typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new ContentValidationError("Archived scene hash is invalid");
  if (typeof file.byte_size !== "number" || !Number.isSafeInteger(file.byte_size) || file.byte_size <= 0 || file.byte_size > MAX_SCENE_BYTES) throw new ContentValidationError("Archived scene size is invalid");
}

function channelForArchivedRelease(releaseId: string): ContentChannel {
  return {
    schema: "parkdex.content-channel/v1",
    environment: "staging",
    generation: 1,
    releaseId,
    manifestUrl: manifestUrl(releaseId),
    manifestSha256: "0".repeat(64),
    minimumReaderVersion: 1,
  };
}

function inventoryBytes(files: ContentFile[]): ArrayBuffer {
  const inventory = files.map(({ path, byte_size, sha256 }) => ({ byte_size, path, sha256 }))
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const encoded = new TextEncoder().encode(JSON.stringify(inventory));
  return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength);
}

async function boundedBytes(response: Response, url: string, maximum: number, label: string): Promise<ArrayBuffer> {
  if (!response.ok) throw new ContentValidationError(`Archived ${label} request returned HTTP ${response.status}`);
  if (response.redirected || response.type === "opaqueredirect" || (response.url && response.url !== url)) throw new ContentValidationError(`Archived ${label} request redirected`);
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum)) throw new ContentValidationError(`Archived ${label} exceeds the permitted size`);
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > maximum) throw new ContentValidationError(`Archived ${label} exceeds the permitted size`);
  return bytes;
}

/** Restore legacy claim art only after a hash-bound registry lookup returned 404. */
export async function restoreArchivedScene(
  releaseId: string,
  scene: string,
  store: ContentStore,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<ContentFile> {
  assertArchivedSceneIdentity(releaseId, scene);
  const cached = await store.getArchivedScene(releaseId, scene);
  if (cached) {
    assertArchivedSceneDescriptor(cached);
    if (await store.hasFile(cached.file.sha256, cached.file.byte_size)) return cached.file;
  }
  const manifestLocation = manifestUrl(releaseId);
  const manifestResponse = await fetcher(manifestLocation, { signal, cache: "no-store", redirect: "error", credentials: "omit" });
  const manifestBytes = await boundedBytes(manifestResponse, manifestLocation, MAX_MANIFEST_BYTES, "manifest");
  const manifest = parseContentManifest(parseJsonBytes(manifestBytes), channelForArchivedRelease(releaseId));
  if (await sha256Hex(inventoryBytes(manifest.files)) !== releaseId) throw new ContentValidationError("Archived manifest inventory does not match its release ID");
  const path = scenePath(scene);
  const file = manifest.files.find((entry) => entry.path === path);
  if (!file || file.key !== `releases/${releaseId}/${path}` || file.url !== sceneUrl(releaseId, path) || file.content_type !== "image/webp" || file.byte_size > MAX_SCENE_BYTES) {
    throw new ContentValidationError("Archived release does not contain the requested immutable scene");
  }
  const response = await fetcher(file.url, { signal, cache: "force-cache", redirect: "error", credentials: "omit" });
  const bytes = await boundedBytes(response, file.url, MAX_SCENE_BYTES, "scene");
  await assertFileBytes(file, bytes);
  const descriptor = { releaseId, scene, file } satisfies ArchivedScene;
  assertArchivedSceneDescriptor(descriptor);
  await store.retainArchivedScene(descriptor);
  await store.putFile(file.sha256, bytes);
  return file;
}

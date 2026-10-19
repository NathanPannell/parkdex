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

function expectedSceneFile(releaseId: string, scene: string): Pick<ContentFile, "path" | "key" | "url" | "content_type"> {
  const path = scenePath(scene);
  return {
    path,
    key: `releases/${releaseId}/${path}`,
    url: sceneUrl(releaseId, path),
    content_type: "image/webp",
  };
}

/** Validates descriptors read from durable stores before they can be used as a GC root or file URL. */
export function assertArchivedSceneDescriptor(value: unknown): asserts value is ArchivedScene {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ContentValidationError("Archived scene descriptor must be an object");
  }
  const descriptor = value as Record<string, unknown>;
  const keys = Object.keys(descriptor).sort();
  if (keys.length !== 3 || keys[0] !== "file" || keys[1] !== "releaseId" || keys[2] !== "scene") {
    throw new ContentValidationError("Archived scene descriptor has an unsupported shape");
  }
  if (typeof descriptor.releaseId !== "string" || typeof descriptor.scene !== "string") {
    throw new ContentValidationError("Archived scene descriptor identifiers are invalid");
  }
  const releaseId = descriptor.releaseId;
  const scene = descriptor.scene;
  assertArchivedSceneIdentity(releaseId, scene);
  if (!descriptor.file || typeof descriptor.file !== "object" || Array.isArray(descriptor.file)) {
    throw new ContentValidationError("Archived scene file is invalid");
  }
  const file = descriptor.file as Record<string, unknown>;
  const fileKeys = Object.keys(file).sort();
  const expectedKeys = ["byte_size", "content_type", "key", "path", "sha256", "url"];
  if (fileKeys.length !== expectedKeys.length || fileKeys.some((key, index) => key !== expectedKeys[index])) {
    throw new ContentValidationError("Archived scene file has an unsupported shape");
  }
  const expected = expectedSceneFile(releaseId, scene);
  if (file.path !== expected.path || file.key !== expected.key || file.url !== expected.url || file.content_type !== expected.content_type) {
    throw new ContentValidationError("Archived scene file is outside its immutable release path");
  }
  if (typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256)) {
    throw new ContentValidationError("Archived scene file hash is invalid");
  }
  if (typeof file.byte_size !== "number" || !Number.isSafeInteger(file.byte_size) || file.byte_size <= 0 || file.byte_size > MAX_SCENE_BYTES) {
    throw new ContentValidationError("Archived scene file size is invalid");
  }
}

function validateResponse(response: Response, expectedUrl: string, kind: "manifest" | "scene") {
  if (!response.ok) throw new ContentValidationError(`Archived ${kind} request failed`);
  if (response.redirected || response.type === "opaqueredirect" || (response.url && response.url !== expectedUrl)) {
    throw new ContentValidationError(`Archived ${kind} request redirected outside its immutable URL`);
  }
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  const expectedType = kind === "manifest" ? "application/json" : "image/webp";
  if (contentType && contentType !== expectedType) {
    throw new ContentValidationError(`Archived ${kind} has an unexpected content type`);
  }
}

async function readBounded(response: Response, maximum: number, label: string): Promise<ArrayBuffer> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/.test(declared)) throw new ContentValidationError(`${label} has an invalid content length`);
    const declaredSize = Number(declared);
    if (!Number.isSafeInteger(declaredSize) || declaredSize > maximum) {
      throw new ContentValidationError(`${label} exceeds the permitted size`);
    }
  }

  if (!response.body) {
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > maximum) throw new ContentValidationError(`${label} exceeds the permitted size`);
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) {
        await reader.cancel();
        throw new ContentValidationError(`${label} exceeds the permitted size`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

async function requestBytes(url: string, kind: "manifest" | "scene", maximum: number, fetcher: typeof fetch, signal?: AbortSignal) {
  const response = await fetcher(url, {
    method: "GET",
    headers: { Accept: kind === "manifest" ? "application/json" : "image/webp" },
    redirect: "error",
    credentials: "omit",
    cache: "no-store",
    signal,
  });
  validateResponse(response, url, kind);
  return readBounded(response, maximum, `Archived ${kind}`);
}

function inventoryBytes(files: ContentFile[]): ArrayBuffer {
  const inventory = files
    .map(({ path, byte_size, sha256 }) => ({ byte_size, path, sha256 }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  // parseContentManifest restricts logical paths and hashes to ASCII, so this compact
  // representation matches Python json.dumps(sort_keys=True, separators=(",", ":")).
  const encoded = new TextEncoder().encode(JSON.stringify(inventory));
  return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength);
}

function channelForArchivedRelease(releaseId: string): ContentChannel {
  // Archived manifest parsing only consumes releaseId. The channel fields are fixed
  // local validation context and are never read from the network.
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

/**
 * Restores the frozen scene art for an earned claim from its immutable content release.
 * The helper never accepts a caller-provided URL and does not fetch an active catalogue.
 */
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
    if (cached.releaseId !== releaseId || cached.scene !== scene) {
      throw new ContentValidationError("Archived scene descriptor does not match its requested key");
    }
    if (await store.hasFile(cached.file.sha256, cached.file.byte_size)) return cached.file;
  }

  const fixedManifestUrl = manifestUrl(releaseId);
  const manifestBytes = await requestBytes(fixedManifestUrl, "manifest", MAX_MANIFEST_BYTES, fetcher, signal);
  const manifest = parseContentManifest(parseJsonBytes(manifestBytes), channelForArchivedRelease(releaseId));
  const actualReleaseId = await sha256Hex(inventoryBytes(manifest.files));
  if (actualReleaseId !== releaseId) {
    throw new ContentValidationError("Archived manifest inventory does not match its release ID");
  }

  const path = scenePath(scene);
  const file = manifest.files.find((entry) => entry.path === path);
  if (!file) throw new ContentValidationError("Archived release does not contain the earned scene art");
  if (file.url !== sceneUrl(releaseId, path) || file.content_type !== "image/webp" || file.byte_size > MAX_SCENE_BYTES) {
    throw new ContentValidationError("Archived scene file is outside the approved scene inventory");
  }

  const bytes = await requestBytes(file.url, "scene", MAX_SCENE_BYTES, fetcher, signal);
  await assertFileBytes(file, bytes);
  const descriptor: ArchivedScene = { releaseId, scene, file };
  assertArchivedSceneDescriptor(descriptor);

  // Pin the content-addressed blob before writing it. GC checks this descriptor in the
  // same store transaction as deletion, so a concurrent sweep cannot win this gap.
  await store.retainArchivedScene(descriptor);
  await store.putFile(file.sha256, bytes);
  return file;
}

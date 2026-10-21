import { HttpError } from "../validation.js";
import { createProgressStore, type ProgressStore } from "./progress-store.js";
import { photoObjectKey, type AccountAuthContext, type PhotoContentType, type PhotoMetadata, type ProgressEnv } from "./progress-types.js";

export const MAX_ACCOUNT_PHOTO_BYTES = 2_621_440;

export interface PhotoDependencies {
  fetch?: typeof fetch;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function validUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function responseError(error: unknown): Response {
  if (error instanceof HttpError) return json({ error: { code: error.code, message: error.message }, code: error.code, message: error.message }, error.status);
  return json(
    {
      error: { code: "service_unavailable", message: "Private photo service is unavailable." },
      code: "service_unavailable",
      message: "Private photo service is unavailable.",
    },
    503,
  );
}

function serviceConfig(env: ProgressEnv): { baseUrl: URL; token: string } {
  const rawUrl = env.KIP_PHOTO_SERVICE_URL?.trim();
  const token = env.KIP_PHOTO_SERVICE_TOKEN?.trim();
  if (!rawUrl || !token || token.length > 8192 || /[\r\n\0]/.test(token)) {
    throw new HttpError(503, "service_unavailable", "Private photo service is unavailable.");
  }
  let baseUrl: URL;
  try {
    baseUrl = new URL(rawUrl);
  } catch {
    throw new HttpError(503, "service_unavailable", "Private photo service is unavailable.");
  }
  if (baseUrl.protocol !== "https:" || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
    throw new HttpError(503, "service_unavailable", "Private photo service is unavailable.");
  }
  return { baseUrl, token };
}

function serviceUrl(baseUrl: URL, path: string): URL {
  const target = new URL(path, baseUrl);
  if (target.origin !== baseUrl.origin) throw new HttpError(503, "service_unavailable", "Private photo service is unavailable.");
  return target;
}

async function privateFetch(env: ProgressEnv, dependencies: PhotoDependencies, path: string, init: RequestInit): Promise<Response> {
  const { baseUrl, token } = serviceConfig(env);
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  return (dependencies.fetch ?? fetch)(serviceUrl(baseUrl, path), { ...init, headers, redirect: "error" });
}

async function readBoundedStream(stream: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<Uint8Array> {
  if (!stream) throw new HttpError(400, "invalid_photo", "Photo bytes are required.");
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new HttpError(413, "photo_too_large", "Photo must be no larger than 2.5 MiB.");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) throw new HttpError(400, "invalid_photo", "Photo bytes are required.");
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readBoundedBody(request: Request, maxBytes: number): Promise<Uint8Array> {
  const contentLength = request.headers.get("content-length");
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > maxBytes) {
    throw new HttpError(413, "photo_too_large", "Photo must be no larger than 2.5 MiB.");
  }
  return readBoundedStream(request.body, maxBytes);
}

function contentTypeFromHeader(value: string | null): PhotoContentType | null {
  if (!value || value.includes(";")) return null;
  const normalized = value.trim().toLowerCase();
  return normalized === "image/jpeg" || normalized === "image/png" || normalized === "image/webp" ? normalized : null;
}

function hasValidMagic(bytes: Uint8Array, contentType: PhotoContentType): boolean {
  if (contentType === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (contentType === "image/png") {
    return (
      bytes.length >= 8 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a
    );
  }
  return (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  );
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

function photoServicePath(accountId: string, claimId: string): string {
  const key = photoObjectKey(accountId, claimId);
  return `/v1/objects/${key.split("/").map(encodeURIComponent).join("/")}`;
}

function accountServicePath(accountId: string): string {
  return `/v1/accounts/${encodeURIComponent(accountId.toLowerCase())}`;
}

async function uploadPhoto(
  request: Request,
  env: ProgressEnv,
  auth: AccountAuthContext,
  claimId: string,
  store: ProgressStore,
  dependencies: PhotoDependencies,
): Promise<Response> {
  const contentType = contentTypeFromHeader(request.headers.get("content-type"));
  if (!contentType) throw new HttpError(415, "invalid_photo", "Photo must be JPEG, PNG, or WebP.");
  const bytes = await readBoundedBody(request, MAX_ACCOUNT_PHOTO_BYTES);
  if (!hasValidMagic(bytes, contentType)) throw new HttpError(415, "invalid_photo", "Photo type does not match its file contents.");
  const sha256 = await sha256Hex(bytes);
  const photo = {
    contentType,
    sizeBytes: bytes.byteLength,
    sha256,
    objectKey: photoObjectKey(auth.accountId, claimId),
  };
  const reservation = await store.reservePhoto(auth.accountId, claimId, photo);
  if (reservation.status === "claim_missing") throw new HttpError(404, "not_found", "Claim not found.");
  if (reservation.status === "unavailable") throw new HttpError(410, "account_deleting", "This account is being deleted.");
  if (reservation.status === "conflict") throw new HttpError(409, "photo_conflict", "A different photo is already backed up for this claim.");

  let stored: Response;
  try {
    stored = await privateFetch(env, dependencies, photoServicePath(auth.accountId, claimId), {
      method: "PUT",
      headers: { "content-type": contentType, "x-content-sha256": sha256 },
      body: new Uint8Array(bytes).buffer,
    });
  } catch {
    throw new HttpError(503, "service_unavailable", "Private photo service is unavailable.");
  }
  if (stored.status !== 204 || stored.headers.get("x-content-sha256")?.toLowerCase() !== sha256) {
    throw new HttpError(503, "service_unavailable", "Private photo service is unavailable.");
  }
  if (!(await store.markPhotoReady(auth.accountId, claimId, sha256))) {
    throw new HttpError(410, "account_deleting", "This account is being deleted.");
  }
  return json(
    {
      claimId,
      photo: { status: "ready", sha256, sizeBytes: bytes.byteLength, contentType },
    },
    reservation.status === "reserved" ? 201 : 200,
  );
}

async function downloadPhoto(
  env: ProgressEnv,
  auth: AccountAuthContext,
  claimId: string,
  store: ProgressStore,
  dependencies: PhotoDependencies,
): Promise<Response> {
  const metadata = await store.getPhoto(auth.accountId, claimId);
  if (!metadata || metadata.status !== "ready") throw new HttpError(404, "not_found", "Photo not found.");

  let stored: Response;
  try {
    stored = await privateFetch(env, dependencies, photoServicePath(auth.accountId, claimId), { method: "GET" });
  } catch {
    throw new HttpError(503, "service_unavailable", "Private photo service is unavailable.");
  }
  if (stored.status === 404) throw new HttpError(404, "not_found", "Photo not found.");
  if (!stored.ok) throw new HttpError(503, "service_unavailable", "Private photo service is unavailable.");
  const contentType = contentTypeFromHeader(stored.headers.get("content-type"));
  const expectedHash = stored.headers.get("x-content-sha256")?.toLowerCase() ?? "";
  if (contentType !== metadata.contentType || expectedHash !== metadata.sha256) {
    throw new HttpError(503, "service_unavailable", "Private photo service is unavailable.");
  }
  let bytes: Uint8Array;
  try {
    bytes = await readBoundedStream(stored.body, MAX_ACCOUNT_PHOTO_BYTES);
  } catch {
    throw new HttpError(503, "service_unavailable", "Private photo service is unavailable.");
  }
  if (bytes.byteLength !== metadata.sizeBytes || !hasValidMagic(bytes, metadata.contentType) || (await sha256Hex(bytes)) !== metadata.sha256) {
    throw new HttpError(503, "service_unavailable", "Private photo service is unavailable.");
  }
  const headers = new Headers({
    "content-type": metadata.contentType,
    "content-length": String(bytes.byteLength),
    "content-disposition": `inline; filename="claim-${claimId}"`,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  return new Response(new Uint8Array(bytes).buffer, { status: 200, headers });
}

function deletionResponseIsComplete(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).every((key) => key === "complete" || key === "deleted") &&
    record.complete === true &&
    Number.isSafeInteger(record.deleted) &&
    (record.deleted as number) >= 0
  );
}

function deletionResponseIsIncomplete(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).every((key) => key === "complete" || key === "deleted") &&
    record.complete === false &&
    Number.isSafeInteger(record.deleted) &&
    (record.deleted as number) >= 0
  );
}

export interface DeleteAccountDataArgs {
  accountId: string;
  receiptId: string;
}

export interface DeletionDependencies {
  createStore?: (env: ProgressEnv) => ProgressStore;
  fetch?: typeof fetch;
}

export async function deleteAccountData(
  args: DeleteAccountDataArgs,
  env: ProgressEnv,
  dependencies: DeletionDependencies = {},
): Promise<{ complete: boolean }> {
  if (!validUuid(args.accountId) || !validUuid(args.receiptId)) throw new Error("Invalid account deletion context.");
  const store = dependencies.createStore?.(env) ?? createProgressStore(env);
  await store.snapshotDeletionPhotoObjects(args.receiptId.toLowerCase(), args.accountId.toLowerCase());
  await store.deleteAccountProgress(args.accountId.toLowerCase());

  try {
    for (let page = 0; page < 10; page += 1) {
      const response = await privateFetch(env, { fetch: dependencies.fetch }, accountServicePath(args.accountId), { method: "DELETE" });
      if (!response.ok) {
        await store.recordPhotoDeletionFailure(args.receiptId.toLowerCase());
        return { complete: false };
      }
      const text = await response.text();
      if (text.length > 2048) {
        await store.recordPhotoDeletionFailure(args.receiptId.toLowerCase());
        return { complete: false };
      }
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        await store.recordPhotoDeletionFailure(args.receiptId.toLowerCase());
        return { complete: false };
      }
      if (deletionResponseIsComplete(body)) {
        await store.clearDeletionPhotoObjects(args.receiptId.toLowerCase());
        return { complete: true };
      }
      if (!deletionResponseIsIncomplete(body)) {
        await store.recordPhotoDeletionFailure(args.receiptId.toLowerCase());
        return { complete: false };
      }
    }
    await store.recordPhotoDeletionFailure(args.receiptId.toLowerCase());
    return { complete: false };
  } catch {
    await store.recordPhotoDeletionFailure(args.receiptId.toLowerCase());
    return { complete: false };
  }
}

export async function handlePhotoRequest(
  request: Request,
  env: ProgressEnv,
  auth: AccountAuthContext | null,
  store: ProgressStore,
  dependencies: PhotoDependencies = {},
): Promise<Response | null> {
  const url = new URL(request.url);
  const match = /^\/api\/claims\/([^/]+)\/photo$/.exec(url.pathname);
  if (!match) return null;
  if (request.method !== "GET" && request.method !== "PUT") {
    return json({ error: { code: "method_not_allowed", message: "Method not allowed." }, code: "method_not_allowed", message: "Method not allowed." }, 405);
  }
  if (!auth || !validUuid(auth.accountId))
    return json({ error: { code: "unauthorized", message: "Sign in is required." }, code: "unauthorized", message: "Sign in is required." }, 401);
  const claimId = match[1].toLowerCase();
  if (!validUuid(claimId)) return json({ error: { code: "not_found", message: "Claim not found." }, code: "not_found", message: "Claim not found." }, 404);
  try {
    return request.method === "PUT"
      ? await uploadPhoto(request, env, auth, claimId, store, dependencies)
      : await downloadPhoto(env, auth, claimId, store, dependencies);
  } catch (error) {
    return responseError(error);
  }
}

export function isPhotoRoute(request: Request): boolean {
  return /^\/api\/claims\/[^/]+\/photo$/.test(new URL(request.url).pathname);
}

export type { PhotoMetadata };

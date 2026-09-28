export const PHOTO_MAX_BYTES = 2.5 * 1024 * 1024;
export const PHOTO_DELETE_PAGE_SIZE = 100;

const SERVICE_TOKEN_HEADER = "Authorization";
const ALLOWED_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OBJECT_PATH_PATTERN = /^\/v1\/objects\/accounts\/([^/]+)\/claims\/([^/]+)$/;
const ACCOUNT_PATH_PATTERN = /^\/v1\/accounts\/([^/]+)$/;
const RETENTION_ORIGIN = "https://parkdex-kip-staging.vercel.app";
const RETENTION_PATH = "/api/retention/interactions/purge";
const RETENTION_MAX_REQUESTS = 5;
const RETENTION_MAX_RESPONSE_BYTES = 16 * 1024;

function jsonResponse(status, value, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });
}

function errorResponse(status, error, headers = {}) {
  return jsonResponse(status, { error }, headers);
}

function methodNotAllowed(allow) {
  return errorResponse(405, "Method not allowed.", { Allow: allow });
}

function normalizedContentType(value) {
  if (!value) return null;
  const contentType = value.split(";", 1)[0].trim().toLowerCase();
  return ALLOWED_CONTENT_TYPES.has(contentType) ? contentType : null;
}

function parseObjectPath(pathname) {
  const match = OBJECT_PATH_PATTERN.exec(pathname);
  if (!match || !UUID_PATTERN.test(match[1]) || !UUID_PATTERN.test(match[2])) return null;
  return { accountId: match[1].toLowerCase(), claimId: match[2].toLowerCase() };
}

function parseAccountPath(pathname) {
  const match = ACCOUNT_PATH_PATTERN.exec(pathname);
  if (!match || !UUID_PATTERN.test(match[1])) return null;
  return { accountId: match[1].toLowerCase() };
}

function objectKey(accountId, claimId) {
  return `accounts/${accountId}/claims/${claimId}`;
}

function accountPrefix(accountId) {
  return `accounts/${accountId}/`;
}

async function sha256Hex(bytes) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (part) => part.toString(16).padStart(2, "0")).join("");
}

async function constantTimeTokenMatch(candidate, expected) {
  const encoder = new TextEncoder();
  const [candidateDigest, expectedDigest] = await Promise.all([
    globalThis.crypto.subtle.digest("SHA-256", encoder.encode(candidate)),
    globalThis.crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const left = new Uint8Array(candidateDigest);
  const right = new Uint8Array(expectedDigest);
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

async function authorize(request, expectedToken) {
  if (typeof expectedToken !== "string" || expectedToken.length < 32) return "unconfigured";
  const authorization = request.headers.get(SERVICE_TOKEN_HEADER);
  if (!authorization || authorization.length > 8192) return false;
  const match = /^Bearer ([^\s]+)$/i.exec(authorization);
  if (!match) return false;
  return constantTimeTokenMatch(match[1], expectedToken);
}

class BodyTooLargeError extends Error {}

async function readBoundedBody(body, maximumBytes) {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) {
        try {
          await reader.cancel();
        } catch {
          // The bounded read has already failed. Cancellation is best effort.
        }
        throw new BodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function hasImageMagic(bytes, contentType) {
  if (contentType === "image/jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (contentType === "image/png") {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    return bytes.length >= signature.length && signature.every((byte, index) => bytes[index] === byte);
  }
  if (contentType === "image/webp") {
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
  return false;
}

function validateDeclaredLength(request) {
  const value = request.headers.get("Content-Length");
  if (value === null) return null;
  if (!/^\d+$/.test(value)) return false;
  const length = Number(value);
  if (!Number.isSafeInteger(length)) return false;
  return length;
}

function internalRequest(pathname, method, { body, contentType, sha256 } = {}) {
  const headers = new Headers();
  if (contentType) headers.set("Content-Type", contentType);
  if (sha256) headers.set("X-Content-SHA256", sha256);
  return new Request(`https://account-photos.internal${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : body.slice().buffer,
  });
}

async function handleEdgeRequest(request, env) {
  const url = new URL(request.url);
  if (url.pathname === "/health") {
    if (request.method !== "GET") return methodNotAllowed("GET");
    const releaseSha = typeof env.RELEASE_SHA === "string" && /^[a-f0-9]{7,64}$/i.test(env.RELEASE_SHA)
      ? env.RELEASE_SHA
      : null;
    return jsonResponse(200, { status: "ok", releaseSha });
  }

  const object = parseObjectPath(url.pathname);
  const account = object ? null : parseAccountPath(url.pathname);
  if (!object && !account) return errorResponse(404, "Not found.");

  const allowedMethods = object ? "GET, PUT, DELETE" : "DELETE";
  if (!allowedMethods.split(", ").includes(request.method)) return methodNotAllowed(allowedMethods);

  const authorization = await authorize(request, env.PHOTO_SERVICE_TOKEN);
  if (authorization === "unconfigured") return errorResponse(503, "Photo service is unavailable.");
  if (!authorization) return errorResponse(401, "Unauthorized.");

  let contentType;
  let bytes;
  let digest;
  if (object && request.method === "PUT") {
    const declaredLength = validateDeclaredLength(request);
    if (declaredLength === false) return errorResponse(400, "Invalid content length.");
    if (declaredLength !== null && declaredLength > PHOTO_MAX_BYTES) {
      return errorResponse(413, "Photo exceeds the 2.5 MiB limit.");
    }

    contentType = normalizedContentType(request.headers.get("Content-Type"));
    if (!contentType) return errorResponse(415, "Only JPEG, PNG, and WebP photos are supported.");
    const requestedDigest = request.headers.get("X-Content-SHA256");
    if (!requestedDigest || !/^[a-f0-9]{64}$/i.test(requestedDigest)) {
      return errorResponse(400, "A SHA-256 digest is required.");
    }

    try {
      bytes = await readBoundedBody(request.body, PHOTO_MAX_BYTES);
    } catch (error) {
      if (error instanceof BodyTooLargeError) return errorResponse(413, "Photo exceeds the 2.5 MiB limit.");
      return errorResponse(400, "Photo body could not be read.");
    }
    if (bytes.byteLength === 0) return errorResponse(400, "Photo body is empty.");
    if (!hasImageMagic(bytes, contentType)) return errorResponse(400, "Photo content does not match its MIME type.");
    digest = await sha256Hex(bytes);
    if (digest !== requestedDigest.toLowerCase()) return errorResponse(400, "Photo SHA-256 digest does not match.");
  }

  const accountId = object?.accountId ?? account.accountId;
  const stub = env.ACCOUNT_PHOTOS.get(env.ACCOUNT_PHOTOS.idFromName(accountId));
  return stub.fetch(
    internalRequest(url.pathname, request.method, {
      body: bytes,
      contentType,
      sha256: digest,
    }),
  );
}

function httpError(status, message) {
  return errorResponse(status, message);
}

function hashHeader(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : null;
}

export class AccountPhotos {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.lockTail = Promise.resolve();
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS deleted_account (
        tombstone INTEGER PRIMARY KEY CHECK (tombstone = 1)
      )
    `);
  }

  serialize(operation) {
    const result = this.lockTail.then(operation, operation);
    this.lockTail = result.then(() => undefined, () => undefined);
    return result;
  }

  isTombstoned() {
    return this.ctx.storage.sql.exec("SELECT tombstone FROM deleted_account LIMIT 1").toArray().length > 0;
  }

  persistTombstone() {
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO deleted_account (tombstone) VALUES (1)");
  }

  async fetch(request) {
    const url = new URL(request.url);
    const object = parseObjectPath(url.pathname);
    const account = object ? null : parseAccountPath(url.pathname);
    if (!object && !account) return httpError(404, "Not found.");

    if (object) {
      if (!["GET", "PUT", "DELETE"].includes(request.method)) return methodNotAllowed("GET, PUT, DELETE");
      const key = objectKey(object.accountId, object.claimId);
      return this.serialize(async () => {
        if (request.method === "GET") return this.getPhoto(key);
        if (request.method === "PUT") return this.putPhoto(key, request);
        return this.deletePhoto(key);
      });
    }

    if (request.method !== "DELETE") return methodNotAllowed("DELETE");
    return this.serialize(() => this.deleteAccount(account.accountId));
  }

  async getPhoto(key) {
    if (this.isTombstoned()) return httpError(404, "Not found.");
    const object = await this.env.PHOTOS.get(key);
    if (!object) return httpError(404, "Not found.");
    if (!Number.isSafeInteger(object.size) || object.size < 1 || object.size > PHOTO_MAX_BYTES) {
      return httpError(500, "Stored photo is invalid.");
    }

    let bytes;
    try {
      bytes = new Uint8Array(await new Response(object.body).arrayBuffer());
    } catch {
      return httpError(500, "Stored photo is invalid.");
    }
    const contentType = normalizedContentType(object.httpMetadata?.contentType);
    if (
      bytes.byteLength !== object.size ||
      !contentType ||
      !hasImageMagic(bytes, contentType)
    ) {
      return httpError(500, "Stored photo is invalid.");
    }

    const digest = await sha256Hex(bytes);
    const storedDigest = hashHeader(object.customMetadata?.sha256);
    if (storedDigest !== digest) return httpError(500, "Stored photo is invalid.");

    return new Response(bytes, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(bytes.byteLength),
        "X-Content-SHA256": digest,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  async putPhoto(key, request) {
    if (this.isTombstoned()) return httpError(410, "Account photos have been deleted.");
    const declaredLength = validateDeclaredLength(request);
    if (declaredLength === false) return httpError(400, "Invalid content length.");
    if (declaredLength !== null && declaredLength > PHOTO_MAX_BYTES) {
      return httpError(413, "Photo exceeds the 2.5 MiB limit.");
    }

    const contentType = normalizedContentType(request.headers.get("Content-Type"));
    if (!contentType) return httpError(415, "Only JPEG, PNG, and WebP photos are supported.");
    const declaredDigest = hashHeader(request.headers.get("X-Content-SHA256"));
    if (!declaredDigest) return httpError(400, "A SHA-256 digest is required.");

    let bytes;
    try {
      bytes = await readBoundedBody(request.body, PHOTO_MAX_BYTES);
    } catch (error) {
      if (error instanceof BodyTooLargeError) return httpError(413, "Photo exceeds the 2.5 MiB limit.");
      return httpError(400, "Photo body could not be read.");
    }
    if (bytes.byteLength === 0) return httpError(400, "Photo body is empty.");
    if (!hasImageMagic(bytes, contentType)) return httpError(400, "Photo content does not match its MIME type.");

    const digest = await sha256Hex(bytes);
    if (digest !== declaredDigest) return httpError(400, "Photo SHA-256 digest does not match.");

    const existing = await this.env.PHOTOS.head(key);
    if (existing) {
      const existingDigest = hashHeader(existing.customMetadata?.sha256);
      const existingContentType = normalizedContentType(existing.httpMetadata?.contentType);
      if (
        existingDigest !== digest ||
        existing.size !== bytes.byteLength ||
        existingContentType !== contentType
      ) {
        return httpError(409, "A different photo is already backed up.");
      }
      return new Response(null, {
        status: 204,
        headers: {
          "X-Content-SHA256": digest,
          "Cache-Control": "no-store",
        },
      });
    }

    await this.env.PHOTOS.put(key, bytes, {
      httpMetadata: { contentType },
      customMetadata: { sha256: digest },
    });
    return new Response(null, {
      status: 204,
      headers: {
        "X-Content-SHA256": digest,
        "Cache-Control": "no-store",
      },
    });
  }

  async deletePhoto(key) {
    await this.env.PHOTOS.delete(key);
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  }

  async deleteAccount(accountId) {
    // This synchronous SQLite write is persisted before the first R2 await.
    // Any later queued PUT observes the tombstone and returns 410.
    this.persistTombstone();

    const prefix = accountPrefix(accountId);
    const page = await this.env.PHOTOS.list({ prefix, limit: PHOTO_DELETE_PAGE_SIZE });
    const keys = page.objects
      .map((object) => object.key)
      .filter((key) => typeof key === "string" && key.startsWith(prefix));
    if (keys.length > 0) await this.env.PHOTOS.delete(keys);
    if (page.truncated && keys.length === 0) throw new Error("R2 returned an empty truncated page.");

    return jsonResponse(200, { complete: !page.truncated, deleted: keys.length });
  }
}

function validateRetentionUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Retention endpoint configuration is invalid.");
  }
  if (
    url.origin !== RETENTION_ORIGIN ||
    url.pathname !== RETENTION_PATH ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Retention endpoint configuration is invalid.");
  }
  return url.href;
}

async function callRetentionEndpoint(url, secret, fetchImpl) {
  let previousRemaining = null;
  for (let attempt = 0; attempt < RETENTION_MAX_REQUESTS; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        redirect: "manual",
        headers: {
          Authorization: `Bearer ${secret}`,
          Accept: "application/json",
        },
      });
    } catch {
      throw new Error("Retention request failed.");
    }
    if (!response.ok) throw new Error(`Retention request failed with status ${response.status}.`);

    let bytes;
    try {
      bytes = await readBoundedBody(response.body, RETENTION_MAX_RESPONSE_BYTES);
    } catch {
      throw new Error("Retention response could not be read.");
    }

    let result;
    try {
      result = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new Error("Retention response was invalid.");
    }
    const deleted = result?.deleted;
    const authDeleted = result?.authDeleted ?? 0;
    const remaining = result?.remainingExpired;
    if (
      !Number.isSafeInteger(deleted) || deleted < 0 ||
      !Number.isSafeInteger(authDeleted) || authDeleted < 0 ||
      !Number.isSafeInteger(remaining) || remaining < 0
    ) {
      throw new Error("Retention response was invalid.");
    }
    if (remaining === 0) return;
    if ((previousRemaining !== null && remaining >= previousRemaining) || deleted + authDeleted === 0) {
      throw new Error("Retention backlog remains and made no progress.");
    }
    previousRemaining = remaining;
  }
  throw new Error("Retention backlog remains after the bounded purge limit.");
}

export function createPhotoWorker({ fetchImpl = globalThis.fetch.bind(globalThis) } = {}) {
  return {
    fetch: (request, env) => handleEdgeRequest(request, env),
    scheduled: (event, env, ctx) => {
      const hasUrl = Boolean(env.RETENTION_URL);
      const hasSecret = Boolean(env.KIP_RETENTION_SECRET);
      if (!hasUrl || !hasSecret) throw new Error("Retention configuration is incomplete.");
      const url = validateRetentionUrl(env.RETENTION_URL);
      const promise = callRetentionEndpoint(url, env.KIP_RETENTION_SECRET, fetchImpl);
      if (typeof ctx?.waitUntil === "function") ctx.waitUntil(promise);
      else return promise;
    },
  };
}

const worker = createPhotoWorker();

export const fetchPhotos = worker.fetch;
export const scheduled = worker.scheduled;

export default {
  fetch: fetchPhotos,
  scheduled,
};

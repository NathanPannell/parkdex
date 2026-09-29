import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  AccountPhotos,
  createPhotoWorker,
  PHOTO_DELETE_PAGE_SIZE,
  PHOTO_MAX_BYTES,
} from "./private-photos.mjs";

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
const CLAIM_ID = "33333333-3333-4333-8333-333333333333";
const TOKEN = "local-test-photo-service-token-that-is-long-enough";
const OBJECT_PATH = `/v1/objects/accounts/${ACCOUNT_ID}/claims/${CLAIM_ID}`;
const ACCOUNT_PATH = `/v1/accounts/${ACCOUNT_ID}`;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function pngBytes(length = 12) {
  const bytes = new Uint8Array(length);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return bytes;
}

function cursor(rows = []) {
  return { toArray: () => rows };
}

class MemorySql {
  tombstoned = false;
  schema = "";

  exec(statement) {
    const sql = String(statement).trim();
    if (sql.startsWith("CREATE TABLE")) {
      this.schema = sql;
      return cursor();
    }
    if (sql.startsWith("INSERT OR IGNORE INTO deleted_account")) {
      this.tombstoned = true;
      return cursor();
    }
    if (sql.startsWith("SELECT tombstone FROM deleted_account")) {
      return cursor(this.tombstoned ? [{ tombstone: 1 }] : []);
    }
    throw new Error("Unexpected SQL in test stub.");
  }
}

class MemoryBucket {
  objects = new Map();
  calls = [];
  beforePut;
  beforeList;

  async put(key, value, options = {}) {
    this.calls.push({ method: "put", key });
    if (this.beforePut) await this.beforePut(key);
    const bytes = new Uint8Array(value).slice();
    this.objects.set(key, {
      bytes,
      size: bytes.byteLength,
      httpMetadata: { ...options.httpMetadata },
      customMetadata: { ...options.customMetadata },
    });
  }

  async get(key) {
    this.calls.push({ method: "get", key });
    const stored = this.objects.get(key);
    if (!stored) return null;
    return {
      size: stored.size,
      httpMetadata: { ...stored.httpMetadata },
      customMetadata: { ...stored.customMetadata },
      body: new Response(stored.bytes.slice()).body,
    };
  }

  async head(key) {
    this.calls.push({ method: "head", key });
    const stored = this.objects.get(key);
    if (!stored) return null;
    return {
      size: stored.size,
      httpMetadata: { ...stored.httpMetadata },
      customMetadata: { ...stored.customMetadata },
    };
  }

  async delete(keys) {
    const list = Array.isArray(keys) ? keys : [keys];
    this.calls.push({ method: "delete", keys: list.slice() });
    for (const key of list) this.objects.delete(key);
  }

  async list({ prefix, limit }) {
    this.calls.push({ method: "list", prefix, limit });
    if (this.beforeList) await this.beforeList(prefix);
    const keys = [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort();
    const page = keys.slice(0, limit);
    return {
      objects: page.map((key) => ({ key })),
      truncated: keys.length > page.length,
    };
  }
}

function harness({ fetchImpl } = {}) {
  const sql = new MemorySql();
  const bucket = new MemoryBucket();
  const env = {
    PHOTO_SERVICE_TOKEN: TOKEN,
    RELEASE_SHA: "a".repeat(40),
    PHOTOS: bucket,
  };
  let durableObject;
  let durableId;
  env.ACCOUNT_PHOTOS = {
    idFromName(name) {
      return name;
    },
    get(id) {
      if (!durableObject || durableId !== id) {
        durableId = id;
        durableObject = new AccountPhotos({ storage: { sql } }, env);
      }
      return { fetch: (request) => durableObject.fetch(request) };
    },
  };

  return {
    env,
    sql,
    bucket,
    worker: createPhotoWorker(fetchImpl ? { fetchImpl } : undefined),
    recreateDurableObject() {
      durableObject = undefined;
      durableId = undefined;
    },
  };
}

function makeRequest(path, { method = "GET", bytes, contentType, digest, token = TOKEN } = {}) {
  const headers = new Headers();
  if (token !== null) headers.set("Authorization", `Bearer ${token}`);
  if (contentType) headers.set("Content-Type", contentType);
  if (digest) headers.set("X-Content-SHA256", digest);
  return new Request(`https://photos.example${path}`, {
    method,
    headers,
    body: bytes === undefined ? undefined : bytes.slice().buffer,
  });
}

async function call(h, path, options = {}) {
  return h.worker.fetch(makeRequest(path, options), h.env);
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("health is public and returns only a validated release SHA", async () => {
  const h = harness();
  const result = await h.worker.fetch(new Request("https://photos.example/health"), h.env);
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { status: "ok", releaseSha: "a".repeat(40) });

  h.env.RELEASE_SHA = TOKEN;
  const invalidSha = await h.worker.fetch(new Request("https://photos.example/health"), h.env);
  assert.deepEqual(await invalidSha.json(), { status: "ok", releaseSha: null });
  assert.equal(h.bucket.calls.length, 0);
});

test("private routes require the service token before touching R2", async () => {
  const h = harness();
  const missing = await call(h, OBJECT_PATH, { method: "GET", token: null });
  assert.equal(missing.status, 401);
  const wrong = await call(h, OBJECT_PATH, { method: "GET", token: "wrong-token-long-enough-but-wrong" });
  assert.equal(wrong.status, 401);
  assert.equal(h.bucket.calls.length, 0);

  delete h.env.PHOTO_SERVICE_TOKEN;
  const unconfigured = await call(h, OBJECT_PATH, { method: "GET" });
  assert.equal(unconfigured.status, 503);
  assert.equal(h.bucket.calls.length, 0);
});

test("unknown paths and unsupported methods cannot reach storage", async () => {
  const h = harness();
  const unknown = await call(h, "/v1/objects/public/file", { method: "GET" });
  assert.equal(unknown.status, 404);

  const unsupported = await call(h, OBJECT_PATH, { method: "POST" });
  assert.equal(unsupported.status, 405);
  assert.equal(unsupported.headers.get("Allow"), "GET, PUT, DELETE");
  assert.equal(h.bucket.calls.length, 0);
});

test("PUT validates size, MIME, magic bytes, and the server-computed SHA-256", async () => {
  const h = harness();
  const bytes = pngBytes();
  const digest = sha256(bytes);
  const uploaded = await call(h, OBJECT_PATH, {
    method: "PUT",
    bytes,
    contentType: "image/png; charset=binary",
    digest,
  });
  assert.equal(uploaded.status, 204);
  assert.equal(uploaded.headers.get("X-Content-SHA256"), digest);
  assert.equal(h.bucket.objects.get(`accounts/${ACCOUNT_ID}/claims/${CLAIM_ID}`).httpMetadata.contentType, "image/png");

  const badHash = await call(h, OBJECT_PATH, {
    method: "PUT",
    bytes,
    contentType: "image/png",
    digest: "0".repeat(64),
  });
  assert.equal(badHash.status, 400);

  const mismatchedMagic = await call(h, OBJECT_PATH, {
    method: "PUT",
    bytes,
    contentType: "image/jpeg",
    digest,
  });
  assert.equal(mismatchedMagic.status, 400);

  const svg = new TextEncoder().encode("<svg></svg>");
  const unsupported = await call(h, OBJECT_PATH, {
    method: "PUT",
    bytes: svg,
    contentType: "image/svg+xml",
    digest: sha256(svg),
  });
  assert.equal(unsupported.status, 415);

  const tooLarge = pngBytes(PHOTO_MAX_BYTES + 1);
  const oversized = await call(h, OBJECT_PATH, {
    method: "PUT",
    bytes: tooLarge,
    contentType: "image/png",
    digest: sha256(tooLarge),
  });
  assert.equal(oversized.status, 413);
  assert.equal(h.bucket.objects.size, 1);
});

test("same-digest PUT is idempotent and a changed photo cannot overwrite the backed-up claim photo", async () => {
  const h = harness();
  const original = pngBytes();
  const originalDigest = sha256(original);
  const first = await call(h, OBJECT_PATH, {
    method: "PUT",
    bytes: original,
    contentType: "image/png",
    digest: originalDigest,
  });
  const retry = await call(h, OBJECT_PATH, {
    method: "PUT",
    bytes: original,
    contentType: "image/png",
    digest: originalDigest,
  });
  assert.equal(first.status, 204);
  assert.equal(retry.status, 204);
  assert.equal(h.bucket.calls.filter((entry) => entry.method === "put").length, 1);

  const changed = pngBytes();
  changed[11] = 1;
  const conflict = await call(h, OBJECT_PATH, {
    method: "PUT",
    bytes: changed,
    contentType: "image/png",
    digest: sha256(changed),
  });
  assert.equal(conflict.status, 409);
  assert.deepEqual(h.bucket.objects.get(`accounts/${ACCOUNT_ID}/claims/${CLAIM_ID}`).bytes, original);
});

test("GET verifies stored bytes and returns private cache, content type, and digest metadata", async () => {
  const h = harness();
  const bytes = pngBytes();
  const digest = sha256(bytes);
  const uploaded = await call(h, OBJECT_PATH, {
    method: "PUT",
    bytes,
    contentType: "image/png",
    digest,
  });
  assert.equal(uploaded.status, 204);

  const downloaded = await call(h, OBJECT_PATH, { method: "GET" });
  assert.equal(downloaded.status, 200);
  assert.equal(downloaded.headers.get("Content-Type"), "image/png");
  assert.equal(downloaded.headers.get("Content-Length"), String(bytes.byteLength));
  assert.equal(downloaded.headers.get("X-Content-SHA256"), digest);
  assert.equal(downloaded.headers.get("Cache-Control"), "private, no-store");
  assert.deepEqual(new Uint8Array(await downloaded.arrayBuffer()), bytes);

  h.bucket.objects.get(`accounts/${ACCOUNT_ID}/claims/${CLAIM_ID}`).customMetadata = {};
  const missingStoredHash = await call(h, OBJECT_PATH, { method: "GET" });
  assert.equal(missingStoredHash.status, 500);

  const missing = await call(h, `/v1/objects/accounts/${OTHER_ACCOUNT_ID}/claims/${CLAIM_ID}`, { method: "GET" });
  assert.equal(missing.status, 404);
});

test("single-object DELETE is idempotent and returns 204", async () => {
  const h = harness();
  const bytes = pngBytes();
  await call(h, OBJECT_PATH, { method: "PUT", bytes, contentType: "image/png", digest: sha256(bytes) });
  const deleted = await call(h, OBJECT_PATH, { method: "DELETE" });
  assert.equal(deleted.status, 204);
  assert.equal(h.bucket.objects.size, 0);
  assert.equal((await call(h, OBJECT_PATH, { method: "DELETE" })).status, 204);
});

test("account deletion persists a boolean tombstone and deletes bounded pages", async () => {
  const h = harness();
  for (let index = 0; index < PHOTO_DELETE_PAGE_SIZE * 2 + 1; index += 1) {
    h.bucket.objects.set(`accounts/${ACCOUNT_ID}/claims/${String(index).padStart(3, "0")}`, { size: 0 });
  }
  h.bucket.objects.set(`accounts/${OTHER_ACCOUNT_ID}/claims/keep`, { size: 0 });
  h.bucket.beforeList = async () => assert.equal(h.sql.tombstoned, true);

  const first = await call(h, ACCOUNT_PATH, { method: "DELETE" });
  assert.deepEqual(await first.json(), { complete: false, deleted: PHOTO_DELETE_PAGE_SIZE });
  const second = await call(h, ACCOUNT_PATH, { method: "DELETE" });
  assert.deepEqual(await second.json(), { complete: false, deleted: PHOTO_DELETE_PAGE_SIZE });
  const last = await call(h, ACCOUNT_PATH, { method: "DELETE" });
  assert.deepEqual(await last.json(), { complete: true, deleted: 1 });
  assert.equal(h.bucket.objects.size, 1);
  assert.equal(h.bucket.objects.has(`accounts/${OTHER_ACCOUNT_ID}/claims/keep`), true);
  assert.match(h.sql.schema, /tombstone INTEGER PRIMARY KEY CHECK \(tombstone = 1\)/);
  assert.doesNotMatch(h.sql.schema, /account_id|email|photo/i);

  h.recreateDurableObject();
  const bytes = pngBytes();
  const staleUpload = await call(h, OBJECT_PATH, {
    method: "PUT",
    bytes,
    contentType: "image/png",
    digest: sha256(bytes),
  });
  assert.equal(staleUpload.status, 410);
});

test("a PUT already in flight completes before account deletion tombstones and purges it", async () => {
  const h = harness();
  const putStarted = deferred();
  const releasePut = deferred();
  h.bucket.beforePut = async () => {
    putStarted.resolve();
    await releasePut.promise;
  };
  const bytes = pngBytes();
  const putPromise = call(h, OBJECT_PATH, {
    method: "PUT",
    bytes,
    contentType: "image/png",
    digest: sha256(bytes),
  });
  await putStarted.promise;

  const deletePromise = call(h, ACCOUNT_PATH, { method: "DELETE" });
  await Promise.resolve();
  assert.equal(h.sql.tombstoned, false);
  releasePut.resolve();

  const [put, deleted] = await Promise.all([putPromise, deletePromise]);
  assert.equal(put.status, 204);
  assert.deepEqual(await deleted.json(), { complete: true, deleted: 1 });
  assert.equal(h.sql.tombstoned, true);
  assert.equal(h.bucket.objects.size, 0);
});

test("an upload queued behind account deletion observes the persisted tombstone", async () => {
  const h = harness();
  const listStarted = deferred();
  const releaseList = deferred();
  h.bucket.beforeList = async () => {
    listStarted.resolve();
    await releaseList.promise;
  };
  const deletion = call(h, ACCOUNT_PATH, { method: "DELETE" });
  await listStarted.promise;
  assert.equal(h.sql.tombstoned, true);

  const bytes = pngBytes();
  const upload = call(h, OBJECT_PATH, {
    method: "PUT",
    bytes,
    contentType: "image/png",
    digest: sha256(bytes),
  });
  releaseList.resolve();

  const [deleted, staleUpload] = await Promise.all([deletion, upload]);
  assert.deepEqual(await deleted.json(), { complete: true, deleted: 0 });
  assert.equal(staleUpload.status, 410);
  assert.equal(h.bucket.objects.size, 0);
});

test("daily retention runs only when configured and never logs its secret", async () => {
  const requests = [];
  const retentionUrl = "https://staging.web.parkdex.app/api/retention/interactions/purge";
  const h = harness({
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return Response.json({ deleted: 2, authDeleted: 0, remainingExpired: 0 });
    },
  });
  const pending = [];
  assert.throws(() => h.worker.scheduled({}, {}, { waitUntil: () => {} }), /Retention configuration is incomplete/);
  assert.throws(() => h.worker.scheduled({}, { RETENTION_URL: retentionUrl }, { waitUntil: () => {} }), /Retention configuration is incomplete/);
  assert.equal(requests.length, 0);

  h.worker.scheduled(
    {},
    { KIP_ENVIRONMENT: "staging", RETENTION_URL: retentionUrl, KIP_RETENTION_SECRET: TOKEN },
    { waitUntil: (promise) => pending.push(promise) },
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.method, "POST");
  assert.equal(requests[0].options.redirect, "manual");
  assert.equal(requests[0].options.headers.Authorization, `Bearer ${TOKEN}`);
  await pending[0];

  const invalidUrlWorker = createPhotoWorker({ fetchImpl: async () => assert.fail("invalid endpoint must not receive the secret") });
  assert.throws(
    () => invalidUrlWorker.scheduled(
      {},
      { KIP_ENVIRONMENT: "staging", RETENTION_URL: "https://untrusted.example/api/retention/interactions/purge", KIP_RETENTION_SECRET: TOKEN },
      { waitUntil: () => {} },
    ),
    /Retention endpoint configuration is invalid/,
  );

  const failing = createPhotoWorker({ fetchImpl: async () => new Response(null, { status: 503 }) });
  const failedPending = [];
  failing.scheduled(
    {},
    { KIP_ENVIRONMENT: "staging", RETENTION_URL: retentionUrl, KIP_RETENTION_SECRET: TOKEN },
    { waitUntil: (promise) => failedPending.push(promise) },
  );
  await assert.rejects(failedPending[0], (error) => {
    assert.equal(error.message.includes(TOKEN), false);
    return /status 503/.test(error.message);
  });
});

test("production retention accepts only the production Parkdex endpoint", async () => {
  const requests = [];
  const h = harness({
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return Response.json({ deleted: 0, authDeleted: 0, remainingExpired: 0 });
    },
  });
  const pending = [];
  h.worker.scheduled(
    {},
    {
      KIP_ENVIRONMENT: "production",
      RETENTION_URL: "https://web.parkdex.app/api/retention/interactions/purge",
      KIP_RETENTION_SECRET: TOKEN,
    },
    { waitUntil: (promise) => pending.push(promise) },
  );
  await pending[0];
  assert.equal(requests[0].url, "https://web.parkdex.app/api/retention/interactions/purge");

  assert.throws(
    () => h.worker.scheduled(
      {},
      {
        KIP_ENVIRONMENT: "production",
        RETENTION_URL: "https://staging.web.parkdex.app/api/retention/interactions/purge",
        KIP_RETENTION_SECRET: TOKEN,
      },
      { waitUntil: () => {} },
    ),
    /Retention endpoint configuration is invalid/,
  );
});

test("daily retention drains a bounded backlog and fails when it stops making progress", async () => {
  const retentionUrl = "https://staging.web.parkdex.app/api/retention/interactions/purge";
  const reports = [
    { deleted: 5000, authDeleted: 0, remainingExpired: 4 },
    { deleted: 4, authDeleted: 0, remainingExpired: 0 },
  ];
  const requests = [];
  const h = harness({
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return Response.json(reports.shift());
    },
  });
  const pending = [];
  h.worker.scheduled(
    {},
    { KIP_ENVIRONMENT: "staging", RETENTION_URL: retentionUrl, KIP_RETENTION_SECRET: TOKEN },
    { waitUntil: (promise) => pending.push(promise) },
  );
  await pending[0];
  assert.equal(requests.length, 2);
  assert.equal(requests.every((item) => item.options.redirect === "manual"), true);

  const stalled = createPhotoWorker({
    fetchImpl: async () => Response.json({ deleted: 0, authDeleted: 0, remainingExpired: 3 }),
  });
  const stalledPending = [];
  stalled.scheduled(
    {},
    { KIP_ENVIRONMENT: "staging", RETENTION_URL: retentionUrl, KIP_RETENTION_SECRET: TOKEN },
    { waitUntil: (promise) => stalledPending.push(promise) },
  );
  await assert.rejects(stalledPending[0], (error) => {
    assert.equal(error.message.includes(TOKEN), false);
    return /backlog remains and made no progress/.test(error.message);
  });

  let remaining = 5;
  const bounded = createPhotoWorker({
    fetchImpl: async () => Response.json({ deleted: 5000, authDeleted: 0, remainingExpired: remaining-- }),
  });
  const boundedPending = [];
  bounded.scheduled(
    {},
    { KIP_ENVIRONMENT: "staging", RETENTION_URL: retentionUrl, KIP_RETENTION_SECRET: TOKEN },
    { waitUntil: (promise) => boundedPending.push(promise) },
  );
  await assert.rejects(boundedPending[0], /bounded purge limit/);
  assert.equal(remaining, 0);
});

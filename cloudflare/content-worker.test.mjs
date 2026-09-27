import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import worker from "./content-worker.mjs";

const RELEASE = "a".repeat(64);
const CONTENT_URL = `https://kip-assets.parkdex.app/releases/${RELEASE}/maps/park.pmtiles`;
const ETAG = '"sha256-test"';
const uploaded = new Date("2026-09-01T12:00:00.123Z");

class MemoryCache {
  entries = new Map();

  async match(request) {
    const key = new URL(request.url).toString();
    const cached = this.entries.get(key);
    if (!cached) return undefined;

    const ifNoneMatch = request.headers.get("If-None-Match");
    if (ifNoneMatch && ifNoneMatch.split(",").map((tag) => tag.trim().replace(/^W\//, "")).includes(cached.headers.get("ETag"))) {
      return new Response(null, { status: 304, headers: cached.headers });
    }
    return cached.clone();
  }

  async put(request, response) {
    assert.equal(request.method, "GET");
    assert.equal(response.status, 200);
    const key = new URL(request.url).toString();
    this.entries.set(key, response.clone());
  }
}

let previousCaches;
let cache;

before(() => {
  previousCaches = globalThis.caches;
});

beforeEach(() => {
  cache = new MemoryCache();
  globalThis.caches = { default: cache };
});

after(() => {
  if (previousCaches === undefined) delete globalThis.caches;
  else globalThis.caches = previousCaches;
});

function makeObject(bytes = "tile bytes", metadata = {}) {
  const body = new TextEncoder().encode(bytes);
  return {
    size: body.byteLength,
    body: new Response(body).body,
    etag: "sha256-test",
    httpEtag: ETAG,
    uploaded,
    writeHttpMetadata(headers) {
      headers.set("Content-Type", "application/vnd.pmtiles");
      headers.set("Cache-Control", "public, max-age=31536000, immutable");
      for (const [name, value] of Object.entries(metadata)) headers.set(name, value);
    },
  };
}

function harness(object = makeObject()) {
  const calls = [];
  const env = {
    CONTENT: {
      async get(key, options) {
        calls.push({ method: "get", key, options });
        if (object === null) return null;
        const ifNoneMatch = options.onlyIf.get("If-None-Match");
        if (ifNoneMatch?.split(",").map((tag) => tag.trim().replace(/^W\//, "")).includes(ETAG)) {
          const { body, ...metadata } = object;
          return metadata;
        }
        if (!options.range) return object;

        const bytes = new TextEncoder().encode("tile bytes");
        let start;
        let end;
        if (options.range.suffix !== undefined) {
          start = Math.max(0, bytes.length - options.range.suffix);
          end = bytes.length - 1;
        } else {
          start = options.range.offset;
          end = Math.min(bytes.length - 1, start + (options.range.length ?? bytes.length) - 1);
        }
        if (start >= bytes.length) throw new Error("get: Invalid range (10039)");
        return { ...object, body: new Response(bytes.slice(start, end + 1)).body };
      },
      async head(key) {
        calls.push({ method: "head", key });
        if (object === null) return null;
        const { body, ...metadata } = object;
        return metadata;
      },
    },
  };
  const pending = [];
  const ctx = { waitUntil(promise) { pending.push(promise); } };
  return { env, ctx, calls, pending, cache };
}

async function request(url = CONTENT_URL, options = {}, setup = harness()) {
  const result = await worker.fetch(new Request(url, options), setup.env, setup.ctx);
  await Promise.all(setup.pending);
  return { ...setup, result };
}

test("only versioned release keys are served and root is not an index", async () => {
  const root = await request("https://kip-assets.parkdex.app/");
  assert.equal(root.result.status, 404);
  assert.equal(root.calls.length, 0);

  for (const path of ["/maps/x", `/releases/${RELEASE}/../secret`, `/releases/${RELEASE}/%2e%2e/secret`]) {
    const invalid = await request(`https://kip-assets.parkdex.app${path}`);
    assert.equal(invalid.result.status, 404, path);
    assert.equal(invalid.calls.length, 0, path);
  }
});

test("OPTIONS is public CORS preflight and unsupported methods cannot access R2", async () => {
  const options = await request(CONTENT_URL, { method: "OPTIONS" });
  assert.equal(options.result.status, 204);
  assert.equal(options.result.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal(options.result.headers.get("Access-Control-Allow-Methods"), "GET, HEAD, OPTIONS");
  assert.equal(options.calls.length, 0);

  const put = await request(CONTENT_URL, { method: "PUT" });
  assert.equal(put.result.status, 405);
  assert.equal(put.result.headers.get("Allow"), "GET, HEAD, OPTIONS");
  assert.equal(put.calls.length, 0);
});

test("GET preserves R2 metadata and caches only a full successful response", async () => {
  const first = await request(`${CONTENT_URL}?source=app`);
  assert.equal(first.result.status, 200);
  assert.equal(first.result.headers.get("Content-Type"), "application/vnd.pmtiles");
  assert.equal(first.result.headers.get("ETag"), ETAG);
  assert.equal(first.result.headers.get("Cache-Control"), "public, max-age=31536000, immutable");
  assert.equal(first.result.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal(first.result.headers.get("X-Content-Cache"), "MISS");
  assert.equal(await first.result.text(), "tile bytes");
  assert.equal(first.cache.entries.size, 1);

  const second = await request(`${CONTENT_URL}?source=android`, {}, first);
  assert.equal(second.result.status, 200);
  assert.equal(second.result.headers.get("X-Content-Cache"), "HIT");
  assert.equal(second.calls.length, 1);

  const notModified = await request(CONTENT_URL, { headers: { "If-None-Match": ETAG } }, first);
  assert.equal(notModified.result.status, 304);
  assert.equal(notModified.result.headers.get("X-Content-Cache"), "HIT");
  assert.equal(notModified.calls.length, 1);
});

test("If-None-Match returns a bodyless 304 for GET and HEAD", async () => {
  const get = await request(CONTENT_URL, { headers: { "If-None-Match": `W/${ETAG}` } });
  assert.equal(get.result.status, 304);
  assert.equal(await get.result.text(), "");
  assert.equal(get.result.headers.get("ETag"), ETAG);
  assert.equal(get.result.headers.get("X-Content-Cache"), "MISS");

  const head = await request(CONTENT_URL, { method: "HEAD", headers: { "If-None-Match": ETAG } });
  assert.equal(head.result.status, 304);
  assert.equal(await head.result.text(), "");
  assert.equal(head.calls[0].method, "head");
});

test("single byte ranges return 206 and unsatisfied ranges return 416", async () => {
  const ranged = await request(CONTENT_URL, { headers: { Range: "bytes=2-5" } });
  assert.equal(ranged.result.status, 206);
  assert.equal(ranged.result.headers.get("Content-Range"), "bytes 2-5/10");
  assert.equal(ranged.result.headers.get("Content-Length"), "4");
  assert.equal(ranged.result.headers.get("X-Content-Cache"), "BYPASS");
  assert.equal(await ranged.result.text(), "le b");
  assert.equal(ranged.cache.entries.size, 0);

  const unsatisfied = await request(CONTENT_URL, { headers: { Range: "bytes=100-" } });
  assert.equal(unsatisfied.result.status, 416);
  assert.equal(unsatisfied.result.headers.get("Content-Range"), "bytes */10");
});

test("HEAD reports metadata without reading or caching an object body", async () => {
  const head = await request(CONTENT_URL, { method: "HEAD" });
  assert.equal(head.result.status, 200);
  assert.equal(head.result.headers.get("Content-Length"), "10");
  assert.equal(head.result.headers.get("X-Content-Cache"), "BYPASS");
  assert.equal(head.calls[0].method, "head");
  assert.equal(head.cache.entries.size, 0);
  assert.equal(await head.result.text(), "");
});

test("date validators use the HTTP Last-Modified second", async () => {
  const head = await request(CONTENT_URL, { method: "HEAD" });
  const lastModified = head.result.headers.get("Last-Modified");
  assert.equal(lastModified, "Tue, 01 Sep 2026 12:00:00 GMT");

  const unchanged = await request(
    CONTENT_URL,
    { method: "HEAD", headers: { "If-Modified-Since": lastModified } },
  );
  assert.equal(unchanged.result.status, 304);

  const unmodified = await request(
    CONTENT_URL,
    { method: "HEAD", headers: { "If-Unmodified-Since": lastModified } },
  );
  assert.equal(unmodified.result.status, 200);
});

test("If-Range applies the stored ETag before choosing a range response", async () => {
  const stale = await request(CONTENT_URL, {
    headers: { Range: "bytes=2-5", "If-Range": '"old-etag"' },
  });
  assert.equal(stale.result.status, 200);
  assert.equal(await stale.result.text(), "tile bytes");
  assert.equal(stale.calls[0].method, "head");
  assert.equal(stale.calls[1].options.range, undefined);

  const current = await request(CONTENT_URL, {
    headers: { Range: "bytes=2-5", "If-Range": ETAG },
  });
  assert.equal(current.result.status, 206);
  assert.equal(await current.result.text(), "le b");
  assert.deepEqual(current.calls[1].options.range, { offset: 2, length: 4 });
});

test("missing objects return 404 without caching", async () => {
  const missing = await request(CONTENT_URL, {}, harness(null));
  assert.equal(missing.result.status, 404);
  assert.equal(missing.cache.entries.size, 0);
});

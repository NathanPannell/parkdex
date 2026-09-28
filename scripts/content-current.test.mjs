import assert from "node:assert/strict";
import { test } from "node:test";
import { createCurrentHandler } from "../api/content/current.ts";

const RELEASE = "a".repeat(64);
const POINTER = {
  schema: "parkdex.content-channel/v1",
  environment: "staging",
  generation: 1,
  releaseId: RELEASE,
  manifestUrl: "https://kip-assets.parkdex.app/releases/" + RELEASE + "/manifest.json",
  manifestSha256: "b".repeat(64),
  minimumReaderVersion: 1,
};

function makeResponse() {
  const headers = new Map();
  return {
    headers,
    statusCode: 200,
    body: "",
    setHeader(name, value) {
      headers.set(name.toLowerCase(), value);
    },
    end(body = "") {
      this.body = body;
    },
  };
}

async function invoke({ env = { CONTENT_CHANNEL: "staging" }, request = {}, upstream } = {}) {
  let fetchArgs;
  const handler = createCurrentHandler({
    env,
    fetcher: async (...args) => {
      fetchArgs = args;
      if (upstream instanceof Error) throw upstream;
      if (typeof upstream === "function") return upstream(...args);
      return upstream ?? new Response(JSON.stringify(POINTER), {
        status: 200,
        headers: { "Content-Type": "application/json", ETag: '"pointer-v1"' },
      });
    },
  });
  const response = makeResponse();
  await handler(
    { method: "GET", headers: {}, ...request },
    response,
  );
  return { response, fetchArgs };
}

test("GET discovers the configured channel from the public CDN and validates its schema", async () => {
  const { response, fetchArgs } = await invoke({
    request: { headers: { origin: "https://staging.web.parkdex.app" } },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), POINTER);
  assert.equal(fetchArgs[0], "https://kip-assets.parkdex.app/channels/staging/current.json");
  assert.equal(fetchArgs[1].cache, "no-store");
  assert.ok(fetchArgs[1].signal instanceof AbortSignal);
  assert.equal(response.headers.get("cache-control"), "public, max-age=60, s-maxage=60");
  assert.equal(response.headers.get("etag"), '"pointer-v1"');
  assert.equal(response.headers.get("access-control-allow-origin"), "https://staging.web.parkdex.app");
});

test("development and preview default to staging, while production requires configuration", async () => {
  const dev = await invoke({ env: { NODE_ENV: "development", VERCEL_ENV: "development" } });
  assert.equal(dev.response.statusCode, 200);
  assert.equal(dev.fetchArgs[0], "https://kip-assets.parkdex.app/channels/staging/current.json");

  const preview = await invoke({ env: { NODE_ENV: "production", VERCEL_ENV: "preview" } });
  assert.equal(preview.response.statusCode, 200);
  assert.equal(preview.fetchArgs[0], "https://kip-assets.parkdex.app/channels/staging/current.json");

  let fetchCount = 0;
  const missing = await invoke({
    env: { NODE_ENV: "production", VERCEL_ENV: "production" },
    upstream: async () => {
      fetchCount += 1;
      return new Response("{}");
    },
  });
  assert.equal(missing.response.statusCode, 500);
  assert.match(missing.response.body, /CONTENT_CHANNEL is required/);
  assert.equal(fetchCount, 0);
});

test("production can select main, and the pointer must match that environment", async () => {
  const mainPointer = { ...POINTER, environment: "main" };
  const result = await invoke({
    env: { NODE_ENV: "production", VERCEL_ENV: "production", CONTENT_CHANNEL: "main" },
    upstream: new Response(JSON.stringify(mainPointer), {
      status: 200,
      headers: { ETag: '"main-v1"' },
    }),
  });
  assert.equal(result.response.statusCode, 200);
  assert.equal(result.fetchArgs[0], "https://kip-assets.parkdex.app/channels/main/current.json");

  const mismatch = await invoke({
    env: { CONTENT_CHANNEL: "main" },
    upstream: new Response(JSON.stringify(POINTER), { status: 200 }),
  });
  assert.equal(mismatch.response.statusCode, 502);
  assert.match(mismatch.response.body, /pointer is invalid/);
});

test("malformed pointers fail closed", async (t) => {
  const cases = [
    ["invalid JSON", "{"],
    ["wrong schema", JSON.stringify({ ...POINTER, schema: "other/v1" })],
    ["extra fields", JSON.stringify({ ...POINTER, debug: true })],
    ["non-integer generation", JSON.stringify({ ...POINTER, generation: 1.5 })],
    ["wrong manifest URL", JSON.stringify({ ...POINTER, manifestUrl: "https://example.com/manifest.json" })],
    ["invalid hash", JSON.stringify({ ...POINTER, manifestSha256: "bad" })],
  ];
  for (const [name, body] of cases) {
    await t.test(name, async () => {
      const { response } = await invoke({
        upstream: new Response(body, { status: 200 }),
      });
      assert.equal(response.statusCode, 502);
      assert.equal(response.headers.get("cache-control"), "no-store");
    });
  }
});

test("CORS allows only exact app origins and OPTIONS does not fetch content", async () => {
  const localhost = await invoke({ request: { headers: { origin: "https://localhost" } } });
  assert.equal(localhost.response.headers.get("access-control-allow-origin"), "https://localhost");

  const evil = await invoke({ request: { headers: { origin: "https://staging.web.parkdex.app.evil.test" } } });
  assert.equal(evil.response.statusCode, 200);
  assert.equal(evil.response.headers.has("access-control-allow-origin"), false);
  assert.equal(evil.response.headers.has("access-control-allow-credentials"), false);

  const preflight = await invoke({ request: { method: "OPTIONS", headers: { origin: "https://localhost" } } });
  assert.equal(preflight.response.statusCode, 204);
  assert.equal(preflight.response.headers.get("access-control-allow-origin"), "https://localhost");
  assert.equal(preflight.fetchArgs, undefined);
});

test("conditional requests and HEAD pass through without a response body", async () => {
  let observedHeaders;
  const conditional = await invoke({
    request: { headers: { "if-none-match": '"pointer-v1"' } },
    upstream: (() => {
      const originalFetch = async (_url, options) => {
        observedHeaders = options.headers;
        return new Response(null, { status: 304, headers: { ETag: '"pointer-v1"' } });
      };
      return originalFetch;
    })(),
  });
  assert.equal(conditional.response.statusCode, 304);
  assert.equal(conditional.response.body, "");
  assert.equal(observedHeaders?.["If-None-Match"], '"pointer-v1"');

  const head = await invoke({
    request: { method: "HEAD" },
    upstream: new Response(null, { status: 200, headers: { ETag: '"pointer-v1"' } }),
  });
  assert.equal(head.response.statusCode, 200);
  assert.equal(head.fetchArgs[1].method, "HEAD");
  assert.equal(head.response.body, "");
});

test("upstream failures are mapped to a no-store gateway error", async (t) => {
  for (const [name, upstream] of [
    ["HTTP error", new Response("missing", { status: 404 })],
    ["network failure", new Error("private upstream detail")],
  ]) {
    await t.test(name, async () => {
      const { response } = await invoke({ upstream });
      assert.equal(response.statusCode, 502);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.body.includes("private upstream detail"), false);
    });
  }
});

test("unsupported methods never fetch the CDN", async () => {
  const { response, fetchArgs } = await invoke({ request: { method: "PUT" } });
  assert.equal(response.statusCode, 405);
  assert.equal(response.headers.get("allow"), "GET, HEAD, OPTIONS");
  assert.equal(fetchArgs, undefined);
});

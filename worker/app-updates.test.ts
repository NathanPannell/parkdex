import assert from "node:assert/strict";
import { test } from "node:test";
import { createFeedbackWorker } from "./index.ts";
import { APP_BUNDLE_ORIGIN, appBundleOrigin, bundleUrlFor, pointerUrlFor, validatePointer, type AppBundleChannel, type AppBundlePointer } from "./appUpdates.ts";

const API_ORIGIN = "https://api.example.test";
const STAGING_SHA = "a".repeat(64);
const PRODUCTION_SHA = "b".repeat(64);

function pointer(channel: AppBundleChannel, overrides: Partial<AppBundlePointer> = {}): AppBundlePointer {
  const sha256 = channel === "staging" ? STAGING_SHA : PRODUCTION_SHA;
  return {
    schema: "parkdex.app-bundle-channel/v1",
    channel,
    generation: 3,
    version: channel === "staging" ? "1234567-aaaaaaaa" : "7654321-bbbbbbbb",
    bundleUrl: bundleUrlFor(APP_BUNDLE_ORIGIN, sha256),
    sha256,
    byteSize: 1024,
    minimumNativeBuild: 12,
    maximumNativeBuild: 14,
    sourceCommit: "c".repeat(40),
    publishedAt: "2026-10-07T12:00:00.000Z",
    ...overrides,
  };
}

/** A fake CDN holding one pointer per channel, recording each URL it was asked for. */
function cdn(pointers: Partial<Record<AppBundleChannel, unknown>>, status?: number) {
  const requested: string[] = [];
  const fetch = async (input: RequestInfo | URL) => {
    const url = String(input);
    requested.push(url);
    if (status) return new Response("unavailable", { status });
    for (const channel of ["staging", "production"] as const) {
      if (url === pointerUrlFor(APP_BUNDLE_ORIGIN, channel) && pointers[channel] !== undefined) {
        return new Response(JSON.stringify(pointers[channel]), { status: 200, headers: { "content-type": "application/json" } });
      }
    }
    return new Response("missing", { status: 404 });
  };
  return { fetch, requested };
}

function checkBody(overrides: Record<string, unknown> = {}) {
  return {
    platform: "android",
    device_id: "00000000-0000-4000-8000-000000000000",
    app_id: "app.parkdex",
    custom_id: "",
    version_build: "1.0.0",
    version_code: "12",
    version_os: "16",
    version_name: "builtin",
    plugin_version: "8.52.1",
    is_emulator: false,
    is_prod: true,
    defaultChannel: "staging",
    ...overrides,
  };
}

async function post(fake: ReturnType<typeof cdn>, body: unknown, init: { method?: string; contentType?: string } = {}) {
  const worker = createFeedbackWorker({ fetch: fake.fetch as typeof fetch });
  const request = new Request(`${API_ORIGIN}/api/updates`, {
    method: init.method ?? "POST",
    headers: { "content-type": init.contentType ?? "application/json" },
    body: init.method === "GET" ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const response = await worker.fetch(request, {});
  return { status: response.status, body: await response.json() as Record<string, unknown>, headers: response.headers };
}

test("offers the channel's bundle to a build inside its native range", async () => {
  const fake = cdn({ staging: pointer("staging"), production: pointer("production") });
  const result = await post(fake, checkBody());
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { version: "1234567-aaaaaaaa", url: bundleUrlFor(APP_BUNDLE_ORIGIN, STAGING_SHA), checksum: STAGING_SHA });
  assert.equal(result.headers.get("cache-control"), "no-store");
  assert.deepEqual(fake.requested, [pointerUrlFor(APP_BUNDLE_ORIGIN, "staging")]);
});

test("keeps channels apart: a production build only reads the production pointer", async () => {
  const fake = cdn({ staging: pointer("staging") });
  const result = await post(fake, checkBody({ defaultChannel: "production" }));
  assert.equal(result.status, 200);
  assert.equal(result.body.kind, "up_to_date");
  assert.equal(result.body.error, "no_bundle_published");
  assert.deepEqual(fake.requested, [pointerUrlFor(APP_BUNDLE_ORIGIN, "production")]);
});

test("refuses a pointer that names another channel, even at the right path", async () => {
  const fake = cdn({ production: pointer("staging") });
  const result = await post(fake, checkBody({ defaultChannel: "production" }));
  assert.equal(result.status, 503);
  assert.equal(result.body.kind, "failed");
  assert.equal(result.body.error, "pointer_unavailable");
});

test("never offers a bundle to a native build below its minimum or above its maximum", async () => {
  const fake = cdn({ staging: pointer("staging") });
  for (const build of ["11", "15"]) {
    const result = await post(fake, checkBody({ version_code: build }));
    assert.equal(result.status, 200);
    assert.equal(result.body.kind, "up_to_date");
    assert.equal(result.body.error, "native_build_out_of_range");
    assert.equal(result.body.url, undefined);
  }
  for (const build of ["12", "14"]) {
    const result = await post(fake, checkBody({ version_code: build }));
    assert.equal(result.body.version, "1234567-aaaaaaaa");
  }
});

test("answers up to date when the build already runs the current bundle", async () => {
  const fake = cdn({ staging: pointer("staging") });
  const result = await post(fake, checkBody({ version_name: "1234567-aaaaaaaa" }));
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { kind: "up_to_date", error: "no_new_version_available", message: "This build already runs the current bundle." });
});

test("moving the pointer back offers the older bundle as a rollback", async () => {
  const fake = cdn({ staging: pointer("staging", { version: "0000001-aaaaaaaa", generation: 4 }) });
  const result = await post(fake, checkBody({ version_name: "1234567-aaaaaaaa" }));
  assert.equal(result.body.version, "0000001-aaaaaaaa");
});

test("rejects malformed update checks without reading the CDN", async () => {
  const fake = cdn({ staging: pointer("staging") });
  const cases: unknown[] = [
    "not json",
    [],
    checkBody({ platform: "ios" }),
    checkBody({ app_id: "com.example.other" }),
    checkBody({ defaultChannel: "main" }),
    checkBody({ defaultChannel: undefined }),
    checkBody({ version_code: "twelve" }),
    checkBody({ version_code: "0" }),
    checkBody({ version_name: "" }),
    checkBody({ version_name: "x".repeat(200) }),
  ];
  for (const body of cases) {
    const result = await post(fake, body);
    assert.equal(result.status, 400, JSON.stringify(body).slice(0, 60));
    assert.equal(result.body.kind, "failed");
    assert.equal(result.body.error, "invalid_request");
  }
  const wrongType = await post(fake, checkBody(), { contentType: "text/plain" });
  assert.equal(wrongType.status, 400);
  const wrongMethod = await post(fake, null, { method: "GET" });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.body.kind, "failed");
  assert.deepEqual(fake.requested, []);
});

test("accepts the debug package and numeric version codes", async () => {
  const fake = cdn({ staging: pointer("staging") });
  const result = await post(fake, checkBody({ app_id: "app.parkdex.debug", version_code: 13 }));
  assert.equal(result.body.version, "1234567-aaaaaaaa");
});

test("reports a failure when the pointer cannot be read or is malformed", async () => {
  const down = await post(cdn({}, 500), checkBody());
  assert.equal(down.status, 503);
  assert.equal(down.body.kind, "failed");
  const broken = await post(cdn({ staging: { ...pointer("staging"), sha256: "nope" } }), checkBody());
  assert.equal(broken.status, 503);
  const swapped = await post(cdn({ staging: { ...pointer("staging"), bundleUrl: "https://evil.example/app.zip" } }), checkBody());
  assert.equal(swapped.status, 503);
});

test("validates every pointer field", () => {
  assert.ok(validatePointer(pointer("staging"), "staging"));
  const invalid: Array<Partial<Record<keyof AppBundlePointer, unknown>>> = [
    { schema: "parkdex.app-bundle-channel/v2" },
    { generation: 0 },
    { version: "builtin" },
    { version: "has space" },
    { bundleUrl: bundleUrlFor(APP_BUNDLE_ORIGIN, PRODUCTION_SHA) },
    { byteSize: 0 },
    { minimumNativeBuild: 15 },
    { maximumNativeBuild: null },
    { publishedAt: "yesterday" },
  ];
  for (const overrides of invalid) {
    assert.equal(validatePointer({ ...pointer("staging"), ...overrides }, "staging"), null, JSON.stringify(overrides));
  }
});

test("only local or https origins replace the CDN", () => {
  assert.equal(appBundleOrigin(undefined), APP_BUNDLE_ORIGIN);
  assert.equal(appBundleOrigin("http://localhost:5194"), "http://localhost:5194");
  assert.equal(appBundleOrigin("http://files.example.test"), APP_BUNDLE_ORIGIN);
  assert.equal(appBundleOrigin("https://user:pass@files.example.test"), APP_BUNDLE_ORIGIN);
  assert.equal(appBundleOrigin("not a url"), APP_BUNDLE_ORIGIN);
});

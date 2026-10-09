import assert from "node:assert/strict";
import { test } from "node:test";
import { APP_BUNDLE_POINTER_SCHEMA, bundleUrlFor } from "../../../worker/appUpdates.ts";
import { createDashboardApi, type DashboardEnv } from "../api.ts";
import { FakeBundleCloud, MemoryOtaHistory } from "./fakeCloud.ts";
import { FAKE_CLOUDFLARE } from "./memory.ts";
import { bundleVersion, CDN_ORIGIN, pointerKey } from "./ota.ts";

const ORIGIN = "https://operator.example.test";
const env: DashboardEnv = { DATABASE_URL: "postgres://unused", DASHBOARD_ENVIRONMENT: "test", ...FAKE_CLOUDFLARE };
const NOW = Date.parse("2026-10-09T12:00:00.000Z");
const OLD = "a".repeat(64);
const NEW = "b".repeat(64);
const COMMIT_OLD = "1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const COMMIT_NEW = "2222222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function request(path: string, options: { method?: string; body?: unknown; origin?: string | null; cookie?: string } = {}) {
  const headers = new Headers();
  const method = options.method ?? "GET";
  if (method !== "GET" && options.origin !== null) headers.set("origin", options.origin ?? ORIGIN);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  if (options.cookie) headers.set("cookie", options.cookie);
  return new Request(`${ORIGIN}${path}`, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
}

function pointer(channel: "staging" | "production", generation: number, sha256: string, commit: string, minimum = 12, maximum = 12) {
  return {
    schema: APP_BUNDLE_POINTER_SCHEMA, channel, generation, version: bundleVersion(commit, sha256), bundleUrl: bundleUrlFor(CDN_ORIGIN, sha256),
    sha256, byteSize: 100, minimumNativeBuild: minimum, maximumNativeBuild: maximum, sourceCommit: commit, publishedAt: "2026-10-01T00:00:00.000Z",
  };
}

/** Staging on generation 2 (NEW, needs build 13), production on generation 1 (OLD, needs 12), both zips in R2. */
async function setup() {
  const cloud = new FakeBundleCloud();
  const history = new MemoryOtaHistory();
  cloud.put(`app-bundles/${OLD}.zip`, new Uint8Array(100));
  cloud.put(`app-bundles/${NEW}.zip`, new Uint8Array(100));
  cloud.put(pointerKey("staging"), JSON.stringify(pointer("staging", 2, NEW, COMMIT_NEW, 13, 14)));
  cloud.put(pointerKey("production"), JSON.stringify(pointer("production", 1, OLD, COMMIT_OLD)));
  const base = { channel: "staging" as const, previousGeneration: 0, source: "script" as const, previousSha256: null, byteSize: 100, outcome: "confirmed" as const, note: "", publishedAt: "2026-10-01T00:00:00.000Z" };
  await history.record({ ...base, generation: 1, action: "publish", sha256: OLD, version: bundleVersion(COMMIT_OLD, OLD), minimumNativeBuild: 12, maximumNativeBuild: 12, sourceCommit: COMMIT_OLD }, "2026-10-01T00:00:00.000Z");
  await history.record({ ...base, generation: 2, action: "publish", sha256: NEW, version: bundleVersion(COMMIT_NEW, NEW), minimumNativeBuild: 13, maximumNativeBuild: 14, sourceCommit: COMMIT_NEW }, "2026-10-02T00:00:00.000Z");
  const api = createDashboardApi({ otaFetch: cloud.fetch, otaHistoryStore: () => history, otaNow: () => NOW });
  return { cloud, history, api };
}

async function body<T>(response: Response): Promise<T> {
  return await response.json() as T;
}

const move = (overrides: Record<string, unknown> = {}) => ({ channel: "staging", sha256: OLD, expectedGeneration: 2, minimumNativeBuild: 12, maximumNativeBuild: 12, note: "Roll back the founders card", ...overrides });

test("rolling staging back writes generation + 1, confirms it through R2 and the CDN, and records it", async () => {
  const { cloud, history, api } = await setup();
  const response = await api(request("/api/app/updates/move", { method: "POST", body: move() }), env);
  assert.equal(response.status, 200, await response.clone().text());
  const result = await body<{ outcome: string; action: string; pointer: Record<string, unknown>; message: string }>(response);
  assert.equal(result.outcome, "confirmed");
  assert.equal(result.action, "rollback");
  assert.equal(result.pointer.generation, 3);
  assert.equal(result.pointer.version, bundleVersion(COMMIT_OLD, OLD));
  assert.equal(result.pointer.publishedAt, new Date(NOW).toISOString());
  const stored = JSON.parse(new TextDecoder().decode(cloud.objects.get(pointerKey("staging"))!.body));
  assert.deepEqual(stored, result.pointer);
  // The CDN readback must skip the worker's 60 second cache.
  assert.ok(cloud.requests.some((item) => item.method === "GET" && item.url === `${CDN_ORIGIN}/${pointerKey("staging")}`));
  const row = history.rows.at(-1)!;
  assert.deepEqual([row.channel, row.generation, row.previousGeneration, row.action, row.source, row.outcome, row.previousSha256, row.note], ["staging", 3, 2, "rollback", "dashboard", "confirmed", NEW, "Roll back the founders card"]);

  // Promoting staging's bundle to production is the other common move.
  const promote = await api(request("/api/app/updates/move", { method: "POST", body: move({ channel: "production", sha256: OLD, expectedGeneration: 1 }) }), env);
  assert.equal((await body<{ action: string }>(promote)).action, "repoint", "production already runs OLD, so this only rewrites its range");
});

test("a move is refused when the generation moved, the ETag changed, or the bundle is not in R2", async () => {
  const { cloud, history, api } = await setup();
  const before = cloud.objects.get(pointerKey("staging"))!.etag;
  const stale = await api(request("/api/app/updates/move", { method: "POST", body: move({ expectedGeneration: 1 }) }), env);
  assert.equal(stale.status, 409);
  assert.equal((await body<{ error: { code: string } }>(stale)).error.code, "generation_moved");
  const etag = await api(request("/api/app/updates/move", { method: "POST", body: move({ expectedEtag: '"deadbeef"' }) }), env);
  assert.equal((await body<{ error: { code: string } }>(etag)).error.code, "generation_moved");
  const missing = await api(request("/api/app/updates/move", { method: "POST", body: move({ sha256: "c".repeat(64) }) }), env);
  assert.equal(missing.status, 409);
  assert.equal((await body<{ error: { code: string } }>(missing)).error.code, "bundle_missing");
  assert.equal(cloud.objects.get(pointerKey("staging"))!.etag, before, "nothing was written");
  assert.equal(history.rows.length, 2, "refusals are not moves");
  // The right ETag passes the guard.
  const ok = await api(request("/api/app/updates/move", { method: "POST", body: move({ expectedEtag: `"${before}"` }) }), env);
  assert.equal(ok.status, 200);
});

test("a move never lowers the minimum native build below what the bundle needs, or uses an unrecorded bundle", async () => {
  const { cloud, api } = await setup();
  const low = await api(request("/api/app/updates/move", { method: "POST", body: move({ channel: "production", sha256: NEW, expectedGeneration: 1, minimumNativeBuild: 12, maximumNativeBuild: 14 }) }), env);
  assert.equal(low.status, 409);
  const error = (await body<{ error: { code: string; message: string } }>(low)).error;
  assert.equal(error.code, "minimum_too_low");
  assert.match(error.message, /needs native build 13/);
  const promoted = await api(request("/api/app/updates/move", { method: "POST", body: move({ channel: "production", sha256: NEW, expectedGeneration: 1, minimumNativeBuild: 13, maximumNativeBuild: 14 }) }), env);
  assert.equal((await body<{ action: string }>(promoted)).action, "promote");

  cloud.put(`app-bundles/${"d".repeat(64)}.zip`, new Uint8Array(10));
  const unknown = await api(request("/api/app/updates/move", { method: "POST", body: move({ sha256: "d".repeat(64) }) }), env);
  assert.equal((await body<{ error: { code: string } }>(unknown)).error.code, "bundle_unrecorded");
  for (const invalid of [move({ channel: "main" }), move({ sha256: "xyz" }), move({ minimumNativeBuild: 14, maximumNativeBuild: 13 }), move({ expectedGeneration: -1 }), move({ extra: true }), move({ note: "x".repeat(301) })]) {
    assert.equal((await api(request("/api/app/updates/move", { method: "POST", body: invalid }), env)).status, 400, JSON.stringify(invalid).slice(0, 80));
  }
});

test("a readback that finds another writer's pointer is a 409 and is recorded as a conflict", async () => {
  const { cloud, history, api } = await setup();
  cloud.afterPut = (key) => {
    cloud.afterPut = undefined;
    // A second publisher lands between the dashboard's PUT and its readback.
    cloud.put(key, JSON.stringify(pointer("staging", 3, NEW, COMMIT_NEW, 13, 14)));
  };
  const response = await api(request("/api/app/updates/move", { method: "POST", body: move() }), env);
  assert.equal(response.status, 409);
  const error = (await body<{ error: { code: string; message: string } }>(response)).error;
  assert.equal(error.code, "readback_mismatch");
  assert.match(error.message, /generation 3/);
  assert.equal(history.rows.at(-1)!.outcome, "conflict");
});

test("when the CDN does not return the new pointer the move is cdn_pending, not confirmed", async () => {
  const { cloud, history, api } = await setup();
  await api(request("/api/app/updates"), env);
  cloud.cdnFrozen = true;
  const frozen = await body<{ outcome: string; message: string }>(await api(request("/api/app/updates/move", { method: "POST", body: move() }), env));
  assert.equal(frozen.outcome, "cdn_pending");
  assert.match(frozen.message, /generation 2/);
  cloud.cdnFrozen = false;
  cloud.servesAppBundles = false;
  const unserved = await body<{ outcome: string; message: string }>(await api(request("/api/app/updates/move", { method: "POST", body: move({ expectedGeneration: 3 }) }), env));
  assert.equal(unserved.outcome, "cdn_pending");
  assert.match(unserved.message, /CDN worker/);
  assert.deepEqual(history.rows.slice(-2).map((row) => row.outcome), ["cdn_pending", "cdn_pending"]);
});

test("moves need Cloudflare credentials, the dashboard origin and POST", async () => {
  const { api, cloud } = await setup();
  assert.equal((await api(request("/api/app/updates/move", { method: "POST", body: move(), origin: "https://evil.example.test" }), env)).status, 403);
  assert.equal((await api(request("/api/app/updates/move", { method: "POST", body: move(), origin: null }), env)).status, 403);
  assert.equal((await api(request("/api/app/updates/move"), env)).status, 405);
  const unset = await api(request("/api/app/updates/move", { method: "POST", body: move() }), { ...env, CLOUDFLARE_API_TOKEN: undefined });
  assert.equal(unset.status, 503);
  const denied = await api(request("/api/app/updates/move", { method: "POST", body: move() }), { ...env, CLOUDFLARE_API_TOKEN: "wrong" });
  assert.equal((await body<{ error: { code: string } }>(denied)).error.code, "cloudflare_denied");
  assert.equal(cloud.objects.get(pointerKey("staging"))!.body.byteLength > 0, true);
});

test("the overview shows each channel, the bundles in R2 with what they need, and the history", async () => {
  const { api } = await setup();
  const overview = await body<{
    channels: { channel: string; state: string; pointer: { generation: number }; r2: { generation: number } }[];
    bundles: { sha256: string; minimumNativeBuild: number; liveOn: string[]; version: string }[];
    history: { available: boolean; rows: unknown[] }; cloudflare: { configured: boolean };
  }>(await api(request("/api/app/updates", { cookie: "parkdex_operator_db=staging" }), env));
  assert.deepEqual(overview.channels.map((item) => [item.channel, item.state, item.pointer.generation, item.r2.generation]), [["staging", "live", 2, 2], ["production", "live", 1, 1]]);
  const byBundle = Object.fromEntries(overview.bundles.map((item) => [item.sha256, item]));
  assert.deepEqual([byBundle[NEW].minimumNativeBuild, byBundle[NEW].liveOn, byBundle[OLD].liveOn], [13, ["staging"], ["production"]]);
  assert.equal(overview.history.rows.length, 2);
  assert.equal(overview.cloudflare.configured, true);
  const without = await body<{ bundles: null; cloudflare: { configured: boolean }; channels: { state: string }[] }>(await api(request("/api/app/updates"), { ...env, CLOUDFLARE_API_TOKEN: undefined }));
  assert.deepEqual([without.bundles, without.cloudflare.configured, without.channels[0].state], [null, false, "live"]);
});

test("the setup checklist tells an old CDN worker apart from a channel with no pointer yet", async () => {
  const items = async (cloud: FakeBundleCloud, scoped: DashboardEnv = env) => {
    const api = createDashboardApi({ otaFetch: cloud.fetch, otaHistoryStore: () => new MemoryOtaHistory() });
    return Object.fromEntries((await body<{ items: { id: string; status: string; detail: string }[] }>(await api(request("/api/app/updates/setup"), scoped))).items.map((item) => [item.id, item]));
  };
  // Today's production: nothing published and a worker that predates app-bundles/.
  const old = new FakeBundleCloud();
  old.servesAppBundles = false;
  const before = await items(old);
  assert.equal(before["cdn-worker"].status, "todo");
  assert.match(before["cdn-worker"].detail, /unknown path/);
  assert.match(before["pointer-staging"].detail, /does not serve/);
  assert.equal(before.endpoint.status, "done");
  assert.equal(before.posthog.status, "todo");

  // Worker redeployed, still nothing published: the probe uses the Allow header.
  const ready = new FakeBundleCloud();
  const after = await items(ready, { ...env, POSTHOG_PERSONAL_API_KEY: "phx_test", POSTHOG_PROJECT_ID: "1" });
  assert.equal(after["cdn-worker"].status, "done");
  assert.equal(after["pointer-staging"].status, "todo");
  assert.match(after["pointer-staging"].detail, /built-in code/);
  assert.equal(after.posthog.status, "done");

  // A zip in R2 that the CDN will not serve is the definitive sign of an old worker.
  const stale = new FakeBundleCloud();
  stale.put(`app-bundles/${OLD}.zip`, new Uint8Array(4));
  stale.put(pointerKey("staging"), JSON.stringify(pointer("staging", 1, OLD, COMMIT_OLD)));
  stale.servesAppBundles = false;
  const unserved = await items(stale);
  assert.match(unserved["cdn-worker"].detail, /answers 404/);
  assert.equal(unserved["pointer-staging"].status, "todo");
  assert.match(unserved["pointer-staging"].detail, /R2 has a pointer/);
  assert.equal(unserved.cloudflare.status, "done");
  assert.equal((await items(stale, { ...env, CLOUDFLARE_API_TOKEN: undefined })).cloudflare.status, "todo");
});

test("the live check posts a sample build to the channel's endpoint and compares it with the pointer", async () => {
  const { api } = await setup();
  const inRange = await body<{ endpoint: string; answer: { version: string }; matches: boolean }>(await api(request("/api/app/updates/check?channel=staging&build=13"), env));
  assert.equal(inRange.endpoint, "https://staging.web.parkdex.app/api/updates");
  assert.equal(inRange.answer.version, bundleVersion(COMMIT_NEW, NEW));
  assert.equal(inRange.matches, true);
  const below = await body<{ answer: { error: string }; matches: boolean }>(await api(request("/api/app/updates/check?channel=staging&build=12"), env));
  assert.deepEqual([below.answer.error, below.matches], ["native_build_out_of_range", true]);
  assert.equal((await api(request("/api/app/updates/check?channel=main&build=12"), env)).status, 400);
  assert.equal((await api(request("/api/app/updates/check?channel=staging&build=0"), env)).status, 400);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { createFeedbackWorker } from "./index.ts";
import {
  API_POINTERS,
  resolveAppConfig,
  sanitizeFlags,
  validateBuildConfigInput,
  type ApiPointer,
  type AppConfigPlatform,
  type AppConfigStore,
  type BuildConfigInput,
  type BuildConfigRecord,
  type UpdateRules,
} from "./appConfig.ts";

const API_ORIGIN = "https://api.example.test";
const SECRET = "test-session-secret-which-is-long-enough";

class MemoryAppConfigStore implements AppConfigStore {
  readonly rows = new Map<string, BuildConfigRecord>();
  readonly rules = new Map<ApiPointer, UpdateRules>();

  async resolve(platform: AppConfigPlatform, build: number) {
    return [...this.rows.values()].filter((row) => row.platform === platform && (row.build === build || row.build === 0));
  }

  async list() {
    return [...this.rows.values()];
  }

  async upsert(platform: AppConfigPlatform, build: number, input: BuildConfigInput) {
    const record = { platform, build, ...input, updatedAt: new Date(0).toISOString() };
    this.rows.set(`${platform}:${build}`, record);
    return record;
  }

  async remove(platform: AppConfigPlatform, build: number) {
    return this.rows.delete(`${platform}:${build}`);
  }

  async updateRules(environment: ApiPointer) {
    return this.rules.get(environment) ?? { environment, minimumBuild: null, latestBuild: null, updatedAt: null };
  }

  async listUpdateRules() {
    return Promise.all(API_POINTERS.map((environment) => this.updateRules(environment)));
  }

  async setUpdateRules(environment: ApiPointer, minimumBuild: number | null, latestBuild: number | null) {
    const rules = { environment, minimumBuild, latestBuild, updatedAt: new Date(0).toISOString() };
    this.rules.set(environment, rules);
    return rules;
  }
}

function setup() {
  const store = new MemoryAppConfigStore();
  const worker = createFeedbackWorker({ createAppConfigStore: () => store });
  const env = { SESSION_SECRET: SECRET, PUBLIC_APP_URL: API_ORIGIN };
  return { store, worker, env };
}

function request(path: string, options: { method?: string; body?: unknown; cookie?: string; origin?: string } = {}) {
  const headers = new Headers();
  if (options.cookie) headers.set("cookie", options.cookie);
  if (options.origin) headers.set("origin", options.origin);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  return new Request(`${API_ORIGIN}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

const row = (build: number, apiPointer: ApiPointer | null, flags: Record<string, boolean> = {}): BuildConfigRecord => ({
  platform: "android",
  build,
  label: "",
  apiPointer,
  flags,
  notes: "",
  updatedAt: "",
});
const rules = (environment: ApiPointer, minimumBuild: number | null, latestBuild: number | null): UpdateRules => ({
  environment,
  minimumBuild,
  latestBuild,
  updatedAt: null,
});

/**
 * The checks builds 8 and earlier apply to a check-in (src/lib/appConfig.ts before API pointers).
 * They must keep accepting every response.
 */
function legacyClientAccepts(body: Record<string, unknown>, platform: string, build: number): boolean {
  if (body.schema !== "parkdex.app-config/v1" || body.platform !== platform || body.build !== build) return false;
  const channel = body.contentChannel ?? null;
  return channel === null || channel === "staging" || channel === "main";
}

test("a build with no configuration keeps its built-in defaults", async () => {
  const { worker, env } = setup();
  const response = await worker.fetch(request("/api/app-config?platform=android&build=42"), env as never);
  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, unknown>;
  assert.deepEqual(body, {
    schema: "parkdex.app-config/v1",
    platform: "android",
    build: 42,
    apiPointer: null,
    contentChannel: null,
    flags: {},
    environment: "production",
    minimumBuild: null,
    latestBuild: null,
    update: "none",
    source: "none",
    // Additive: without POSTHOG_PROJECT_KEY the app loads no analytics SDK.
    analytics: null,
  });
  assert.ok(legacyClientAccepts(body, "android", 42));
});

test("an exact build overrides the default pointer and flags, flag by flag", () => {
  const rows = [row(0, "production", { rankProgression: false, experimentA: true }), row(42, "staging", { experimentA: false })];
  const config = resolveAppConfig("android", 42, rows, rules("staging", null, null));
  assert.deepEqual(
    [config.apiPointer, config.contentChannel, config.flags, config.source],
    ["staging", "staging", { rankProgression: false, experimentA: false }, "build"],
  );
  const inherited = resolveAppConfig("android", 7, rows, rules("production", null, null));
  assert.deepEqual([inherited.apiPointer, inherited.contentChannel, inherited.source], ["production", "main", "default"]);
});

test("an exact build with no pointer keeps its built-in server under a production default", () => {
  const config = resolveAppConfig("android", 42, [row(0, "production"), row(42, null)], rules("production", null, null));
  assert.deepEqual([config.apiPointer, config.contentChannel], [null, null]);
});

test("update rules are global per environment and follow the build's pointer or declared environment", async () => {
  const { store, worker, env } = setup();
  await store.setUpdateRules("production", 10, 20);
  await store.setUpdateRules("staging", 30, 40);
  const check = async (query: string) => (await (await worker.fetch(request(`/api/app-config?${query}`), env as never)).json()) as Record<string, unknown>;

  // Builds 8 and earlier send no environment, so production rules apply.
  assert.deepEqual([(await check("platform=android&build=8")).update, (await check("platform=android&build=8")).environment], ["required", "production"]);
  assert.equal((await check("platform=android&build=15")).update, "available");
  assert.equal((await check("platform=android&build=20")).update, "none");
  assert.equal((await check("platform=android&build=25&env=staging")).update, "required");
  assert.equal((await check("platform=android&build=35&env=staging")).update, "available");

  // A pointer wins over the declared environment.
  await store.upsert("android", 25, { label: "", apiPointer: "production", flags: {}, notes: "" });
  const pointed = await check("platform=android&build=25&env=staging");
  assert.deepEqual([pointed.environment, pointed.update, pointed.apiPointer], ["production", "none", "production"]);
  assert.ok(legacyClientAccepts(pointed, "android", 25));

  // Unversioned web builds never need a store update.
  assert.equal((await check("platform=web&build=0")).update, "none");
});

test("any well-formed flag is stored and sent, and malformed ones are refused", () => {
  const input = validateBuildConfigInput({ apiPointer: "staging", flags: { rankProgression: true, futureMapStyle: false, beta_2: true } });
  assert.deepEqual(input.flags, { rankProgression: true, futureMapStyle: false, beta_2: true });
  for (const body of [
    { flags: { "bad-name": true } },
    { flags: { "1st": true } },
    { flags: { ok: "yes" } },
    { apiPointer: "main" },
    { contentChannel: "main" },
    { minimumBuild: 3 },
  ]) {
    assert.throws(() => validateBuildConfigInput(body), JSON.stringify(body));
  }
  assert.deepEqual(sanitizeFlags({ ok: true, "bad key": true, number: 1 }), { ok: true });
});

test("the public check-in rejects malformed builds and platforms", async () => {
  const { worker, env } = setup();
  for (const query of ["platform=android&build=-1", "platform=android&build=4.2", "platform=ios&build=1", "platform=android"]) {
    const response = await worker.fetch(request(`/api/app-config?${query}`), env as never);
    assert.equal(response.status, 400, query);
  }
});

test("the public check-in is readable from the Android web view origin", async () => {
  const { worker, env } = setup();
  const response = await worker.fetch(request("/api/app-config?platform=android&build=1", { origin: "https://localhost" }), env as never);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "https://localhost");
});

test("the app no longer edits build configuration; the operator dashboard does", async () => {
  const { store, worker, env } = setup();
  const body = { label: "Build 42", contentChannel: "main", flags: {}, minimumBuild: null, latestBuild: null, notes: "" };
  const put = await worker.fetch(request("/api/operator/app-config/android/42", { method: "PUT", body, origin: API_ORIGIN }), env as never);
  assert.equal(put.status, 404);
  assert.equal((await worker.fetch(request("/api/operator/app-config"), env as never)).status, 404);
  assert.equal(store.rows.size, 0);
});

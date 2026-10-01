import assert from "node:assert/strict";
import { test } from "node:test";
import { createFeedbackWorker } from "./index.ts";
import { resolveAppConfig, type AppConfigPlatform, type AppConfigStore, type BuildConfigInput, type BuildConfigRecord } from "./appConfig.ts";

const API_ORIGIN = "https://api.example.test";
const SECRET = "test-session-secret-which-is-long-enough";

class MemoryAppConfigStore implements AppConfigStore {
  readonly rows = new Map<string, BuildConfigRecord>();

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

test("a build with no configuration keeps its built-in defaults", async () => {
  const { worker, env } = setup();
  const response = await worker.fetch(request("/api/app-config?platform=android&build=42"), env as never);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    schema: "parkdex.app-config/v1",
    platform: "android",
    build: 42,
    contentChannel: null,
    flags: {},
    minimumBuild: null,
    latestBuild: null,
    update: "none",
    source: "none",
  });
});

test("an exact build overrides the platform default flag by flag", () => {
  const rows: BuildConfigRecord[] = [
    { platform: "android", build: 0, label: "Default", contentChannel: "main", flags: { rankProgression: false }, minimumBuild: 5, latestBuild: 50, notes: "", updatedAt: "" },
    { platform: "android", build: 42, label: "Closed test", contentChannel: "staging", flags: {}, minimumBuild: null, latestBuild: null, notes: "", updatedAt: "" },
  ];
  assert.deepEqual(resolveAppConfig("android", 42, rows), {
    schema: "parkdex.app-config/v1", platform: "android", build: 42, contentChannel: "staging", flags: { rankProgression: false },
    minimumBuild: 5, latestBuild: 50, update: "available", source: "build",
  });
  assert.equal(resolveAppConfig("android", 7, rows).contentChannel, "main");
  assert.equal(resolveAppConfig("android", 7, rows).source, "default");
});

test("an exact build with no content channel keeps its built-in channel under a main default", async () => {
  const { store, worker, env } = setup();
  store.rows.set("android:0", {
    platform: "android", build: 0, label: "Default", contentChannel: "main", flags: {},
    minimumBuild: 5, latestBuild: 50, notes: "", updatedAt: "",
  });
  store.rows.set("android:42", {
    platform: "android", build: 42, label: "Build 42", contentChannel: null, flags: {},
    minimumBuild: null, latestBuild: null, notes: "", updatedAt: "",
  });

  const response = await worker.fetch(request("/api/app-config?platform=android&build=42"), env as never);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    schema: "parkdex.app-config/v1", platform: "android", build: 42, contentChannel: null, flags: {},
    minimumBuild: 5, latestBuild: 50, update: "available", source: "build",
  });
});

test("builds below the minimum must update and below the latest are nudged", () => {
  const rows: BuildConfigRecord[] = [
    { platform: "android", build: 0, label: "", contentChannel: null, flags: {}, minimumBuild: 10, latestBuild: 20, notes: "", updatedAt: "" },
  ];
  assert.equal(resolveAppConfig("android", 9, rows).update, "required");
  assert.equal(resolveAppConfig("android", 10, rows).update, "available");
  assert.equal(resolveAppConfig("android", 20, rows).update, "none");
  assert.equal(resolveAppConfig("android", 0, rows).update, "none");
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

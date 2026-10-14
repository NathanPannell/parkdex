import assert from "node:assert/strict";
import { test } from "node:test";
import { createDashboardApi, type DashboardEnv } from "../api.ts";
import { MemoryAppConfigStore } from "./memory.ts";

const ORIGIN = "https://operator.example.test";
const env: DashboardEnv = { DATABASE_URL: "postgres://unused", DASHBOARD_ENVIRONMENT: "test" };

function request(path: string, options: { method?: string; body?: unknown; origin?: string; cookie?: string } = {}) {
  const headers = new Headers();
  const method = options.method ?? "GET";
  if (method !== "GET") headers.set("origin", options.origin ?? ORIGIN);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  if (options.cookie) headers.set("cookie", options.cookie);
  return new Request(`${ORIGIN}${path}`, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
}

test("build rows and per-environment update rules can be edited, and invalid input is refused", async () => {
  const builds = new MemoryAppConfigStore();
  const api = createDashboardApi({ appConfigStore: () => builds });
  const body = { label: "Build 42", apiPointer: "staging", flags: { rankProgression: true, futureThing: false } };
  assert.equal((await api(request("/api/app/builds/android/42", { method: "PUT", body, origin: "https://evil.example.test" }), env)).status, 403);
  assert.equal((await api(request("/api/app/builds/android/42", { method: "PUT", body }), env)).status, 200);
  assert.deepEqual(builds.rows.get("android:42")?.flags, { rankProgression: true, futureThing: false }, "rows can still carry retired flags");
  const listing = await (await api(request("/api/app/builds"), env)).json() as { builds: unknown[]; rules: { environment: string }[]; knownFlags: string[]; retiredFlags: string[] };
  assert.equal(listing.builds.length, 1);
  assert.deepEqual(listing.rules.map((rule) => rule.environment), ["production", "staging"]);
  assert.deepEqual(listing.knownFlags, ["friends", "crews", "badges"], "retired flags are not offered for new rows");
  assert.deepEqual(listing.retiredFlags, ["rankProgression", "parkProposals"]);
  for (const invalid of [{ apiPointer: "main" }, { flags: { "bad name": true } }, { flags: { ok: "yes" } }, { extra: 1 }, { minimumBuild: 3 }]) {
    assert.equal((await api(request("/api/app/builds/android/1", { method: "PUT", body: invalid }), env)).status, 400, JSON.stringify(invalid));
  }

  assert.equal((await api(request("/api/app/update-rules/production", { method: "PUT", body: { minimumBuild: 9, latestBuild: 12 } }), env)).status, 200);
  assert.deepEqual(await builds.updateRules("production").then(({ minimumBuild, latestBuild }) => [minimumBuild, latestBuild]), [9, 12]);
  assert.equal((await api(request("/api/app/update-rules/production", { method: "PUT", body: { minimumBuild: 13, latestBuild: 12 } }), env)).status, 400);
  assert.equal((await api(request("/api/app/update-rules/main", { method: "PUT", body: {} }), env)).status, 400);
  assert.equal((await api(request("/api/app/update-rules/staging", { method: "PUT", body: { minimumBuild: null, latestBuild: 5 }, origin: "https://evil.example.test" }), env)).status, 403);

  assert.equal((await api(request("/api/app/builds/android/42", { method: "DELETE" }), env)).status, 200);
  assert.equal((await api(request("/api/app/builds/android/42", { method: "DELETE" }), env)).status, 404);
  assert.equal((await api(request("/api/app/builds/android/42", { method: "POST", body }), env)).status, 405);
});

test("build config always reads production, whatever the staging toggle says", async () => {
  const seen: string[] = [];
  const builds = new MemoryAppConfigStore();
  const api = createDashboardApi({ appConfigStore: (scoped) => { seen.push(String(scoped.DATABASE_URL)); return builds; } });
  const both = { ...env, DATABASE_URL: "postgres://prod", DASHBOARD_ENVIRONMENT: "production", STAGING_DATABASE_URL: "postgres://staging" };
  for (const cookie of [undefined, "parkdex_operator_db=staging", "parkdex_operator_db=production"]) {
    assert.equal((await api(request("/api/app/builds", { cookie }), both)).status, 200);
  }
  assert.deepEqual(seen, ["postgres://prod", "postgres://prod", "postgres://prod"]);
  // A stale staging cookie on a deployment without staging must not block build config.
  const noStaging = await api(request("/api/app/builds", { cookie: "parkdex_operator_db=staging" }), { ...both, STAGING_DATABASE_URL: undefined });
  assert.equal(noStaging.status, 200);
});

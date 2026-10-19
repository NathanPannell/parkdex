import assert from "node:assert/strict";
import { test } from "node:test";
import { createDashboardApi, SECTIONS, sectionFor, type DashboardEnv, type Section, type SectionContext } from "./api.ts";
import { demoDependencies } from "./demo.ts";
import { originalRequest } from "./edge.ts";
import { HttpError, json } from "./http.ts";

const ORIGIN = "https://operator.example.test";
const env: DashboardEnv = { DATABASE_URL: "postgres://unused", EMAIL_MODE: "disabled", DASHBOARD_ENVIRONMENT: "test" };

function request(path: string, init: { method?: string; origin?: string; cookie?: string } = {}) {
  const headers = new Headers();
  if (init.origin) headers.set("origin", init.origin);
  if (init.cookie) headers.set("cookie", init.cookie);
  return new Request(`${ORIGIN}${path}`, { method: init.method ?? "GET", headers });
}

/** A section that records what it was asked, so delegation can be checked without real stores. */
function recorder(prefix: string, calls: string[]): Section {
  return {
    prefix,
    async route(incoming, context) {
      calls.push(`${prefix} ${context.path}`);
      if (context.path === `${prefix}/missing`) return null;
      if (context.path === `${prefix}/broken`) throw new Error("secret connection string");
      if (context.path === `${prefix}/teapot`) throw new HttpError(418, "teapot", "Short and stout.");
      if (incoming.method === "POST") context.requireSameOrigin();
      return json({ section: prefix, database: context.env.DATABASE_URL, base: context.baseEnv.DATABASE_URL, other: context.otherEnv?.DATABASE_URL ?? null });
    },
  };
}

test("the router sends each prefix to its own section and nothing else", async () => {
  const calls: string[] = [];
  const sections = ["/api/feedback", "/api/parks", "/api/analytics", "/api/app"].map((prefix) => recorder(prefix, calls));
  const api = createDashboardApi({}, sections);
  for (const path of ["/api/feedback", "/api/feedback/abc/attachment", "/api/parks/regions", "/api/analytics/overview", "/api/app/builds"]) {
    assert.equal((await api(request(path), env)).status, 200, path);
  }
  assert.deepEqual(calls, [
    "/api/feedback /api/feedback",
    "/api/feedback /api/feedback/abc/attachment",
    "/api/parks /api/parks/regions",
    "/api/analytics /api/analytics/overview",
    "/api/app /api/app/builds",
  ]);
  // Paths that only share a prefix's letters, or belong to no section, never reach one.
  for (const path of ["/api/feedbacks", "/api/application", "/api/proposals", "/api/builds", "/api/drafts", "/api/legacy/parks", "/api/unknown"]) {
    const response = await api(request(path), env);
    assert.equal(response.status, 404, path);
    assert.deepEqual(await response.json(), { error: { code: "not_found", message: "API route not found." } });
  }
  assert.equal(calls.length, 5);
});

test("sections share one error shape, and unknown errors never leak details", async () => {
  const calls: string[] = [];
  const api = createDashboardApi({}, [recorder("/api/app", calls)]);
  const missing = await api(request("/api/app/missing"), env);
  assert.equal(missing.status, 404);
  const broken = await api(request("/api/app/broken"), env);
  assert.equal(broken.status, 503);
  assert.doesNotMatch(await broken.text(), /secret/);
  const teapot = await api(request("/api/app/teapot"), env);
  assert.deepEqual([teapot.status, await teapot.json()], [418, { error: { code: "teapot", message: "Short and stout." } }]);
});

test("each section gets the toggled database, production and the other database", async () => {
  const api = createDashboardApi({}, [recorder("/api/parks", [])]);
  const both = { ...env, DATABASE_URL: "postgres://prod", STAGING_DATABASE_URL: "postgres://staging" };
  assert.deepEqual(await (await api(request("/api/parks"), both)).json(), {
    section: "/api/parks",
    database: "postgres://prod",
    base: "postgres://prod",
    other: "postgres://staging",
  });
  assert.deepEqual(await (await api(request("/api/parks", { cookie: "parkdex_operator_db=staging" }), both)).json(), {
    section: "/api/parks",
    database: "postgres://staging",
    base: "postgres://prod",
    other: "postgres://prod",
  });
  const unconfigured = await api(request("/api/parks", { cookie: "parkdex_operator_db=staging" }), { ...both, STAGING_DATABASE_URL: undefined });
  assert.equal(unconfigured.status, 503, "staging is never silently replaced by production");
});

test("writes through any section must come from the dashboard origin", async () => {
  const api = createDashboardApi({}, [recorder("/api/analytics", [])]);
  assert.equal((await api(request("/api/analytics/x", { method: "POST" }), env)).status, 403);
  assert.equal((await api(request("/api/analytics/x", { method: "POST", origin: "https://evil.example.test" }), env)).status, 403);
  assert.equal((await api(request("/api/analytics/x", { method: "POST", origin: ORIGIN }), env)).status, 200);
});

test("the four sections are registered once each", () => {
  assert.deepEqual(
    SECTIONS.map((section) => section.prefix),
    ["/api/feedback", "/api/parks", "/api/analytics", "/api/app"],
  );
  assert.equal(sectionFor("/api/app")?.prefix, "/api/app");
  assert.equal(sectionFor("/api/app/updates/staging")?.prefix, "/api/app");
  assert.equal(sectionFor("/api/apps"), null);
  assert.equal(sectionFor("/api/health"), null);
});

test("health reports the data environment, and a missing database fails closed", async () => {
  const api = createDashboardApi();
  const health = await api(request("/api/health"), { DASHBOARD_ENVIRONMENT: "production" });
  assert.deepEqual(await health.json(), { ok: true, environment: "production", canSwitch: false, emailMode: "unconfigured" });
  const staging = await api(request("/api/health", { cookie: "parkdex_operator_db=staging" }), { ...env, STAGING_DATABASE_URL: "postgres://staging" });
  assert.deepEqual(await staging.json(), { ok: true, environment: "staging", canSwitch: true, emailMode: "disabled" });
  assert.equal((await api(request("/api/feedback"), {})).status, 503);
  assert.equal((await api(request("/api/analytics/overview"), {})).status, 503);
});

test("the local demo serves every section that has data", async () => {
  const api = createDashboardApi(demoDependencies());
  for (const path of [
    "/api/feedback",
    "/api/feedback/other-database",
    "/api/parks",
    "/api/parks/regions",
    "/api/app/builds",
    "/api/analytics/overview",
    "/api/analytics/accounts",
    "/api/analytics/events",
    "/api/analytics/posthog/status",
  ]) {
    assert.equal((await api(request(path), { ...env, STAGING_DATABASE_URL: "demo" })).status, 200, path);
  }
});

test("the edge entry restores the original API path from the route rewrite", () => {
  const rewritten = originalRequest(new Request(`${ORIGIN}/api?__path=feedback%2Fabc%2Fattachment&status=new`));
  const url = new URL(rewritten.url);
  assert.equal(url.pathname, "/api/feedback/abc/attachment");
  assert.equal(url.search, "?status=new");
  const untouched = new Request(`${ORIGIN}/api/health`);
  assert.equal(originalRequest(untouched), untouched);
});

test("a production deployment refuses to serve data because Vercel login would not cover it", async () => {
  const { createEdgeHandler } = await import("./edge.ts");
  const production = await createEdgeHandler({ ...env, VERCEL_ENV: "production" })(request("/api/health"));
  assert.equal(production.status, 403);
  const preview = await createEdgeHandler({ ...env, VERCEL_ENV: "preview" })(request("/api/health"));
  assert.equal(preview.status, 200);
});

// Keeps the context shape stable for the section agents: adding a field is fine, removing one is not.
test("the section context exposes the agreed fields", async () => {
  let seen: SectionContext | null = null;
  const api = createDashboardApi({}, [
    {
      prefix: "/api/app",
      route: async (_request, context) => {
        seen = context;
        return json({});
      },
    },
  ]);
  await api(request("/api/app/x?y=1"), env);
  const context = seen as unknown as SectionContext;
  assert.equal(context.path, "/api/app/x");
  assert.equal(context.url.searchParams.get("y"), "1");
  assert.equal(typeof context.requireSameOrigin, "function");
  assert.ok("dependencies" in context && "baseEnv" in context && "otherEnv" in context && "env" in context);
});

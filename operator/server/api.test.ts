import assert from "node:assert/strict";
import { test } from "node:test";
import { createDashboardApi, type DashboardEnv } from "./api.ts";
import { originalRequest } from "./edge.ts";
import { MemoryAppConfigStore, MemoryFeedbackStore, MemoryProposalStore, demoDependencies } from "./memoryStores.ts";

const ORIGIN = "https://operator.example.test";
const env: DashboardEnv = { DATABASE_URL: "postgres://unused", EMAIL_MODE: "disabled", DASHBOARD_ENVIRONMENT: "test" };

function request(path: string, options: { method?: string; body?: unknown; origin?: string | null } = {}) {
  const headers = new Headers();
  const method = options.method ?? "GET";
  if (method !== "GET" && options.origin !== null) headers.set("origin", options.origin ?? ORIGIN);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  return new Request(`${ORIGIN}${path}`, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
}

function seedReports(store: MemoryFeedbackStore, count: number, status: "new" | "reviewing" = "reviewing") {
  const base = Date.now();
  for (let index = 0; index < count; index += 1) {
    const id = `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
    store.reports.set(id, {
      id, submissionId: id, kind: "idea", message: `Report ${index}`, email: null, contact: false,
      context: { version: "1", platform: "web", screen: "map", parkId: null, parkName: null },
      createdAt: new Date(base - index * 1000).toISOString(), hasScreenshot: false, status, emails: [], screenshot: null,
    });
  }
}

test("feedback lists in stable 30-row pages and a cursor cannot cross filters", async () => {
  const feedback = new MemoryFeedbackStore();
  seedReports(feedback, 31);
  const api = createDashboardApi({ feedbackStore: () => feedback });
  const first = await (await api(request("/api/feedback?status=reviewing"), env)).json() as { reports: { id: string }[]; nextCursor: string };
  assert.equal(first.reports.length, 30);
  const second = await (await api(request(`/api/feedback?status=reviewing&cursor=${encodeURIComponent(first.nextCursor)}`), env)).json() as { reports: { id: string }[]; nextCursor: null };
  assert.equal(second.reports.length, 1);
  assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.reports, ...second.reports].map((report) => report.id)).size, 31);
  assert.equal((await api(request(`/api/feedback?status=closed&cursor=${encodeURIComponent(first.nextCursor)}`), env)).status, 400);
  assert.equal((await api(request("/api/feedback?status=done"), env)).status, 400);
});

test("moving a card saves its status, and writes must come from the dashboard origin", async () => {
  const feedback = new MemoryFeedbackStore();
  seedReports(feedback, 1, "new");
  const api = createDashboardApi({ feedbackStore: () => feedback });
  const id = "00000000-0000-4000-8000-000000000001";
  assert.equal((await api(request(`/api/feedback/${id}`, { method: "PATCH", body: { status: "planned" }, origin: "https://evil.example.test" }), env)).status, 403);
  assert.equal((await api(request(`/api/feedback/${id}`, { method: "PATCH", body: { status: "planned" }, origin: null }), env)).status, 403);
  assert.equal(feedback.reports.get(id)?.status, "new");
  const moved = await api(request(`/api/feedback/${id}`, { method: "PATCH", body: { status: "planned" } }), env);
  assert.equal(moved.status, 200);
  assert.equal(((await moved.json()) as { report: { status: string } }).report.status, "planned");
  assert.equal((await api(request(`/api/feedback/${id}`, { method: "PATCH", body: { status: "done" } }), env)).status, 400);
  assert.equal((await api(request(`/api/feedback/${id}`, { method: "PATCH", body: { status: "new", extra: 1 } }), env)).status, 400);
  assert.equal((await api(request("/api/feedback/not-a-uuid"), env)).status, 404);
});

test("screenshots are served as raw bytes with no caching", async () => {
  const feedback = new MemoryFeedbackStore();
  seedReports(feedback, 1);
  const id = "00000000-0000-4000-8000-000000000001";
  feedback.attachments.set(id, { contentType: "image/png", size: 8, base64: "iVBORw0KGgo=" });
  const api = createDashboardApi({ feedbackStore: () => feedback });
  const response = await api(request(`/api/feedback/${id}/attachment`), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
});

test("email retry uses the shared delivery path and respects disabled email", async () => {
  const deps = demoDependencies();
  const api = createDashboardApi(deps);
  const id = "00000000-0000-4000-8000-000000000002";
  const retry = await api(request(`/api/feedback/${id}/retry-emails`, { method: "POST", body: { audiences: ["operator"] } }), env);
  assert.equal(retry.status, 200);
  assert.deepEqual(await retry.json(), { results: [{ audience: "operator", status: "disabled" }] });
  assert.equal((await api(request(`/api/feedback/${id}/retry-emails`, { method: "POST", body: {}, origin: "https://evil.example.test" }), env)).status, 403);
});

test("build rows and per-environment update rules can be edited, and invalid input is refused", async () => {
  const builds = new MemoryAppConfigStore();
  const api = createDashboardApi({ appConfigStore: () => builds });
  const body = { label: "Build 42", apiPointer: "staging", flags: { rankProgression: true, futureThing: false } };
  assert.equal((await api(request("/api/builds/android/42", { method: "PUT", body, origin: "https://evil.example.test" }), env)).status, 403);
  assert.equal((await api(request("/api/builds/android/42", { method: "PUT", body }), env)).status, 200);
  assert.deepEqual(builds.rows.get("android:42")?.flags, { rankProgression: true, futureThing: false });
  const listing = await (await api(request("/api/builds"), env)).json() as { builds: unknown[]; rules: { environment: string }[]; knownFlags: string[] };
  assert.equal(listing.builds.length, 1);
  assert.deepEqual(listing.rules.map((rule) => rule.environment), ["production", "staging"]);
  assert.deepEqual(listing.knownFlags, ["rankProgression", "parkProposals"]);
  for (const invalid of [{ apiPointer: "main" }, { flags: { "bad name": true } }, { flags: { ok: "yes" } }, { extra: 1 }, { minimumBuild: 3 }]) {
    assert.equal((await api(request("/api/builds/android/1", { method: "PUT", body: invalid }), env)).status, 400, JSON.stringify(invalid));
  }

  assert.equal((await api(request("/api/update-rules/production", { method: "PUT", body: { minimumBuild: 9, latestBuild: 12 } }), env)).status, 200);
  assert.deepEqual(await builds.updateRules("production").then(({ minimumBuild, latestBuild }) => [minimumBuild, latestBuild]), [9, 12]);
  assert.equal((await api(request("/api/update-rules/production", { method: "PUT", body: { minimumBuild: 13, latestBuild: 12 } }), env)).status, 400);
  assert.equal((await api(request("/api/update-rules/main", { method: "PUT", body: {} }), env)).status, 400);
  assert.equal((await api(request("/api/update-rules/staging", { method: "PUT", body: { minimumBuild: null, latestBuild: 5 }, origin: "https://evil.example.test" }), env)).status, 403);

  assert.equal((await api(request("/api/builds/android/42", { method: "DELETE" }), env)).status, 200);
  assert.equal((await api(request("/api/builds/android/42", { method: "DELETE" }), env)).status, 404);
});

test("proposals can be filtered and reviewed", async () => {
  const proposals = new MemoryProposalStore();
  const id = "10000000-0000-4000-8000-000000000001";
  proposals.rows.set(id, { id, name: "Cedar Hill Woods", note: "", point: [-123.34, 48.46], outline: null, context: {}, status: "new", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  const api = createDashboardApi({ proposalStore: () => proposals });
  const listed = await (await api(request("/api/proposals?status=new"), env)).json() as { proposals: unknown[]; statuses: string[] };
  assert.equal(listed.proposals.length, 1);
  assert.deepEqual(listed.statuses, ["new", "reviewing", "accepted", "declined"]);
  assert.equal((await api(request("/api/proposals?status=done"), env)).status, 400);
  assert.equal((await api(request(`/api/proposals/${id}`, { method: "PATCH", body: { status: "accepted" }, origin: "https://evil.example.test" }), env)).status, 403);
  assert.equal((await api(request(`/api/proposals/${id}`, { method: "PATCH", body: { status: "accepted" } }), env)).status, 200);
  assert.equal(proposals.rows.get(id)?.status, "accepted");
  assert.equal((await api(request(`/api/proposals/${id}`, { method: "PATCH", body: { status: "done" } }), env)).status, 400);
});

test("the operator approves a waiting OpenStreetMap proposal and it is published", async () => {
  const proposals = new MemoryProposalStore();
  const id = "10000000-0000-4000-8000-000000000009";
  const now = new Date().toISOString();
  proposals.rows.set(id, {
    id, name: "Cedar Hill Woods", note: "", point: [-123.357, 48.4505], outline: null, context: {}, status: "new", createdAt: now, updatedAt: now,
    osm: { type: "way", id: 77 }, decision: "unsure", moderation: null, decidedAt: now, publishedParkId: null,
  });
  const ring: [number, number][] = [[-123.36, 48.45], [-123.35, 48.45], [-123.35, 48.456], [-123.36, 48.456], [-123.36, 48.45]];
  const statements: string[][] = [];
  const sql = {
    async query(text: string) {
      if (text.includes("INSERT INTO kip_park_drafts.drafts")) return [{ updated_at: now }];
      if (text.includes("FROM kip_park_drafts.drafts") || text.startsWith("SELECT 1 FROM public.parks")) return [];
      throw new Error(`unexpected ${text}`);
    },
    async transaction(batch: { text: string; params: unknown[] }[]) {
      statements.push(batch.map((statement) => statement.text));
      const accept = batch.find((statement) => statement.text.includes("status = 'accepted'"))!;
      const row = proposals.rows.get(String(accept.params[0]))!;
      Object.assign(row, { status: "accepted", publishedParkId: accept.params[1] });
      return batch.map(() => []);
    },
  };
  const api = createDashboardApi({
    proposalStore: () => proposals,
    proposalReviewStore: () => ({
      state: async (proposalId) => ({ decision: "unsure", publishedParkId: proposals.rows.get(proposalId)?.publishedParkId ?? null }),
      nearbyParks: async () => [],
      record: async () => undefined,
      sql: () => sql,
    }),
    osmClient: {
      search: async () => [],
      feature: async (ref) => ({ ...ref, name: "Cedar Hill Woods", kind: "leisure=park", tags: { leisure: "park" }, areaM2: 400_000, geometry: { type: "MultiPolygon", coordinates: [[ring]] } }),
    },
  });
  assert.equal((await api(request(`/api/proposals/${id}/publish`, { method: "POST", body: {}, origin: "https://evil.example.test" }), env)).status, 403);
  assert.equal((await api(request(`/api/proposals/${id}/publish`), env)).status, 405);
  const published = await api(request(`/api/proposals/${id}/publish`, { method: "POST", body: {} }), env);
  assert.equal(published.status, 200);
  const body = await published.json() as { parkId: string; proposal: { status: string; publishedParkId: string } };
  assert.equal(body.parkId, "osm-way-77");
  assert.equal(body.proposal.status, "accepted");
  assert.equal(statements.length, 1);
  assert.ok(statements[0].some((text) => text.includes("INSERT INTO public.parks")));

  const freeForm = "10000000-0000-4000-8000-000000000010";
  proposals.rows.set(freeForm, { id: freeForm, name: "Somewhere", note: "", point: [-123.3, 48.4], outline: null, context: {}, status: "new", createdAt: now, updatedAt: now, osm: null });
  const refused = await api(request(`/api/proposals/${freeForm}/publish`, { method: "POST", body: {} }), env);
  assert.equal(refused.status, 422);
  assert.equal((await api(request("/api/proposals/10000000-0000-4000-8000-000000000099/publish", { method: "POST", body: {} }), env)).status, 404);
});

test("health reports the data environment, and a missing database fails closed", async () => {
  const api = createDashboardApi();
  const health = await api(request("/api/health"), { DASHBOARD_ENVIRONMENT: "production" });
  assert.deepEqual(await health.json(), { ok: true, environment: "production", canSwitch: false, emailMode: "unconfigured" });
  const missing = await api(request("/api/feedback"), {});
  assert.equal(missing.status, 503);
  assert.equal((await api(request("/api/unknown"), env)).status, 404);
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

test("email retry refuses to touch deliveries when no provider key is configured", async () => {
  const deps = demoDependencies();
  const api = createDashboardApi(deps);
  const id = "00000000-0000-4000-8000-000000000002";
  const before = (await deps.feedbackStore!(env).getReport(id))!.emails;
  const retry = await api(request(`/api/feedback/${id}/retry-emails`, { method: "POST", body: {} }), { ...env, EMAIL_MODE: "resend" });
  assert.equal(retry.status, 503);
  assert.deepEqual((await deps.feedbackStore!(env).getReport(id))!.emails, before);
});

test("the staging toggle switches the boards, but build config always stays in production", async () => {
  const seen: string[] = [];
  const builds = new MemoryAppConfigStore();
  const proposals = new MemoryProposalStore();
  const api = createDashboardApi({
    appConfigStore: (scoped) => { seen.push(`builds ${scoped.DATABASE_URL}`); return builds; },
    proposalStore: (scoped) => { seen.push(`proposals ${scoped.DATABASE_URL}`); return proposals; },
    queueCounts: async (scoped) => ({ feedback: { new: scoped.DASHBOARD_ENVIRONMENT === "staging" ? 2 : 5 }, proposals: {} }),
  });
  const withCookie = (path: string, value?: string) => new Request(`${ORIGIN}${path}`, { headers: value ? { cookie: `other=1; parkdex_operator_db=${value}` } : {} });
  const both = { ...env, DATABASE_URL: "postgres://prod", DASHBOARD_ENVIRONMENT: "production", STAGING_DATABASE_URL: "postgres://staging" };

  for (const value of [undefined, "staging", "production"]) {
    assert.equal((await api(withCookie("/api/proposals", value), both)).status, 200);
    assert.equal((await api(withCookie("/api/builds", value), both)).status, 200);
  }
  assert.deepEqual(seen, [
    "proposals postgres://prod", "builds postgres://prod",
    "proposals postgres://staging", "builds postgres://prod",
    "proposals postgres://prod", "builds postgres://prod",
  ]);

  const health = await (await api(withCookie("/api/health", "staging"), both)).json() as { environment: string; canSwitch: boolean };
  assert.deepEqual([health.environment, health.canSwitch], ["staging", true]);
  const unconfigured = await api(withCookie("/api/proposals", "staging"), { ...both, STAGING_DATABASE_URL: undefined });
  assert.equal(unconfigured.status, 503, "staging is never silently replaced by production");

  const fromProduction = await (await api(withCookie("/api/other-database"), both)).json() as { environment: string; feedback: { new: number } };
  assert.deepEqual([fromProduction.environment, fromProduction.feedback.new], ["staging", 2]);
  const fromStaging = await (await api(withCookie("/api/other-database", "staging"), both)).json() as { environment: string; feedback: { new: number } };
  assert.deepEqual([fromStaging.environment, fromStaging.feedback.new], ["production", 5]);
  assert.deepEqual(await (await api(withCookie("/api/other-database"), { ...both, STAGING_DATABASE_URL: undefined })).json(), { available: false });
});

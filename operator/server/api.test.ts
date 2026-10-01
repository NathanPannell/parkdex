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

test("build rows can be listed, saved and removed, and invalid rows are refused", async () => {
  const builds = new MemoryAppConfigStore();
  const api = createDashboardApi({ appConfigStore: () => builds });
  const body = { label: "Build 42", contentChannel: "main", flags: { rankProgression: true }, minimumBuild: 40, latestBuild: 44, notes: "" };
  assert.equal((await api(request("/api/builds/android/42", { method: "PUT", body, origin: "https://evil.example.test" }), env)).status, 403);
  assert.equal((await api(request("/api/builds/android/42", { method: "PUT", body }), env)).status, 200);
  assert.equal(builds.rows.get("android:42")?.contentChannel, "main");
  const listing = await (await api(request("/api/builds"), env)).json() as { builds: unknown[]; flags: string[] };
  assert.equal(listing.builds.length, 1);
  assert.deepEqual(listing.flags, ["rankProgression", "parkProposals"]);
  for (const invalid of [
    { contentChannel: "production" },
    { flags: { somethingNew: true } },
    { flags: { rankProgression: "yes" } },
    { extra: 1 },
    { minimumBuild: 30, latestBuild: 20 },
    { minimumBuild: "10" },
    { latestBuild: -1 },
  ]) {
    assert.equal((await api(request("/api/builds/android/1", { method: "PUT", body: invalid }), env)).status, 400, JSON.stringify(invalid));
  }
  assert.equal((await api(request("/api/builds/ios/1", { method: "PUT", body }), env)).status, 400);
  assert.equal((await api(request("/api/builds/android/42", { method: "DELETE" }), env)).status, 200);
  assert.equal(builds.rows.size, 0);
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

test("health reports the data environment, and a missing database fails closed", async () => {
  const api = createDashboardApi();
  const health = await api(request("/api/health"), { DASHBOARD_ENVIRONMENT: "production" });
  assert.deepEqual(await health.json(), { ok: true, environment: "production", emailMode: "unconfigured" });
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

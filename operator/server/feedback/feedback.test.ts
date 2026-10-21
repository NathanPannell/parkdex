import assert from "node:assert/strict";
import { test } from "node:test";
import { createDashboardApi, type DashboardEnv } from "../api.ts";
import { demoFeedback, MemoryFeedbackStore } from "./memory.ts";

const ORIGIN = "https://operator.example.test";
const env: DashboardEnv = { DATABASE_URL: "postgres://unused", EMAIL_MODE: "disabled", DASHBOARD_ENVIRONMENT: "test" };

function request(path: string, options: { method?: string; body?: unknown; origin?: string | null; cookie?: string } = {}) {
  const headers = new Headers();
  const method = options.method ?? "GET";
  if (method !== "GET" && options.origin !== null) headers.set("origin", options.origin ?? ORIGIN);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  if (options.cookie) headers.set("cookie", options.cookie);
  return new Request(`${ORIGIN}${path}`, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
}

/** The board and archive queries and the shared feedback store, all served from one memory store. */
function stores(feedback: MemoryFeedbackStore) {
  return { feedbackStore: () => feedback, feedbackArchive: () => feedback };
}

function seedReports(store: MemoryFeedbackStore, count: number, status: "new" | "reviewing" | "planned" | "closed" = "reviewing", offset = 0) {
  const base = Date.now();
  for (let index = offset; index < offset + count; index += 1) {
    const id = `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
    store.reports.set(id, {
      id,
      submissionId: id,
      kind: "idea",
      message: `Report ${index}`,
      email: null,
      contact: false,
      context: { version: "1", platform: "web", screen: "map", parkId: null, parkName: null },
      createdAt: new Date(base - index * 1000).toISOString(),
      hasScreenshot: false,
      status,
      emails: [],
      screenshot: null,
    });
  }
}

test("feedback lists in stable 30-row pages and a cursor cannot cross filters", async () => {
  const feedback = new MemoryFeedbackStore();
  seedReports(feedback, 31);
  const api = createDashboardApi(stores(feedback));
  const first = (await (await api(request("/api/feedback?status=reviewing"), env)).json()) as { reports: { id: string }[]; nextCursor: string };
  assert.equal(first.reports.length, 30);
  const second = (await (await api(request(`/api/feedback?status=reviewing&cursor=${encodeURIComponent(first.nextCursor)}`), env)).json()) as {
    reports: { id: string }[];
    nextCursor: null;
  };
  assert.equal(second.reports.length, 1);
  assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.reports, ...second.reports].map((report) => report.id)).size, 31);
  assert.equal((await api(request(`/api/feedback?status=closed&cursor=${encodeURIComponent(first.nextCursor)}`), env)).status, 400);
  assert.equal((await api(request("/api/feedback?status=done"), env)).status, 400);
});

test("moving a card saves its status, and writes must come from the dashboard origin", async () => {
  const feedback = new MemoryFeedbackStore();
  seedReports(feedback, 1, "new");
  const api = createDashboardApi(stores(feedback));
  const id = "00000000-0000-4000-8000-000000000001";
  assert.equal(
    (await api(request(`/api/feedback/${id}`, { method: "PATCH", body: { status: "planned" }, origin: "https://evil.example.test" }), env)).status,
    403,
  );
  assert.equal((await api(request(`/api/feedback/${id}`, { method: "PATCH", body: { status: "planned" }, origin: null }), env)).status, 403);
  assert.equal(feedback.reports.get(id)?.status, "new");
  const moved = await api(request(`/api/feedback/${id}`, { method: "PATCH", body: { status: "planned" } }), env);
  assert.equal(moved.status, 200);
  assert.equal(((await moved.json()) as { report: { status: string } }).report.status, "planned");
  assert.equal((await api(request(`/api/feedback/${id}`, { method: "PATCH", body: { status: "done" } }), env)).status, 400);
  assert.equal((await api(request(`/api/feedback/${id}`, { method: "PATCH", body: { status: "new", extra: 1 } }), env)).status, 400);
  assert.equal((await api(request(`/api/feedback/${id}`, { method: "DELETE" }), env)).status, 405);
  assert.equal((await api(request("/api/feedback/not-a-uuid"), env)).status, 404);
});

test("screenshots are served as raw bytes with no caching", async () => {
  const feedback = new MemoryFeedbackStore();
  seedReports(feedback, 1);
  const id = "00000000-0000-4000-8000-000000000001";
  feedback.attachments.set(id, { contentType: "image/png", size: 8, base64: "iVBORw0KGgo=" });
  const api = createDashboardApi(stores(feedback));
  const response = await api(request(`/api/feedback/${id}/attachment`), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
});

test("email retry uses the shared delivery path and respects disabled email", async () => {
  const api = createDashboardApi(demoFeedback());
  const id = "00000000-0000-4000-8000-000000000002";
  const retry = await api(request(`/api/feedback/${id}/retry-emails`, { method: "POST", body: { audiences: ["operator"] } }), env);
  assert.equal(retry.status, 200);
  assert.deepEqual(await retry.json(), { results: [{ audience: "operator", status: "disabled" }] });
  assert.equal((await api(request(`/api/feedback/${id}/retry-emails`, { method: "POST", body: {}, origin: "https://evil.example.test" }), env)).status, 403);
});

test("email retry refuses to touch deliveries when no provider key is configured", async () => {
  const deps = demoFeedback();
  const api = createDashboardApi(deps);
  const id = "00000000-0000-4000-8000-000000000002";
  const before = (await deps.feedbackStore!(env).getReport(id))!.emails;
  const retry = await api(request(`/api/feedback/${id}/retry-emails`, { method: "POST", body: {} }), { ...env, EMAIL_MODE: "resend" });
  assert.equal(retry.status, 503);
  assert.deepEqual((await deps.feedbackStore!(env).getReport(id))!.emails, before);
});

test("the board follows the staging toggle and counts what waits in the other database", async () => {
  const seen: string[] = [];
  const feedback = new MemoryFeedbackStore();
  const api = createDashboardApi({
    feedbackStore: () => feedback,
    feedbackArchive: (scoped) => {
      seen.push(String(scoped.DATABASE_URL));
      return feedback;
    },
    feedbackCounts: async (scoped) => ({ new: scoped.DASHBOARD_ENVIRONMENT === "staging" ? 2 : 5 }),
  });
  const both = { ...env, DATABASE_URL: "postgres://prod", DASHBOARD_ENVIRONMENT: "production", STAGING_DATABASE_URL: "postgres://staging" };
  for (const cookie of [undefined, "parkdex_operator_db=staging", "other=1; parkdex_operator_db=production"]) {
    assert.equal((await api(request("/api/feedback", { cookie }), both)).status, 200);
  }
  assert.deepEqual(seen, ["postgres://prod", "postgres://staging", "postgres://prod"]);

  const fromProduction = (await (await api(request("/api/feedback/other-database"), both)).json()) as { environment: string; feedback: { new: number } };
  assert.deepEqual([fromProduction.environment, fromProduction.feedback.new], ["staging", 2]);
  const fromStaging = (await (await api(request("/api/feedback/other-database", { cookie: "parkdex_operator_db=staging" }), both)).json()) as {
    environment: string;
    feedback: { new: number };
  };
  assert.deepEqual([fromStaging.environment, fromStaging.feedback.new], ["production", 5]);
  assert.deepEqual(await (await api(request("/api/feedback/other-database"), { ...both, STAGING_DATABASE_URL: undefined })).json(), { available: false });
  const unconfigured = await api(request("/api/feedback", { cookie: "parkdex_operator_db=staging" }), { ...both, STAGING_DATABASE_URL: undefined });
  assert.equal(unconfigured.status, 503, "staging is never silently replaced by production");
});

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

test("clear done archives every done report, and the board and its counts leave them out", async () => {
  const feedback = new MemoryFeedbackStore();
  seedReports(feedback, 2, "new");
  seedReports(feedback, 3, "closed", 2);
  const api = createDashboardApi(stores(feedback));
  assert.equal((await api(request("/api/feedback/clear-done", { method: "POST", origin: "https://evil.example.test" }), env)).status, 403);
  assert.equal((await api(request("/api/feedback/clear-done", { method: "POST", origin: null }), env)).status, 403);
  assert.equal((await api(request("/api/feedback/clear-done"), env)).status, 405);
  assert.equal(feedback.archived.size, 0);

  const cleared = await api(request("/api/feedback/clear-done", { method: "POST" }), env);
  assert.equal(cleared.status, 200);
  const body = (await cleared.json()) as { archived: number; ids: string[]; more: boolean };
  assert.deepEqual([body.archived, body.ids.sort(), body.more], [3, [id(3), id(4), id(5)], false]);
  const board = (await (await api(request("/api/feedback?status=closed"), env)).json()) as { reports: unknown[] };
  assert.equal(board.reports.length, 0);
  const all = (await (await api(request("/api/feedback"), env)).json()) as { reports: { id: string }[] };
  assert.deepEqual(all.reports.map((report) => report.id).sort(), [id(1), id(2)]);
  const detail = (await (await api(request(`/api/feedback/${id(3)}`), env)).json()) as { report: { status: string; archivedAt: string | null } };
  assert.equal(detail.report.status, "closed");
  assert.ok(detail.report.archivedAt, "an archived report still opens from an email link, marked archived");
  assert.deepEqual(await (await api(request("/api/feedback/clear-done", { method: "POST" }), env)).json(), { archived: 0, ids: [], more: false });
});

test("the archive is searchable and pages most recently archived first", async () => {
  const feedback = new MemoryFeedbackStore();
  seedReports(feedback, 33, "closed");
  feedback.reports.get(id(7))!.message = "The 50% off sign at Cattle Point";
  [...feedback.reports.keys()].forEach((key, index) => feedback.archived.set(key, new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString()));
  const api = createDashboardApi(stores(feedback));
  const first = (await (await api(request("/api/feedback/archive"), env)).json()) as { reports: { id: string }[]; nextCursor: string; total: number };
  assert.equal(first.reports.length, 30);
  assert.equal(first.total, 33);
  assert.equal(first.reports[0].id, id(33), "newest archive first");
  const second = (await (await api(request(`/api/feedback/archive?cursor=${encodeURIComponent(first.nextCursor)}`), env)).json()) as {
    reports: { id: string }[];
    nextCursor: null;
  };
  assert.deepEqual(
    second.reports.map((report) => report.id),
    [id(3), id(2), id(1)],
  );
  assert.equal(second.nextCursor, null);
  const found = (await (await api(request("/api/feedback/archive?q=cattle"), env)).json()) as { reports: { id: string }[]; total: number };
  assert.deepEqual([found.reports.map((report) => report.id), found.total], [[id(7)], 1]);
  // A board cursor cannot page the archive, and searches stay short and plain.
  const boardCursor = ((await (await api(request("/api/feedback?status=closed"), env)).json()) as { nextCursor: string | null }).nextCursor;
  assert.equal(boardCursor, null, "everything is archived, so the board is empty");
  assert.equal((await api(request(`/api/feedback/archive?q=${"x".repeat(101)}`), env)).status, 400);
  assert.equal((await api(request("/api/feedback/archive?q=a%00b"), env)).status, 400);
  assert.equal((await api(request("/api/feedback/archive?cursor=not*valid"), env)).status, 400);
});

test("restore puts archived reports back in Done and refuses bad ids", async () => {
  const feedback = new MemoryFeedbackStore();
  seedReports(feedback, 2, "closed");
  feedback.archived.set(id(1), new Date().toISOString());
  const api = createDashboardApi(stores(feedback));
  assert.equal(
    (await api(request("/api/feedback/archive/restore", { method: "POST", body: { ids: [id(1)] }, origin: "https://evil.example.test" }), env)).status,
    403,
  );
  for (const body of [{}, { ids: [] }, { ids: ["nope"] }, { ids: [id(1)], extra: true }, { ids: Array.from({ length: 501 }, (_, n) => id(n + 1)) }]) {
    assert.equal((await api(request("/api/feedback/archive/restore", { method: "POST", body }), env)).status, 400, JSON.stringify(body).slice(0, 60));
  }
  const restored = await api(request("/api/feedback/archive/restore", { method: "POST", body: { ids: [id(1), id(1).toUpperCase(), id(2)] } }), env);
  assert.deepEqual(await restored.json(), { restored: [id(1)] }, "only archived reports move, once each");
  const board = (await (await api(request("/api/feedback?status=closed"), env)).json()) as { reports: { id: string }[] };
  assert.deepEqual(
    board.reports.map((report) => report.id),
    [id(1), id(2)],
  );
});

test("the other database note counts only reports still on the board", async () => {
  const feedback = new MemoryFeedbackStore();
  seedReports(feedback, 2, "new");
  seedReports(feedback, 2, "closed", 2);
  feedback.archived.set(id(3), new Date().toISOString());
  const api = createDashboardApi(stores(feedback));
  const both = { ...env, DATABASE_URL: "postgres://prod", DASHBOARD_ENVIRONMENT: "production", STAGING_DATABASE_URL: "postgres://staging" };
  const note = (await (await api(request("/api/feedback/other-database"), both)).json()) as { feedback: Record<string, number> };
  assert.deepEqual(note.feedback, { new: 2, closed: 1 });
});

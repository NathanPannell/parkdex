import assert from "node:assert/strict";
import { test } from "node:test";
import { createDashboardApi, type DashboardDependencies, type DashboardEnv } from "../api.ts";
import { maskEmail } from "./store.ts";
import { MemoryAccountDeleter, MemoryAnalyticsStore, seedDemoAnalytics } from "./memory.ts";
import type { AccountRow, EventRow } from "./types.ts";

const ORIGIN = "https://operator.example.test";
const NOW = Date.parse("2026-10-09T19:00:00.000Z");
const env: DashboardEnv = { DATABASE_URL: "postgres://production", STAGING_DATABASE_URL: "postgres://staging", DASHBOARD_ENVIRONMENT: "production" };
const photoEnv: DashboardEnv = {
  ...env,
  KIP_PHOTO_SERVICE_URL: "https://photos-production.example.workers.dev", KIP_PHOTO_SERVICE_TOKEN: "production-token",
  STAGING_KIP_PHOTO_SERVICE_URL: "https://photos-staging.example.workers.dev", STAGING_KIP_PHOTO_SERVICE_TOKEN: "staging-token",
};

function request(path: string, options: { method?: string; body?: unknown; origin?: string | null; cookie?: string } = {}) {
  const headers = new Headers();
  const method = options.method ?? "GET";
  if (method !== "GET" && options.origin !== null) headers.set("origin", options.origin ?? ORIGIN);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  if (options.cookie) headers.set("cookie", options.cookie);
  return new Request(`${ORIGIN}${path}`, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
}

function setup(overrides: Partial<DashboardDependencies> = {}) {
  const production = seedDemoAnalytics(new MemoryAnalyticsStore(), NOW, 135);
  const staging = seedDemoAnalytics(new MemoryAnalyticsStore(), NOW, 76);
  staging.accounts = staging.accounts.slice(0, 3);
  const storeFor = (selected: DashboardEnv) => selected.DATABASE_URL === "postgres://staging" ? staging : production;
  const api = createDashboardApi({
    analyticsStore: storeFor,
    accountDeleter: (selected) => new MemoryAccountDeleter(storeFor(selected)),
    analyticsNow: () => new Date(NOW),
    ...overrides,
  });
  return { api, production, staging };
}

async function body<T>(response: Response): Promise<T> {
  return await response.json() as T;
}

test("the overview follows the database toggle and only takes the offered periods", async () => {
  const { api, production, staging } = setup();
  const prod = await body<{ overview: { accounts: { total: number }; series: { days: string[] }; days: number } }>(await api(request("/api/analytics/overview?days=30"), env));
  assert.equal(prod.overview.accounts.total, production.accounts.length);
  assert.equal(prod.overview.series.days.length, 30);
  const stage = await body<{ overview: { accounts: { total: number } } }>(await api(request("/api/analytics/overview?days=7", { cookie: "parkdex_operator_db=staging" }), env));
  assert.equal(stage.overview.accounts.total, staging.accounts.length);
  assert.equal((await api(request("/api/analytics/overview?days=14"), env)).status, 400);
  assert.equal((await api(request("/api/analytics/overview", { method: "POST" }), env)).status, 405);
  // Staging chosen on a deployment without a staging database is a 503, never production data.
  assert.equal((await api(request("/api/analytics/overview", { cookie: "parkdex_operator_db=staging" }), { DATABASE_URL: "postgres://production" })).status, 503);
});

test("the overview counts visits by outcome and the photo approve rate from the same rows", async () => {
  const { api, production } = setup();
  const { overview } = await body<{ overview: { visits: Record<string, { current: number }>; photoChecks: { total: { current: number }; approved: { current: number } }; topParks: { visits: number }[] } }>(await api(request("/api/analytics/overview?days=90"), env));
  const visits = production.visits.filter((visit) => visit.outcome !== "imported" && Date.parse(visit.visitedAt) > NOW - 90 * 86_400_000);
  assert.equal(overview.visits.planted.current + overview.visits.took.current + overview.visits.held.current, visits.length);
  assert.ok(overview.photoChecks.approved.current <= overview.photoChecks.total.current);
  assert.ok(overview.topParks.length <= 10);
  assert.deepEqual(overview.topParks.map((park) => park.visits), [...overview.topParks.map((park) => park.visits)].sort((a, b) => b - a));
});

test("accounts page by 50 newest first, search by handle, ID or email, and never list an email", async () => {
  const { api, production } = setup();
  for (let index = 0; index < 30; index += 1) {
    production.accounts.push({ ...production.accounts[0], id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, handle: `extra_${index}`, email: `extra${index}@example.test` });
  }
  const first = await body<{ accounts: AccountRow[]; nextCursor: string; deletion: { available: boolean } }>(await api(request("/api/analytics/accounts"), env));
  assert.equal(first.accounts.length, 50);
  assert.ok(first.nextCursor);
  const second = await body<{ accounts: AccountRow[]; nextCursor: null }>(await api(request(`/api/analytics/accounts?cursor=${first.nextCursor}`), env));
  assert.equal(first.accounts.length + second.accounts.length, production.accounts.length);
  assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.accounts, ...second.accounts].map((row) => row.id)).size, production.accounts.length);
  const listed = JSON.stringify([...first.accounts, ...second.accounts]);
  assert.equal(listed.includes("@"), false);
  assert.ok(first.accounts.every((row, index) => index === 0 || first.accounts[index - 1].createdAt >= row.createdAt));

  const byHandle = await body<{ accounts: AccountRow[] }>(await api(request("/api/analytics/accounts?q=MOSSY"), env));
  assert.deepEqual(byHandle.accounts.map((row) => row.handle), ["mossy_maddie"]);
  const target = production.accounts.find((account) => account.handle === "trailhound")!;
  assert.equal((await body<{ accounts: AccountRow[] }>(await api(request(`/api/analytics/accounts?q=${target.id}`), env))).accounts[0].handle, "trailhound");
  assert.equal((await body<{ accounts: AccountRow[] }>(await api(request(`/api/analytics/accounts?q=${encodeURIComponent(target.email.toUpperCase())}`), env))).accounts[0].handle, "trailhound");
  assert.equal((await api(request("/api/analytics/accounts?state=gone"), env)).status, 400);
  assert.equal((await api(request("/api/analytics/accounts?cursor=nope!"), env)).status, 400);
});

test("account detail masks the email and a reveal is a recorded same-origin action", async () => {
  const { api, production } = setup();
  const target = production.accounts.find((account) => account.handle === "trailhound")!;
  const detail = await body<{ account: { maskedEmail: string; recentEvents: EventRow[] } }>(await api(request(`/api/analytics/accounts/${target.id}`), env));
  assert.equal(detail.account.maskedEmail, maskEmail(target.email));
  assert.equal(JSON.stringify(detail).includes(target.email), false);
  assert.equal((await api(request(`/api/analytics/accounts/${target.id}/email`, { method: "POST", origin: "https://evil.example.test" }), env)).status, 403);
  assert.equal((await api(request(`/api/analytics/accounts/${target.id}/email`), env)).status, 405);
  const revealed = await body<{ email: string }>(await api(request(`/api/analytics/accounts/${target.id}/email`, { method: "POST" }), env));
  assert.equal(revealed.email, target.email);
  assert.deepEqual(production.securityEvents, [{ eventType: "operator_email_reveal", outcome: "revealed" }]);
  assert.equal((await api(request("/api/analytics/accounts/00000000-0000-4000-8000-999999999999"), env)).status, 404);
  assert.equal((await api(request("/api/analytics/accounts/not-an-id"), env)).status, 404);
});

test("masked emails keep the first letters and the top-level domain", () => {
  assert.equal(maskEmail("trailhound@gmail.com"), "t***@g***.com");
  assert.equal(maskEmail("a@b"), "a***@b***");
  assert.equal(maskEmail("broken"), "***");
});

test("delete is disabled until the selected environment's photo service is configured", async () => {
  const { api, production } = setup({ accountDeleter: undefined });
  const target = production.accounts.find((account) => account.handle === "trailhound")!;
  const list = await body<{ deletion: { available: boolean; missing: string[] } }>(await api(request("/api/analytics/accounts"), env));
  assert.deepEqual(list.deletion, { available: false, missing: ["KIP_PHOTO_SERVICE_URL", "KIP_PHOTO_SERVICE_TOKEN"] });
  const staging = await body<{ deletion: { missing: string[] } }>(await api(request("/api/analytics/accounts", { cookie: "parkdex_operator_db=staging" }), { ...env, KIP_PHOTO_SERVICE_URL: "https://x", KIP_PHOTO_SERVICE_TOKEN: "y" }));
  assert.deepEqual(staging.deletion.missing, ["STAGING_KIP_PHOTO_SERVICE_URL", "STAGING_KIP_PHOTO_SERVICE_TOKEN"]);
  const refused = await api(request(`/api/analytics/accounts/${target.id}/delete`, { method: "POST", body: { accountId: target.id } }), env);
  assert.equal(refused.status, 503);
  assert.match((await body<{ error: { message: string } }>(refused)).error.message, /KIP_PHOTO_SERVICE_URL/);
  // Refusing must not leave the account half deleted.
  assert.equal(target.deletionState, "active");
  assert.equal(production.receipts.filter((receipt) => receipt.accountId === target.id).length, 0);
  assert.equal((await body<{ deletion: { available: boolean } }>(await api(request("/api/analytics/accounts"), photoEnv))).deletion.available, true);
});

test("deleting an account signs it out, runs the cleanup and records operator security events", async () => {
  const { api, production } = setup();
  const target = production.accounts.find((account) => account.handle === "trailhound")!;
  assert.equal((await api(request(`/api/analytics/accounts/${target.id}/delete`, { method: "POST", body: { accountId: target.id }, origin: null }), photoEnv)).status, 403);
  assert.equal((await api(request(`/api/analytics/accounts/${target.id}/delete`, { method: "POST", body: { accountId: production.accounts[1].id } }), photoEnv)).status, 400);
  const deleted = await api(request(`/api/analytics/accounts/${target.id}/delete`, { method: "POST", body: { accountId: target.id } }), photoEnv);
  assert.equal(deleted.status, 200);
  const result = await body<{ receiptId: string; status: string }>(deleted);
  assert.equal(result.status, "complete");
  assert.equal(production.accounts.some((account) => account.id === target.id), false);
  assert.equal(production.visits.some((visit) => visit.accountId === target.id), false);
  assert.deepEqual(production.securityEvents, [{ eventType: "operator_account_delete", outcome: "started" }, { eventType: "operator_account_delete", outcome: "complete" }]);
  assert.equal((await api(request(`/api/analytics/accounts/${target.id}/delete`, { method: "POST", body: { accountId: target.id } }), photoEnv)).status, 404);
});

test("a deletion stuck on the photo service stays pending, is listed, and can be resumed", async () => {
  let photoServiceUp = false;
  const { api, production } = setup({ accountDeleter: (selected) => new MemoryAccountDeleter(selected.DATABASE_URL === "postgres://staging" ? new MemoryAnalyticsStore() : production, () => photoServiceUp) });
  const target = production.accounts.find((account) => account.handle === "cedar_kid")!;
  const started = await api(request(`/api/analytics/accounts/${target.id}/delete`, { method: "POST", body: { accountId: target.id } }), photoEnv);
  assert.equal(started.status, 202);
  const { receiptId } = await body<{ receiptId: string; status: string }>(started);
  assert.equal(target.deletionState, "deleting");
  assert.ok(target.sessions.every((session) => session.revokedAt));
  const pending = await body<{ deletions: { receiptId: string; attempts: number; accountState: string }[] }>(await api(request("/api/analytics/deletions"), photoEnv));
  const row = pending.deletions.find((item) => item.receiptId === receiptId)!;
  assert.equal(row.accountState, "deleting");
  assert.equal(row.attempts, 1);
  // Deleting again does not open a second receipt; it resumes the open one.
  const again = await body<{ receiptId: string }>(await api(request(`/api/analytics/accounts/${target.id}/delete`, { method: "POST", body: { accountId: target.id } }), photoEnv));
  assert.equal(again.receiptId, receiptId);
  photoServiceUp = true;
  assert.equal((await api(request(`/api/analytics/deletions/${receiptId}/resume`, { method: "POST", origin: "https://evil.example.test" }), photoEnv)).status, 403);
  const resumed = await body<{ status: string }>(await api(request(`/api/analytics/deletions/${receiptId}/resume`, { method: "POST" }), photoEnv));
  assert.equal(resumed.status, "complete");
  assert.equal(production.accounts.some((account) => account.id === target.id), false);
  assert.equal((await api(request(`/api/analytics/deletions/${receiptId}/resume`, { method: "POST" }), photoEnv)).status, 404);
  assert.deepEqual(production.securityEvents.map((event) => event.outcome), ["started", "pending", "resumed_pending", "resumed_complete"]);
});

type EventsPage = { events: EventRow[]; nextCursor: string | null; filter: { from: string; to: string; types: string[] }; unknownHandle: string | null };

test("server events hide db_read and db_write by default and page with a keyset cursor", async () => {
  const { api, production } = setup();
  const range = `from=${new Date(NOW - 30 * 86_400_000).toISOString()}&to=${new Date(NOW).toISOString()}`;
  const first = await body<EventsPage>(await api(request(`/api/analytics/events?${range}`), env));
  assert.equal(first.events.length, 100);
  assert.ok(first.events.every((event) => event.type !== "db_read" && event.type !== "db_write"));
  assert.equal(first.filter.types.includes("db_read"), false);
  const withDb = await body<EventsPage>(await api(request(`/api/analytics/events?${range}&db=1`), env));
  assert.ok(withDb.events.some((event) => event.type === "db_read"));
  const ids = new Set(first.events.map((event) => event.id));
  let cursor = first.nextCursor;
  let pages = 1;
  while (cursor) {
    const page = await body<EventsPage>(await api(request(`/api/analytics/events?${range}&cursor=${cursor}`), env));
    for (const event of page.events) {
      assert.equal(ids.has(event.id), false);
      ids.add(event.id);
    }
    cursor = page.nextCursor;
    pages += 1;
  }
  const expected = production.events.filter((event) => event.type !== "db_read" && event.type !== "db_write" && event.receivedAt >= new Date(NOW - 30 * 86_400_000).toISOString());
  assert.equal(ids.size, expected.length);
  assert.ok(pages > 1);
});

test("server events filter by handle, type, park, route and result", async () => {
  const { api, production } = setup();
  const target = production.accounts.find((account) => account.handle === "trailhound")!;
  const byHandle = await body<EventsPage>(await api(request("/api/analytics/events?account=@trailhound&db=1&from=2026-08-01T00:00:00Z"), env));
  assert.ok(byHandle.events.length > 0);
  assert.ok(byHandle.events.every((event) => event.accountId === target.id && event.handle === "trailhound"));
  const unknown = await body<EventsPage>(await api(request("/api/analytics/events?account=nobody_here"), env));
  assert.deepEqual([unknown.events.length, unknown.unknownHandle], [0, "nobody_here"]);
  const failed = await body<EventsPage>(await api(request("/api/analytics/events?type=db_read,db_write&result=failed&from=2026-08-01T00:00:00Z"), env));
  assert.ok(failed.events.every((event) => event.result !== "ok"));
  const route = await body<EventsPage>(await api(request(`/api/analytics/events?route=${encodeURIComponent("POST /api/game/visits")}&from=2026-08-01T00:00:00Z`), env));
  assert.ok(route.events.length > 0 && route.events.every((event) => event.route === "POST /api/game/visits"));
  const park = await body<EventsPage>(await api(request("/api/analytics/events?park=regional-thetis-lake&type=flag_planted,flag_taken&from=2026-08-01T00:00:00Z"), env));
  assert.ok(park.events.every((event) => event.parkId === "regional-thetis-lake" && ["flag_planted", "flag_taken"].includes(event.type)));
  assert.equal((await api(request("/api/analytics/events?type=drop_table"), env)).status, 400);
  assert.equal((await api(request("/api/analytics/events?route=DROP"), env)).status, 400);
  assert.equal((await api(request("/api/analytics/events?from=2026-10-09T00:00:00Z&to=2026-10-08T00:00:00Z"), env)).status, 400);
  // Nothing older than the 90-day retention can match, so the range is clamped.
  const clamped = await body<EventsPage>(await api(request("/api/analytics/events?from=2020-01-01T00:00:00Z"), env));
  assert.equal(clamped.filter.from, new Date(NOW - 90 * 86_400_000).toISOString());
  const routes = await body<{ routes: string[] }>(await api(request("/api/analytics/events/routes"), env));
  assert.ok(routes.routes.includes("POST /api/game/visits"));
});

test("the histogram buckets by hour for short ranges and by day for long ones", async () => {
  const { api } = setup();
  const short = await body<{ bucket: string; buckets: { count: number }[] }>(await api(request(`/api/analytics/events/histogram?from=${new Date(NOW - 2 * 86_400_000).toISOString()}&db=1`), env));
  assert.equal(short.bucket, "hour");
  const long = await body<{ bucket: string; buckets: { count: number; db: number }[] }>(await api(request(`/api/analytics/events/histogram?from=${new Date(NOW - 30 * 86_400_000).toISOString()}&db=1`), env));
  assert.equal(long.bucket, "day");
  assert.ok(long.buckets.some((bucket) => bucket.db > 0));
  assert.ok(long.buckets.every((bucket) => bucket.db <= bucket.count));
  // Beyond a month the chart leaves the database queries out rather than count millions of rows.
  const months = await body<{ dbOmitted: boolean; buckets: { db: number }[] }>(await api(request(`/api/analytics/events/histogram?from=${new Date(NOW - 60 * 86_400_000).toISOString()}&db=1`), env));
  assert.equal(months.dbOmitted, true);
  assert.ok(months.buckets.every((bucket) => bucket.db === 0));
});

test("the CSV export streams the current filter and neutralises spreadsheet formulas", async () => {
  const { api, production } = setup();
  production.events.push({ ...production.events[0], id: "00000000-0000-4000-8000-00000000c5f0", type: "handle_set", receivedAt: new Date(NOW - 1000).toISOString(), appVersion: "=1+1", properties: { note: "a, \"quoted\" value" } });
  const response = await api(request(`/api/analytics/events/export?from=${new Date(NOW - 7 * 86_400_000).toISOString()}`), env);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/csv/);
  assert.match(response.headers.get("content-disposition") ?? "", /attachment; filename="parkdex-events-production-/);
  const text = await response.text();
  const lines = text.trim().split("\r\n");
  assert.equal(lines[0].split(",")[0], "event_id");
  const expected = production.events.filter((event) => event.type !== "db_read" && event.type !== "db_write" && event.receivedAt >= new Date(NOW - 7 * 86_400_000).toISOString());
  assert.equal(lines.length - 1, expected.length);
  assert.equal(text.includes(",db_read,"), false);
  const planted = lines.find((line) => line.startsWith("00000000-0000-4000-8000-00000000c5f0"))!;
  assert.ok(planted.includes(",'=1+1,"));
  assert.ok(planted.endsWith('"{""note"":""a, \\""quoted\\"" value""}"'));
});

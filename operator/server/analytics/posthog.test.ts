import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { createDashboardApi, type DashboardEnv } from "../api.ts";
import { strictEdgeFetch } from "../app/fakeCloud.ts";
import { buildTemplate, guardCustomQuery, resetPostHogPacing } from "./posthog.ts";

const ORIGIN = "https://operator.example.test";
const KEY = "phx_test_personal_key_never_in_responses";
const env: DashboardEnv = {
  DATABASE_URL: "postgres://production", STAGING_DATABASE_URL: "postgres://staging",
  POSTHOG_PERSONAL_API_KEY: KEY, POSTHOG_PROJECT_ID: "12345",
};

function request(path: string, options: { body?: unknown; cookie?: string; origin?: string | null; method?: string } = {}) {
  const headers = new Headers();
  const method = options.method ?? (options.body === undefined ? "GET" : "POST");
  if (method !== "GET" && options.origin !== null) headers.set("origin", options.origin ?? ORIGIN);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  if (options.cookie) headers.set("cookie", options.cookie);
  return new Request(`${ORIGIN}${path}`, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
}

type Call = { url: string; init: RequestInit; body: { query: { kind: string; query: string; values?: Record<string, unknown> } } };

function mockPostHog(respond: (call: Call) => Response = () => Response.json({ columns: ["event", "events", "people"], results: [["$pageview", 10, 3]], hasMore: false })) {
  const calls: Call[] = [];
  const fetchMock = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {}, body: JSON.parse(String(init?.body)) };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { calls, api: createDashboardApi({ posthogFetch: fetchMock }) };
}

beforeEach(() => resetPostHogPacing());

test("without a key the status lists the missing settings and queries say how to set it up", async () => {
  const { api, calls } = mockPostHog();
  const status = await (await api(request("/api/analytics/posthog/status"), { DATABASE_URL: "postgres://production" })).json() as { configured: boolean; missing: string[]; host: string };
  assert.deepEqual(status, { configured: false, host: "https://us.posthog.com", missing: ["POSTHOG_PERSONAL_API_KEY", "POSTHOG_PROJECT_ID"], problem: null, environment: "production" });
  const query = await api(request("/api/analytics/posthog/query", { body: { template: "top_events", days: 7 } }), { DATABASE_URL: "postgres://production" });
  assert.equal(query.status, 503);
  assert.equal(((await query.json()) as { error: { code: string } }).error.code, "posthog_not_configured");
  const badHost = await (await api(request("/api/analytics/posthog/status"), { ...env, POSTHOG_APP_HOST: "http://posthog.internal/path" })).json() as { configured: boolean; problem: string };
  assert.equal(badHost.configured, false);
  assert.match(badHost.problem, /https origin/);
  assert.equal(calls.length, 0);
});

test("a template query posts HogQL with placeholders and the toggle's environment, and the key stays on the server", async () => {
  const { api, calls } = mockPostHog();
  const response = await api(request("/api/analytics/posthog/query", { body: { template: "top_events", days: 14 }, cookie: "parkdex_operator_db=staging" }), { ...env, POSTHOG_APP_HOST: "https://eu.posthog.com/" });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.equal(text.includes(KEY), false);
  assert.deepEqual(JSON.parse(text).result, { columns: ["event", "events", "people"], rows: [["$pageview", 10, 3]], hasMore: false, nextCursor: null });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://eu.posthog.com/api/projects/12345/query/");
  assert.equal(new Headers(calls[0].init.headers).get("authorization"), `Bearer ${KEY}`);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].body.query.kind, "HogQLQuery");
  assert.match(calls[0].body.query.query, /properties\.environment = \{environment\}/);
  assert.equal(calls[0].body.query.values?.environment, "staging");
  assert.ok(Number.isFinite(Date.parse(String(calls[0].body.query.values?.since))));
  assert.equal((await api(request("/api/analytics/posthog/query", { body: { template: "top_events" }, origin: "https://evil.example.test" }), env)).status, 403);
  assert.equal((await api(request("/api/analytics/posthog/query", { body: { template: "drop_everything" } }), env)).status, 400);
  assert.equal((await api(request("/api/analytics/posthog/query", { body: { template: "top_events", days: 365 } }), env)).status, 400);
  assert.equal(calls.length, 1);
});

test("person and recent events page by timestamp instead of OFFSET", async () => {
  const rows = Array.from({ length: 100 }, (_, i) => [new Date(Date.UTC(2026, 9, 9, 12, 0, 0) - i * 60_000).toISOString(), "$autocapture", "acct", "/map", "Plant flag", "0.4.4+43", "android", null]);
  const { api, calls } = mockPostHog(() => Response.json({ columns: ["timestamp", "event", "distinct_id", "screen", "label", "app_version", "platform", "url"], results: rows }));
  const first = await (await api(request("/api/analytics/posthog/query", { body: { template: "person_events", days: 30, distinctId: "6f1c2b9e-1111-4a2b-9c3d-123456789abc" } }), env)).json() as { result: { nextCursor: string } };
  assert.equal(first.result.nextCursor, rows[99][0]);
  assert.equal(calls[0].body.query.values?.distinctId, "6f1c2b9e-1111-4a2b-9c3d-123456789abc");
  assert.doesNotMatch(calls[0].body.query.query, /OFFSET/i);
  await api(request("/api/analytics/posthog/query", { body: { template: "recent_events", days: 7, before: first.result.nextCursor, event: "$autocapture" } }), env);
  assert.match(calls[1].body.query.query, /timestamp < toDateTime\(\{before\}\)/);
  assert.match(calls[1].body.query.query, /event = \{event\}/);
  assert.equal(calls[1].body.query.values?.before, rows[99][0]);
  assert.equal((await api(request("/api/analytics/posthog/query", { body: { template: "person_events", distinctId: "a' OR 1=1 --" } }), env)).status, 400);
});

test("a 429 is passed on with its wait, and the instance backs off without calling PostHog again", async () => {
  const { api, calls } = mockPostHog(() => Response.json({ type: "throttled_error", code: "api_queries_budget_exceeded", detail: "Request was throttled." }, { status: 429, headers: { "retry-after": "42" } }));
  const limited = await api(request("/api/analytics/posthog/query", { body: { template: "events_per_day", days: 7 } }), env);
  assert.equal(limited.status, 429);
  const error = ((await limited.json()) as { error: { code: string; message: string } }).error;
  assert.equal(error.code, "posthog_rate_limited");
  assert.match(error.message, /42 seconds/);
  const again = await api(request("/api/analytics/posthog/query", { body: { template: "events_per_day", days: 7 } }), env);
  assert.equal(again.status, 429);
  assert.equal(calls.length, 1);
});

test("PostHog errors become messages the operator can act on", async () => {
  let status = 400;
  const { api } = mockPostHog(() => Response.json({ type: "validation_error", detail: "Unable to resolve field: nope" }, { status }));
  const invalid = await api(request("/api/analytics/posthog/sql", { body: { query: "SELECT nope FROM events" } }), env);
  assert.equal(invalid.status, 400);
  assert.match(((await invalid.json()) as { error: { message: string } }).error.message, /Unable to resolve field/);
  status = 403;
  const forbidden = await api(request("/api/analytics/posthog/sql", { body: { query: "SELECT 1" } }), env);
  assert.equal(forbidden.status, 502);
  assert.match(((await forbidden.json()) as { error: { message: string } }).error.message, /Query Read/);
});

test("custom SQL is one SELECT with a forced LIMIT", async () => {
  const { api, calls } = mockPostHog();
  const ok = await api(request("/api/analytics/posthog/sql", { body: { query: "select event, count() from events group by event;", limit: 50 } }), env);
  assert.equal(ok.status, 200);
  assert.equal(calls[0].body.query.query, "SELECT * FROM (\nselect event, count() from events group by event\n) LIMIT 50");
  assert.equal(calls[0].body.query.values, undefined);
  const rejected = [
    "INSERT INTO events VALUES (1)",
    "SELECT 1; SELECT 2",
    "SELECT 1 -- hide the rest",
    "SELECT 1 /* x */",
    "ALTER TABLE events DELETE WHERE 1",
    "SELECT * FROM events WHERE event = {event}",
    "SHOW TABLES",
    "",
  ];
  for (const query of rejected) {
    assert.equal((await api(request("/api/analytics/posthog/sql", { body: { query } }), env)).status, 400, query);
  }
  assert.equal((await api(request("/api/analytics/posthog/sql", { body: { query: "SELECT 1", limit: 50_001 } }), env)).status, 400);
  assert.equal(calls.length, 1);
});

test("the guard ignores keywords inside strings and allows WITH queries", () => {
  assert.equal(guardCustomQuery("SELECT 'drop table; -- not code' AS label", undefined).query, "SELECT * FROM (\nSELECT 'drop table; -- not code' AS label\n) LIMIT 500");
  assert.match(guardCustomQuery("WITH t AS (SELECT event FROM events) SELECT * FROM t", 10).query, /\) LIMIT 10$/);
  assert.match(guardCustomQuery("SELECT properties.$set FROM events", 1).query, /\$set/);
});

test("every template keeps operator input in values, never in the query text", () => {
  const now = new Date("2026-10-09T19:00:00Z");
  for (const name of ["events_per_day", "top_events", "taps", "screens", "recent_events"]) {
    const hogql = buildTemplate(name, { days: 7, event: "found_park_started" }, "production", now);
    assert.equal(hogql.query.includes("production"), false, name);
    assert.equal(hogql.query.includes("found_park_started"), false, name);
    assert.match(hogql.query, /LIMIT|GROUP BY day/, name);
  }
});

test("queries use only RequestInit fields the Edge runtime accepts, and a redirect is no answer", async () => {
  const strict = strictEdgeFetch(async () => Response.json({ columns: ["event", "events", "people"], results: [["$pageview", 10, 3]], hasMore: false }));
  const api = createDashboardApi({ posthogFetch: strict as unknown as typeof fetch });
  const ok = await api(request("/api/analytics/posthog/query", { body: { template: "top_events", days: 7 } }), env);
  assert.equal(ok.status, 200);
  assert.deepEqual(strict.violations, []);

  resetPostHogPacing();
  const redirecting = createDashboardApi({ posthogFetch: (async () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example.test/" } })) as typeof fetch });
  const moved = await redirecting(request("/api/analytics/posthog/query", { body: { template: "top_events", days: 7 } }), env);
  assert.equal(moved.status, 502);
});

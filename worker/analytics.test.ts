import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createAnalyticsSink,
  eventRows,
  flushRequestAnalytics,
  posthogBatch,
  posthogConfig,
  type AnalyticsSink,
} from "./analyticsSink.ts";
import {
  analyticsEnvironment,
  createRequestContext,
  emitEvent,
  MAX_EVENTS_PER_REQUEST,
  normalizeRoute,
  recordDbQuery,
  runWithRequestContext,
  setRequestAccount,
  validAppVersion,
  validBundleId,
  validInstallationId,
  type RequestContext,
} from "./requestContext.ts";
import { createFeedbackWorker } from "./index.ts";
import type { AppConfigStore } from "./appConfig.ts";

const INSTALLATION = "1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b";
const ACCOUNT = "6ec0bd7f-11c0-43da-975e-2a8ad9ebae0b";
const KEY = "phc_testProjectKey1234567890";

function headers(values: Record<string, string>) {
  const map = new Map(Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]));
  return (name: string) => map.get(name.toLowerCase()) ?? null;
}

function requestContext(values: Record<string, string> = {}, env: Record<string, string | undefined> = {}): RequestContext {
  return createRequestContext({ method: "GET", path: "/api/game/leaderboard", header: headers(values), env });
}

function dbEvent(operation: "read" | "write" = "read") {
  recordDbQuery({ operation, tables: ["kip_game.players"], durationMs: 4.6, result: "ok", startedAt: Date.parse("2026-10-07T12:00:00Z") });
}

test("context headers are validated strictly and malformed values are dropped", () => {
  assert.equal(validInstallationId(INSTALLATION.toUpperCase()), INSTALLATION);
  for (const bad of ["", "not-a-uuid", `${INSTALLATION} `, `${INSTALLATION}\r\nx: y`, "' OR 1=1 --"]) {
    assert.equal(validInstallationId(bad), null, bad);
  }
  assert.equal(validAppVersion("0.1.0+field"), "0.1.0+field");
  assert.equal(validAppVersion("1.0 beta"), null);
  assert.equal(validAppVersion("x".repeat(65)), null);
  assert.equal(validBundleId("abc123-dirty"), "abc123-dirty");
  assert.equal(validBundleId("<script>"), null);
  const context = requestContext({ "X-Kip-Installation-Id": "nope", "X-Kip-App-Version": "0.1.0", "X-Kip-Bundle-Id": "a b" });
  assert.equal(context.installationId, null);
  assert.equal(context.appVersion, "0.1.0");
  assert.equal(context.bundleId, null);
});

test("routes keep their shape but never identifiers", () => {
  assert.equal(normalizeRoute("put", `/api/claims/${INSTALLATION}/photo`), "PUT /api/claims/:id/photo");
  assert.equal(normalizeRoute("GET", "/api/content/snapshot"), "GET /api/content/snapshot");
  assert.equal(normalizeRoute("GET", `/api/recovery/${"a".repeat(64)}/12`), "GET /api/recovery/:hash/:n");
  assert.equal(normalizeRoute("GET", "/api/Some%20Thing/a@b.test"), "GET /api/:x/:x");
  assert.equal(normalizeRoute("BREW", "/"), "OTHER /");
});

test("environment comes from the deployment's content channel", () => {
  assert.equal(analyticsEnvironment({ CONTENT_CHANNEL: "main" }), "main");
  assert.equal(analyticsEnvironment({ CONTENT_CHANNEL: "staging" }), "staging");
  assert.equal(analyticsEnvironment({}), "preview");
});

test("events attach to the request, pick up the account and are capped", () => {
  const context = requestContext({ "X-Kip-Installation-Id": INSTALLATION });
  runWithRequestContext(context, () => {
    dbEvent();
    setRequestAccount(ACCOUNT.toUpperCase());
    emitEvent("flag_taken", { parkId: "provincial-goldstream-park", pointsEarned: 3, previousHandle: "sam", "bad key": "x", nested: { a: 1 } });
    for (let index = 0; index < MAX_EVENTS_PER_REQUEST + 10; index += 1) dbEvent();
  });
  assert.equal(context.accountId, ACCOUNT);
  assert.equal(context.events.length, MAX_EVENTS_PER_REQUEST);
  const game = context.events[1];
  assert.equal(game.type, "flag_taken");
  assert.equal(game.parkId, "provincial-goldstream-park");
  assert.deepEqual(game.properties, { points_earned: 3, previous_handle: "sam" });
  assert.equal(context.events[0].durationMs, 5);
});

test("emitEvent outside a request or with an unknown type does nothing", () => {
  assert.doesNotThrow(() => emitEvent("flag_planted", { parkId: "x" }));
  const context = requestContext();
  runWithRequestContext(context, () => emitEvent("not_a_game_event" as never));
  assert.equal(context.events.length, 0);
});

test("database rows carry request labels and no free text", () => {
  const context = requestContext({ "X-Kip-Installation-Id": INSTALLATION, "X-Kip-App-Version": "0.1.0", "X-Kip-Bundle-Id": "abc1234" }, { CONTENT_CHANNEL: "staging" });
  runWithRequestContext(context, () => dbEvent("write"));
  const [row] = eventRows(context);
  assert.equal(row.event_type, "db_write");
  assert.equal(row.installation_id, INSTALLATION);
  assert.equal(row.environment, "staging");
  assert.equal(row.route, "GET /api/game/leaderboard");
  assert.equal(row.bundle_id, "abc1234");
  assert.deepEqual(row.tables, ["kip_game.players"]);
});

test("PostHog config needs a key and only accepts an https host", () => {
  assert.equal(posthogConfig({}), null);
  assert.equal(posthogConfig({ POSTHOG_PROJECT_KEY: "short" }), null);
  assert.deepEqual(posthogConfig({ POSTHOG_PROJECT_KEY: KEY }), { key: KEY, host: "https://us.i.posthog.com" });
  assert.deepEqual(posthogConfig({ POSTHOG_PROJECT_KEY: KEY, POSTHOG_HOST: "https://eu.i.posthog.com/" }), { key: KEY, host: "https://eu.i.posthog.com" });
  assert.equal(posthogConfig({ POSTHOG_PROJECT_KEY: KEY, POSTHOG_HOST: "http://evil.example" })?.host, "https://us.i.posthog.com");
});

test("PostHog gets writes and game events, never the read firehose", () => {
  const context = requestContext({ "X-Kip-Installation-Id": INSTALLATION, "X-Kip-App-Version": "0.1.0" }, { CONTENT_CHANNEL: "main" });
  runWithRequestContext(context, () => {
    dbEvent("read");
    dbEvent("write");
    emitEvent("leaderboard_viewed");
  });
  const anonymous = posthogBatch(context, KEY);
  assert.equal(anonymous.api_key, KEY);
  assert.deepEqual(anonymous.batch.map((item) => item.event), ["db_write", "leaderboard_viewed"]);
  const first = anonymous.batch[0] as { distinct_id: string; uuid: string; properties: Record<string, unknown> };
  assert.equal(first.distinct_id, INSTALLATION);
  assert.equal(first.uuid, context.events[1].eventId);
  assert.equal(first.properties.$process_person_profile, false);
  assert.equal(first.properties.environment, "production");
  assert.equal(first.properties.app_version, "0.1.0");

  runWithRequestContext(context, () => setRequestAccount(ACCOUNT));
  const identified = posthogBatch(context, KEY).batch[0] as { distinct_id: string; properties: Record<string, unknown> };
  assert.equal(identified.distinct_id, ACCOUNT);
  assert.equal(identified.properties.$process_person_profile, true);
});

test("the sink inserts once and posts one capture batch to the configured host", async () => {
  const inserted: Record<string, unknown>[][] = [];
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const sink = createAnalyticsSink({ POSTHOG_PROJECT_KEY: KEY }, { writeRows: async (rows) => { inserted.push(rows); }, fetch: fetcher })!;
  const context = requestContext({ "X-Kip-Installation-Id": INSTALLATION });
  runWithRequestContext(context, () => { dbEvent("read"); dbEvent("write"); });
  await sink.write(context);
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].length, 2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://us.i.posthog.com/batch/");
  assert.equal(calls[0].init.method, "POST");
  const body = JSON.parse(String(calls[0].init.body));
  assert.equal(body.batch.length, 1);
  assert.equal(body.batch[0].event, "db_write");
});

test("without a key nothing is sent to PostHog, and without anything there is no sink", async () => {
  let fetched = false;
  const sink = createAnalyticsSink({}, { writeRows: async () => undefined, fetch: (async () => { fetched = true; return new Response(); }) as typeof fetch })!;
  const context = requestContext();
  runWithRequestContext(context, () => dbEvent("write"));
  await sink.write(context);
  assert.equal(fetched, false);
  assert.equal(createAnalyticsSink({}), null);
});

test("sink failures never reach the caller", async () => {
  const sink = createAnalyticsSink({ POSTHOG_PROJECT_KEY: KEY }, {
    writeRows: async () => { throw new Error("database down"); },
    fetch: (async () => { throw new Error("network down"); }) as typeof fetch,
  })!;
  const context = requestContext();
  runWithRequestContext(context, () => dbEvent("write"));
  await assert.doesNotReject(sink.write(context));
  const throwing: AnalyticsSink = { write() { throw new Error("sync failure"); } };
  assert.doesNotThrow(() => flushRequestAnalytics(context, throwing, () => { throw new Error("no waitUntil"); }));
});

class RecordingAppConfigStore implements Partial<AppConfigStore> {
  async resolve() {
    dbEvent("read");
    return [];
  }
  async updateRules(environment: "production" | "staging") {
    dbEvent("read");
    return { environment, minimumBuild: null, latestBuild: null, updatedAt: null };
  }
}

test("the API router records a request's queries after the response via waitUntil", async () => {
  const written: RequestContext[] = [];
  const pending: Promise<unknown>[] = [];
  const worker = createFeedbackWorker({
    createAppConfigStore: () => new RecordingAppConfigStore() as unknown as AppConfigStore,
    analytics: () => ({ async write(context) { written.push(context); } }),
  });
  const response = await worker.fetch(new Request("https://kip.example.test/api/app-config?platform=web&build=0", {
    headers: { "X-Kip-Installation-Id": INSTALLATION, "X-Kip-App-Version": "0.1.0", "X-Kip-Bundle-Id": "abc1234" },
  }), { POSTHOG_PROJECT_KEY: KEY }, { waitUntil: (promise) => { pending.push(promise); } });
  assert.equal(response.status, 200);
  const body = await response.json() as { analytics: unknown };
  assert.deepEqual(body.analytics, { posthogKey: KEY, posthogHost: "https://us.i.posthog.com" });
  assert.equal(pending.length, 1);
  await Promise.all(pending);
  assert.equal(written.length, 1);
  assert.equal(written[0].route, "GET /api/app-config");
  assert.equal(written[0].installationId, INSTALLATION);
  assert.equal(written[0].events.length, 2);
});

test("the app config omits analytics without a key", async () => {
  const worker = createFeedbackWorker({ createAppConfigStore: () => new RecordingAppConfigStore() as unknown as AppConfigStore, analytics: () => null });
  const response = await worker.fetch(new Request("https://kip.example.test/api/app-config?platform=web&build=0"), {});
  assert.equal((await response.json() as { analytics: unknown }).analytics, null);
});

test("CORS preflights allow the context headers", async () => {
  const worker = createFeedbackWorker();
  const response = await worker.fetch(new Request("https://kip.example.test/api/claims", { method: "OPTIONS", headers: { origin: "https://localhost" } }), {
    PUBLIC_APP_URL: "https://kip.example.test",
    ALLOWED_ORIGINS: "https://localhost",
  });
  const allowed = response.headers.get("access-control-allow-headers") ?? "";
  for (const name of ["X-Kip-Installation-Id", "X-Kip-App-Version", "X-Kip-Bundle-Id"]) assert.match(allowed, new RegExp(name));
});

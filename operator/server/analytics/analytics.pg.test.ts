import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { after, before, test } from "node:test";
import { createDashboardApi, type DashboardEnv } from "../api.ts";
import { publishStatements, type SqlRunner } from "../drafts.ts";
import { insertDraft, openTestDatabase } from "../pgHarness.ts";
import { createSqlAnalyticsStore } from "./store.ts";
import type { AccountRow, AnalyticsStore, EventRow } from "./types.ts";

// Runs the analytics queries and account deletion against every deploy migration. Point
// OPERATOR_ANALYTICS_TEST_DATABASE_URL at a disposable loopback database named kip_qa_*.
const DSN = process.env.OPERATOR_ANALYTICS_TEST_DATABASE_URL;
const ROOT = new URL("../../../", import.meta.url);
const ORIGIN = "https://operator.example.test";
const DAY = 86_400_000;

let pool: import("pg").Pool;
let runner: SqlRunner;
let store: AnalyticsStore;
const now = new Date();
const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();

const ids = { ada: randomUUID(), ben: randomUUID(), cy: randomUUID(), quiet: randomUUID() };

/** Every migration a deploy runs, in deploy order, so this also proves the new index migration replays. */
async function inventory(): Promise<string[]> {
  const config = JSON.parse(await readFile(new URL("deployment.json", ROOT), "utf8"));
  return [
    config.migrationPath,
    ...config.contentSync.supportingMigrationPaths,
    ...config.optionalMigrationPaths,
    ...config.contentSync.migrationPaths,
    ...config.independentMigrationPaths,
  ];
}

/**
 * The worker's account stores speak Neon's HTTP protocol. Answer it from the pg pool, as
 * scripts/qa-postgres-adapter.mjs does, on the driver copy the worker modules load.
 */
async function routeNeonToPool() {
  // The worker imports the driver as ESM, so configure the package's "import" entry, not require's.
  const manifest = new URL("package.json", pathToFileURL(createRequire(new URL("worker/db.ts", ROOT)).resolve("@neondatabase/serverless")));
  const entry = (JSON.parse(await readFile(manifest, "utf8")) as { exports: { import: string } }).exports.import;
  const { neonConfig } = (await import(new URL(entry, manifest).href)) as typeof import("@neondatabase/serverless");
  const identity = { getTypeParser: () => (value: unknown) => value };
  const shape = (result: import("pg").QueryResult) => ({
    fields: result.fields.map(({ name, dataTypeID }) => ({ name, dataTypeID })),
    rows: result.rows,
    rowCount: result.rowCount,
  });
  neonConfig.fetchFunction = async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const client = await pool.connect();
    try {
      if (Array.isArray(body.queries)) {
        await client.query("BEGIN");
        const results = [];
        for (const query of body.queries)
          results.push(shape(await client.query({ text: query.query, values: query.params, rowMode: "array", types: identity })));
        await client.query("COMMIT");
        return new Response(JSON.stringify({ results }), { status: 200 });
      }
      return new Response(JSON.stringify(shape(await client.query({ text: body.query, values: body.params, rowMode: "array", types: identity }))), {
        status: 200,
      });
    } catch (error) {
      if (Array.isArray(body.queries)) await client.query("ROLLBACK").catch(() => undefined);
      const failure = error as { message: string; code?: string };
      return new Response(JSON.stringify({ message: failure.message, code: failure.code }), { status: 400 });
    } finally {
      client.release();
    }
  };
}

async function account(id: string, email: string, createdAt: string, handle: string | null) {
  await pool.query("INSERT INTO kip_account.accounts (id, normalized_email, created_at) VALUES ($1, $2, $3)", [id, email, createdAt]);
  await pool.query("INSERT INTO kip_account.google_identities (subject, account_id) VALUES ($1, $2)", [`sub-${id}`, id]);
  await pool.query(
    "INSERT INTO kip_account.sessions (id, account_id, token_hash, transport, created_at, expires_at, absolute_expires_at) VALUES ($1, $2, $3, 'native', $4, $5, $5)",
    [randomUUID(), id, createHash("sha256").update(id).digest("hex"), ago(5 * DAY), new Date(now.getTime() + 20 * DAY).toISOString()],
  );
  if (handle) await pool.query("INSERT INTO kip_game.players (account_id, handle, flag_seed) VALUES ($1, $2, kip_game.flag_seed($1))", [id, handle]);
}

async function event(type: string, accountId: string | null, receivedAt: string, extra: Record<string, unknown> = {}) {
  const db = type === "db_read" || type === "db_write";
  await pool.query(
    `INSERT INTO kip_analytics.events (event_id, event_type, account_id, request_id, route, occurred_at, received_at, environment,
       operation, tables, duration_ms, result, park_id, properties, schema_version)
     VALUES ($1, $2, $3, $4, $5, $6, $6, 'main', $7, $8, $9, $10, $11, $12, 1)`,
    [
      randomUUID(),
      type,
      accountId,
      randomUUID(),
      extra.route ?? (db ? "GET /api/game/flags" : "POST /api/game/visits"),
      receivedAt,
      db ? (type === "db_read" ? "read" : "write") : null,
      db ? ["kip_game.tenures"] : null,
      db ? 12 : null,
      db ? (extra.result ?? "ok") : null,
      extra.parkId ?? null,
      db ? null : JSON.stringify(extra.properties ?? { source: "visit" }),
    ],
  );
}

before(async () => {
  if (!DSN) return;
  const opened = await openTestDatabase(DSN, await inventory());
  pool = opened.pool;
  runner = opened.runner;
  // Every deploy replays the inventory, so the second pass must be a no-op.
  for (const file of await inventory()) await pool.query(await readFile(new URL(file, ROOT), "utf8"));
  await routeNeonToPool();
  store = createSqlAnalyticsStore(runner);
  const updatedAt = await insertDraft(runner, "regional-thetis-lake");
  await runner.transaction(publishStatements("regional-thetis-lake", updatedAt, null));

  await account(ids.ada, "ada@example.test", ago(40 * DAY), "ada_trails");
  await account(ids.ben, "ben@example.test", ago(3 * DAY), "ben_bikes");
  await account(ids.cy, "cy@example.test", ago(2 * DAY), null);
  await account(ids.quiet, "quiet@example.test", ago(1 * DAY), "quiet_q");

  // Ada plants, Ben takes the flag and comes back the next day to hold it, through the real game function.
  await pool.query("SELECT kip_game.record_visit($1, $2, 'regional-thetis-lake', $3)", [randomUUID(), ids.ada, ago(4 * DAY)]);
  await pool.query("SELECT kip_game.record_visit($1, $2, 'regional-thetis-lake', $3)", [randomUUID(), ids.ben, ago(2 * DAY)]);
  await pool.query("SELECT kip_game.record_visit($1, $2, 'regional-thetis-lake', $3)", [randomUUID(), ids.ben, ago(1 * DAY - 3_600_000)]);

  const photo = Buffer.from("ffd8ffe0-founder-photo");
  await pool.query(
    `INSERT INTO kip_founders.parks (park_id, account_id, attempt_id, founded_at, source, photo_sha256, photo_bytes, photo_width, photo_height, moderation)
     VALUES ('regional-thetis-lake', $1, $2, $3, 'existing', $4, $5, 640, 480, '{}'::jsonb)`,
    [ids.ada, randomUUID(), ago(4 * DAY), createHash("sha256").update(photo).digest("hex"), photo],
  );
  for (const [outcome, flags] of [
    ["approve", []],
    ["reject", ["people"]],
    ["reject", ["people", "lighting"]],
    ["unsure", ["not_park"]],
  ] as const) {
    await pool.query(
      "INSERT INTO kip_founders.photo_checks (id, account_id, attempt_id, park_id, outcome, flags, photo_sha256, created_at) VALUES ($1, $2, $1, 'regional-thetis-lake', $3, $4, $5, $6)",
      [randomUUID(), ids.ada, outcome, flags, "b".repeat(64), ago(3 * DAY)],
    );
  }

  await event("flag_planted", ids.ada, ago(4 * DAY), { parkId: "regional-thetis-lake" });
  await event("flag_taken", ids.ben, ago(2 * DAY), { parkId: "regional-thetis-lake", properties: { points: 2 } });
  await event("db_read", ids.ben, ago(2 * DAY));
  await event("db_write", ids.ben, ago(2 * DAY), { result: "23505" });
  await event("leaderboard_viewed", ids.ben, ago(3_600_000), { route: "GET /api/game/leaderboard" });
  await event("leaderboard_viewed", null, ago(7_200_000), { route: "GET /api/game/leaderboard" });
  await pool.query(
    "INSERT INTO kip_feedback.reports (id, submission_id, payload_hash, kind, message, contact, context, status) VALUES ($1, $1, $2, 'bug', 'Map froze', false, '{}', 'new')",
    [randomUUID(), "c".repeat(64)],
  );
});

after(async () => {
  await pool?.end();
});

test("the overview reads every tile and chart from the migrated schema", { skip: !DSN }, async () => {
  const overview = await store.overview(now, 7);
  assert.equal(overview.accounts.total, 4);
  assert.equal(overview.accounts.new7, 3);
  assert.equal(overview.accounts.withHandle, 3);
  assert.deepEqual(overview.players.week, { current: 2, previous: 0 });
  assert.deepEqual(overview.players.day, { current: 1, previous: 0 });
  assert.deepEqual([overview.visits.planted.current, overview.visits.took.current, overview.visits.held.current], [1, 1, 1]);
  assert.deepEqual(overview.founded, { total: 1, new7: 1, period: { current: 1, previous: 0 } });
  assert.deepEqual(
    [overview.photoChecks!.total.current, overview.photoChecks!.approved.current, overview.photoChecks!.rejected, overview.photoChecks!.unsure],
    [4, 1, 2, 1],
  );
  assert.deepEqual(overview.rejectionFlags, [
    { flag: "people", count: 2 },
    { flag: "lighting", count: 1 },
    { flag: "not_park", count: 1 },
  ]);
  assert.deepEqual(overview.topParks, [{ parkId: "regional-thetis-lake", name: "Thetis Lake Regional Park", visits: 3, players: 2 }]);
  assert.equal(overview.feedbackOpen, 1);
  assert.equal(overview.series.days.length, 7);
  assert.equal(
    overview.series.newAccounts.reduce((sum, value) => sum + value, 0),
    3,
  );
  assert.equal(overview.series.planted.reduce((sum, value) => sum + value, 0) + overview.series.took.reduce((sum, value) => sum + value, 0), 2);
  assert.equal(
    overview.series.foundings!.reduce((sum, value) => sum + value, 0),
    1,
  );
  assert.ok(overview.series.activePlayers.reduce((sum, value) => sum + value, 0) >= 3);
});

test("account rows match the game's own score function", { skip: !DSN }, async () => {
  const rows = await store.listAccounts({ search: null, state: null, cursor: null, limit: 10 }, now);
  assert.deepEqual(
    rows.map((row) => row.handle),
    ["quiet_q", null, "ben_bikes", "ada_trails"],
  );
  const scores = (await pool.query("SELECT account_id::text, score, parks_held FROM kip_game.player_scores($1)", [now.toISOString()])).rows;
  for (const score of scores) {
    const row = rows.find((item) => item.id === score.account_id) as AccountRow;
    assert.equal(row.score, score.score, row.handle ?? row.id);
    assert.equal(row.parksHeld, score.parks_held, row.handle ?? row.id);
  }
  const ben = rows.find((row) => row.handle === "ben_bikes")!;
  assert.deepEqual([ben.visits, ben.parksHeld, ben.providers], [2, 1, ["google"]]);
  assert.equal(rows.find((row) => row.handle === "ada_trails")!.foundedParks, 1);
  const page = await store.listAccounts({ search: null, state: null, cursor: { createdAt: ben.createdAt, id: ben.id }, limit: 10 }, now);
  assert.deepEqual(
    page.map((row) => row.handle),
    ["ada_trails"],
  );
  assert.deepEqual(
    (await store.listAccounts({ search: "ben_", state: null, cursor: null, limit: 10 }, now)).map((row) => row.handle),
    ["ben_bikes"],
  );
  // An underscore is a handle character here, not a LIKE wildcard.
  assert.deepEqual(
    (await store.listAccounts({ search: "a_t", state: null, cursor: null, limit: 10 }, now)).map((row) => row.handle),
    ["ada_trails"],
  );
  assert.deepEqual(
    (await store.listAccounts({ search: "CY@example.test", state: null, cursor: null, limit: 10 }, now)).map((row) => row.id),
    [ids.cy],
  );
  const detail = await store.getAccount(ids.ben, now);
  assert.equal(detail?.maskedEmail, "b***@e***.test");
  assert.equal(detail?.recentEvents.length, 4);
  assert.deepEqual(
    detail?.recentVisits.map((visit) => visit.outcome),
    ["held", "took"],
  );
  assert.equal(await store.accountIdForHandle("BEN_BIKES"), ids.ben);
});

test("event queries filter, page and bucket on the real table", { skip: !DSN }, async () => {
  const base = { from: ago(30 * DAY), to: new Date(now.getTime() + 60_000).toISOString(), accountId: null, parkId: null, route: null, result: null } as const;
  const game = ["flag_planted", "flag_taken", "leaderboard_viewed"];
  const all = await store.listEvents({ ...base, types: game }, null, 100);
  assert.deepEqual(
    all.map((row) => row.type),
    ["leaderboard_viewed", "leaderboard_viewed", "flag_taken", "flag_planted"],
  );
  assert.equal(all.find((row) => row.type === "flag_taken")?.handle, "ben_bikes");
  assert.deepEqual(all.find((row) => row.type === "flag_taken")?.properties, { points: 2 });
  const firstTwo = await store.listEvents({ ...base, types: game }, null, 2);
  const rest = await store.listEvents({ ...base, types: game }, { receivedAt: firstTwo[1].receivedAt, id: firstTwo[1].id }, 10);
  assert.deepEqual(
    [...firstTwo, ...rest].map((row: EventRow) => row.id),
    all.map((row) => row.id),
  );
  const failed = await store.listEvents({ ...base, types: ["db_read", "db_write"], result: "failed" }, null, 10);
  assert.deepEqual(
    failed.map((row) => [row.type, row.result, row.tables]),
    [["db_write", "23505", ["kip_game.tenures"]]],
  );
  assert.equal((await store.listEvents({ ...base, types: game, accountId: ids.ada }, null, 10)).length, 1);
  assert.equal((await store.listEvents({ ...base, types: game, parkId: "regional-thetis-lake" }, null, 10)).length, 2);
  assert.equal((await store.listEvents({ ...base, types: game, route: "GET /api/game/leaderboard" }, null, 10)).length, 2);
  const buckets = await store.histogram({ ...base, types: [...game, "db_read", "db_write"] }, "day");
  assert.equal(
    buckets.reduce((sum, bucket) => sum + bucket.count, 0),
    6,
  );
  assert.equal(
    buckets.reduce((sum, bucket) => sum + bucket.db, 0),
    2,
  );
  assert.deepEqual(await store.routes(), ["GET /api/game/flags", "GET /api/game/leaderboard", "POST /api/game/visits"]);
});

test("reads run read-only, so a write slipped into one fails", { skip: !DSN }, async () => {
  await assert.rejects(
    runner.transaction([
      { text: "SET TRANSACTION READ ONLY", params: [] },
      { text: "DELETE FROM kip_feedback.reports", params: [] },
    ]),
    /read-only/,
  );
});

test("operator deletion reuses the app's cleanup, keeps a stuck receipt pending, and resumes it", { skip: !DSN }, async () => {
  let photoService: "down" | "up" = "down";
  const photoCalls: string[] = [];
  const photoFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    photoCalls.push(`${init?.method} ${String(input)} ${new Headers(init?.headers).get("authorization")}`);
    return photoService === "down" ? new Response("unavailable", { status: 503 }) : Response.json({ complete: true, deleted: 1 });
  }) as typeof fetch;
  const env: DashboardEnv = { DATABASE_URL: DSN, KIP_PHOTO_SERVICE_URL: "https://photos.example.workers.dev", KIP_PHOTO_SERVICE_TOKEN: "photo-token" };
  const api = createDashboardApi({ analyticsStore: () => store, photoFetch });
  const post = (path: string, body?: unknown) =>
    api(
      new Request(`${ORIGIN}${path}`, {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      env,
    );

  const claimId = randomUUID();
  await pool.query(
    `INSERT INTO kip_account.claims (account_id, claim_id, park_id, claimed_at, park_snapshot, sync_revision, payload_hash)
    VALUES ($1, $2, 'regional-thetis-lake', now(), '{"id":"regional-thetis-lake"}', 1, $3)`,
    [ids.cy, claimId, "d".repeat(64)],
  );
  await pool.query(
    `INSERT INTO kip_account.claim_photos (account_id, claim_id, object_key, content_type, sha256, size_bytes, status, sync_revision)
    VALUES ($1, $2, $3, 'image/jpeg', $4, 10, 'ready', 2)`,
    [ids.cy, claimId, `accounts/${ids.cy}/claims/${claimId}`, "e".repeat(64)],
  );

  const started = await post(`/api/analytics/accounts/${ids.cy}/delete`, { accountId: ids.cy });
  assert.equal(started.status, 202);
  const { receiptId } = (await started.json()) as { receiptId: string };
  assert.equal(photoCalls[0], `DELETE https://photos.example.workers.dev/v1/accounts/${ids.cy} Bearer photo-token`);
  const account = (await pool.query("SELECT deletion_state FROM kip_account.accounts WHERE id = $1", [ids.cy])).rows[0];
  assert.equal(account.deletion_state, "deleting");
  assert.equal(Number((await pool.query("SELECT count(*) FROM kip_account.sessions WHERE account_id = $1 AND revoked_at IS NULL", [ids.cy])).rows[0].count), 0);
  // Claims are gone, but the photo key stays listed until the photo service confirms.
  assert.equal(Number((await pool.query("SELECT count(*) FROM kip_account.claims WHERE account_id = $1", [ids.cy])).rows[0].count), 0);
  const pending = await store.pendingDeletions();
  assert.deepEqual(
    pending.map((row) => [row.receiptId, row.photoObjects, row.attempts, row.accountState]),
    [[receiptId, 1, 1, "deleting"]],
  );

  photoService = "up";
  const resumed = await post(`/api/analytics/deletions/${receiptId}/resume`);
  assert.deepEqual(await resumed.json(), { receiptId, status: "complete" });
  assert.equal((await pool.query("SELECT 1 FROM kip_account.accounts WHERE id = $1", [ids.cy])).rowCount, 0);
  assert.equal((await pool.query("SELECT status FROM kip_account.account_deletion_receipts WHERE receipt_id = $1", [receiptId])).rows[0].status, "complete");
  assert.deepEqual(await store.pendingDeletions(), []);
  const events = (
    await pool.query("SELECT outcome FROM kip_account.security_events WHERE event_type = 'operator_account_delete' ORDER BY created_at, outcome")
  ).rows.map((row) => row.outcome);
  assert.deepEqual([...events].sort(), ["pending", "resumed_complete", "started"]);
  assert.equal((await post(`/api/analytics/accounts/${ids.cy}/delete`, { accountId: ids.cy })).status, 404);
});

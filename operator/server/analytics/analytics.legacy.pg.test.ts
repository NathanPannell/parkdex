import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { createDashboardApi } from "../api.ts";
import { publishStatements, type SqlRunner } from "../drafts.ts";
import { insertDraft, openTestDatabase } from "../pgHarness.ts";
import { clearFeatureCache } from "./schema.ts";
import { createSqlAnalyticsStore } from "./store.ts";
import type { AccountRow, AnalyticsStore } from "./types.ts";

// Production can run a release behind staging. This database gets every deploy migration except
// founders_001 to founders_003 (so no kip_founders schema) and the game migrations that build on
// them, like production before the founders release, and the analytics pages must still load.
// Point OPERATOR_ANALYTICS_LEGACY_TEST_DATABASE_URL at a fresh loopback database named kip_qa_*.
const DSN = process.env.OPERATOR_ANALYTICS_LEGACY_TEST_DATABASE_URL;
const ROOT = new URL("../../../", import.meta.url);
const ORIGIN = "https://operator.example.test";
const DAY = 86_400_000;
const FOUNDERS = "database/migrations/founders_001_init.sql";
// founders_002 builds on founders_001, so it cannot arrive first.
const FOUNDER_REVIEWS = "database/migrations/founders_002_reviews.sql";
const PARK_REMOVED = "database/migrations/founders_003_park_removed.sql";
// Hourly points (#169) build on founders_001, so a database without founders predates them too.
const GAME_POINTS = "database/migrations/game_002_points.sql";
// Crews (#170) read game_002's day_bonus, and badges (#175) call crews' kip_game.holdings, so neither
// can apply without hourly points either.
const GAME_CREWS = "database/migrations/game_003_crews.sql";
const GAME_BADGES = "database/migrations/game_004_badges.sql";
// Adding crewmates as friends reads crews' crew_members, so it cannot apply without crews either.
const CREWMATES = "database/migrations/social_002_crewmates.sql";
const NOT_YET_DEPLOYED = new Set([FOUNDERS, FOUNDER_REVIEWS, PARK_REMOVED, GAME_POINTS, GAME_CREWS, GAME_BADGES, CREWMATES]);

let pool: import("pg").Pool;
let runner: SqlRunner;
let store: AnalyticsStore;
const now = new Date();
const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
const ids = { ada: randomUUID(), ben: randomUUID() };

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

async function account(id: string, email: string, createdAt: string, handle: string) {
  await pool.query("INSERT INTO kip_account.accounts (id, normalized_email, created_at) VALUES ($1, $2, $3)", [id, email, createdAt]);
  await pool.query(
    "INSERT INTO kip_account.sessions (id, account_id, token_hash, transport, created_at, expires_at, absolute_expires_at) VALUES ($1, $2, $3, 'native', $4, $5, $5)",
    [randomUUID(), id, createHash("sha256").update(id).digest("hex"), ago(5 * DAY), new Date(now.getTime() + 20 * DAY).toISOString()],
  );
  await pool.query("INSERT INTO kip_game.players (account_id, handle, flag_seed) VALUES ($1, $2, kip_game.flag_seed($1))", [id, handle]);
}

before(async () => {
  if (!DSN) return;
  const migrations = (await inventory()).filter((file) => !NOT_YET_DEPLOYED.has(file));
  const opened = await openTestDatabase(DSN, migrations);
  pool = opened.pool;
  runner = opened.runner;
  // The analytics index migration replays on a database without founders, as a deploy would.
  await pool.query(await readFile(new URL("database/migrations/operator_analytics_001_indexes.sql", ROOT), "utf8"));
  clearFeatureCache();
  store = createSqlAnalyticsStore(runner, "legacy-test");
  const updatedAt = await insertDraft(runner, "regional-thetis-lake");
  await runner.transaction(publishStatements("regional-thetis-lake", updatedAt, null));
  await account(ids.ada, "ada@example.test", ago(10 * DAY), "ada_trails");
  await account(ids.ben, "ben@example.test", ago(3 * DAY), "ben_bikes");
  await pool.query("SELECT kip_game.record_visit($1, $2, 'regional-thetis-lake', $3)", [randomUUID(), ids.ada, ago(4 * DAY)]);
  await pool.query("SELECT kip_game.record_visit($1, $2, 'regional-thetis-lake', $3)", [randomUUID(), ids.ben, ago(2 * DAY)]);
  await pool.query(
    `INSERT INTO kip_analytics.events (event_id, event_type, account_id, request_id, route, occurred_at, received_at, environment, park_id, properties, schema_version)
     VALUES ($1, 'flag_taken', $2, $3, 'POST /api/game/visits', $4, $4, 'main', 'regional-thetis-lake', '{"points": 2}', 1)`,
    [randomUUID(), ids.ben, randomUUID(), ago(2 * DAY)],
  );
});

after(async () => {
  await pool?.end();
});

test("the database really lacks kip_founders", { skip: !DSN }, async () => {
  assert.equal((await pool.query("SELECT to_regclass('kip_founders.parks') AS parks")).rows[0].parks, null);
  assert.equal((await pool.query("SELECT to_regclass('kip_founders.photo_checks_created_idx') AS idx")).rows[0].idx, null);
  assert.ok((await pool.query("SELECT to_regclass('kip_game.visits_visited_at_idx') AS idx")).rows[0].idx);
  assert.deepEqual(await store.features(), { founders: false });
});

test("the overview loads without founder tiles and says why", { skip: !DSN }, async () => {
  const api = createDashboardApi({ analyticsStore: () => store });
  const response = await api(new Request(`${ORIGIN}/api/analytics/overview?days=30`), { DATABASE_URL: DSN });
  assert.equal(response.status, 200);
  const { overview } = (await response.json()) as {
    overview: Record<string, unknown> & {
      accounts: { total: number };
      visits: { planted: { current: number }; took: { current: number } };
      series: { foundings: unknown; took: number[] };
      players: { week: { current: number } };
    };
  };
  assert.equal(overview.accounts.total, 2);
  assert.deepEqual([overview.visits.planted.current, overview.visits.took.current], [1, 1]);
  assert.equal(overview.players.week.current, 1);
  assert.equal(overview.founded, null);
  assert.equal(overview.photoChecks, null);
  assert.deepEqual(overview.rejectionFlags, []);
  assert.equal(overview.series.foundings, null);
  assert.equal(
    overview.series.took.reduce((sum, value) => sum + value, 0),
    1,
  );
  assert.deepEqual(overview.unavailable, ["founders not deployed"]);
});

test("accounts and events load, with scores from game_001 and no founded count", { skip: !DSN }, async () => {
  const api = createDashboardApi({ analyticsStore: () => store });
  const list = await api(new Request(`${ORIGIN}/api/analytics/accounts`), { DATABASE_URL: DSN });
  assert.equal(list.status, 200);
  const { accounts, unavailable } = (await list.json()) as { accounts: AccountRow[]; unavailable: string[] };
  assert.deepEqual(unavailable, ["founders not deployed"]);
  const scores = (await pool.query("SELECT account_id::text, score, parks_held FROM kip_game.player_scores($1)", [now.toISOString()])).rows;
  for (const score of scores) {
    const row = accounts.find((item) => item.id === score.account_id)!;
    assert.deepEqual([row.score, row.parksHeld, row.foundedParks], [score.score, score.parks_held, null]);
  }
  const detail = await api(new Request(`${ORIGIN}/api/analytics/accounts/${ids.ben}`), { DATABASE_URL: DSN });
  assert.equal(detail.status, 200);
  assert.equal(((await detail.json()) as { account: { founded: unknown } }).account.founded, null);
  const events = await api(new Request(`${ORIGIN}/api/analytics/events?from=${encodeURIComponent(ago(30 * DAY))}`), { DATABASE_URL: DSN });
  assert.equal(events.status, 200);
  const page = (await events.json()) as { events: { type: string }[]; unavailable: string[] };
  assert.deepEqual(
    page.events.map((event) => event.type),
    ["flag_taken"],
  );
  assert.deepEqual(page.unavailable, ["founders not deployed"]);
});

test("once founders_001 arrives, the founder tiles come back after the cache expires", { skip: !DSN }, async () => {
  await pool.query(await readFile(new URL(FOUNDERS, ROOT), "utf8"));
  assert.deepEqual(await store.features(), { founders: false }, "cached for a minute");
  clearFeatureCache();
  const overview = await store.overview(now, 7);
  assert.deepEqual(overview.founded, { total: 0, new7: 0, period: { current: 0, previous: 0 } });
  assert.deepEqual(overview.unavailable, []);
});

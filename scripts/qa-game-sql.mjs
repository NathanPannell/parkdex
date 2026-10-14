import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// The flag game against real PostgreSQL. A few visits are recorded under game_001's day rules
// first, then game_002_points.sql runs and the game's migrations replay in inventory order the way
// every deploy does, so the history keeps what it was paid and is re-scored in hours. Crews
// (game_003_crews.sql, #170) replay with them. Runs in its own throwaway kip_qa_ database, so the
// history step always starts without game_002. Only the migrations the game needs run: the content
// migrations would require boundaries and drive rows for every synthetic park. The interactions
// migrations are there for the analytics event checks that game_003 widens.
const shared = process.env.PGDATABASE;
assert.ok(shared?.startsWith('kip_qa_') || shared === 'kip_accounts_qa', 'SQL QA requires a dedicated kip_qa_ database');
const owned = `kip_qa_game_${randomBytes(8).toString('hex')}`;
const admin = new pg.Client({ host: process.env.PGHOST, port: Number(process.env.PGPORT), user: process.env.PGUSER, password: process.env.PGPASSWORD, database: shared });
await admin.connect();
await admin.query(`CREATE DATABASE "${owned}"`);
process.env.PGDATABASE = owned;
const { applyMigration, dbUrl, pool } = await import('./qa-postgres-adapter.mjs');
const { createNeonGameStore } = await import('../worker/game-store.ts');
const { flagSeedFor } = await import('../worker/game.ts');

const root = new URL('../', import.meta.url);
const POINTS_MIGRATION = 'database/migrations/game_002_points.sql';
const CREWS_MIGRATION = 'database/migrations/game_003_crews.sql';
const GAME_MIGRATIONS = new Set([
  'database/migrations/accounts_001_init.sql', 'database/migrations/progress_001_init.sql', 'database/001_cloud_content.sql',
  'database/migrations/interactions_001_init.sql', 'database/migrations/interactions_002_db_events.sql',
  'database/migrations/park_proposals_001_init.sql', 'database/migrations/game_001_init.sql', 'database/migrations/founders_001_init.sql',
  POINTS_MIGRATION, CREWS_MIGRATION,
]);
const suffix = randomUUID().replaceAll('-', '').slice(0, 6);
const store = createNeonGameStore(dbUrl);
const log = (name) => process.stdout.write(`${name}: PASS\n`);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// 10:00 in Victoria (PDT), so whole-day offsets stay on distinct local days.
const T0 = Date.parse('2026-06-01T17:00:00.000Z');
const at = (offsetMs) => new Date(T0 + offsetMs).toISOString();
const park = (name) => `qa-game-${suffix}-${name}`;
const PARKS = ['history', 'plant', 'take', 'take0', 'take1', 'take10', 'hours', 'daily', 'fall', 'revisit', 'replay', 'import', 'race', 'delete', 'found',
  'crew', 'crewfull', 'crewexpired', 'crewfall', 'crewrace', 'crewreplay', 'crewother', 'crewmisc'];

async function account(name, { handle = true } = {}) {
  const id = randomUUID();
  await pool.query('INSERT INTO kip_account.accounts (id, normalized_email, password_hash) VALUES ($1, $2, $3)', [id, `game-${name}-${suffix}@example.test`, 'qa-hash']);
  if (handle) await pool.query('INSERT INTO kip_game.players (account_id, handle, flag_seed, created_at) VALUES ($1, $2, kip_game.flag_seed($1), $3)', [id, `qa${suffix}_${name}`, at(-DAY)]);
  return id;
}

async function visit(accountId, parkId, offsetMs, visitId = randomUUID()) {
  const { rows } = await pool.query('SELECT kip_game.record_visit($1, $2, $3, $4) AS result', [visitId, accountId, parkId, at(offsetMs)]);
  return { visitId, ...rows[0].result };
}

async function join(accountId, code, offsetMs, visitId = randomUUID()) {
  const { rows } = await pool.query('SELECT kip_game.join_crew($1, $2, $3, $4) AS result', [accountId, code, visitId, at(offsetMs)]);
  return { visitId, ...rows[0].result };
}

const crewCode = async (parkId) => value(`
  SELECT c.code FROM kip_game.crew_codes c JOIN kip_game.tenures t ON t.tenure_id = c.tenure_id
  WHERE t.park_id = $1 AND t.ended_at IS NULL`, [parkId]);

async function score(accountId, offsetMs) {
  const { rows } = await pool.query('SELECT score, parks_held FROM kip_game.player_scores($1) WHERE account_id = $2', [at(offsetMs), accountId]);
  return rows[0] ? { score: rows[0].score, parksHeld: rows[0].parks_held } : null;
}

async function flagUp(parkId, offsetMs) {
  const { rows } = await pool.query('SELECT handle, since FROM kip_game.flags_up($1) WHERE park_id = $2', [at(offsetMs), parkId]);
  return rows[0] ?? null;
}

async function count(sql, params) {
  return Number((await pool.query(sql, params)).rows[0].count);
}

async function value(sql, params = []) {
  return Object.values((await pool.query(sql, params)).rows[0])[0];
}

const holdingPoints = async (parkId, holder, offsetMs) => value(
  'SELECT kip_game.holding_points(started_at, last_visit_at, ended_at, $3) FROM kip_game.tenures WHERE park_id = $1 AND holder_account_id = $2',
  [parkId, holder, at(offsetMs)],
);

try {
  const config = JSON.parse(readFileSync(new URL('deployment.json', root), 'utf8'));
  const full = [config.migrationPath, ...config.contentSync.supportingMigrationPaths, ...config.optionalMigrationPaths, ...config.contentSync.migrationPaths, ...config.independentMigrationPaths];
  // Later game migrations add themselves to GAME_MIGRATIONS when they build on these functions.
  const inventory = full.filter((path) => GAME_MIGRATIONS.has(path));
  assert.equal(inventory.length, GAME_MIGRATIONS.size, 'every game migration is in deployment.json');
  const position = (name) => inventory.indexOf(`database/migrations/${name}`);
  // game_002 must replay after game_001 and founders_001, whose functions it redefines.
  assert.ok(position('game_002_points.sql') > position('game_001_init.sql') && position('game_002_points.sql') > position('founders_001_init.sql'));
  // game_003 redefines game_002's functions, so it must replay after it.
  assert.ok(position('game_003_crews.sql') > position('game_002_points.sql'));
  const apply = async (paths) => { for (const path of paths) await applyMigration(fileURLToPath(new URL(path, root))); };
  await apply(inventory.slice(0, inventory.indexOf(POINTS_MIGRATION)));
  for (const name of PARKS) {
    await pool.query(`
      INSERT INTO public.parks (id, name, short, category, region, lat, lng, biome, shape, rarity, scene, seed, blurb)
      VALUES ($1, $2, 'QA', 'community', 'QA', 48.4, -123.4, 'forest', 'circle', 'common', NULL, 1, 'Synthetic QA park.')
      ON CONFLICT (id) DO NOTHING`, [park(name), `QA ${name}`]);
  }

  // History under game_001: a plant that paid nothing and a take that paid its 3 days.
  const old = await account('old');
  const taker = await account('tk');
  await visit(old, park('history'), 0);
  const historicTake = await visit(taker, park('history'), 3 * DAY + HOUR);
  assert.equal(historicTake.visit.pointsEarned, 3);
  assert.equal((await score(old, 3 * DAY + HOUR)).score, 3, 'game_001 pays whole days');

  await apply([POINTS_MIGRATION]);
  // Every deploy replays the inventory: game_001 and founders_001 run again before game_002.
  await apply(inventory);
  await apply(inventory);
  assert.equal(await value('SELECT kip_founders.bonus_points()'), 24);
  assert.equal(await value("SELECT kip_game.holding_points($1, $1, NULL, $2)", [at(0), at(DAY)]), 24, 'game_002 wins the replay');
  assert.equal(await value("SELECT kip_game.visit_base_points('joined')"), 2, 'game_003 wins the replay');
  assert.equal(await value("SELECT kip_game.visit_base_points('logged')"), 1);
  // game_001's replay must not bring back its one-visit-a-day index: the flag action index holds its name.
  const indexes = Object.fromEntries((await pool.query(
    "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'kip_game' AND tablename = 'visits' AND indexdef LIKE '%local_day%'",
  )).rows.map((row) => [row.indexname, row.indexdef]));
  assert.deepEqual(Object.keys(indexes).sort(), ['visits_one_logged_per_park_per_day_idx', 'visits_one_per_park_per_day_idx']);
  assert.match(indexes.visits_one_per_park_per_day_idx, /outcome <> 'logged'/);
  assert.match(indexes.visits_one_logged_per_park_per_day_idx, /outcome = 'logged'/);
  assert.match(await value("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'visits_outcome_check'"), /joined.*logged/);
  assert.deepEqual(
    (await pool.query("SELECT outcome, points_earned, day_bonus FROM kip_game.visits WHERE park_id = $1 ORDER BY visited_at", [park('history')])).rows,
    [{ outcome: 'planted', points_earned: 0, day_bonus: 0 }, { outcome: 'took', points_earned: 3, day_bonus: 3 }],
  );
  const historicReplay = await visit(taker, park('history'), 4 * DAY, historicTake.visitId);
  assert.equal(historicReplay.status, 'replayed');
  assert.deepEqual(historicReplay.visit.pointsBreakdown, { base: 0, days: 3 }, 'a historic take keeps its stored day bonus');
  // Old holder: 73 hours held, no stored bonus. Taker: the 3 stored points plus 47 hours.
  assert.equal((await score(old, 5 * DAY)).score, 73);
  assert.equal((await score(taker, 5 * DAY)).score, 3 + 47);
  log('history keeps its stored points and is re-scored in hours after the migration replays');

  // Analytics event checks: game_003 only adds the crew types, keeping everyone else's.
  const typeCheck = async () => value("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'events_event_type_v2_check'");
  const shapeCheck = async () => value("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'events_shape_v2_check'");
  for (const type of ['crew_joined', 'crew_code_shown', 'visit_logged_protected', 'park_founded', 'flag_taken', 'db_read', 'park_viewed']) {
    assert.ok((await typeCheck()).includes(`'${type}'`), type);
  }
  const serverEvent = (type, route = 'POST /api/game/crews/join') => pool.query(
    `INSERT INTO kip_analytics.events (event_id, event_type, environment, schema_version, route, request_id, occurred_at, properties)
     VALUES ($1, $2, 'preview', 1, $3, $4, now(), '{"crew_size": 2}')`, [randomUUID(), type, route, randomUUID()]);
  for (const type of ['crew_joined', 'crew_code_shown', 'visit_logged_protected', 'flag_taken']) await serverEvent(type);
  await assert.rejects(serverEvent('crew_joined', null), /events_shape_v2_check/, 'crew events still need the request fields');
  await assert.rejects(serverEvent('crew_left'), /events_event_type_v2_check/);
  // A parallel migration that rewrites the full lists without the crew types, in either order:
  // the next replay adds the crew types back and keeps the other migration's type.
  const checksBefore = { type: await typeCheck(), shape: await shapeCheck() };
  await pool.query(`ALTER TABLE kip_analytics.events DROP CONSTRAINT events_event_type_v2_check,
    ADD CONSTRAINT events_event_type_v2_check CHECK (event_type IN ('db_read', 'db_write', 'park_viewed', 'directions_opened', 'park_claimed',
      'flag_planted', 'flag_taken', 'flag_held', 'visit_already_today', 'flag_fell', 'leaderboard_viewed', 'takeover_message_seen', 'handle_set',
      'park_founded', 'founder_photo_checked', 'qa_parallel_badge')) NOT VALID`);
  await apply(inventory);
  const merged = await typeCheck();
  for (const type of ['crew_joined', 'crew_code_shown', 'visit_logged_protected', 'qa_parallel_badge', 'park_founded']) assert.ok(merged.includes(`'${type}'`), type);
  await apply(inventory);
  assert.equal(await typeCheck(), merged, 'a replay changes nothing once every type is there');
  assert.equal(await shapeCheck(), checksBefore.shape, 'the shape check is not touched while it has the crew types');
  await serverEvent('crew_joined');
  log('crew analytics types are added to the event checks without dropping other migrations\' types');

  const a = await account('a');
  const b = await account('b');
  const c = await account('c');
  const d = await account('d');
  const noHandle = await account('n', { handle: false });

  assert.equal(await value('SELECT kip_game.flag_seed($1)', [a]), await flagSeedFor(a));
  assert.equal((await value("SELECT kip_game.local_day('2026-06-02T06:30:00Z')")).toISOString().slice(0, 10), '2026-06-01');
  log('flag seed matches the worker and local day uses America/Vancouver');

  assert.equal((await visit(noHandle, park('plant'), 0)).status, 'handle_required');
  assert.equal((await visit(a, `qa-game-${suffix}-missing`, 0)).status, 'park_not_found');
  assert.equal(await count('SELECT count(*) FROM kip_game.visits WHERE account_id = $1', [noHandle]), 0);
  log('visits need a handle and a catalogue park');

  for (const [from, to, hours] of [[0, 59 * MINUTE, 0], [0, 60 * MINUTE, 1], [0, 25 * HOUR, 25], [0, HOUR - 1, 0], [HOUR, 0, 0]]) {
    assert.equal(await value('SELECT kip_game.whole_hours($1, $2)', [at(from), at(to)]), hours, `${from} to ${to}`);
  }
  const hourly = await account('h');
  await visit(hourly, park('hours'), 0);
  assert.equal((await score(hourly, 59 * MINUTE)).score, 6, '59 minutes is the plant bonus only');
  assert.equal((await score(hourly, 60 * MINUTE)).score, 7);
  assert.equal((await score(hourly, 25 * HOUR)).score, 6 + 25);
  log('holding pays one point per whole hour');

  const planted = await visit(a, park('plant'), 0);
  assert.equal(planted.status, 'recorded');
  assert.equal(planted.visit.outcome, 'planted');
  assert.equal(planted.visit.pointsEarned, 6);
  assert.deepEqual(planted.visit.pointsBreakdown, { base: 6, days: 0 });
  assert.equal(planted.visit.previousHolder, null);
  assert.equal(new Date(planted.visit.flagSince).toISOString(), at(0));
  assert.equal((await flagUp(park('plant'), HOUR)).handle, `qa${suffix}_a`);
  assert.equal((await score(a, 2.9 * DAY)).score, 6 + 69);
  assert.equal((await score(a, 3 * DAY + HOUR)).score, 6 + 73);
  assert.equal((await score(a, 3 * DAY + HOUR)).parksHeld, 1);
  log('planting an empty park pays 6 and then the hours');

  await visit(a, park('take'), 0);
  const took = await visit(b, park('take'), 5 * DAY + 2 * HOUR);
  assert.equal(took.visit.outcome, 'took');
  assert.equal(took.visit.pointsEarned, 4 + 5, 'a take pays 4 plus the flag age in whole days');
  assert.deepEqual(took.visit.pointsBreakdown, { base: 4, days: 5 });
  assert.equal(took.visit.previousHolder.handle, `qa${suffix}_a`);
  assert.equal(took.visit.previousHolder.flagSeed, await flagSeedFor(a));
  assert.equal(await value('SELECT bounty_points FROM kip_game.tenures WHERE park_id = $1 AND ended_at IS NULL', [park('take')]), 9);
  assert.equal((await flagUp(park('take'), 6 * DAY)).handle, `qa${suffix}_b`);
  // A keeps 122 hours and the plant bonus on the taken park, plus 240 hours and the bonus on the planted park.
  assert.equal((await score(a, 10 * DAY)).score, (6 + 122) + (6 + 240));
  // B: 9 for the take plus floor((10d - 5d2h) / 1h) = 118 hours.
  assert.equal((await score(b, 10 * DAY)).score, 9 + 118);
  const summary = await store.summary(a, at(10 * DAY));
  assert.deepEqual(summary.takeovers.map((row) => [row.parkId, row.byHandle]), [[park('take'), `qa${suffix}_b`]]);
  assert.deepEqual(summary.parks.map((row) => [row.parkId, row.days, row.hours]), [[park('plant'), 10, 240]]);
  assert.equal(summary.score, (await score(a, 10 * DAY)).score);
  await store.markTakeoversSeen(a, at(6 * DAY));
  assert.equal((await store.summary(a, at(10 * DAY))).takeovers.length, 0);
  await store.markTakeoversSeen(a, at(1 * DAY));
  assert.equal((await store.summary(a, at(10 * DAY))).takeovers.length, 0, 'the seen marker never moves backwards');
  log('taking pays 4 plus the flag age and the old holder keeps their points');

  const planter = await account('p');
  const raider = await account('r');
  for (const [name, offset, days] of [['take0', 2 * HOUR, 0], ['take1', DAY + HOUR, 1], ['take10', 10 * DAY + HOUR, 10]]) {
    await visit(planter, park(name), 0);
    const result = await visit(raider, park(name), offset);
    assert.equal(result.visit.outcome, 'took', name);
    assert.equal(result.visit.pointsEarned, 4 + days, name);
    assert.deepEqual(result.visit.pointsBreakdown, { base: 4, days }, name);
  }
  log('a take after 0, 1 and 10 days pays 4, 5 and 14');

  await visit(c, park('daily'), 0);
  const second = await visit(c, park('daily'), 3 * HOUR);
  assert.equal(second.status, 'already_today');
  assert.equal(second.visit.outcome, 'already_today');
  assert.equal(second.visit.pointsEarned, 0);
  assert.deepEqual(second.visit.pointsBreakdown, { base: 0, days: 0 });
  assert.equal(await count("SELECT count(*) FROM kip_game.visits WHERE account_id = $1 AND park_id = $2", [c, park('daily')]), 1);
  // 23:30 local is still the same day; 00:30 is the next one.
  assert.equal((await visit(c, park('daily'), 13.5 * HOUR)).status, 'already_today');
  const nextDay = await visit(c, park('daily'), 14.5 * HOUR);
  assert.equal(nextDay.status, 'recorded');
  assert.equal(nextDay.visit.outcome, 'held');
  assert.equal(nextDay.visit.pointsEarned, 1, 'visiting your own flag pays 1');
  assert.deepEqual(nextDay.visit.pointsBreakdown, { base: 1, days: 0 });
  assert.equal((await visit(c, park('daily'), 15 * HOUR)).status, 'already_today');
  assert.equal(await value("SELECT sum(points_earned) FROM kip_game.visits WHERE account_id = $1 AND park_id = $2", [c, park('daily')]), '7');
  log('one visit per account, park and local day; a held visit pays 1');

  // 23:00 local still counts the morning visit; 00:24 the next day is before that day's 00:30 visit.
  assert.deepEqual((await store.summary(c, at(13 * HOUR))).visitedToday, [park('daily')]);
  assert.deepEqual((await store.summary(c, at(14.4 * HOUR))).visitedToday, []);
  assert.deepEqual((await store.summary(c, at(15 * HOUR))).visitedToday, [park('daily')]);
  assert.deepEqual((await store.summary(b, at(15 * HOUR))).visitedToday, [], 'only the reading account counts');
  // June 1 ends at midnight PDT, 07:00 UTC on June 2, whatever the session time zone.
  assert.equal((await store.summary(c, at(13 * HOUR))).visitedTodayUntil, '2026-06-02T07:00:00.000Z');
  assert.equal((await store.summary(c, at(15 * HOUR))).visitedTodayUntil, '2026-06-03T07:00:00.000Z');
  log('me lists the parks already visited today');

  const faller = await account('f');
  await visit(faller, park('fall'), 0);
  assert.ok(await flagUp(park('fall'), 30 * DAY - 1000));
  assert.equal(await flagUp(park('fall'), 30 * DAY), null);
  assert.equal(await holdingPoints(park('fall'), faller, 40 * DAY), 720);
  assert.equal((await score(faller, 30 * DAY)).score, 6 + 720);
  assert.equal((await score(faller, 40 * DAY)).score, 6 + 720, 'a fallen flag stops accruing');
  assert.equal((await score(faller, 40 * DAY)).parksHeld, 0);
  const afterFall = await visit(d, park('fall'), 31 * DAY);
  assert.equal(afterFall.visit.outcome, 'planted');
  assert.equal(afterFall.visit.pointsEarned, 6, 'planting over a fallen flag is a plant, not a take');
  assert.equal(afterFall.visit.fell, true);
  const fallen = (await pool.query("SELECT ended_at, end_reason FROM kip_game.tenures WHERE park_id = $1 AND holder_account_id = $2", [park('fall'), faller])).rows[0];
  assert.equal(fallen.end_reason, 'fell');
  assert.equal(fallen.ended_at.toISOString(), at(30 * DAY));
  assert.equal((await score(faller, 50 * DAY)).score, 6 + 720);
  log('a flag falls 30 days after the last holder visit and stops accruing');

  await visit(c, park('revisit'), 0);
  const held = await visit(c, park('revisit'), 20 * DAY);
  assert.equal(held.visit.outcome, 'held');
  assert.equal(held.visit.pointsEarned, 1);
  assert.equal(new Date(held.visit.flagSince).toISOString(), at(0), 'a revisit keeps the flag age');
  assert.equal((await flagUp(park('revisit'), 45 * DAY)).handle, `qa${suffix}_c`);
  assert.equal(new Date((await flagUp(park('revisit'), 45 * DAY)).since).toISOString(), at(0));
  assert.equal(await flagUp(park('revisit'), 50 * DAY), null);
  assert.equal(await holdingPoints(park('revisit'), c, 45 * DAY), 45 * 24);
  assert.equal(await holdingPoints(park('revisit'), c, 60 * DAY), 50 * 24);
  log('a holder revisit restarts the fall timer but not the age');

  const founder = await account('fd');
  const before = (await score(founder, DAY)).score;
  const photo = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  await pool.query(`
    INSERT INTO kip_founders.parks (park_id, account_id, attempt_id, founded_at, source, photo_sha256, photo_bytes, photo_width, photo_height, moderation)
    VALUES ($1, $2, $3, $4, 'existing', $5, $6, 1, 1, '{}')`, [park('found'), founder, randomUUID(), at(0), createHash('sha256').update(photo).digest('hex'), photo]);
  const founding = await visit(founder, park('found'), 0);
  assert.equal(founding.visit.pointsEarned, 6);
  assert.equal((await score(founder, DAY)).score, before + 24 + 6 + 24, 'founder bonus, plant bonus and 24 hours');
  assert.equal(await store.founderPoints(founder, at(DAY)), 24);
  log('founder points stay in the score, now 24');

  const first = await visit(d, park('replay'), 0);
  const replay = await visit(d, park('replay'), 2 * DAY, first.visitId);
  assert.equal(replay.status, 'replayed');
  assert.deepEqual(replay.visit, first.visit);
  assert.equal((await visit(d, park('plant'), 2 * DAY, first.visitId)).status, 'conflict');
  assert.equal(await count('SELECT count(*) FROM kip_game.visits WHERE account_id = $1 AND visit_id = $2', [d, first.visitId]), 1);
  log('replaying a visit ID returns the stored result');

  const claimId = randomUUID();
  const snapshot = { id: park('import'), name: 'QA import' };
  await pool.query(`
    INSERT INTO kip_account.claims (account_id, claim_id, park_id, claimed_at, park_snapshot, sync_revision, payload_hash)
    VALUES ($1, $2, $3, $4, $5, nextval('kip_account.progress_change_seq'), $6)`, [a, claimId, park('import'), at(HOUR), JSON.stringify(snapshot), 'a'.repeat(64)]);
  await apply(inventory);
  await apply(inventory);
  assert.equal(await count("SELECT count(*) FROM kip_game.visits WHERE account_id = $1 AND source = 'claim_import' AND park_id = $2", [a, park('import')]), 1);
  assert.equal(await count('SELECT count(*) FROM kip_game.tenures WHERE park_id = $1', [park('import')]), 0);
  assert.equal(await flagUp(park('import'), 2 * HOUR), null);
  const sameDay = await visit(a, park('import'), 2 * HOUR, claimId);
  assert.equal(sameDay.visit.outcome, 'planted', 'an imported claim never blocks a real visit, even with the same ID');
  log('claims import as history only, idempotently');

  const racers = await Promise.all(Array.from({ length: 8 }, (_, index) => account(`r${index}`)));
  const results = await Promise.all(racers.map((id) => visit(id, park('race'), DAY)));
  assert.equal(results.filter((row) => row.visit.outcome === 'planted').length, 1);
  // Everyone after the first lands inside the planter's protected hour (#170).
  assert.equal(results.filter((row) => row.visit.outcome === 'logged').length, 7);
  assert.equal(await count('SELECT count(*) FROM kip_game.tenures WHERE park_id = $1 AND ended_at IS NULL', [park('race')]), 1);
  assert.equal(await count('SELECT count(*) FROM kip_game.tenures WHERE park_id = $1', [park('race')]), 1);
  // After the hour, the same day: one take wins, and its own hour covers the rest, who already logged today.
  const later = await Promise.all(racers.map((id) => visit(id, park('race'), DAY + 2 * HOUR)));
  assert.equal(later.filter((row) => row.visit.outcome === 'took').length, 1);
  assert.equal(later.filter((row) => row.status === 'already_today').length, 7);
  assert.equal(await count('SELECT count(*) FROM kip_game.tenures WHERE park_id = $1', [park('race')]), 2);
  const sameId = randomUUID();
  const repeats = await Promise.all(Array.from({ length: 6 }, () => visit(racers[0], park('race'), 2 * DAY, sameId)));
  assert.equal(repeats.filter((row) => row.status === 'recorded').length, 1);
  assert.equal(repeats.filter((row) => row.status === 'replayed').length, 5);
  log('concurrent visits to one park serialise');

  // Crews (#170).
  const lead = await account('cl');
  const outsider = await account('co');
  const mates = await Promise.all(Array.from({ length: 9 }, (_, index) => account(`cm${index}`)));
  const leadHandle = `qa${suffix}_cl`;

  const plantedCrew = await visit(lead, park('crew'), 0);
  assert.equal(plantedCrew.visit.outcome, 'planted');
  assert.equal(plantedCrew.visit.protected, null);
  const code = await crewCode(park('crew'));
  assert.match(code, /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);
  assert.equal(await value('SELECT expires_at FROM kip_game.crew_codes WHERE code = $1', [code]).then((date) => date.toISOString()), at(HOUR));
  assert.deepEqual((await pool.query('SELECT account_id, joined_at FROM kip_game.crew_members m JOIN kip_game.tenures t USING (tenure_id) WHERE t.park_id = $1', [park('crew')])).rows,
    [{ account_id: lead, joined_at: new Date(at(0)) }], 'the planter is the first member');
  log('planting starts a protected hour with a 6-character crew code and the planter as first member');

  // An outsider during the hour logs a visit, then takes after the hour on the same day.
  const logged = await visit(outsider, park('crew'), 20 * MINUTE);
  assert.equal(logged.status, 'protected');
  assert.equal(logged.visit.outcome, 'logged');
  assert.equal(logged.visit.pointsEarned, 1);
  assert.deepEqual(logged.visit.pointsBreakdown, { base: 1, days: 0 });
  assert.equal(logged.visit.flagSince, null);
  assert.equal(new Date(logged.visit.protected.until).toISOString(), at(HOUR));
  assert.deepEqual(logged.visit.protected.leader, { handle: leadHandle, flagSeed: await flagSeedFor(lead) });
  assert.equal(logged.visit.protected.crewSize, 1);
  assert.equal((await flagUp(park('crew'), 30 * MINUTE)).handle, leadHandle, 'a logged visit leaves the flag alone');
  const againLogged = await visit(outsider, park('crew'), 40 * MINUTE);
  assert.equal(againLogged.status, 'already_today', 'one logged visit a day');
  assert.equal(againLogged.visit.protected.leader.handle, leadHandle);
  const outsiderToday = await store.summary(outsider, at(45 * MINUTE));
  assert.deepEqual([outsiderToday.visitedToday, outsiderToday.loggedToday], [[], [park('crew')]], 'a logged visit does not use up the flag action');
  assert.equal((await score(outsider, 45 * MINUTE)).score, 1);
  const storeLogged = await store.recordVisit(outsider, randomUUID(), park('crew'), at(50 * MINUTE));
  assert.equal(storeLogged.status, 'already_today');
  assert.equal(storeLogged.visit.protected.crewSize, 1);
  log('an outsider during the hour logs a visit for +1 and leaves the flag');

  // Members join with the code: +2 each, and the 9th person is refused.
  const joins = [];
  for (const [index, mate] of mates.slice(0, 7).entries()) joins.push(await join(mate, code.toUpperCase(), (21 + index) * MINUTE));
  assert.deepEqual(joins.map((row) => row.status), Array(7).fill('joined'));
  assert.equal(joins[0].visit.outcome, 'joined');
  assert.equal(joins[0].visit.pointsEarned, 2);
  assert.equal(new Date(joins[0].visit.flagSince).toISOString(), at(0));
  const fullCrew = joins[6].crew;
  assert.equal(fullCrew.size, 8);
  assert.equal(fullCrew.cap, 8);
  assert.equal(fullCrew.leader.handle, leadHandle);
  assert.equal(fullCrew.members[0].leader, true);
  assert.deepEqual(fullCrew.members.slice(1).map((member) => member.handle), mates.slice(0, 7).map((_, index) => `qa${suffix}_cm${index}`));
  assert.equal(fullCrew.member, true);
  assert.equal(fullCrew.code, code, 'members see the code during the hour');
  assert.equal((await join(mates[7], code, 30 * MINUTE)).status, 'crew_full');
  assert.equal((await join(mates[0], code, 31 * MINUTE)).status, 'already_member');
  assert.equal((await join(lead, code, 31 * MINUTE)).status, 'already_member', 'the leader is a member');
  assert.equal((await join(mates[8], 'ZZZZZZ', 31 * MINUTE)).status, 'code_not_found');
  assert.equal((await join(noHandle, code, 31 * MINUTE)).status, 'handle_required');
  const leaving = await account('cdel');
  await pool.query("UPDATE kip_account.accounts SET deletion_state = 'deleting' WHERE id = $1", [leaving]);
  assert.equal((await join(leaving, code, 31 * MINUTE)).status, 'account_unavailable');
  // The outsider logged a visit earlier today: joining is still allowed, but not for this full crew.
  assert.equal((await join(outsider, code, 32 * MINUTE)).status, 'crew_full');
  assert.equal(await count('SELECT count(*) FROM kip_game.crew_members m JOIN kip_game.tenures t USING (tenure_id) WHERE t.park_id = $1', [park('crew')]), 8);
  log('joining pays 2, members see the code, and the 9th joiner is refused');

  const asOutsider = await store.parkCrew(park('crew'), outsider, at(33 * MINUTE));
  assert.equal(asOutsider.member, false);
  assert.equal(asOutsider.code, null, 'only members get the code');
  assert.equal(asOutsider.protectedUntil, at(HOUR));
  assert.equal(asOutsider.size, 8);
  const asMember = await store.parkCrew(park('crew'), mates[3], at(33 * MINUTE));
  assert.equal(asMember.code, code);
  assert.equal(asMember.codeExpiresAt, at(HOUR));
  assert.equal((await store.parkCrew(park('crew'), mates[3], at(HOUR))).code, null, 'the code ends with the hour');
  assert.equal(await store.parkCrew(park('crewother'), lead, at(0)), null);
  const pin = (await store.flags(at(33 * MINUTE))).find((flag) => flag.parkId === park('crew'));
  assert.deepEqual(pin.crew, { size: 8, memberSeeds: await Promise.all(mates.slice(0, 3).map(flagSeedFor)), protectedUntil: at(HOUR) });
  assert.equal((await store.flags(at(2 * HOUR))).find((flag) => flag.parkId === park('crew')).crew.protectedUntil, null);
  log('crew details and map pins list the crew, and only members see the code');

  // Members hold the park: parks held, hours from their own joined_at and Your Parks.
  const mateScore = await score(mates[0], 21 * MINUTE + 2 * HOUR);
  assert.deepEqual(mateScore, { score: 2 + 2, parksHeld: 1 }, 'join bonus plus two whole hours from joining');
  const mateSummary = await store.summary(mates[0], at(3 * HOUR));
  assert.deepEqual(mateSummary.parks.map((row) => [row.parkId, row.hours, row.crew]), [[park('crew'), 2, { size: 8, leader: false, protectedUntil: null }]]);
  assert.equal(new Date(mateSummary.parks[0].since).toISOString(), at(0), 'since is the flag age, for weathering');
  assert.deepEqual(mateSummary.visitedToday, [park('crew')], 'joining is the day\'s flag action');
  assert.deepEqual((await store.summary(lead, at(30 * MINUTE))).parks[0].crew, { size: 8, leader: true, protectedUntil: at(HOUR) });
  assert.equal((await score(lead, 3 * HOUR)).parksHeld, 1);
  assert.equal((await visit(mates[0], park('crew'), 3 * HOUR)).status, 'already_today', 'a member who joined today already had the flag action');
  log('crew members hold the park from their joined_at');

  // After the hour, the same day: the outsider takes. Every member's holding ends with it.
  const sameDayTake = await visit(outsider, park('crew'), HOUR + 5 * MINUTE);
  assert.equal(sameDayTake.status, 'recorded');
  assert.equal(sameDayTake.visit.outcome, 'took');
  assert.equal(sameDayTake.visit.pointsEarned, 4);
  assert.equal(sameDayTake.visit.previousHolder.handle, leadHandle);
  assert.equal(sameDayTake.visit.protected, null);
  assert.equal((await visit(outsider, park('crew'), HOUR + 10 * MINUTE)).status, 'already_today');
  assert.equal((await flagUp(park('crew'), 2 * HOUR)).handle, `qa${suffix}_co`);
  for (const mate of mates.slice(0, 7)) {
    assert.equal((await score(mate, 10 * DAY)).parksHeld, 0);
    assert.equal((await store.summary(mate, at(2 * HOUR))).parks.length, 0);
  }
  assert.equal((await score(lead, 10 * DAY)).parksHeld, 0);
  // mates[6] joined at 27 minutes: no whole hour before the take at 65 minutes.
  assert.equal((await score(mates[6], 10 * DAY)).score, 2);
  assert.equal((await score(mates[0], 10 * DAY)).score, 2 + 0, 'joined at 21 minutes, taken at 65: no whole hour');
  assert.equal((await score(lead, 10 * DAY)).score, 6 + 1, 'the leader held for 65 minutes');
  assert.deepEqual((await store.summary(mates[2], at(2 * HOUR))).takeovers.map((row) => [row.parkId, row.byHandle]), [[park('crew'), `qa${suffix}_co`]],
    'members hear about the take too');
  const newCrew = await store.parkCrew(park('crew'), outsider, at(HOUR + 6 * MINUTE));
  assert.equal(newCrew.size, 1);
  assert.equal(newCrew.protectedUntil, at(2 * HOUR + 5 * MINUTE), 'the taker gets their own protected hour');
  assert.notEqual(newCrew.code, code);
  assert.equal((await join(mates[8], code, HOUR + 7 * MINUTE)).status, 'code_expired', 'a taken crew\'s code is over');
  assert.equal((await visit(lead, park('crew'), HOUR + 8 * MINUTE)).status, 'already_today', 'the old leader planted today');
  log('an outsider takes after the hour on the same day and the take ends every member\'s holding');

  // An expired code is refused.
  const expiredLead = await account('ce');
  await visit(expiredLead, park('crewexpired'), 0);
  const expiredCode = await crewCode(park('crewexpired'));
  assert.equal((await join(mates[8], expiredCode, HOUR)).status, 'code_expired');
  assert.equal((await join(mates[8], expiredCode, HOUR - 1000)).status, 'joined');
  log('a code is valid until the hour ends and refused from then on');

  // A member's revisit counts as held and restarts the fall for everyone.
  const fallLead = await account('cf');
  const fallMate = await account('cg');
  await visit(fallLead, park('crewfall'), 0);
  await join(fallMate, await crewCode(park('crewfall')), 10 * MINUTE);
  const memberHeld = await visit(fallMate, park('crewfall'), 20 * DAY);
  assert.equal(memberHeld.visit.outcome, 'held');
  assert.equal(memberHeld.visit.pointsEarned, 1);
  assert.equal(new Date(memberHeld.visit.flagSince).toISOString(), at(0), 'a member revisit keeps the flag age');
  assert.ok(await flagUp(park('crewfall'), 45 * DAY), 'the fall restarted at the member\'s visit');
  assert.equal(await flagUp(park('crewfall'), 50 * DAY), null);
  assert.equal((await score(fallLead, 60 * DAY)).score, 6 + 50 * 24, 'the leader holds until the restarted fall');
  assert.equal((await score(fallMate, 60 * DAY)).score, 2 + 1 + 50 * 24 - 1, 'the member holds from joining, 10 minutes in');
  const memberAgain = await visit(fallMate, park('crewfall'), 20 * DAY + HOUR);
  assert.equal(memberAgain.status, 'already_today');
  assert.equal(new Date(memberAgain.visit.flagSince).toISOString(), at(0));
  // Planting over the fallen crew flag is a plant, with a fresh crew.
  const replant = await visit(outsider, park('crewfall'), 51 * DAY);
  assert.equal(replant.visit.outcome, 'planted');
  assert.equal(replant.visit.fell, true);
  assert.equal((await store.parkCrew(park('crewfall'), outsider, at(51 * DAY))).size, 1);
  log('a member revisit counts as held and restarts the 30-day fall');

  // Concurrent joins and outsider visits stay consistent under the park lock.
  const raceLead = await account('crl');
  await visit(raceLead, park('crewrace'), 0);
  const raceCode = await crewCode(park('crewrace'));
  const joiners = await Promise.all(Array.from({ length: 12 }, (_, index) => account(`crj${index}`)));
  const visitors = await Promise.all(Array.from({ length: 4 }, (_, index) => account(`crv${index}`)));
  const twice = await account('crd');
  const twiceId = randomUUID();
  const raced = await Promise.all([
    ...joiners.map((id) => join(id, raceCode, 10 * MINUTE)),
    ...visitors.map((id) => visit(id, park('crewrace'), 10 * MINUTE)),
    // The same join sent three times at once is recorded at most once.
    ...Array.from({ length: 3 }, () => join(twice, raceCode, 10 * MINUTE, twiceId)),
  ]);
  const statuses = raced.map((row) => row.status);
  const twiceJoined = statuses.slice(16).includes('joined');
  assert.equal(statuses.filter((status) => status === 'joined').length, 7, '7 seats after the leader');
  assert.equal(statuses.filter((status) => status === 'replayed').length, twiceJoined ? 2 : 0);
  assert.equal(statuses.filter((status) => status === 'crew_full').length, 15 - 7 - (twiceJoined ? 2 : 0));
  assert.deepEqual(raced.slice(12, 16).map((row) => row.visit.outcome), Array(4).fill('logged'), 'outsiders never take during the hour');
  assert.equal(await value('SELECT kip_game.crew_size(tenure_id) FROM kip_game.tenures WHERE park_id = $1 AND ended_at IS NULL', [park('crewrace')]), 8, 'the cap holds');
  assert.equal(await count('SELECT count(*) FROM kip_game.tenures WHERE park_id = $1', [park('crewrace')]), 1);
  assert.equal(await count("SELECT count(*) FROM kip_game.visits WHERE park_id = $1 AND outcome = 'joined'", [park('crewrace')]), 7);
  assert.equal(await count('SELECT count(*) FROM kip_game.crew_members m JOIN kip_game.tenures t USING (tenure_id) WHERE t.park_id = $1', [park('crewrace')]), 8);
  assert.equal(await count('SELECT count(*) FROM kip_game.visits WHERE account_id = $1', [twice]), twiceJoined ? 1 : 0, 'one visit per join, whatever the race');
  log('concurrent joins and visits stay consistent under the park lock');

  // Replays are safe: same answer, nothing recorded twice, even after the code expired.
  const replayLead = await account('cpl');
  const replayMate = await account('cpm');
  await visit(replayLead, park('crewreplay'), 0);
  const replayCode = await crewCode(park('crewreplay'));
  const firstJoin = await join(replayMate, replayCode, 5 * MINUTE);
  const replayJoin = await join(replayMate, replayCode, 3 * HOUR, firstJoin.visitId);
  assert.equal(replayJoin.status, 'replayed');
  assert.deepEqual(replayJoin.visit, firstJoin.visit);
  const storeReplay = await store.joinCrew(replayMate, replayCode, firstJoin.visitId, at(3 * HOUR));
  assert.equal(storeReplay.status, 'replayed');
  assert.equal(storeReplay.visit.outcome, 'joined');
  assert.deepEqual([storeReplay.crew.size, storeReplay.crew.code, storeReplay.crew.protectedUntil], [2, null, null], 'the code is gone after the hour');
  assert.equal((await store.joinCrew(replayMate, 'ZZZZZZ', randomUUID(), at(3 * HOUR))).status, 'code_not_found');
  assert.equal((await join(replayMate, newCrew.code, 5 * MINUTE, firstJoin.visitId)).status, 'conflict', 'a join ID cannot name another crew');
  assert.equal((await visit(replayMate, park('crewother'), 5 * MINUTE, firstJoin.visitId)).status, 'conflict', 'nor a visit elsewhere');
  const loggedReplay = await visit(outsider, park('crew'), 5 * DAY, logged.visitId);
  assert.equal(loggedReplay.status, 'replayed');
  assert.equal(loggedReplay.visit.outcome, 'logged');
  assert.equal(loggedReplay.visit.protected.leader.handle, leadHandle);
  const someVisit = await visit(replayMate, park('crewmisc'), 6 * MINUTE);
  assert.equal((await join(replayMate, replayCode, 7 * MINUTE, someVisit.visitId)).status, 'conflict', 'a visit ID cannot become a join');
  assert.equal(await count('SELECT count(*) FROM kip_game.visits WHERE account_id = $1', [replayMate]), 2);
  assert.equal((await score(replayMate, 5 * MINUTE + HOUR)).score, 2 + 6 + 1);
  log('crew joins and logged visits replay safely');

  // Codes stay unique among open windows; an expired code can be issued again. The random draw is
  // pinned to a chosen code for this, then the migration restores it.
  const openOwner = await account('cot');
  await visit(openOwner, park('crewother'), 2 * DAY);
  const openCode = await crewCode(park('crewother'));
  const drawOwner = await account('cdw');
  await visit(drawOwner, park('crewfull'), 2 * DAY + MINUTE);
  const drawTenure = await value('SELECT tenure_id FROM kip_game.tenures WHERE park_id = $1 AND ended_at IS NULL', [park('crewfull')]);
  await pool.query('DELETE FROM kip_game.crew_codes WHERE tenure_id = $1', [drawTenure]);
  const pinDraw = (pinned) => pool.query(`CREATE OR REPLACE FUNCTION kip_game.random_crew_code() RETURNS text LANGUAGE sql VOLATILE AS $$ SELECT '${pinned}'::text $$`);
  try {
    await pinDraw(openCode);
    await assert.rejects(pool.query('SELECT kip_game.issue_crew_code($1, $2)', [drawTenure, at(2 * DAY + MINUTE)]), /crew_codes_open_code_idx/, 'an open code is never issued twice');
    await pinDraw(expiredCode);
    assert.equal(await value('SELECT kip_game.issue_crew_code($1, $2)', [drawTenure, at(2 * DAY + MINUTE)]), expiredCode);
  } finally {
    await apply([CREWS_MIGRATION]);
  }
  assert.deepEqual((await pool.query('SELECT released FROM kip_game.crew_codes WHERE code = $1 ORDER BY expires_at', [expiredCode])).rows, [{ released: true }, { released: false }]);
  const reissued = await join(mates[8], expiredCode, 2 * DAY + 10 * MINUTE);
  assert.equal(reissued.status, 'joined');
  assert.equal(reissued.crew.parkId, park('crewfull'), 'a reused code finds its open window');
  assert.notEqual(await value('SELECT kip_game.random_crew_code()'), expiredCode);
  log('crew codes are unique among open windows and expired codes can be reused');

  const board = await store.leaderboard(at(10 * DAY));
  const ranks = board.filter((row) => row.handle.startsWith(`qa${suffix}_`));
  assert.ok(ranks.findIndex((row) => row.handle === `qa${suffix}_a`) < ranks.findIndex((row) => row.handle === `qa${suffix}_b`));
  assert.deepEqual(board.map((row) => row.rank), board.map((_, index) => index + 1));
  for (let index = 1; index < board.length; index += 1) assert.ok(board[index - 1].score >= board[index].score);
  log('leaderboard ranks by score');

  const victim = await account('x');
  const remover = await account('y');
  await visit(victim, park('delete'), 0);
  await visit(remover, park('delete'), DAY);
  await visit(victim, park('delete'), 2 * DAY);
  await pool.query('DELETE FROM kip_account.accounts WHERE id = $1', [remover]);
  assert.equal(await count('SELECT count(*) FROM kip_game.players WHERE account_id = $1', [remover]), 0);
  assert.equal(await count('SELECT count(*) FROM kip_game.visits WHERE account_id = $1', [remover]), 0);
  assert.equal(await count('SELECT count(*) FROM kip_game.tenures WHERE holder_account_id = $1', [remover]), 0);
  assert.equal(await count('SELECT count(*) FROM kip_game.tenures WHERE park_id = $1 AND ended_at IS NULL', [park('delete')]), 1);
  assert.equal((await store.summary(victim, at(3 * DAY))).takeovers.length, 0, 'a deleted taker leaves no takeover message');
  await pool.query('DELETE FROM kip_account.accounts WHERE id = $1', [victim]);
  assert.equal(await count('SELECT count(*) FROM kip_game.tenures WHERE park_id = $1', [park('delete')]), 0);
  log('account deletion cascades through game rows');
} finally {
  // pool.end() resolves before its connections close; the adapter ignores the server ending them
  // when the database is dropped WITH (FORCE) below.
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS "${owned}" WITH (FORCE)`);
  await admin.end();
}

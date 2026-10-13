import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// The flag game against real PostgreSQL. A few visits are recorded under game_001's day rules
// first, then game_002_points.sql runs and the game's migrations replay in inventory order the way
// every deploy does, so the history keeps what it was paid and is re-scored in hours. Runs in its
// own throwaway kip_qa_ database, so the history step always starts without game_002. Only the
// migrations the game needs run: the content migrations would require boundaries and drive rows
// for every synthetic park.
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
const GAME_MIGRATIONS = new Set([
  'database/migrations/accounts_001_init.sql', 'database/migrations/progress_001_init.sql', 'database/001_cloud_content.sql',
  'database/migrations/park_proposals_001_init.sql', 'database/migrations/game_001_init.sql', 'database/migrations/founders_001_init.sql',
  POINTS_MIGRATION,
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
const PARKS = ['history', 'plant', 'take', 'take0', 'take1', 'take10', 'hours', 'daily', 'fall', 'revisit', 'replay', 'import', 'race', 'delete', 'found'];

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
  assert.equal(results.filter((row) => row.visit.outcome === 'took').length, 7);
  assert.equal(await count('SELECT count(*) FROM kip_game.tenures WHERE park_id = $1 AND ended_at IS NULL', [park('race')]), 1);
  assert.equal(await count('SELECT count(*) FROM kip_game.tenures WHERE park_id = $1', [park('race')]), 8);
  const sameId = randomUUID();
  const repeats = await Promise.all(Array.from({ length: 6 }, () => visit(racers[0], park('race'), 2 * DAY, sameId)));
  assert.equal(repeats.filter((row) => row.status === 'recorded').length, 1);
  assert.equal(repeats.filter((row) => row.status === 'replayed').length, 5);
  log('concurrent visits to one park serialise');

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

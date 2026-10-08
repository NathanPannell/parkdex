import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { applyMigration, dbUrl, pool } from './qa-postgres-adapter.mjs';
import { createNeonGameStore } from '../worker/game-store.ts';
import { flagSeedFor } from '../worker/game.ts';

const migration = (name) => fileURLToPath(new URL(`../database/migrations/${name}`, import.meta.url));
const suffix = randomUUID().replaceAll('-', '').slice(0, 6);
const store = createNeonGameStore(dbUrl);
const log = (name) => process.stdout.write(`${name}: PASS\n`);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// 10:00 in Victoria (PDT), so whole-day offsets stay on distinct local days.
const T0 = Date.parse('2026-06-01T17:00:00.000Z');
const at = (offsetMs) => new Date(T0 + offsetMs).toISOString();
const park = (name) => `qa-game-${suffix}-${name}`;

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

try {
  await applyMigration(migration('accounts_001_init.sql'));
  await applyMigration(migration('progress_001_init.sql'));
  if (!(await pool.query("SELECT to_regclass('public.parks') AS name")).rows[0].name) {
    await applyMigration(fileURLToPath(new URL('../database/001_cloud_content.sql', import.meta.url)));
  }
  await applyMigration(migration('game_001_init.sql'));
  for (const name of ['plant', 'take', 'daily', 'fall', 'revisit', 'replay', 'import', 'race', 'delete']) {
    await pool.query(`
      INSERT INTO public.parks (id, name, short, category, region, lat, lng, biome, shape, rarity, scene, seed, blurb)
      VALUES ($1, $2, 'QA', 'community', 'QA', 48.4, -123.4, 'forest', 'circle', 'common', NULL, 1, 'Synthetic QA park.')
      ON CONFLICT (id) DO NOTHING`, [park(name), `QA ${name}`]);
  }

  const a = await account('a');
  const b = await account('b');
  const c = await account('c');
  const d = await account('d');
  const noHandle = await account('n', { handle: false });

  assert.equal((await pool.query('SELECT kip_game.flag_seed($1) AS seed', [a])).rows[0].seed, await flagSeedFor(a));
  assert.equal((await pool.query("SELECT kip_game.local_day('2026-06-02T06:30:00Z') AS day")).rows[0].day.toISOString().slice(0, 10), '2026-06-01');
  log('flag seed matches the worker and local day uses America/Vancouver');

  assert.equal((await visit(noHandle, park('plant'), 0)).status, 'handle_required');
  assert.equal((await visit(a, `qa-game-${suffix}-missing`, 0)).status, 'park_not_found');
  assert.equal(await count('SELECT count(*) FROM kip_game.visits WHERE account_id = $1', [noHandle]), 0);
  log('visits need a handle and a catalogue park');

  const planted = await visit(a, park('plant'), 0);
  assert.equal(planted.status, 'recorded');
  assert.equal(planted.visit.outcome, 'planted');
  assert.equal(planted.visit.pointsEarned, 0);
  assert.equal(planted.visit.previousHolder, null);
  assert.equal(new Date(planted.visit.flagSince).toISOString(), at(0));
  assert.equal((await flagUp(park('plant'), HOUR)).handle, `qa${suffix}_a`);
  log('planting an empty park');

  assert.equal((await score(a, 2.9 * DAY)).score, 2);
  assert.equal((await score(a, 3 * DAY + HOUR)).score, 3);
  assert.equal((await score(a, 3 * DAY + HOUR)).parksHeld, 1);
  log('holding points over several days');

  await visit(a, park('take'), 0);
  const took = await visit(b, park('take'), 5 * DAY + 2 * HOUR);
  assert.equal(took.visit.outcome, 'took');
  assert.equal(took.visit.pointsEarned, 5, 'bounty equals the flag age in whole days');
  assert.equal(took.visit.previousHolder.handle, `qa${suffix}_a`);
  assert.equal(took.visit.previousHolder.flagSeed, await flagSeedFor(a));
  assert.equal((await flagUp(park('take'), 6 * DAY)).handle, `qa${suffix}_b`);
  // A keeps 5 days on the taken park, plus 10 days on the planted park.
  assert.equal((await score(a, 10 * DAY)).score, 15);
  // B: 5 bounty + floor((10d - 5d2h) / 24h) = 4 holding.
  assert.equal((await score(b, 10 * DAY)).score, 9);
  const summary = await store.summary(a, at(10 * DAY));
  assert.deepEqual(summary.takeovers.map((row) => [row.parkId, row.byHandle]), [[park('take'), `qa${suffix}_b`]]);
  assert.deepEqual(summary.parks.map((row) => [row.parkId, row.days]), [[park('plant'), 10]]);
  await store.markTakeoversSeen(a, at(6 * DAY));
  assert.equal((await store.summary(a, at(10 * DAY))).takeovers.length, 0);
  await store.markTakeoversSeen(a, at(1 * DAY));
  assert.equal((await store.summary(a, at(10 * DAY))).takeovers.length, 0, 'the seen marker never moves backwards');
  log('taking pays the flag age and the old holder keeps their points');

  await visit(c, park('daily'), 0);
  const second = await visit(c, park('daily'), 3 * HOUR);
  assert.equal(second.status, 'already_today');
  assert.equal(second.visit.outcome, 'already_today');
  assert.equal(second.visit.pointsEarned, 0);
  assert.equal(await count("SELECT count(*) FROM kip_game.visits WHERE account_id = $1 AND park_id = $2", [c, park('daily')]), 1);
  // 23:30 local is still the same day; 00:30 is the next one.
  assert.equal((await visit(c, park('daily'), 13.5 * HOUR)).status, 'already_today');
  assert.equal((await visit(c, park('daily'), 14.5 * HOUR)).status, 'recorded');
  assert.equal((await visit(c, park('daily'), 15 * HOUR)).status, 'already_today');
  log('one visit per account, park and local day');

  await visit(c, park('fall'), 0);
  assert.ok(await flagUp(park('fall'), 30 * DAY - 1000));
  assert.equal(await flagUp(park('fall'), 30 * DAY), null);
  assert.equal((await score(c, 40 * DAY)).score >= 30, true);
  const fallScore = (await pool.query('SELECT kip_game.holding_points(started_at, last_visit_at, ended_at, $2) AS points FROM kip_game.tenures WHERE park_id = $1', [park('fall'), at(40 * DAY)])).rows[0].points;
  assert.equal(fallScore, 30);
  const afterFall = await visit(d, park('fall'), 31 * DAY);
  assert.equal(afterFall.visit.outcome, 'planted');
  assert.equal(afterFall.visit.pointsEarned, 0);
  assert.equal(afterFall.visit.fell, true);
  const fallen = (await pool.query("SELECT ended_at, end_reason FROM kip_game.tenures WHERE park_id = $1 AND holder_account_id = $2", [park('fall'), c])).rows[0];
  assert.equal(fallen.end_reason, 'fell');
  assert.equal(fallen.ended_at.toISOString(), at(30 * DAY));
  log('a flag falls 30 days after the last holder visit');

  await visit(c, park('revisit'), 0);
  const held = await visit(c, park('revisit'), 20 * DAY);
  assert.equal(held.visit.outcome, 'held');
  assert.equal(new Date(held.visit.flagSince).toISOString(), at(0), 'a revisit keeps the flag age');
  assert.equal((await flagUp(park('revisit'), 45 * DAY)).handle, `qa${suffix}_c`);
  assert.equal(new Date((await flagUp(park('revisit'), 45 * DAY)).since).toISOString(), at(0));
  assert.equal(await flagUp(park('revisit'), 50 * DAY), null);
  const revisitPoints = async (offset) => (await pool.query('SELECT kip_game.holding_points(started_at, last_visit_at, ended_at, $2) AS points FROM kip_game.tenures WHERE park_id = $1 AND holder_account_id = $3', [park('revisit'), at(offset), c])).rows[0].points;
  assert.equal(await revisitPoints(45 * DAY), 45);
  assert.equal(await revisitPoints(60 * DAY), 50);
  log('a holder revisit restarts the fall timer but not the age');

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
  await applyMigration(migration('game_001_init.sql'));
  await applyMigration(migration('game_001_init.sql'));
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
  const taker = await account('y');
  await visit(victim, park('delete'), 0);
  await visit(taker, park('delete'), DAY);
  await visit(victim, park('delete'), 2 * DAY);
  await pool.query('DELETE FROM kip_account.accounts WHERE id = $1', [taker]);
  assert.equal(await count('SELECT count(*) FROM kip_game.players WHERE account_id = $1', [taker]), 0);
  assert.equal(await count('SELECT count(*) FROM kip_game.visits WHERE account_id = $1', [taker]), 0);
  assert.equal(await count('SELECT count(*) FROM kip_game.tenures WHERE holder_account_id = $1', [taker]), 0);
  assert.equal(await count('SELECT count(*) FROM kip_game.tenures WHERE park_id = $1 AND ended_at IS NULL', [park('delete')]), 1);
  assert.equal((await store.summary(victim, at(3 * DAY))).takeovers.length, 0, 'a deleted taker leaves no takeover message');
  await pool.query('DELETE FROM kip_account.accounts WHERE id = $1', [victim]);
  assert.equal(await count('SELECT count(*) FROM kip_game.tenures WHERE park_id = $1', [park('delete')]), 0);
  log('account deletion cascades through game rows');
} finally {
  await pool.end();
}

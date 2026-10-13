import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { applyMigration, dbUrl, pool } from './qa-postgres-adapter.mjs';
import { createNeonFriendsStore } from '../worker/friends-store.ts';
import { SOCIAL_CODE_ALPHABET } from '../worker/socialCodes.ts';

const migration = (name) => fileURLToPath(new URL(`../database/migrations/${name}`, import.meta.url));
const suffix = randomUUID().replaceAll('-', '').slice(0, 6);
const store = createNeonFriendsStore(dbUrl);
const log = (name) => process.stdout.write(`${name}: PASS\n`);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Wednesday 14 October 2026, 10:00 in Victoria (PDT). Its game week runs Monday 12 to Sunday 18.
const T0 = Date.parse('2026-10-14T17:00:00.000Z');
const at = (offsetMs) => new Date(T0 + offsetMs).toISOString();
const park = (name) => `qa-friends-${suffix}-${name}`;
const CODE = new RegExp(`^[${SOCIAL_CODE_ALPHABET}]{8}$`);

async function account(name, { handle = true } = {}) {
  const id = randomUUID();
  await pool.query('INSERT INTO kip_account.accounts (id, normalized_email, password_hash) VALUES ($1, $2, $3)', [id, `friends-${name}-${suffix}@example.test`, 'qa-hash']);
  if (handle) await pool.query('INSERT INTO kip_game.players (account_id, handle, flag_seed) VALUES ($1, $2, kip_game.flag_seed($1))', [id, `qf${suffix}_${name}`]);
  return id;
}

const handle = (name) => `qf${suffix}_${name}`;

async function visitAt(accountId, parkId, iso) {
  const { rows } = await pool.query('SELECT kip_game.record_visit($1, $2, $3, $4) AS result', [randomUUID(), accountId, parkId, iso]);
  assert.equal(rows[0].result.status, 'recorded', `${parkId} at ${iso}`);
}

const visit = (accountId, parkId, offsetMs) => visitAt(accountId, parkId, at(offsetMs));

async function friendCode(accountId) {
  return (await pool.query('SELECT kip_social.ensure_friend_code($1) AS code', [accountId])).rows[0].code;
}

async function add(accountId, code, limit) {
  const { rows } = limit === undefined
    ? await pool.query('SELECT kip_social.add_friend($1, $2) AS result', [accountId, code])
    : await pool.query('SELECT kip_social.add_friend($1, $2, $3) AS result', [accountId, code, limit]);
  return rows[0].result;
}

async function count(sql, params) {
  return Number((await pool.query(sql, params)).rows[0].count);
}

const friendships = (accountId) => count('SELECT count(*) FROM kip_social.friendships WHERE account_id = $1', [accountId]);

try {
  await applyMigration(migration('accounts_001_init.sql'));
  await applyMigration(migration('progress_001_init.sql'));
  if (!(await pool.query("SELECT to_regclass('public.parks') AS name")).rows[0].name) {
    await applyMigration(fileURLToPath(new URL('../database/001_cloud_content.sql', import.meta.url)));
  }
  await applyMigration(migration('game_001_init.sql'));
  await applyMigration(migration('social_001_friends.sql'));
  await applyMigration(migration('social_001_friends.sql'));
  log('the migration replays');
  for (const name of ['one', 'two', 'three', 'four']) {
    await pool.query(`
      INSERT INTO public.parks (id, name, short, category, region, lat, lng, biome, shape, rarity, scene, seed, blurb)
      VALUES ($1, $2, 'QA', 'community', 'QA', 48.4, -123.4, 'forest', 'circle', 'common', NULL, 1, 'Synthetic QA park.')
      ON CONFLICT (id) DO NOTHING`, [park(name), `QA ${name}`]);
  }

  const codes = (await pool.query('SELECT kip_social.random_code(8) AS code FROM generate_series(1, 400)')).rows.map((row) => row.code);
  for (const code of codes) assert.match(code, CODE);
  assert.equal(new Set(codes).size, codes.length);
  assert.equal(new Set(codes.join('')).size, 31, 'every character of the alphabet appears');
  assert.match((await pool.query('SELECT kip_social.random_code(6) AS code')).rows[0].code, new RegExp(`^[${SOCIAL_CODE_ALPHABET}]{6}$`));
  await assert.rejects(pool.query('SELECT kip_social.random_code(2)'));
  log('random codes use the shared alphabet at any length');

  const me = await account('me');
  const bee = await account('bee');
  const cat = await account('cat');
  const dee = await account('dee');
  const eve = await account('eve');
  const stranger = await account('stranger');
  const noHandle = await account('nohandle', { handle: false });

  assert.equal(await friendCode(noHandle), null);
  const myCode = await friendCode(me);
  assert.match(myCode, CODE);
  assert.equal(await friendCode(me), myCode, 'the code is permanent');
  assert.equal(await store.friendCode(me), myCode);
  const parallel = await Promise.all(Array.from({ length: 6 }, () => friendCode(bee)));
  assert.equal(new Set(parallel).size, 1, 'concurrent first reads agree on one code');
  assert.equal(await count('SELECT count(*) FROM kip_social.friend_codes WHERE account_id = $1', [bee]), 1);
  log('friend codes are created once, only for players with a handle');

  assert.deepEqual(await add(noHandle, myCode), { status: 'handle_required' });
  assert.deepEqual(await add(me, myCode), { status: 'own_code' });
  assert.deepEqual(await add(me, 'ZZZZZZZZ'), { status: 'code_not_found' });
  const beeCode = await friendCode(bee);
  const added = await add(me, beeCode.toLowerCase());
  assert.equal(added.status, 'added');
  assert.deepEqual(added.friend, { handle: handle('bee'), flagSeed: (await pool.query('SELECT kip_game.flag_seed($1) AS seed', [bee])).rows[0].seed });
  assert.equal(await friendships(me), 1);
  assert.equal(await friendships(bee), 1, 'friendships are mutual');
  assert.equal((await add(me, beeCode)).status, 'already_friends', 'a resent add is safe');
  assert.equal((await add(bee, myCode)).status, 'already_friends', 'adding back is already done');
  assert.equal(await friendships(me), 1);
  log('adding a friend is mutual and replay-safe');

  for (const friend of [cat, eve]) assert.equal((await add(me, await friendCode(friend))).status, 'added');
  assert.equal((await store.addFriend(me, await friendCode(dee), 3)).status, 'too_many_friends');
  assert.equal((await store.addFriend(dee, myCode, 3)).status, 'too_many_friends', 'the limit holds for the code owner too');
  const crowd = await Promise.all(Array.from({ length: 6 }, (_, index) => account(`crowd${index}`)));
  const crowdCodes = await Promise.all(crowd.map(friendCode));
  const raced = await Promise.all(crowdCodes.map((code) => add(stranger, code, 4)));
  assert.equal(raced.filter((row) => row.status === 'added').length, 4);
  assert.equal(raced.filter((row) => row.status === 'too_many_friends').length, 2);
  assert.equal(await friendships(stranger), 4, 'concurrent adds respect the limit');
  log('the friend limit holds under concurrent adds');

  const oldCode = myCode;
  const newCode = (await store.resetFriendCode(me));
  assert.match(newCode, CODE);
  assert.notEqual(newCode, oldCode);
  assert.deepEqual(await add(dee, oldCode), { status: 'code_not_found' });
  assert.equal(await friendships(me), 3, 'a new code keeps existing friends');
  assert.equal(await store.resetFriendCode(noHandle), null);
  log('a new code retires the old one');

  // Monday 12 to Sunday 18 October is this week.
  await visit(me, park('one'), -2 * DAY);
  await visit(me, park('one'), -DAY);
  await visit(me, park('two'), -HOUR);
  // Sunday 11 October 23:30 PDT: the week before, although it is already Monday in UTC.
  await visitAt(me, park('three'), '2026-10-12T06:30:00.000Z');
  // After the board's clock.
  await visit(me, park('four'), HOUR);
  for (const name of ['one', 'two', 'three']) await visit(bee, park(name), -DAY);
  await visit(cat, park('one'), -2 * HOUR);
  await pool.query(`
    INSERT INTO kip_game.visits (account_id, visit_id, park_id, visited_at, local_day, source, outcome)
    VALUES ($1, $2, $3, $4, kip_game.local_day($4), 'claim_import', 'imported')`, [cat, randomUUID(), park('two'), at(-HOUR)]);
  await visit(eve, park('two'), -3 * HOUR);
  for (const name of ['one', 'two', 'three', 'four']) await visit(dee, park(name), -DAY);

  const { week, players } = await store.week(me, at(0));
  assert.deepEqual(week, { start: '2026-10-12', end: '2026-10-18', resetsAt: '2026-10-19T07:00:00.000Z' });
  assert.deepEqual(players.map((row) => [row.rank, row.handle, row.uniqueParks, row.isMe]), [
    [1, handle('bee'), 3, false],
    [2, handle('me'), 2, true],
    [3, handle('cat'), 1, false],
    [3, handle('eve'), 1, false],
  ]);
  log('the weekly board counts distinct parks this Victoria week, friends only, ties share a rank');

  const late = await store.week(me, at(4 * DAY + 14 * HOUR - 60_000));
  assert.equal(late.week.start, '2026-10-12', 'Sunday 23:59 is still this week');
  const next = await store.week(me, at(4 * DAY + 15 * HOUR));
  assert.equal(next.week.start, '2026-10-19', 'Monday 00:00 in Victoria starts a new week');
  assert.ok(next.players.every((row) => row.uniqueParks === 0), 'last week does not carry over');
  const winter = await store.week(me, '2026-10-30T12:00:00.000Z');
  // British Columbia's clock rules depend on the server's time zone data (permanent daylight time
  // in newer releases), so the expected reset comes from the same database.
  const winterReset = (await pool.query("SELECT ('2026-11-02 00:00'::timestamp AT TIME ZONE 'America/Vancouver') AS at")).rows[0].at.toISOString();
  assert.deepEqual(winter.week, { start: '2026-10-26', end: '2026-11-01', resetsAt: winterReset }, 'the reset is Victoria midnight whatever its offset');
  const lonely = await store.week(noHandle, at(0));
  assert.deepEqual(lonely.players, []);
  log('weeks start on Monday in Victoria');

  assert.equal(await store.removeFriend(me, handle('eve')), true);
  assert.equal(await store.removeFriend(me, handle('eve')), false);
  assert.equal(await friendships(eve), 0, 'removal ends the friendship for both players');
  assert.equal(await store.removeFriend(me, handle('nobody')), false);
  log('removing a friend works for both players');

  await pool.query('DELETE FROM kip_account.accounts WHERE id = $1', [bee]);
  assert.equal(await count('SELECT count(*) FROM kip_social.friendships WHERE friend_account_id = $1', [bee]), 0);
  assert.equal(await count('SELECT count(*) FROM kip_social.friend_codes WHERE account_id = $1', [bee]), 0);
  await pool.query("UPDATE kip_account.accounts SET deletion_state = 'deleting' WHERE id = $1", [cat]);
  assert.deepEqual((await store.week(me, at(0))).players.map((row) => row.handle), [handle('me')], 'deleting accounts leave the board at once');
  assert.deepEqual(await add(dee, await friendCode(cat).catch(() => 'ZZZZZZZZ')), { status: 'code_not_found' });
  assert.deepEqual(await add(cat, await friendCode(dee)), { status: 'account_unavailable' });
  log('account deletion removes friendships and codes');
} finally {
  await pool.end();
}

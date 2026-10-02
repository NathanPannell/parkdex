import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { applyMigration, dbUrl, pool } from './qa-postgres-adapter.mjs';
import { createNeonSocialStore } from '../worker/social.ts';

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const [me, friend, other, deleting] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
const store = createNeonSocialStore(dbUrl);
const log = (name) => process.stdout.write(`${name}: PASS\n`);
const migration = (name) => fileURLToPath(new URL(`../database/migrations/${name}`, import.meta.url));
const claim = (account, park, claimedAt) => pool.query(`
  INSERT INTO kip_account.claims (account_id, claim_id, park_id, claimed_at, park_snapshot, sync_revision, payload_hash)
  VALUES ($1, $2, $3, $4, jsonb_build_object('id', $3::text), nextval('kip_account.progress_change_seq'), repeat('a', 64))`,
  [account, randomUUID(), park, claimedAt]);

try {
  for (const name of ['accounts_001_init.sql', 'progress_001_init.sql', 'social_001_friends.sql', 'social_001_friends.sql']) await applyMigration(migration(name));
  log('migration is repeatable');

  await pool.query(`INSERT INTO kip_account.accounts (id, normalized_email, display_name, deletion_state) VALUES
    ($1, $5, 'Nathan', 'active'), ($2, $6, 'Robin', 'active'), ($3, $7, NULL, 'active'), ($4, $8, 'Gone', 'deleting')`,
    [me, friend, other, deleting, `me-${suffix}@example.test`, `friend-${suffix}@example.test`, `other-${suffix}@example.test`, `gone-${suffix}@example.test`]);

  const code = (n) => `QA${suffix.toUpperCase().replace(/[^2-9A-HJKMNP-Z]/g, 'X').slice(0, 5)}${'ABC'[n]}`;
  const mine = await store.ensureProfile(me, code(0));
  assert.equal(mine.friendCode, code(0));
  assert.equal((await store.ensureProfile(me, 'ZZZZZZZZ')).friendCode, code(0));
  assert.equal(await store.ensureProfile(friend, code(0)), null, 'a taken code reports a collision');
  assert.equal((await store.ensureProfile(friend, code(1))).displayName, 'Robin');
  assert.equal(await store.ensureProfile(deleting, code(2)), null, 'deleting accounts get no profile');
  log('profiles and code collisions');

  assert.equal((await store.addFriendByCode(me, code(0), 200)).status, 'self');
  assert.equal((await store.addFriendByCode(me, 'NOPE2345', 200)).status, 'not_found');
  const added = await store.addFriendByCode(me, code(1), 200);
  assert.equal(added.status, 'added');
  assert.equal(added.friend.displayName, 'Robin');
  assert.equal((await store.addFriendByCode(friend, code(0), 200)).status, 'existing');
  const pairs = await pool.query('SELECT count(*)::int AS n FROM kip_social.friendships WHERE account_low = LEAST($1::uuid,$2::uuid)', [me, friend]);
  assert.equal(pairs.rows[0].n, 1);
  log('mutual friendship by code');

  const otherCode = (await store.ensureProfile(other, code(2))).friendCode;
  assert.equal((await store.addFriendByCode(me, otherCode, 1)).status, 'limit');
  assert.equal((await store.addFriendByCode(me, otherCode, 200)).status, 'added');
  log('friend limit');

  const week = (await pool.query(`SELECT (date_trunc('week', now() AT TIME ZONE 'America/Vancouver') AT TIME ZONE 'America/Vancouver') AS w`)).rows[0].w;
  const thisWeek = new Date(new Date(week).getTime() + 60_000).toISOString();
  const lastWeek = new Date(new Date(week).getTime() - 60_000).toISOString();
  await claim(me, 'elk-lake', thisWeek);
  await claim(me, 'elk-lake', thisWeek);
  await claim(me, 'goldstream', lastWeek);
  await claim(friend, 'elk-lake', thisWeek);
  await claim(friend, 'thetis', thisWeek);
  const board = await store.leaderboard(me);
  assert.equal(new Date(board.weekStart).getTime(), new Date(week).getTime());
  const byName = Object.fromEntries(board.rows.map((row) => [row.displayName ?? '(none)', [row.parksThisWeek, row.totalParks]]));
  assert.deepEqual(byName, { Nathan: [1, 2], Robin: [2, 2], '(none)': [0, 0] });
  assert.equal((await store.leaderboard(friend)).rows.length, 2, 'friends of friends are not shown');
  log('weekly unique-park leaderboard');

  const rotated = await store.rotateCode(friend, `${code(1).slice(0, 7)}Z`);
  assert.equal(rotated.friendCode, `${code(1).slice(0, 7)}Z`);
  assert.equal(await store.rotateCode(friend, code(0)), null, 'rotating onto a taken code fails');
  await store.setDisplayName(me, 'Trail Runner');
  assert.equal((await store.ensureProfile(me, 'ZZZZZZZZ')).displayName, 'Trail Runner');
  log('rotate code and rename');

  assert.equal(await store.removeFriend(friend, me), true);
  assert.equal(await store.removeFriend(friend, me), false);
  await pool.query('DELETE FROM kip_account.accounts WHERE id = $1', [other]);
  assert.equal((await store.leaderboard(me)).rows.length, 1);
  log('remove friend and account deletion cascade');
} finally {
  await pool.query('DELETE FROM kip_account.accounts WHERE id = ANY($1::uuid[])', [[me, friend, other, deleting]]).catch(() => undefined);
  await pool.end();
}

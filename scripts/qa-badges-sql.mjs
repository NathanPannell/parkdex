import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// Badges (#175) against real PostgreSQL: each unlock rule at its goal, unlocks once only, the
// visit, crew join and /api/game/me paths, flag patches, analytics types and replays. Runs the
// game's migrations in inventory order in its own throwaway kip_qa_ database, like qa-game-sql.
const shared = process.env.PGDATABASE;
assert.ok(shared?.startsWith('kip_qa_') || shared === 'kip_accounts_qa', 'SQL QA requires a dedicated kip_qa_ database');
const owned = `kip_qa_badges_${randomBytes(8).toString('hex')}`;
const admin = new pg.Client({ host: process.env.PGHOST, port: Number(process.env.PGPORT), user: process.env.PGUSER, password: process.env.PGPASSWORD, database: shared });
await admin.connect();
await admin.query(`CREATE DATABASE "${owned}"`);
process.env.PGDATABASE = owned;
const { applyMigration, dbUrl, pool } = await import('./qa-postgres-adapter.mjs');
const { createNeonGameStore } = await import('../worker/game-store.ts');
const { createNeonProgressStore } = await import('../worker/accounts/progress-store.ts');

const root = new URL('../', import.meta.url);
const BADGES_MIGRATION = 'database/migrations/game_004_badges.sql';
const MIGRATIONS = new Set([
  'database/migrations/accounts_001_init.sql', 'database/migrations/progress_001_init.sql', 'database/001_cloud_content.sql',
  'database/migrations/interactions_001_init.sql', 'database/migrations/interactions_002_db_events.sql',
  'database/migrations/park_proposals_001_init.sql', 'database/migrations/game_001_init.sql', 'database/migrations/founders_001_init.sql',
  'database/migrations/game_002_points.sql', 'database/migrations/game_003_crews.sql', BADGES_MIGRATION,
]);
const suffix = randomUUID().replaceAll('-', '').slice(0, 6);
const store = createNeonGameStore(dbUrl);
const progress = createNeonProgressStore(dbUrl);
const log = (name) => process.stdout.write(`${name}: PASS\n`);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// 10:00 in Victoria (PDT), so whole-day offsets stay on distinct local days.
const T0 = Date.parse('2026-06-01T17:00:00.000Z');
const at = (offsetMs) => new Date(T0 + offsetMs).toISOString();
let parkCount = 0;

async function park({ region = 'QA', biome = 'forest' } = {}) {
  parkCount += 1;
  const id = `qa-badge-${suffix}-${parkCount}`;
  await pool.query(`
    INSERT INTO public.parks (id, name, short, category, region, lat, lng, biome, shape, rarity, scene, seed, blurb)
    VALUES ($1, $2, 'QA', 'community', $3, 48.4, -123.4, $4, 'circle', 'common', NULL, 1, 'Synthetic QA park.')`, [id, `QA ${parkCount}`, region, biome]);
  return id;
}

async function account(name, { handle = true } = {}) {
  const id = randomUUID();
  await pool.query('INSERT INTO kip_account.accounts (id, normalized_email, password_hash) VALUES ($1, $2, $3)', [id, `badge-${name}-${suffix}@example.test`, 'qa-hash']);
  if (handle) await pool.query('INSERT INTO kip_game.players (account_id, handle, flag_seed, created_at) VALUES ($1, $2, kip_game.flag_seed($1), $3)', [id, `bd${suffix}_${name}`, at(-DAY)]);
  return id;
}

const ids = (badges) => (badges ?? []).map((badge) => badge.id);

async function visit(accountId, parkId, offsetMs, visitId = randomUUID()) {
  const { rows } = await pool.query('SELECT kip_game.record_visit_with_badges($1, $2, $3, $4) AS result', [visitId, accountId, parkId, at(offsetMs)]);
  return { visitId, ...rows[0].result };
}

async function join(accountId, code, offsetMs, visitId = randomUUID()) {
  const { rows } = await pool.query('SELECT kip_game.join_crew_with_badges($1, $2, $3, $4) AS result', [accountId, code, visitId, at(offsetMs)]);
  return { visitId, ...rows[0].result };
}

async function award(accountId, offsetMs) {
  return ids((await pool.query('SELECT kip_game.award_badges($1, $2, NULL) AS badges', [accountId, at(offsetMs)])).rows[0].badges);
}

/** History that does not need flag rules: imported visits, one row per park and day. */
async function imported(accountId, parkId, offsetMs) {
  await pool.query(`
    INSERT INTO kip_game.visits (account_id, visit_id, park_id, visited_at, local_day, source, outcome)
    VALUES ($1, $2, $3, $4, kip_game.local_day($4), 'claim_import', 'imported')`, [accountId, randomUUID(), parkId, at(offsetMs)]);
}

async function unlocked(accountId) {
  return (await pool.query('SELECT badge_id FROM kip_game.player_badges WHERE account_id = $1 ORDER BY badge_id', [accountId])).rows.map((row) => row.badge_id);
}

async function value(sql, params = []) {
  return Object.values((await pool.query(sql, params)).rows[0])[0];
}

const crewCode = async (parkId) => value(`
  SELECT c.code FROM kip_game.crew_codes c JOIN kip_game.tenures t ON t.tenure_id = c.tenure_id
  WHERE t.park_id = $1 AND t.ended_at IS NULL`, [parkId]);

try {
  const config = JSON.parse(readFileSync(new URL('deployment.json', root), 'utf8'));
  const full = [config.migrationPath, 'database/001_cloud_content.sql', ...config.optionalMigrationPaths, ...config.independentMigrationPaths];
  const inventory = full.filter((path) => MIGRATIONS.has(path));
  assert.equal(inventory.length, MIGRATIONS.size, 'every migration badges need is in deployment.json');
  const independent = config.independentMigrationPaths;
  assert.equal(independent.indexOf(BADGES_MIGRATION), independent.indexOf('database/migrations/game_003_crews.sql') + 1, 'game_004 runs right after game_003');
  const apply = async () => { for (const path of inventory) await applyMigration(fileURLToPath(new URL(path, root))); };
  await apply();
  await apply();
  const source = readFileSync(new URL(BADGES_MIGRATION, root), 'utf8');
  assert.doesNotMatch(source.replace(/--.*$/gm, ''), /player_scores|points_earned|bounty_points/, 'badges never touch points');
  log('game_004_badges replays cleanly after game_003, and never touches points');

  // Analytics types: added without dropping anyone else's, and a replay changes nothing.
  const typeCheck = async () => value("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'events_event_type_v2_check'");
  const shapeCheck = async () => value("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'events_shape_v2_check'");
  for (const type of ['badge_unlocked', 'flag_patches_set', 'crew_joined', 'park_founded', 'flag_taken', 'db_read']) assert.ok((await typeCheck()).includes(`'${type}'`), type);
  const serverEvent = (type, route = 'POST /api/game/visits') => pool.query(
    `INSERT INTO kip_analytics.events (event_id, event_type, environment, schema_version, route, request_id, occurred_at, properties)
     VALUES ($1, $2, 'preview', 1, $3, $4, now(), '{"badge_id": "parks-1"}')`, [randomUUID(), type, route, randomUUID()]);
  for (const type of ['badge_unlocked', 'flag_patches_set', 'crew_joined']) await serverEvent(type);
  await assert.rejects(serverEvent('badge_unlocked', null), /events_shape_v2_check/, 'badge events need the request fields');
  const before = { type: await typeCheck(), shape: await shapeCheck() };
  await pool.query(`ALTER TABLE kip_analytics.events DROP CONSTRAINT events_event_type_v2_check,
    ADD CONSTRAINT events_event_type_v2_check CHECK (event_type IN ('db_read', 'db_write', 'park_viewed', 'directions_opened', 'park_claimed',
      'flag_planted', 'flag_taken', 'flag_held', 'visit_already_today', 'flag_fell', 'leaderboard_viewed', 'takeover_message_seen', 'handle_set',
      'park_founded', 'founder_photo_checked', 'crew_joined', 'crew_code_shown', 'visit_logged_protected', 'qa_parallel_type')) NOT VALID`);
  await apply();
  const merged = await typeCheck();
  for (const type of ['badge_unlocked', 'flag_patches_set', 'crew_joined', 'qa_parallel_type']) assert.ok(merged.includes(`'${type}'`), type);
  await apply();
  assert.equal(await typeCheck(), merged);
  assert.equal(await shapeCheck(), before.shape, 'the shape check is not touched while it has the badge types');
  log('badge analytics types join the event checks without dropping other migrations\' types');

  // parks: the first visit, then 10, then 25, 50 and 100 from history. Claims count too.
  const walker = await account('walker');
  const first = await visit(walker, await park(), 0);
  assert.equal(first.status, 'recorded');
  assert.deepEqual(ids(first.badges), ['parks-1'], 'the visit response announces the first badge');
  for (let index = 0; index < 8; index += 1) await imported(walker, await park(), -DAY - index * HOUR);
  assert.deepEqual(await award(walker, HOUR), [], '9 parks is not 10');
  // A claim backed up since the last deploy counts at once, like My Dex.
  const claimPark = await park();
  const claimId = randomUUID();
  const snapshot = { id: claimPark, name: 'QA', short: 'QA', category: 'community', region: 'QA', lat: 48.4, lng: -123.4, biome: 'forest', shape: 'circle', rarity: 'common', seed: 1, blurb: 'QA', scene: null };
  const claim = { claimId, parkId: claimPark, claimedAt: at(HOUR), parkSnapshot: snapshot, contentReleaseId: null };
  assert.equal((await progress.putClaim(walker, claim, createHash('sha256').update(JSON.stringify(claim)).digest('hex'))).status, 'created');
  assert.deepEqual(await award(walker, 2 * HOUR), ['parks-10']);
  for (const [goal, badge] of [[25, 'parks-25'], [50, 'parks-50'], [100, 'parks-100']]) {
    const have = Number(await value("SELECT value FROM kip_game.badge_metrics($1, $2) WHERE metric = 'parks'", [walker, at(3 * HOUR)]));
    for (let index = have; index < goal - 1; index += 1) await imported(walker, await park(), -2 * DAY);
    assert.deepEqual(await award(walker, 3 * HOUR), [], `${goal - 1} parks`);
    await imported(walker, await park(), -2 * DAY);
    assert.deepEqual(await award(walker, 3 * HOUR), [badge], `${goal} parks`);
  }
  log('parks badges unlock at 1, 10, 25, 50 and 100 distinct parks, counting claims');

  // Unlocks are idempotent, and a replay of the visit announces what the visit unlocked.
  const keep = await value("SELECT unlocked_at FROM kip_game.player_badges WHERE account_id = $1 AND badge_id = 'parks-1'", [walker]);
  assert.deepEqual(await award(walker, 4 * DAY), []);
  assert.equal(String(await value("SELECT unlocked_at FROM kip_game.player_badges WHERE account_id = $1 AND badge_id = 'parks-1'", [walker])), String(keep));
  assert.equal(Number(await value("SELECT count(*) FROM kip_game.player_badges WHERE account_id = $1 AND badge_id = 'parks-1'", [walker])), 1);
  const firstPark = await value('SELECT park_id FROM kip_game.visits WHERE account_id = $1 AND visit_id = $2', [walker, first.visitId]);
  const replay = await visit(walker, firstPark, 0, first.visitId);
  assert.equal(replay.status, 'replayed');
  assert.deepEqual(ids(replay.badges), ['parks-1']);
  const sameDay = await visit(walker, firstPark, HOUR);
  assert.equal(sameDay.status, 'already_today');
  assert.equal(sameDay.badges, undefined, 'a visit that changed nothing unlocks nothing');
  log('unlocks happen once, keep their time, and replays announce them again');

  // same_park_days: distinct Victoria days at one park.
  const regular = await account('regular');
  const home = await park();
  assert.deepEqual(ids((await visit(regular, home, 0)).badges), ['parks-1']);
  assert.deepEqual(ids((await visit(regular, home, DAY)).badges), []);
  await imported(regular, home, DAY + HOUR);
  assert.deepEqual(await award(regular, 2 * DAY - HOUR), [], 'a second visit on the same day is the same day');
  assert.deepEqual(ids((await visit(regular, home, 2 * DAY)).badges), ['regular-3']);
  // Someone takes the flag, so this player's holding badges stay out of the way.
  assert.equal((await visit(await account('rival'), home, 2 * DAY + HOUR)).visit.outcome, 'took');
  for (let day = 3; day < 9; day += 1) await imported(regular, home, day * DAY);
  assert.deepEqual(await award(regular, 9 * DAY - HOUR), [], '9 days');
  await imported(regular, home, 9 * DAY);
  assert.deepEqual(await award(regular, 9 * DAY + HOUR), ['regular-10']);
  for (let day = 10; day < 24; day += 1) await imported(regular, home, day * DAY);
  assert.deepEqual(await award(regular, 24 * DAY - HOUR), []);
  await imported(regular, home, 24 * DAY);
  assert.deepEqual(await award(regular, 24 * DAY + HOUR), ['regular-25']);
  log('regular badges count distinct visit days at one park: 3, 10 and 25');

  // planted: plants in empty parks. Holding your own flag is not a plant.
  const planter = await account('planter');
  const firstPlant = await park();
  await visit(planter, firstPlant, 0);
  await visit(planter, firstPlant, DAY);
  for (let index = 0; index < 3; index += 1) await visit(planter, await park(), index * HOUR);
  assert.equal(Number(await value("SELECT value FROM kip_game.badge_metrics($1, $2) WHERE metric = 'planted'", [planter, at(2 * DAY)])), 4);
  assert.deepEqual(ids((await visit(planter, await park(), 2 * DAY)).badges), ['planter-5']);
  log('planter-5 unlocks on the fifth plant');

  // taken: flags taken from someone else.
  const holder = await account('holder');
  const taker = await account('taker');
  const takeParks = [];
  for (let index = 0; index < 5; index += 1) {
    const id = await park();
    takeParks.push(id);
    await visit(holder, id, index * MINUTE);
  }
  for (let index = 0; index < 4; index += 1) assert.equal((await visit(taker, takeParks[index], 2 * HOUR + index * MINUTE)).visit.outcome, 'took');
  assert.deepEqual(await award(taker, 3 * HOUR), [], 'four takes (parks-1 came with the first)');
  const fifth = await visit(taker, takeParks[4], 3 * HOUR);
  assert.equal(fifth.visit.outcome, 'took');
  assert.deepEqual(ids(fifth.badges), ['taker-5']);
  const tookBefore = async () => pool.query(`INSERT INTO kip_game.visits (account_id, visit_id, park_id, visited_at, local_day, source, outcome)
    VALUES ($1, $2, $3, $4, kip_game.local_day($4), 'visit', 'took')`, [taker, randomUUID(), await park(), at(-3 * DAY)]);
  for (let index = 5; index < 24; index += 1) await tookBefore();
  assert.ok(!(await award(taker, 4 * HOUR)).includes('taker-25'), '24 takes');
  await tookBefore();
  assert.ok((await award(taker, 4 * HOUR)).includes('taker-25'), '25 takes');
  log('taker badges unlock at 5 and 25 takes');

  // hold_days: one holding's age while the flag flies, or until it ended. Checked on read.
  const keeper = await account('keeper');
  const hill = await park();
  await visit(keeper, hill, 0);
  assert.deepEqual(await award(keeper, 7 * DAY - MINUTE), [], '6 days 23 hours');
  assert.deepEqual(ids(await store.awardBadges(keeper, at(7 * DAY))), ['hold-7'], 'GET /api/game/me unlocks it once 7 whole days have passed');
  await visit(keeper, hill, 20 * DAY);
  assert.deepEqual(await award(keeper, 30 * DAY - MINUTE), []);
  assert.deepEqual(await award(keeper, 30 * DAY), ['hold-30']);
  // A flag taken after 5 days never reaches 7, however long ago it was planted.
  const short = await account('short');
  const brief = await park();
  await visit(short, brief, 0);
  await visit(taker, brief, 5 * DAY);
  assert.deepEqual(await award(short, 40 * DAY), [], 'no hold-7 for a flag taken after 5 days');
  // A flag that fell stops counting at its fall: 30 days after the last visit.
  const faller = await account('faller');
  await visit(faller, await park(), 0);
  assert.deepEqual(await award(faller, 90 * DAY), ['hold-7'], 'a flag nobody revisits flies just under 30 days: hold-7, not hold-30');
  log('hold badges use one holding\'s age while it flies, up to its end or fall, and unlock on read');

  // crews: a flag held with at least one other person, as leader or member.
  const leader = await account('leader');
  const friend = await account('friend');
  const solo = await park();
  await visit(leader, solo, 0);
  assert.ok(!(await unlocked(leader)).includes('crew-1'), 'a solo flag is not a crew');
  const shore = await park();
  await visit(leader, shore, DAY);
  const joined = await join(friend, await crewCode(shore), DAY + 10 * MINUTE);
  assert.equal(joined.status, 'joined');
  assert.deepEqual(ids(joined.badges), ['parks-1', 'crew-1'], 'the join response announces the joiner\'s badges');
  assert.ok((await unlocked(leader)).includes('crew-1'), 'the leader unlocks crew-1 in the same transaction');
  const rejoin = await join(friend, await crewCode(shore), DAY + 11 * MINUTE, joined.visitId);
  assert.equal(rejoin.status, 'replayed');
  assert.deepEqual(ids(rejoin.badges), ['parks-1', 'crew-1']);
  for (let index = 2; index <= 9; index += 1) {
    const id = await park();
    await visit(leader, id, DAY + index * HOUR);
    assert.equal((await join(friend, await crewCode(id), DAY + index * HOUR + MINUTE)).status, 'joined');
  }
  assert.equal(Number(await value("SELECT value FROM kip_game.badge_metrics($1, $2) WHERE metric = 'crews'", [friend, at(2 * DAY)])), 9);
  const tenth = await park();
  await visit(friend, tenth, 3 * DAY);
  const tenthJoin = await join(leader, await crewCode(tenth), 3 * DAY + MINUTE);
  assert.ok(ids(tenthJoin.badges).includes('crew-10'), 'the tenth crew, joined as a member');
  assert.ok((await unlocked(friend)).includes('crew-10'), 'and the friend leading it reaches ten too');
  log('crew badges count flags held in a crew of 2 or more, for the joiner and the rest of the crew');

  // biomes and regions, from the catalogue; coast to coast from the region's province.
  const roamer = await account('roamer');
  for (const biome of ['coast', 'forest', 'lake', 'river']) await imported(roamer, await park({ biome, region: 'Capital Region' }), -DAY);
  assert.deepEqual((await award(roamer, 0)).sort(), ['parks-1']);
  await imported(roamer, await park({ biome: 'cave', region: ' capital region ' }), -DAY);
  assert.deepEqual(await award(roamer, 0), ['biomes-5'], 'five landscape types; one region however it is spelled');
  await imported(roamer, await park({ region: 'Central Island' }), -DAY);
  assert.deepEqual(await award(roamer, 0), []);
  await imported(roamer, await park({ region: 'North Island' }), -DAY);
  assert.deepEqual(await award(roamer, 0), ['regions-3']);
  assert.equal(Number(await value("SELECT value FROM kip_game.badge_metrics($1, $2) WHERE metric = 'coast_to_coast'", [roamer, at(0)])), 1);
  await imported(roamer, await park({ region: 'QA Elsewhere' }), -DAY);
  assert.deepEqual(await award(roamer, 0), [], 'a region outside both provinces');
  await imported(roamer, await park({ region: 'Halifax Metro' }), -DAY);
  assert.deepEqual(await award(roamer, 0), ['coast-to-coast']);
  const eastOnly = await account('east');
  await imported(eastOnly, await park({ region: 'Cape Breton Island' }), -DAY);
  assert.deepEqual(await award(eastOnly, 0), ['parks-1'], 'Nova Scotia alone is half the way');
  assert.equal(await value("SELECT kip_game.region_province('Yarmouth and Acadian Shores')"), 'Nova Scotia');
  assert.equal(await value("SELECT kip_game.region_province('Southern Vancouver Island')"), 'British Columbia');
  assert.equal(await value('SELECT kip_game.region_province(NULL)'), null);
  log('biomes-5, regions-3 and coast-to-coast read the catalogue and the province of each region');

  // founded: a founder row; an instant founding's transaction unlocks it with its visit.
  const founder = await account('founder');
  const foundedPark = await park();
  const photo = Buffer.from('qa founder photo');
  await pool.query(`
    INSERT INTO kip_founders.parks (park_id, account_id, attempt_id, founded_at, source, photo_sha256, photo_bytes, photo_width, photo_height, moderation)
    VALUES ($1, $2, $3, $4, 'existing', $5, $6, 1, 1, '{}')`, [foundedPark, founder, randomUUID(), at(0), createHash('sha256').update(photo).digest('hex'), photo]);
  const foundingVisit = randomUUID();
  await pool.query('SELECT kip_game.record_visit($1, $2, $3, $4)', [foundingVisit, founder, foundedPark, at(0)]);
  assert.deepEqual(ids((await pool.query('SELECT kip_game.award_badges($1, $2, $3) AS badges', [founder, at(0), foundingVisit])).rows[0].badges), ['parks-1', 'founder']);
  assert.deepEqual(ids((await pool.query('SELECT kip_game.visit_badges($1, $2) AS badges', [founder, foundingVisit])).rows[0].badges), ['parks-1', 'founder']);
  log('founder unlocks with the founding, and its replay lists the same badges');

  // Badges never add points.
  const scoreOf = async (accountId, offsetMs) => value('SELECT score FROM kip_game.player_scores($1) WHERE account_id = $2', [at(offsetMs), accountId]);
  const scoreBefore = await scoreOf(walker, 5 * DAY);
  await pool.query('DELETE FROM kip_game.player_badges WHERE account_id = $1', [walker]);
  assert.equal(await scoreOf(walker, 5 * DAY), scoreBefore);
  assert.ok((await award(walker, 5 * DAY)).length >= 5);
  assert.equal(await scoreOf(walker, 5 * DAY), scoreBefore, 'unlocking badges leaves the score alone');
  log('badges add no points');

  // Progress on read: every rule with its progress toward the goal.
  const listed = await store.badges(roamer, at(0));
  assert.equal(listed.badges.length, 19);
  assert.deepEqual(listed.badges.find((badge) => badge.id === 'parks-1'), { id: 'parks-1', progress: 1, goal: 1, unlockedAt: at(0) });
  assert.deepEqual(listed.badges.find((badge) => badge.id === 'parks-10'), { id: 'parks-10', progress: 9, goal: 10, unlockedAt: null });
  assert.deepEqual(listed.badges.find((badge) => badge.id === 'coast-to-coast'), { id: 'coast-to-coast', progress: 2, goal: 2, unlockedAt: at(0) });
  assert.deepEqual(listed.badges.map((badge) => badge.id).slice(0, 3), ['parks-1', 'parks-10', 'parks-25'], 'in shelf order');
  assert.deepEqual(listed.patches, []);
  log('badges list every rule with progress, in shelf order');

  // Flag patches: up to 3 unlocked badges, checked in the database.
  assert.deepEqual(await store.setFlagPatches(roamer, ['coast-to-coast', 'biomes-5', 'parks-1']), { status: 'saved', patches: ['coast-to-coast', 'biomes-5', 'parks-1'] });
  assert.deepEqual((await store.badges(roamer, at(0))).patches, ['coast-to-coast', 'biomes-5', 'parks-1']);
  assert.deepEqual(await store.setFlagPatches(roamer, ['parks-1', 'parks-10', 'regions-3', 'biomes-5']), { status: 'too_many' });
  assert.deepEqual(await store.setFlagPatches(roamer, ['parks-1', 'parks-1']), { status: 'duplicate' });
  assert.deepEqual(await store.setFlagPatches(roamer, ['parks-1', 'hold-30']), { status: 'locked' }, 'only unlocked badges');
  assert.deepEqual(await store.setFlagPatches(roamer, ['no-such-badge']), { status: 'locked' });
  assert.deepEqual((await store.badges(roamer, at(0))).patches, ['coast-to-coast', 'biomes-5', 'parks-1'], 'refusals change nothing');
  assert.deepEqual(await store.setFlagPatches(await account('nohandle', { handle: false }), []), { status: 'handle_required' });
  await assert.rejects(pool.query("UPDATE kip_game.players SET flag_patches = ARRAY['a', 'b', 'c', 'd'] WHERE account_id = $1", [roamer]), /players_flag_patches_check/);
  log('flag patches hold at most 3 unlocked badges, and the table holds at most 3');

  // Others see the patches: flags, the leaderboard and crews.
  await store.setFlagPatches(leader, ['crew-1']);
  const flags = await store.flags(at(DAY + 20 * MINUTE));
  assert.deepEqual(flags.find((flag) => flag.parkId === shore)?.patches, ['crew-1']);
  const board = await store.leaderboard(at(DAY + 20 * MINUTE));
  assert.deepEqual(board.find((row) => row.handle === `bd${suffix}_leader`)?.patches, ['crew-1']);
  assert.deepEqual(board.find((row) => row.handle === `bd${suffix}_walker`)?.patches, []);
  const crew = await store.parkCrew(shore, friend, at(DAY + 20 * MINUTE));
  assert.deepEqual(crew?.leader.patches, ['crew-1']);
  assert.deepEqual(crew?.members.map((member) => [member.leader, member.patches]), [[true, ['crew-1']], [false, []]]);
  log('flags, the leaderboard and crews carry each player\'s patches');

  // The store goes through the wrappers, and falls back to the plain functions without them.
  const storeVisit = await store.recordVisit(eastOnly, randomUUID(), await park(), at(DAY));
  assert.equal(storeVisit.status, 'recorded');
  assert.deepEqual(storeVisit.badges, []);
  const fresh = await account('fresh');
  const freshVisit = await store.recordVisit(fresh, randomUUID(), await park(), at(DAY));
  assert.deepEqual(ids(freshVisit.badges), ['parks-1']);
  await pool.query('ALTER FUNCTION kip_game.record_visit_with_badges(uuid, uuid, text, timestamptz) RENAME TO qa_hidden_record_visit_with_badges');
  try {
    const plain = await store.recordVisit(fresh, randomUUID(), await park(), at(DAY));
    assert.equal(plain.status, 'recorded');
    assert.deepEqual(plain.badges, [], 'without game_004 a visit still records, with no badges');
  } finally {
    await pool.query('ALTER FUNCTION kip_game.qa_hidden_record_visit_with_badges(uuid, uuid, text, timestamptz) RENAME TO record_visit_with_badges');
  }
  log('the store records visits through the badge wrapper, and without it on an older database');

  // A deleting account gets no badges and cannot sew patches; deleting it removes its badges.
  await pool.query("UPDATE kip_account.accounts SET deletion_state = 'deleting' WHERE id = $1", [roamer]);
  await imported(roamer, await park({ biome: 'marsh' }), -DAY);
  assert.deepEqual(await award(roamer, 0), []);
  assert.deepEqual(await store.setFlagPatches(roamer, []), { status: 'account_unavailable' });
  await pool.query('DELETE FROM kip_account.accounts WHERE id = $1', [roamer]);
  assert.equal(Number(await value('SELECT count(*) FROM kip_game.player_badges WHERE account_id = $1', [roamer])), 0);
  log('account deletion stops unlocks and cascades to badges');
} finally {
  // pool.end() resolves before its connections close; the adapter ignores the server ending them
  // when the database is dropped WITH (FORCE) below.
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS "${owned}" WITH (FORCE)`);
  await admin.end();
}

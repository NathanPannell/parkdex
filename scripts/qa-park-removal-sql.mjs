import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// Remove from map (operator dashboard) against real PostgreSQL: the full migration inventory
// replayed twice, then the real founding API, the real OpenStreetMap search over kip_osm.parks and
// the real dashboard routes with their SQL stores. Only sign-in, the network and the photo model
// are stand-ins. Covers founding an OpenStreetMap park, removing it, the search offering it again,
// founding it again the same day with the bonus counted once, a curated park founded again from
// its outline, pending reviews closed with a reason, a park without an outline refused, and a
// removal racing a founding. Content triggers check every park, so this runs in its own
// throwaway kip_qa_ database.
const shared = process.env.PGDATABASE;
assert.ok(shared?.startsWith('kip_qa_') || shared === 'kip_accounts_qa', 'SQL QA requires a dedicated kip_qa_ database');
const owned = `kip_qa_removal_${randomBytes(8).toString('hex')}`;
const admin = new pg.Client({ host: process.env.PGHOST, port: Number(process.env.PGPORT), user: process.env.PGUSER, password: process.env.PGPASSWORD, database: shared });
admin.on('error', () => undefined);
await admin.connect();
await admin.query(`CREATE DATABASE "${owned}"`);
process.env.PGDATABASE = owned;
const { applyMigration, dbUrl, pool } = await import('./qa-postgres-adapter.mjs');
const { createFeedbackWorker } = await import('../worker/index.ts');
const { publishStatements } = await import('../operator/server/drafts.ts');
const { createDashboardApi } = await import('../operator/server/api.ts');
const { createSqlLiveParkStore } = await import('../operator/server/parks/liveParks.ts');
const { createSqlParkManagerStore } = await import('../operator/server/parks/manager.ts');
const { createSqlOsmStore } = await import('../operator/server/parks/osm.ts');
const { createSqlParkRemovalStore, REMOVED_REASON } = await import('../operator/server/parks/removal.ts');
const { createSqlFoundingReviewStore } = await import('../worker/founding-reviews.ts');
const { EXIF_GPS_JPEG } = await import('../worker/fixtures/exif-gps-jpeg.ts');
const { PHOTO_FLAGS } = await import('../worker/founderPhoto.ts');
const { createOsmClient } = await import('../worker/osmParks.ts');
const { createSqlOsmParkTable } = await import('../worker/osmParkTable.ts');
const { databaseSqlRunner } = await import('../worker/proposalReview.ts');

const root = new URL('../', import.meta.url);
const log = (name) => process.stdout.write(`${name}: PASS\n`);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const ORIGIN = 'https://kip.example.test';
const OPERATOR = 'https://operator.example.test';
const box = (west, south, east, north) => [[west, south], [east, south], [east, north], [west, north], [west, south]];
const multi = (...rings) => ({ type: 'MultiPolygon', coordinates: [rings] });
const osmBase = 700_000_000 + Math.floor(Math.random() * 90_000_000);

// An OpenStreetMap park not in Parkdex, and curated parks with their own outlines in the table.
const MEADOW = { type: 'way', id: osmBase, name: 'Removal Meadow', ring: box(-123.062, 49.088, -123.058, 49.0902) };
const IN_MEADOW = { lat: 49.089, lng: -123.0601, accuracyM: 8 };
const MEADOW_PARK = `osm-way-${MEADOW.id}`;
const GREEN = 'municipal-qa-removal-green';
const GREEN_OSM = { type: 'way', id: osmBase + 1, name: 'QA Removal Green', ring: box(-123.1, 49.1, -123.095, 49.103) };
const IN_GREEN = { lat: 49.1015, lng: -123.0975, accuracyM: 6 };
const RACE = 'municipal-qa-removal-race';
const RACE_OSM = { type: 'way', id: osmBase + 2, name: 'QA Removal Race', ring: box(-123.1, 49.14, -123.095, 49.143) };
const IN_RACE = { lat: 49.1415, lng: -123.0975, accuracyM: 6 };
const OTHER = 'municipal-qa-removal-other';
const IN_OTHER = { lat: 49.1215, lng: -123.0975, accuracyM: 6 };
const BARE = 'municipal-qa-removal-bare';

const answers = (flags = {}) => ({
  model: 'qa-model',
  answers: Object.fromEntries(PHOTO_FLAGS.map((flag) => [flag, { choice: (flags[flag] ?? 0.01) > 0.5 ? 'yes' : 'no', probabilities: { yes: flags[flag] ?? 0.01, no: 1 - (flags[flag] ?? 0.01) } }])),
});
const APPROVE = answers();
const PEOPLE = answers({ people: 0.96 });
let photoAnswers = APPROVE;

const players = new Map();
const authStore = {
  async findSession(tokenHash) {
    const accountId = players.get(tokenHash);
    if (!accountId) return null;
    return {
      id: accountId, email: `${accountId}@example.test`, emailVerified: true, displayName: 'QA', providers: ['email'], sessionId: randomUUID(),
      tokenHash, csrfHash: null, transport: 'native', expiresAt: '2099-01-01T00:00:00Z', absoluteExpiresAt: '2099-02-01T00:00:00Z', reauthenticatedAt: null,
    };
  },
};
// 10:00 in Victoria; every founding below happens on this one Victoria day.
let clock = Date.parse('2026-10-10T17:00:00.000Z');
const pending = [];
const noNetwork = async (url) => { throw new Error(`no network: ${url}`); };
const worker = createFeedbackWorker({
  auth: { createStore: () => authStore },
  // The production client over our own outline table, with Nominatim and Overpass unreachable.
  osmClient: createOsmClient({ NOMINATIM_URL: 'off', OVERPASS_URLS: 'https://overpass.invalid/api/interpreter' }, noNetwork, { table: createSqlOsmParkTable(databaseSqlRunner(dbUrl)) }),
  osmSearchAllowed: async () => true,
  photoChecker: async () => photoAnswers,
  now: () => clock,
});
const env = {
  DATABASE_URL: dbUrl, PUBLIC_APP_URL: ORIGIN, AUTH_SESSION_SECRET: 'auth-test-secret-'.repeat(4), SESSION_SECRET: 'qa-session-secret-which-is-long-enough',
  EMAIL_MODE: 'disabled', CONTENT_CHANNEL: 'staging',
};
// The dashboard has its own copy of the Neon driver under operator/node_modules, which the adapter
// does not redirect, so its stores get the root driver's runner; the SQL is the same.
const runner = databaseSqlRunner(dbUrl);
const dashboard = createDashboardApi({
  now: () => clock,
  liveParkStore: () => createSqlLiveParkStore(runner),
  parkManagerStore: () => createSqlParkManagerStore(runner),
  osmStore: () => createSqlOsmStore(runner),
  foundingReviewStore: () => createSqlFoundingReviewStore(runner),
  parkRemovalStore: () => createSqlParkRemovalStore(runner),
});
const operatorEnv = { DATABASE_URL: dbUrl, DASHBOARD_ENVIRONMENT: 'staging' };

async function call(method, path, { token, body } = {}) {
  const headers = new Headers({ origin: ORIGIN });
  if (token) {
    headers.set('authorization', `Bearer ${token}`);
    headers.set('x-kip-account-id', players.get(hash(token)));
  }
  if (body !== undefined) headers.set('content-type', 'application/json');
  const response = await worker.fetch(new Request(ORIGIN + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env,
    { waitUntil: (promise) => { pending.push(promise); } });
  await Promise.all(pending.splice(0));
  return response;
}

function operator(method, path) {
  const headers = new Headers();
  if (method !== 'GET') headers.set('origin', OPERATOR);
  return dashboard(new Request(OPERATOR + path, { method, headers }), operatorEnv);
}

const photo = { mime: 'image/jpeg', base64: Buffer.from(EXIF_GPS_JPEG).toString('base64'), width: 16, height: 12 };
const found = (token, target, position, attemptId = randomUUID()) => call('POST', '/api/parks/found', { token, body: { attemptId, position, target, photo } });
const search = (position) => call('GET', `/api/osm/parks?lat=${position.lat}&lng=${position.lng}&accuracy=${position.accuracyM}`);

async function account(name) {
  const id = randomUUID();
  const token = randomBytes(32).toString('base64url');
  await pool.query('INSERT INTO kip_account.accounts (id, normalized_email, password_hash) VALUES ($1, $2, $3)', [id, `removal-${name}-${id.slice(0, 6)}@example.test`, 'qa-hash']);
  await pool.query("INSERT INTO kip_game.players (account_id, handle, flag_seed, created_at) VALUES ($1, $2, kip_game.flag_seed($1), '2026-10-01T00:00:00Z')", [id, `qa_${name}_${id.slice(0, 4)}`]);
  players.set(hash(token), id);
  return { id, token, handle: `qa_${name}_${id.slice(0, 4)}` };
}

/** A catalogue park published the way the operator dashboard does, with its pin inside. */
async function publishPark(id, name, ring) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO kip_park_drafts.drafts (id, source, source_sha256, geometry, name, short, category, region, lat, lng, biome, shape, rarity, seed, blurb)
       VALUES ($1, '{}'::jsonb, $2, $3::jsonb, $4, $4, 'municipal', 'South Coast', $5, $6, 'forest', 'circle', 'common', 1, 'A QA park.') RETURNING updated_at`,
      [id, 'a'.repeat(64), JSON.stringify(multi(ring)), name, (ring[0][1] + ring[2][1]) / 2, (ring[0][0] + ring[2][0]) / 2],
    );
    for (const statement of publishStatements(id, new Date(rows[0].updated_at).toISOString(), null)) await client.query(statement.text, statement.params);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function outline({ type, id, name, ring }) {
  const lats = ring.map((point) => point[1]), lngs = ring.map((point) => point[0]);
  await pool.query(
    `INSERT INTO kip_osm.parks (osm_type, osm_id, name, kind, tags, min_lat, max_lat, min_lng, max_lng, area_m2, geometry, source_date)
     VALUES ($1, $2, $3, 'leisure=park', $4::jsonb, $5, $6, $7, $8, 70000, $9::jsonb, '2026-10-05T20:21:03Z')`,
    [type, id, name, JSON.stringify({ leisure: 'park', name }), Math.min(...lats), Math.max(...lats), Math.min(...lngs), Math.max(...lngs), JSON.stringify(multi(ring))],
  );
}

const count = async (sql, params = []) => Number((await pool.query(sql, params)).rows[0].count);
const score = async (accountId) => (await pool.query('SELECT score FROM kip_game.player_scores($1) WHERE account_id = $2', [new Date(clock).toISOString(), accountId])).rows[0]?.score;
const json = async (response) => response.json();
const offered = async (position, id) => (await json(await search(position))).parks.find((park) => park.id === id);

try {
  const config = JSON.parse(readFileSync(new URL('deployment.json', root), 'utf8'));
  const inventory = [config.migrationPath, ...config.contentSync.supportingMigrationPaths, ...config.optionalMigrationPaths, ...config.contentSync.migrationPaths, ...config.independentMigrationPaths];
  const position = (name) => inventory.indexOf(`database/migrations/${name}`);
  assert.ok(position('founders_003_park_removed.sql') > position('founders_002_reviews.sql'), 'founders_003 replays after founders_002');
  for (const path of inventory) await applyMigration(fileURLToPath(new URL(path, root)));
  for (const path of inventory) await applyMigration(fileURLToPath(new URL(path, root)));
  const constraints = (await pool.query(`SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
    WHERE conrelid = 'kip_analytics.events'::regclass AND conname IN ('events_event_type_v2_check', 'events_shape_v2_check')`)).rows;
  assert.equal(constraints.length, 2);
  for (const row of constraints) {
    for (const type of ['park_removed', 'park_founded', 'founder_photo_checked', 'founding_review_requested', 'founding_review_decided', 'flag_planted', 'park_viewed']) {
      assert.match(row.def, new RegExp(type), `${row.conname} keeps ${type}`);
    }
  }
  await pool.query("INSERT INTO public.drive_hubs (position, name, lng, lat) VALUES (0, 'Victoria', -123.36, 48.43), (1, 'Nanaimo', -123.94, 49.17) ON CONFLICT DO NOTHING");
  for (const shape of [MEADOW, GREEN_OSM, RACE_OSM]) await outline(shape);
  await publishPark(GREEN, 'QA Removal Green', GREEN_OSM.ring);
  await publishPark(RACE, 'QA Removal Race', RACE_OSM.ring);
  await publishPark(OTHER, 'QA Removal Other', box(-123.1, 49.12, -123.095, 49.123));
  await publishPark(BARE, 'QA Removal Bare', box(-123.3, 49.3, -123.295, 49.303));
  log('founders_003 replays after founders_002 and adds park_removed, keeping every analytics event type');

  // Found an OpenStreetMap park.
  const tester = await account('tester');
  const rival = await account('rival');
  const scoreBefore = await score(tester.id);
  assert.equal((await offered(IN_MEADOW, MEADOW.id)).inCatalogue, null, 'offered as not in Parkdex before the first founding');
  const first = await found(tester.token, { osm: { type: 'way', id: MEADOW.id } }, IN_MEADOW);
  assert.equal(first.status, 200, await first.clone().text());
  const firstBody = await json(first);
  assert.deepEqual([firstBody.outcome, firstBody.park.id, firstBody.visit.outcome, firstBody.founderPoints], ['founded', MEADOW_PARK, 'planted', 24]);
  assert.equal(await score(tester.id), scoreBefore + 24 + 6, 'the founder bonus and the plant bonus');
  const listed = await offered(IN_MEADOW, MEADOW.id);
  assert.deepEqual([listed.inCatalogue?.parkId, listed.founder?.handle], [MEADOW_PARK, tester.handle], 'the search shows it founded');
  log('a tester founds an OpenStreetMap park');

  // Remove it from the map.
  const plan = (await json(await operator('GET', `/api/parks/${MEADOW_PARK}/remove-from-map`))).plan;
  assert.deepEqual([plan.blocked, plan.source, plan.founder?.handle, plan.pendingReviews, plan.outline?.parkId, plan.audited],
    [null, 'founded', tester.handle, 0, MEADOW_PARK, true]);
  const revisionBefore = Number((await pool.query('SELECT revision FROM public.content_clock')).rows[0].revision);
  const removed = await operator('POST', `/api/parks/${MEADOW_PARK}/remove-from-map`);
  assert.equal(removed.status, 200, await removed.clone().text());
  const result = await json(removed);
  assert.deepEqual([result.ok, result.founder?.handle, result.reviewsClosed, result.outline.parkId, result.revision], [true, tester.handle, 0, MEADOW_PARK, revisionBefore + 1]);
  assert.equal(await count('SELECT count(*) FROM public.parks WHERE id = $1', [MEADOW_PARK]), 0);
  assert.equal(await count('SELECT count(*) FROM kip_founders.parks WHERE park_id = $1', [MEADOW_PARK]), 0, 'the founder and cover are gone');
  assert.equal(await count('SELECT count(*) FROM kip_park_drafts.drafts WHERE id = $1', [MEADOW_PARK]), 0, 'the draft goes too, so nothing blocks a new founding');
  assert.equal(await count('SELECT count(*) FROM kip_osm.parks WHERE osm_type = $1 AND osm_id = $2', ['way', MEADOW.id]), 1, 'the outline stays');
  assert.equal(await score(tester.id), scoreBefore + 6, 'the founder bonus goes with the founder row; the visit keeps its plant bonus');
  const tombstones = (await pool.query('SELECT entity, operation FROM public.content_changes WHERE revision = $1 AND entity_id = $2 ORDER BY entity', [result.revision, MEADOW_PARK])).rows;
  assert.deepEqual(tombstones.map((row) => `${row.entity}:${row.operation}`), ['boundary:delete', 'drive:delete', 'park:delete'], 'one content revision, like Delete');
  assert.equal(await count('SELECT count(*) FROM kip_game.visits WHERE park_id = $1', [MEADOW_PARK]), 1, 'the visit stays as history');
  assert.equal(await count('SELECT count(*) FROM kip_proposals.parks WHERE published_park_id = $1', [MEADOW_PARK]), 1, 'the founding audit row stays');
  const event = (await pool.query("SELECT account_id, route, environment, park_id, properties FROM kip_analytics.events WHERE event_type = 'park_removed'")).rows;
  assert.equal(event.length, 1);
  assert.deepEqual([event[0].account_id, event[0].route, event[0].environment, event[0].park_id], [tester.id, 'POST /operator/parks/:id/remove-from-map', 'staging', MEADOW_PARK]);
  assert.deepEqual(event[0].properties, { source: 'founded', had_founder: true, founder_source: 'osm_new', reviews_closed: 0, outline: `way/${MEADOW.id}` });
  assert.equal((await operator('GET', `/api/parks/${MEADOW_PARK}`)).status, 404);
  log('remove from map deletes the park, founder, cover and bonus in one revision and keeps the outline, visits and audit row');

  // The OpenStreetMap search offers it again as not in Parkdex.
  const again = await offered(IN_MEADOW, MEADOW.id);
  assert.deepEqual([again.name, again.inCatalogue, again.founder, again.hasCover], [MEADOW.name, null, null, false]);
  assert.equal((await call('GET', `/api/parks/${MEADOW_PARK}/summary`)).status, 404);
  log('the search offers the outline again as not in Parkdex');

  // Found it again the same day: same tester, same outline, same id.
  clock += 10 * 60_000;
  const second = await found(tester.token, { osm: { type: 'way', id: MEADOW.id } }, IN_MEADOW);
  assert.equal(second.status, 200, await second.clone().text());
  const secondBody = await json(second);
  assert.deepEqual([secondBody.outcome, secondBody.park.id, secondBody.founderPoints], ['founded', MEADOW_PARK, 24]);
  assert.equal(secondBody.visit.outcome, 'already_today', 'today\'s first visit still counts; founding accepts it');
  assert.equal(await count('SELECT count(*) FROM kip_founders.parks WHERE park_id = $1 AND account_id = $2', [MEADOW_PARK, tester.id]), 1);
  assert.equal(await score(tester.id), scoreBefore + 6 + 24, 'the bonus is counted once');
  assert.equal(await count('SELECT count(*) FROM kip_game.visits WHERE park_id = $1', [MEADOW_PARK]), 1, 'one visit a day');
  assert.equal(await count("SELECT count(*) FROM kip_analytics.events WHERE event_type = 'park_founded' AND park_id = $1", [MEADOW_PARK]), 2);
  const summary = await json(await call('GET', `/api/parks/${MEADOW_PARK}/summary`));
  assert.equal(summary.founder.handle, tester.handle);
  log('the same tester founds it again the same day, and the bonus is counted once');

  // A curated park with its own outline, with a pending founding review, and another park's
  // pending review, which must be left alone.
  photoAnswers = PEOPLE;
  const asker = await account('asker');
  const attempt = randomUUID();
  assert.equal((await json(await found(asker.token, { parkId: GREEN }, IN_GREEN, attempt))).outcome, 'rejected');
  const request = await json(await call('POST', '/api/parks/found/review', { token: asker.token, body: { attemptId: attempt } }));
  assert.equal(request.status, 'pending');
  const otherAttempt = randomUUID();
  assert.equal((await json(await found(asker.token, { parkId: OTHER }, IN_OTHER, otherAttempt))).outcome, 'rejected');
  const otherRequest = await json(await call('POST', '/api/parks/found/review', { token: asker.token, body: { attemptId: otherAttempt } }));
  assert.equal(otherRequest.status, 'pending');
  assert.equal((await offered(IN_GREEN, GREEN_OSM.id)).inCatalogue?.parkId, GREEN, 'the outline is the curated park while it is on the map');

  const greenPlan = (await json(await operator('GET', `/api/parks/${GREEN}/remove-from-map`))).plan;
  assert.deepEqual([greenPlan.blocked, greenPlan.source, greenPlan.founder, greenPlan.pendingReviews, greenPlan.outline?.parkId],
    [null, 'curated', null, 1, `osm-way-${GREEN_OSM.id}`]);
  clock += 5 * 60_000;
  const greenRemoved = await operator('POST', `/api/parks/${GREEN}/remove-from-map`);
  assert.equal(greenRemoved.status, 200, await greenRemoved.clone().text());
  assert.equal((await json(greenRemoved)).reviewsClosed, 1);
  const closed = (await pool.query('SELECT status, reason_code, decision_reason, decided_at FROM kip_founders.review_requests WHERE id = $1', [request.requestId])).rows[0];
  assert.deepEqual([closed.status, closed.reason_code, closed.decision_reason, closed.decided_at.toISOString()], ['rejected', 'other', REMOVED_REASON, new Date(clock).toISOString()]);
  assert.equal((await pool.query('SELECT status FROM kip_founders.review_requests WHERE id = $1', [otherRequest.requestId])).rows[0].status, 'pending', 'other parks keep their requests');
  const decided = (await pool.query("SELECT account_id, properties FROM kip_analytics.events WHERE event_type = 'founding_review_decided' AND park_id = $1", [GREEN])).rows;
  assert.deepEqual(decided.map((row) => [row.account_id, row.properties.decision, row.properties.reason_code]), [[asker.id, 'rejected', 'park_removed']]);
  const me = await json(await call('GET', '/api/game/me', { token: asker.token }));
  assert.deepEqual(me.foundingReviews.decided.map((row) => [row.status, row.parkName, row.reason, row.founderHandle]), [['rejected', 'QA Removal Green', REMOVED_REASON, null]],
    'the player reads that the park was removed, not that someone else founded it');
  assert.deepEqual(me.foundingReviews.pending.map((row) => row.parkId), [OTHER]);
  log('removing a curated park closes its pending reviews with the reason the player reads, and only those');

  // Its outline is offered as a new park and founded as one.
  photoAnswers = APPROVE;
  assert.equal((await offered(IN_GREEN, GREEN_OSM.id)).inCatalogue, null);
  const foundedGreen = await found(rival.token, { osm: { type: 'way', id: GREEN_OSM.id } }, IN_GREEN);
  assert.equal(foundedGreen.status, 200, await foundedGreen.clone().text());
  assert.equal((await json(foundedGreen)).park.id, `osm-way-${GREEN_OSM.id}`);
  assert.equal((await json(await call('GET', `/api/parks/osm-way-${GREEN_OSM.id}/summary`))).founder.handle, rival.handle);
  log('a curated park removed from the map is founded again from its OpenStreetMap outline');

  // A park with no outline in the table cannot be removed from the map; Delete is the way.
  const bare = (await json(await operator('GET', `/api/parks/${BARE}/remove-from-map`))).plan;
  assert.equal(bare.blocked?.code, 'no_outline');
  const refused = await operator('POST', `/api/parks/${BARE}/remove-from-map`);
  assert.equal(refused.status, 409);
  assert.equal((await json(refused)).error.code, 'no_outline');
  assert.equal(await count('SELECT count(*) FROM public.parks WHERE id = $1', [BARE]), 1);
  log('a park without an OpenStreetMap outline is refused and stays');

  // A database a release behind (founders_002, no founders_003): the removal still works and
  // records no park_removed row, and founders_003 then upgrades it in place.
  await pool.query('ALTER TABLE kip_analytics.events DROP CONSTRAINT events_event_type_v2_check');
  await pool.query(`ALTER TABLE kip_analytics.events ADD CONSTRAINT events_event_type_v2_check CHECK (event_type IN (
    'park_viewed', 'directions_opened', 'park_claimed', 'db_read', 'db_write',
    'flag_planted', 'flag_taken', 'flag_held', 'visit_already_today', 'flag_fell', 'leaderboard_viewed', 'takeover_message_seen', 'handle_set',
    'park_founded', 'founder_photo_checked', 'founding_review_requested', 'founding_review_decided')) NOT VALID`);
  const behind = (await json(await operator('GET', `/api/parks/${MEADOW_PARK}/remove-from-map`))).plan;
  assert.deepEqual([behind.blocked, behind.audited], [null, false]);
  const behindRemoved = await operator('POST', `/api/parks/${MEADOW_PARK}/remove-from-map`);
  assert.equal(behindRemoved.status, 200, await behindRemoved.clone().text());
  assert.equal((await json(behindRemoved)).audited, false);
  assert.equal(await count('SELECT count(*) FROM public.parks WHERE id = $1', [MEADOW_PARK]), 0);
  assert.equal(await count("SELECT count(*) FROM kip_analytics.events WHERE event_type = 'park_removed'"), 2, 'only the two earlier removals are recorded');
  await applyMigration(fileURLToPath(new URL('database/migrations/founders_003_park_removed.sql', root)));
  assert.match((await pool.query("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'events_event_type_v2_check'")).rows[0].def, /park_removed/);
  log('on a database without founders_003 the removal works without its analytics row, and founders_003 upgrades it');

  // A removal racing a founding of the same park: both take the founding lock, so either the
  // founding lands first and the removal clears it, or the founding finds no park.
  const racer = await account('racer');
  const [raceRemoval, raceFounding] = await Promise.all([
    operator('POST', `/api/parks/${RACE}/remove-from-map`),
    found(racer.token, { parkId: RACE }, IN_RACE),
  ]);
  assert.equal(raceRemoval.status, 200, await raceRemoval.clone().text());
  assert.ok([200, 404].includes(raceFounding.status), `founding during removal answered ${raceFounding.status}`);
  assert.equal(await count('SELECT count(*) FROM public.parks WHERE id = $1', [RACE]), 0);
  assert.equal(await count('SELECT count(*) FROM kip_founders.parks WHERE park_id = $1', [RACE]), 0);
  // The founder bonus never survives. A founding that landed first keeps its visit's +6 plant
  // bonus, because removal keeps visits as history (#169).
  assert.equal(await score(racer.id), raceFounding.status === 200 ? 6 : 0, 'no founder bonus survives the removal');
  log(`a removal and a founding of the same park never interleave (the founding answered ${raceFounding.status})`);
} finally {
  await Promise.all(pending.splice(0)).catch(() => undefined);
  // pool.end() resolves before its connections close; the adapter ignores the server ending them
  // when the database is dropped WITH (FORCE) below.
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS "${owned}" WITH (FORCE)`);
  await admin.end();
}

import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// Found a park (#126) against real PostgreSQL: the full migration inventory replayed, then the
// real API routes with the real stores. Only sign-in, OpenStreetMap and the photo model are
// stand-ins. Covers founding a new OpenStreetMap park and a catalogue park in one transaction,
// concurrent founders, the founder bonus in player_scores, one visit per day, hidden parks,
// the cover photo, summary counts, analytics rows and account deletion, and outlines in a far
// part of a big catalogue park (#182), and two neighbouring parks where one name is inside the
// other (Steveston Town Square Park and Steveston Community Park).
// Content triggers check every park, so this runs in its own throwaway kip_qa_ database.
const shared = process.env.PGDATABASE;
assert.ok(shared?.startsWith('kip_qa_') || shared === 'kip_accounts_qa', 'SQL QA requires a dedicated kip_qa_ database');
const owned = `kip_qa_founders_${randomBytes(8).toString('hex')}`;
const admin = new pg.Client({ host: process.env.PGHOST, port: Number(process.env.PGPORT), user: process.env.PGUSER, password: process.env.PGPASSWORD, database: shared });
await admin.connect();
await admin.query(`CREATE DATABASE "${owned}"`);
process.env.PGDATABASE = owned;
const { applyMigration, dbUrl, pool } = await import('./qa-postgres-adapter.mjs');
const { createFeedbackWorker } = await import('../worker/index.ts');
const { publishStatements } = await import('../operator/server/drafts.ts');
const { EXIF_GPS_JPEG } = await import('../worker/fixtures/exif-gps-jpeg.ts');
const { PHOTO_FLAGS } = await import('../worker/founderPhoto.ts');

const root = new URL('../', import.meta.url);
const log = (name) => process.stdout.write(`${name}: PASS\n`);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const ORIGIN = 'https://kip.example.test';
const box = (west, south, east, north) => [[west, south], [east, south], [east, north], [west, north], [west, south]];
const multi = (...rings) => ({ type: 'MultiPolygon', coordinates: [rings] });
const osmBase = 900_000_000 + Math.floor(Math.random() * 90_000_000);
// More racers for a stress run; the adapter pool has 16 connections, so stay below that.
const RACERS = Math.min(Math.max(Number(process.env.FOUNDERS_QA_RACERS) || 4, 2), 12);

// Paterson Park in Ladner and a second OpenStreetMap park for the race; neither is in the catalogue yet.
const PATERSON = { type: 'way', id: osmBase, name: 'Paterson Park', kind: 'leisure=park', tags: { name: 'Paterson Park', leisure: 'park' }, geometry: multi(box(-123.062, 49.088, -123.058, 49.0902)), areaM2: 71_000 };
const RACE = { type: 'way', id: osmBase + 1, name: 'Race Meadow', kind: 'leisure=park', tags: { name: 'Race Meadow', leisure: 'park' }, geometry: multi(box(-123.05, 49.088, -123.047, 49.09)), areaM2: 50_000 };
const IN_PATERSON = { lat: 49.089, lng: -123.0601, accuracyM: 8 };
const IN_RACE = { lat: 49.089, lng: -123.0485, accuracyM: 8 };
const EXISTING = 'municipal-qa-founders-green';
const EXISTING_RING = box(-123.1, 49.1, -123.095, 49.103);
const IN_EXISTING = { lat: 49.1015, lng: -123.0975, accuracyM: 12 };
const HIDDEN = 'municipal-qa-founders-hidden';
// A two-part catalogue park: the pin is in the west part, the east part is about 70 km away and
// has a hole, like Kejimkujik and its Seaside (#182). Outlines in the east part are that park;
// outlines in the hole and just outside the part are new parks.
const BIG = 'national-qa-founders-two-parts';
const BIG_PIN = { lat: 48.01, lng: -124.19 };
const BIG_GEOMETRY = { type: 'MultiPolygon', coordinates: [
  [box(-124.2, 48, -124.18, 48.02)],
  [box(-123.25, 47.99, -123.21, 48.03), box(-123.235, 48.005, -123.225, 48.015)],
] };
const FAR_PART = { type: 'way', id: osmBase + 2, name: 'QA Founders Seaside', kind: 'leisure=nature_reserve', tags: { name: 'QA Founders Seaside', leisure: 'nature_reserve' }, geometry: multi(box(-123.245, 47.995, -123.24, 48)), areaM2: 200_000 };
const IN_FAR_PART = { lat: 47.9975, lng: -123.2425, accuracyM: 8 };
const IN_HOLE_PARK = { type: 'way', id: osmBase + 3, name: 'QA Hole Meadow', kind: 'leisure=park', tags: { name: 'QA Hole Meadow', leisure: 'park' }, geometry: multi(box(-123.232, 48.008, -123.228, 48.012)), areaM2: 130_000 };
const IN_HOLE = { lat: 48.01, lng: -123.23, accuracyM: 8 };
const NEIGHBOUR = { type: 'way', id: osmBase + 4, name: 'QA Neighbour Green', kind: 'leisure=park', tags: { name: 'QA Neighbour Green', leisure: 'park' }, geometry: multi(box(-123.205, 48, -123.2, 48.005)), areaM2: 210_000 };
const IN_NEIGHBOUR = { lat: 48.0025, lng: -123.2025, accuracyM: 8 };
// The real Steveston outlines: a small square about 120 m west of the big park, sharing no ground.
const TOWN_SQUARE = { type: 'way', id: osmBase + 5, name: 'Steveston Town Square Park', kind: 'leisure=park', tags: { name: 'Steveston Town Square Park', leisure: 'park' },
  geometry: multi([[-123.183254, 49.125553], [-123.182878, 49.125554], [-123.18288, 49.125276], [-123.183255, 49.125277], [-123.183254, 49.125553]]), areaM2: 838 };
const STEVESTON = { type: 'way', id: osmBase + 6, name: 'Steveston Community Park', kind: 'leisure=park', tags: { name: 'Steveston Community Park', leisure: 'park' },
  geometry: multi([[-123.180522, 49.125873], [-123.179685, 49.126405], [-123.179726, 49.127813], [-123.174312, 49.127932], [-123.174287, 49.125227],
    [-123.180991, 49.125252], [-123.18111, 49.125328], [-123.181113, 49.125879], [-123.180522, 49.125873]]), areaM2: 123_477 };
const IN_TOWN_SQUARE = { lat: 49.12541, lng: -123.18307, accuracyM: 8 };
const IN_STEVESTON = { lat: 49.1266, lng: -123.177, accuracyM: 8 };
const OUTLINES = [PATERSON, RACE, FAR_PART, IN_HOLE_PARK, NEIGHBOUR, TOWN_SQUARE, STEVESTON];
const inside = ([x, y], ring) => {
  let result = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    if ((ring[i][1] > y) !== (ring[j][1] > y) && x < ((ring[j][0] - ring[i][0]) * (y - ring[i][1])) / (ring[j][1] - ring[i][1]) + ring[i][0]) result = !result;
  }
  return result;
};
const IN_HIDDEN = { lat: 49.1215, lng: -123.0975, accuracyM: 12 };

const approve = {
  model: 'qa-model',
  answers: Object.fromEntries(PHOTO_FLAGS.map((flag) => [flag, { choice: 'no', probabilities: { yes: 0.01, no: 0.99 } }])),
};

// Sign-in is a stand-in keyed by bearer token; everything else reads and writes the database.
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
let clock = Date.parse('2026-10-08T17:00:00.000Z');
const pending = [];
const worker = createFeedbackWorker({
  auth: { createStore: () => authStore },
  osmClient: {
    // The outlines that contain the position, as the kip_osm table search answers.
    async search(lat, lng) {
      return OUTLINES.filter((feature) => feature.geometry.coordinates.some(([outer]) => inside([lng, lat], outer)))
        .map((feature) => ({ ...feature, containsPin: true, distanceM: 0 }));
    },
    async feature(ref) { return OUTLINES.find((feature) => feature.type === ref.type && feature.id === ref.id) ?? null; },
  },
  photoChecker: async () => approve,
  now: () => clock,
});
const env = {
  DATABASE_URL: dbUrl, PUBLIC_APP_URL: ORIGIN, AUTH_SESSION_SECRET: 'auth-test-secret-'.repeat(4), SESSION_SECRET: 'qa-session-secret-which-is-long-enough', EMAIL_MODE: 'disabled', CONTENT_CHANNEL: 'staging',
};

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

const photo = { mime: 'image/jpeg', base64: Buffer.from(EXIF_GPS_JPEG).toString('base64'), width: 16, height: 12 };
const found = (token, target, position, attemptId = randomUUID()) => call('POST', '/api/parks/found', { token, body: { attemptId, position, target, photo } });

async function account(name, handle = true) {
  const id = randomUUID();
  const token = randomBytes(32).toString('base64url');
  await pool.query('INSERT INTO kip_account.accounts (id, normalized_email, password_hash) VALUES ($1, $2, $3)', [id, `founders-${name}-${id.slice(0, 6)}@example.test`, 'qa-hash']);
  if (handle) await pool.query("INSERT INTO kip_game.players (account_id, handle, flag_seed, created_at) VALUES ($1, $2, kip_game.flag_seed($1), '2026-10-01T00:00:00Z')", [id, `qa_${name}_${id.slice(0, 4)}`]);
  players.set(hash(token), id);
  return { id, token, handle: `qa_${name}_${id.slice(0, 4)}` };
}

/** A catalogue park published the way the operator dashboard does. */
async function publishPark(id, name, ring, { geometry = multi(ring), pin = { lat: ring[0][1], lng: ring[0][0] } } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO kip_park_drafts.drafts (id, source, source_sha256, geometry, name, short, category, region, lat, lng, biome, shape, rarity, seed, blurb)
       VALUES ($1, '{}'::jsonb, $2, $3::jsonb, $4, $4, 'municipal', 'South Coast', $5, $6, 'forest', 'circle', 'common', 1, 'A QA park.') RETURNING updated_at`,
      [id, 'a'.repeat(64), JSON.stringify(geometry), name, pin.lat, pin.lng],
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

const count = async (sql, params) => Number((await pool.query(sql, params)).rows[0].count);
const score = async (accountId, at = new Date(clock).toISOString()) => (await pool.query('SELECT score FROM kip_game.player_scores($1) WHERE account_id = $2', [at, accountId])).rows[0]?.score;
const json = async (response) => response.json();

try {
  const config = JSON.parse(readFileSync(new URL('deployment.json', root), 'utf8'));
  const inventory = [config.migrationPath, ...config.contentSync.supportingMigrationPaths, ...config.optionalMigrationPaths, ...config.contentSync.migrationPaths, ...config.independentMigrationPaths];
  // founders_001 must replay after the migrations whose functions and checks it widens.
  const position = (name) => inventory.indexOf(`database/migrations/${name}`);
  assert.ok(position('founders_001_init.sql') > position('game_001_init.sql') && position('founders_001_init.sql') > position('interactions_002_db_events.sql'));
  for (const path of inventory) await applyMigration(fileURLToPath(new URL(path, root)));
  // Every deploy replays the whole inventory: game_001 and interactions_002 run again before founders_001.
  for (const path of inventory) await applyMigration(fileURLToPath(new URL(path, root)));
  const constraints = (await pool.query(`SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
    WHERE conrelid = 'kip_analytics.events'::regclass AND conname IN ('events_event_type_v2_check', 'events_shape_v2_check')`)).rows;
  assert.equal(constraints.length, 2);
  for (const row of constraints) assert.match(row.def, /park_founded/, row.conname);
  await pool.query("INSERT INTO public.drive_hubs (position, name, lng, lat) VALUES (0, 'Victoria', -123.36, 48.43), (1, 'Nanaimo', -123.94, 49.17) ON CONFLICT DO NOTHING");
  await assert.rejects(pool.query("INSERT INTO kip_founders.photo_checks (id, account_id, attempt_id, park_id, outcome, flags, photo_sha256) VALUES ($1, $1, $1, 'x', 'approve', ARRAY['bad_flag'], $2)", [randomUUID(), 'a'.repeat(64)]), /check constraint|violates/);
  log('the migration replays after game_001 and interactions_002, and widens the analytics checks once');

  const a = await account('a');
  const b = await account('b');
  const c = await account('c');
  const d = await account('d');
  const noHandle = await account('n', false);
  await publishPark(EXISTING, 'QA Founders Green', EXISTING_RING);
  await publishPark(HIDDEN, 'QA Hidden Green', box(-123.1, 49.12, -123.095, 49.123));
  await pool.query("INSERT INTO public.content_park_hidden (park_id, reason, source) VALUES ($1, 'QA', 'operator')", [HIDDEN]);
  const revisionBefore = Number((await pool.query('SELECT revision FROM public.content_clock')).rows[0].revision);

  const attemptId = randomUUID();
  const response = await found(a.token, { osm: { type: 'way', id: PATERSON.id } }, IN_PATERSON, attemptId);
  assert.equal(response.status, 200, await response.clone().text());
  const result = await json(response);
  const parkId = `osm-way-${PATERSON.id}`;
  assert.equal(result.outcome, 'founded');
  assert.deepEqual(result.park, { id: parkId, name: 'Paterson Park' });
  assert.equal(result.founderPoints, 24);
  assert.equal(result.visit.outcome, 'planted');
  const park = (await pool.query('SELECT * FROM public.parks WHERE id = $1', [parkId])).rows[0];
  assert.equal(park.category, 'municipal');
  assert.notDeepEqual([park.lng, park.lat], [IN_PATERSON.lng, IN_PATERSON.lat], 'the marker is not the founder position');
  assert.ok(park.lng > -123.062 && park.lng < -123.058 && park.lat > 49.088 && park.lat < 49.0902, 'the marker is inside the outline');
  assert.deepEqual((await pool.query('SELECT feature FROM public.boundaries WHERE park_id = $1', [parkId])).rows[0].feature.geometry, PATERSON.geometry);
  assert.equal(await count('SELECT count(*) FROM public.park_drive WHERE park_id = $1', [parkId]), 2);
  assert.ok(Number((await pool.query('SELECT revision FROM public.content_clock')).rows[0].revision) > revisionBefore, 'publishing advances the content revision');
  const proposal = (await pool.query('SELECT * FROM kip_proposals.parks WHERE published_park_id = $1', [parkId])).rows[0];
  assert.equal(proposal.status, 'accepted');
  assert.equal(proposal.decision, 'approved');
  assert.equal(proposal.founder_account_id, a.id);
  assert.equal(proposal.submission_id, attemptId);
  assert.equal((await pool.query('SELECT status, source FROM kip_park_drafts.drafts WHERE id = $1', [parkId])).rows[0].status, 'published');
  const founder = (await pool.query('SELECT account_id, source, photo_width, photo_height, encode(photo_bytes, \'escape\') AS text, octet_length(photo_bytes) AS size FROM kip_founders.parks WHERE park_id = $1', [parkId])).rows[0];
  assert.deepEqual([founder.account_id, founder.source, founder.photo_width, founder.photo_height], [a.id, 'osm_new', 16, 12]);
  assert.ok(!founder.text.includes('QA Camera Maker') && !founder.text.includes('GPSLatitude'), 'the stored photo has no metadata');
  assert.equal(await count("SELECT count(*) FROM kip_game.visits WHERE account_id = $1 AND park_id = $2 AND source = 'visit'", [a.id, parkId]), 1);
  assert.equal((await pool.query('SELECT handle FROM kip_game.flags_up($1) WHERE park_id = $2', [new Date(clock + 1000).toISOString(), parkId])).rows[0].handle, a.handle);
  assert.equal(await score(a.id), 24 + 6, 'founding pays the 24 point bonus and the 6 point plant bonus at once');
  log('founding an OpenStreetMap park publishes it, stores the photo, plants the flag and pays the bonus in one transaction');

  const replay = await found(a.token, { osm: { type: 'way', id: PATERSON.id } }, IN_PATERSON, attemptId);
  assert.equal(replay.status, 200);
  assert.deepEqual(await json(replay), result);
  assert.equal(await count('SELECT count(*) FROM kip_founders.photo_checks WHERE attempt_id = $1', [attemptId]), 1);
  const again = await found(b.token, { osm: { type: 'way', id: PATERSON.id } }, IN_PATERSON);
  assert.equal(again.status, 409);
  assert.equal((await json(again)).message, `This park already has a founder: @${a.handle}.`);
  log('a retry replays the founding and a second founder gets 409');

  // C visits the catalogue park first and holds its flag; B founds it later the same day and takes it.
  const cVisit = await pool.query('SELECT kip_game.record_visit($1, $2, $3, $4) AS result', [randomUUID(), c.id, EXISTING, new Date(clock - 2 * 86_400_000).toISOString()]);
  assert.equal(cVisit.rows[0].result.status, 'recorded');
  await pool.query('SELECT kip_game.record_visit($1, $2, $3, $4)', [randomUUID(), b.id, EXISTING, new Date(clock - 3_600_000).toISOString()]);
  const existing = await found(b.token, { parkId: EXISTING }, IN_EXISTING);
  assert.equal(existing.status, 200, await existing.clone().text());
  const existingResult = await json(existing);
  assert.deepEqual(existingResult.park, { id: EXISTING, name: 'QA Founders Green' });
  assert.equal(existingResult.visit.outcome, 'already_today', 'founding counts as today\'s visit, and B already visited today');
  assert.equal(await count("SELECT count(*) FROM kip_game.visits WHERE account_id = $1 AND park_id = $2 AND local_day = kip_game.local_day($3) AND source = 'visit'", [b.id, EXISTING, new Date(clock).toISOString()]), 1);
  assert.equal(await count('SELECT count(*) FROM kip_park_drafts.drafts WHERE id = $1', [EXISTING]), 1, 'nothing new is published for a catalogue park');
  assert.equal((await pool.query('SELECT source FROM kip_founders.parks WHERE park_id = $1', [EXISTING])).rows[0].source, 'existing');
  log('founding a catalogue park records the founder and counts as the one visit of the day');

  // D founds a park C holds: the founding visit takes the flag.
  await publishPark('municipal-qa-founders-take', 'QA Take Green', box(-123.1, 49.11, -123.095, 49.113));
  await pool.query('SELECT kip_game.record_visit($1, $2, $3, $4)', [randomUUID(), c.id, 'municipal-qa-founders-take', new Date(clock - 3 * 86_400_000).toISOString()]);
  const take = await json(await found(d.token, { parkId: 'municipal-qa-founders-take' }, { lat: 49.1115, lng: -123.0975, accuracyM: 5 }));
  assert.equal(take.visit.outcome, 'took');
  assert.equal(take.visit.pointsEarned, 4 + 3);
  assert.equal(take.visit.previousHolder.handle, c.handle);
  assert.equal(await score(d.id), 7 + 24, 'the take plus the founder bonus');
  log('a founding visit takes a held flag');

  const racers = await Promise.all(Array.from({ length: RACERS }, (_, index) => account(`r${index}`)));
  const raced = await Promise.all(racers.map((racer) => found(racer.token, { osm: { type: 'way', id: RACE.id } }, IN_RACE)));
  assert.deepEqual(raced.map((r) => r.status).sort(), [200, ...Array(RACERS - 1).fill(409)]);
  assert.equal(await count('SELECT count(*) FROM kip_founders.parks WHERE park_id = $1', [`osm-way-${RACE.id}`]), 1);
  assert.equal(await count('SELECT count(*) FROM public.parks WHERE id = $1', [`osm-way-${RACE.id}`]), 1);
  assert.equal(await count('SELECT count(*) FROM kip_proposals.parks WHERE published_park_id = $1', [`osm-way-${RACE.id}`]), 1, 'losers leave no audit row');
  assert.equal(await count("SELECT count(*) FROM kip_game.visits WHERE park_id = $1 AND source = 'visit'", [`osm-way-${RACE.id}`]), 1, 'losers record no visit');
  const catalogueRacers = await Promise.all(Array.from({ length: RACERS - 1 }, (_, index) => account(`s${index}`)));
  await publishPark('municipal-qa-founders-race', 'QA Race Green', box(-123.1, 49.13, -123.095, 49.133));
  const racedExisting = await Promise.all(catalogueRacers.map((racer) => found(racer.token, { parkId: 'municipal-qa-founders-race' }, { lat: 49.1315, lng: -123.0975, accuracyM: 5 })));
  assert.deepEqual(racedExisting.map((r) => r.status).sort(), [200, ...Array(RACERS - 2).fill(409)]);
  log('concurrent founders: exactly one wins, for a new and for a catalogue park');

  const hidden = await found(c.token, { parkId: HIDDEN }, IN_HIDDEN);
  assert.equal(hidden.status, 404);
  assert.equal(await count('SELECT count(*) FROM kip_founders.parks WHERE park_id = $1', [HIDDEN]), 0);
  assert.equal((await call('GET', `/api/parks/${HIDDEN}/summary`)).status, 404);
  assert.equal((await found(noHandle.token, { parkId: EXISTING }, IN_EXISTING)).status, 409);
  log('hidden parks and players without a handle are refused');

  const cover = await call('GET', new URL(result.coverUrl).pathname);
  assert.equal(cover.status, 200);
  assert.equal(cover.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  const coverBytes = Buffer.from(await cover.arrayBuffer());
  assert.equal(hash(coverBytes), new URL(result.coverUrl).pathname.split('/').at(-1).replace('.jpg', ''));
  assert.ok(!coverBytes.toString('latin1').includes('GPSLatitude'));
  log('the cover photo is served by its hash without metadata');

  // Summary counts: three more visits to Paterson Park, one of them 40 days ago.
  await pool.query('SELECT kip_game.record_visit($1, $2, $3, $4)', [randomUUID(), b.id, parkId, new Date(clock - 40 * 86_400_000).toISOString()]);
  await pool.query('SELECT kip_game.record_visit($1, $2, $3, $4)', [randomUUID(), b.id, parkId, new Date(clock - 2 * 86_400_000).toISOString()]);
  await pool.query('SELECT kip_game.record_visit($1, $2, $3, $4)', [randomUUID(), c.id, parkId, new Date(clock - 86_400_000).toISOString()]);
  const publicSummary = await json(await call('GET', `/api/parks/${parkId}/summary`));
  assert.deepEqual(publicSummary.visits, { total: 4, last30Days: 3, mine: null });
  assert.equal(publicSummary.founder.handle, a.handle);
  assert.equal(publicSummary.coverUrl, result.coverUrl);
  assert.deepEqual((await json(await call('GET', `/api/parks/${parkId}/summary`, { token: b.token }))).visits, { total: 4, last30Days: 3, mine: 2 });
  const plain = await json(await call('GET', `/api/parks/${EXISTING}/summary`));
  assert.equal(plain.founder.handle, b.handle);
  const flags = await json(await call('GET', '/api/game/flags'));
  assert.ok(flags.founders.some((item) => item.parkId === parkId && item.handle === a.handle && item.coverUrl === result.coverUrl));
  const me = await json(await call('GET', '/api/game/me', { token: a.token }));
  assert.equal(me.founderPoints, 24);
  const board = await json(await call('GET', '/api/game/leaderboard'));
  assert.equal(board.players.find((row) => row.handle === a.handle).score, await score(a.id));
  assert.ok(await score(a.id) >= 24 + 6);
  log('summary counts, flags, me and the leaderboard include founders');

  const osmSearch = await json(await call('GET', `/api/osm/parks?lat=${IN_EXISTING.lat}&lng=${IN_EXISTING.lng}&accuracy=10`));
  assert.ok(Array.isArray(osmSearch.parks));
  log('the outline search answers against the real catalogue');

  // #182: a big park's far part. Its pin is 70 km away, far outside the 5 km pin search.
  await publishPark(BIG, 'QA Two Parts National Park', null, { geometry: BIG_GEOMETRY, pin: BIG_PIN });
  const bigBox = (await pool.query('SELECT public.park_boundary_box(feature)::text AS box FROM public.boundaries WHERE park_id = $1', [BIG])).rows[0].box;
  assert.equal(bigBox, '(-123.21,48.03),(-124.2,47.99)', 'the boundary box spans both parts');
  const search = async (position) => (await json(await call('GET', `/api/osm/parks?lat=${position.lat}&lng=${position.lng}&accuracy=${position.accuracyM}`))).parks;
  const farSearch = await search(IN_FAR_PART);
  assert.deepEqual(farSearch.map((item) => [item.name, item.inCatalogue]), [['QA Founders Seaside', { parkId: BIG, name: 'QA Two Parts National Park' }]]);
  const holeSearch = await search(IN_HOLE);
  assert.deepEqual(holeSearch.map((item) => [item.name, item.inCatalogue]), [['QA Hole Meadow', null]], 'a park in a hole of the big park is a new park');
  const neighbourSearch = await search(IN_NEIGHBOUR);
  assert.deepEqual(neighbourSearch.map((item) => [item.name, item.inCatalogue]), [['QA Neighbour Green', null]], 'a park next to the far part is a new park');
  log('the outline search marks an outline in a part 70 km from the pin as that catalogue park, and not one in its hole or next to it');

  const e = await account('e');
  const farFounding = await found(e.token, { osm: { type: 'way', id: FAR_PART.id } }, IN_FAR_PART);
  assert.equal(farFounding.status, 200, await farFounding.clone().text());
  assert.deepEqual((await json(farFounding)).park, { id: BIG, name: 'QA Two Parts National Park' });
  assert.equal(await count('SELECT count(*) FROM public.parks WHERE id = $1', [`osm-way-${FAR_PART.id}`]), 0, 'the far part is not published as a new park');
  assert.equal((await pool.query('SELECT source FROM kip_founders.parks WHERE park_id = $1', [BIG])).rows[0].source, 'existing');
  const again182 = await found(c.token, { osm: { type: 'way', id: FAR_PART.id } }, IN_FAR_PART);
  assert.equal(again182.status, 409, 'founding the far part again is the catalogue park, which has a founder now');
  assert.equal((await json(again182)).code, 'already_founded');
  const holeFounding = await found(c.token, { osm: { type: 'way', id: IN_HOLE_PARK.id } }, IN_HOLE);
  assert.equal(holeFounding.status, 200, await holeFounding.clone().text());
  assert.equal((await json(holeFounding)).park.id, `osm-way-${IN_HOLE_PARK.id}`);
  const neighbourFounding = await found(d.token, { osm: { type: 'way', id: NEIGHBOUR.id } }, IN_NEIGHBOUR);
  assert.equal(neighbourFounding.status, 200, await neighbourFounding.clone().text());
  assert.equal((await json(neighbourFounding)).park.id, `osm-way-${NEIGHBOUR.id}`);
  log('founding an outline in the far part founds the catalogue park; the hole and the neighbour are published as new parks');

  // A name inside a longer one is not the same park: founding Steveston Town Square Park must not
  // make Steveston Community Park, next door, "already founded" (or the other way round).
  const f = await account('f');
  const squareFounding = await found(f.token, { osm: { type: 'way', id: TOWN_SQUARE.id } }, IN_TOWN_SQUARE);
  assert.equal(squareFounding.status, 200, await squareFounding.clone().text());
  assert.equal((await json(squareFounding)).park.id, `osm-way-${TOWN_SQUARE.id}`);
  const stevestonSearch = await search(IN_STEVESTON);
  assert.deepEqual(stevestonSearch.map((item) => [item.name, item.inCatalogue, item.founder]), [['Steveston Community Park', null, null]], 'the big park is not marked as the founded square');
  const stevestonFounding = await found(f.token, { osm: { type: 'way', id: STEVESTON.id } }, IN_STEVESTON);
  assert.equal(stevestonFounding.status, 200, await stevestonFounding.clone().text());
  assert.equal((await json(stevestonFounding)).park.id, `osm-way-${STEVESTON.id}`);
  assert.equal((await pool.query('SELECT source FROM kip_founders.parks WHERE park_id = $1', [`osm-way-${STEVESTON.id}`])).rows[0].source, 'osm_new');
  const squareSearch = await search(IN_TOWN_SQUARE);
  assert.deepEqual(squareSearch.map((item) => [item.name, item.inCatalogue?.parkId, item.founder?.handle]), [['Steveston Town Square Park', `osm-way-${TOWN_SQUARE.id}`, f.handle]], 'the square is still itself');
  log("founding a park whose name is inside a neighbour's name leaves the neighbour free to found");

  const events = (await pool.query("SELECT event_type, park_id, properties, route FROM kip_analytics.events WHERE event_type IN ('park_founded', 'founder_photo_checked') ORDER BY occurred_at")).rows;
  assert.ok(events.some((event) => event.event_type === 'park_founded' && event.park_id === parkId && event.properties.source === 'osm_new' && event.route === 'POST /api/parks/found'));
  assert.ok(events.some((event) => event.event_type === 'founder_photo_checked' && event.properties.outcome === 'approve'));
  assert.ok(await count("SELECT count(*) FROM kip_analytics.events WHERE route = 'GET /api/parks/:park/summary'", []) > 0);
  log('park_founded and founder_photo_checked are stored in kip_analytics.events');

  const usage = await count('SELECT count(*) FROM kip_founders.photo_checks WHERE account_id = $1', [a.id]);
  assert.equal(usage, 1);
  await pool.query('DELETE FROM kip_account.accounts WHERE id = $1', [a.id]);
  assert.equal(await count('SELECT count(*) FROM kip_founders.parks WHERE park_id = $1', [parkId]), 0, 'the photo goes with the account');
  assert.equal(await count('SELECT count(*) FROM kip_founders.photo_checks WHERE account_id = $1', [a.id]), 0);
  assert.equal((await pool.query('SELECT founder_account_id FROM kip_proposals.parks WHERE published_park_id = $1', [parkId])).rows[0].founder_account_id, null);
  assert.equal(await count('SELECT count(*) FROM public.parks WHERE id = $1', [parkId]), 1, 'the park stays');
  assert.equal((await json(await call('GET', `/api/parks/${parkId}/summary`))).founder, null);
  log('deleting the founder account removes the founder and photo; the park stays and can be founded again');
} finally {
  await Promise.all(pending.splice(0)).catch(() => undefined);
  // pool.end() resolves before its connections close; the adapter ignores the server ending them
  // when the database is dropped WITH (FORCE) below.
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS "${owned}" WITH (FORCE)`);
  await admin.end();
}

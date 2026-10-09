// End-to-end check of reversible park hiding against a real PostgreSQL database:
// the reviewed plan and apply tool, the snapshot and changes SQL for every reader,
// the app's strict and current readers applying the tombstones, the CDN release
// builder, new parks under a hidden category, player proposals, and the flag game.
// It runs in its own throwaway database so its content triggers stay out of the
// other SQL QA scripts.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = fileURLToPath(new URL('..', import.meta.url));
const baseDatabase = process.env.PGDATABASE;
assert.ok(['127.0.0.1', 'localhost', '::1'].includes(process.env.PGHOST), 'SQL QA only accepts a loopback PostgreSQL host');
assert.ok(baseDatabase === 'kip_accounts_qa' || baseDatabase?.startsWith('kip_qa_'), 'SQL QA requires a dedicated kip_qa_ database');
const database = `kip_qa_visibility_${randomBytes(4).toString('hex')}`;
const admin = new pg.Client({ host: process.env.PGHOST, port: Number(process.env.PGPORT), user: process.env.PGUSER, password: process.env.PGPASSWORD, database: baseDatabase });
const log = (name) => process.stdout.write(`${name}: PASS\n`);
const REASON = 'Testers want a less dense map: provincial, national and regional parks only.';

function response() {
  let body = '';
  return { statusCode: 0, get body() { return body; }, setHeader() {}, end(value) { body = value ?? ''; } };
}

function square(lng, lat) {
  return { type: 'MultiPolygon', coordinates: [[[[lng, lat], [lng + 0.01, lat], [lng + 0.01, lat + 0.01], [lng, lat + 0.01], [lng, lat]]]] };
}

await admin.connect();
await admin.query(`CREATE DATABASE ${database}`);
process.env.PGDATABASE = database;
const adapter = await import('./qa-postgres-adapter.mjs');
const { createChangesHandler, createSnapshotHandler } = await import('../worker/content_sync.ts');
const { createNeonGameStore } = await import('../worker/game-store.ts');
const { isParkHidden } = await import('../worker/parkVisibility.ts');
const { database: sqlClient } = await import('../worker/db.ts');
const current = await import('../src/lib/content/manifest.ts');
const strict = await import('../src/lib/content/compat/reader-v1.ts');
const work = await mkdtemp(join(tmpdir(), 'parkdex-visibility-qa-'));
const pool = adapter.pool;

async function serve(handler, query) {
  const res = response();
  await handler({ env: { DATABASE_URL: adapter.dbUrl } })({ method: 'GET', query, headers: {} }, res);
  assert.equal(res.statusCode, 200, res.body);
  return JSON.parse(res.body);
}

function python(script, args) {
  const result = spawnSync(process.env.PYTHON ?? 'python', [join(root, 'scripts', script), ...args], {
    env: { ...process.env, DATABASE_URL: adapter.dbUrl }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

async function addPark(client, id, category, lng, lat, floor) {
  await client.query(
    "INSERT INTO public.parks (id, name, short, category, region, lat, lng, biome, shape, rarity, scene, seed, blurb) VALUES ($1, $2, $1, $3, 'QA', $4, $5, 'forest', 'circle', 'common', NULL, 7, 'A QA park.')",
    [id, `Park ${id}`, category, lat + 0.005, lng + 0.005],
  );
  await client.query('INSERT INTO public.park_drive_settings (park_id, walk_m) VALUES ($1, 0)', [id]);
  await client.query('INSERT INTO public.park_drive (park_id, hub_position, distance_km, duration_min) VALUES ($1, 0, NULL, NULL)', [id]);
  await client.query('INSERT INTO public.boundaries (park_id, feature) VALUES ($1, $2::jsonb)', [id, JSON.stringify({ type: 'Feature', properties: { id, biome: 'forest' }, geometry: square(lng, lat) })]);
  if (floor) await client.query('INSERT INTO public.content_park_reader_floor (park_id, minimum_reader) VALUES ($1, $2)', [id, floor]);
}

async function inTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await work(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const ids = (body) => body.parks.map((park) => park.id).sort();
const plan = (args) => {
  const out = join(work, `plan-${randomBytes(3).toString('hex')}.json`);
  const summary = python('park_visibility.py', ['plan', ...args, '--target-host', process.env.PGHOST, '--target-environment', 'local-qa', '--out', out]);
  return { ...summary, out };
};
const apply = (planned) => python('park_visibility.py', ['apply', '--plan', planned.out, '--reviewed-plan-sha', planned.planSha256, '--expected-target-host', process.env.PGHOST, '--target-environment', 'local-qa']);

try {
  for (const name of ['001_cloud_content.sql', 'migrations/content_001_sync.sql', 'migrations/content_002_authoring.sql', 'migrations/content_003_park_maps_link.sql',
    'migrations/content_004_catalogue_release.sql', 'migrations/content_005_park_visibility.sql', 'migrations/content_005_park_visibility.sql',
    'migrations/accounts_001_init.sql', 'migrations/progress_001_init.sql', 'migrations/game_001_init.sql',
    'migrations/park_drafts_001_init.sql', 'migrations/park_drafts_002_proposals.sql']) {
    await adapter.applyMigration(join(root, 'database', name));
  }
  await inTransaction(async (client) => {
    await client.query("INSERT INTO public.drive_hubs (position, name, lng, lat) VALUES (0, 'Downtown', -123.36, 48.42)");
    await addPark(client, 'provincial-qa-keep', 'provincial', -123.5, 48.5);
    await addPark(client, 'municipal-qa-local', 'municipal', -123.37, 48.42);
    await addPark(client, 'community-qa-hall', 'community', -123.38, 48.43);
    await addPark(client, 'municipal-qa-cdn', 'municipal', -120.3, 50.7, 3);
    await addPark(client, 'osm-way-4242', 'municipal', -123.39, 48.44);
  });
  const before = await serve(createSnapshotHandler, { reader: '2' });
  assert.deepEqual(ids(before), ['community-qa-hall', 'municipal-qa-local', 'osm-way-4242', 'provincial-qa-keep']);
  const strictState = strict.parseContentSnapshot(await serve(createSnapshotHandler, { reader: '1' }));
  const currentState = current.parseContentSnapshot(await serve(createSnapshotHandler, { reader: '3' }));
  log('fixture catalogue before hiding');

  // Players and a flag on a park that is about to be hidden.
  const store = createNeonGameStore(adapter.dbUrl);
  const holder = randomUUID();
  await pool.query('INSERT INTO kip_account.accounts (id, normalized_email, password_hash) VALUES ($1, $2, $3)', [holder, `vis-${database}@example.test`, 'qa-hash']);
  await pool.query("INSERT INTO kip_game.players (account_id, handle, flag_seed, created_at) VALUES ($1, $2, kip_game.flag_seed($1), now() - interval '2 days')", [holder, `vis${database.slice(-6)}`]);
  const visitId = randomUUID();
  const planted = await store.recordVisit(holder, visitId, 'municipal-qa-local', new Date(Date.now() - 36 * 3_600_000).toISOString());
  assert.equal(planted.status, 'recorded');

  const hidePlan = plan(['hide', '--category', 'municipal', '--category', 'community', '--reason', REASON]);
  assert.equal(hidePlan.total, 3);
  assert.equal(hidePlan.counts.municipal.change, 2);
  assert.equal(hidePlan.counts.municipal.keptVisibleAsPlayerProposals, 1);
  assert.equal(hidePlan.counts.municipal.changeServedToReaders1And2, 1);
  assert.equal(hidePlan.counts.community.change, 1);
  const headBefore = Number((await pool.query('SELECT revision FROM public.content_clock')).rows[0].revision);
  const applied = apply(hidePlan);
  assert.equal(applied.result, 'applied');
  assert.equal(applied.revision, headBefore + 1);
  assert.equal(apply(hidePlan).result, 'already-current');
  assert.equal(Number((await pool.query('SELECT count(*) FROM public.parks')).rows[0].count), 5);
  log('reviewed hide plan applies once as one revision and replays as a no-op, keeping every row');

  for (const reader of ['1', '2', '3']) {
    assert.deepEqual(ids(await serve(createSnapshotHandler, { reader })), reader === '3' ? ['osm-way-4242', 'provincial-qa-keep'] : ['osm-way-4242', 'provincial-qa-keep']);
  }
  const strictChanges = await serve(createChangesHandler, { after: String(headBefore), reader: '1' });
  const tombstones = strictChanges.batches[0].changes.map((change) => `${change.entity}:${change.op}:${change.id}`).sort();
  assert.deepEqual(tombstones, ['boundary:delete:community-qa-hall', 'boundary:delete:municipal-qa-local', 'drive:delete:community-qa-hall', 'drive:delete:municipal-qa-local', 'park:delete:community-qa-hall', 'park:delete:municipal-qa-local']);
  const strictAfter = strict.applyContentChangeBatch(strictState, strict.parseContentChanges(strictChanges, headBefore).batches[0]);
  assert.deepEqual(strictAfter.parks.map((park) => park.id).sort(), ['osm-way-4242', 'provincial-qa-keep']);
  const currentChanges = await serve(createChangesHandler, { after: String(headBefore), reader: '3' });
  assert.ok(currentChanges.batches[0].changes.some((change) => change.id === 'municipal-qa-cdn' && change.op === 'delete'));
  const currentAfter = current.applyContentChangeBatch(currentState, current.parseContentChanges(currentChanges, headBefore).batches[0]);
  assert.deepEqual(currentAfter.parks.map((park) => park.id).sort(), ['osm-way-4242', 'provincial-qa-keep']);
  log('hidden parks leave every snapshot and reach installed readers as tombstones they apply');

  await pool.query("UPDATE public.parks SET blurb = 'Edited while hidden.' WHERE id = 'municipal-qa-local'");
  const edit = await serve(createChangesHandler, { after: String(applied.revision), reader: '2' });
  assert.deepEqual(edit.batches[0].changes.map((change) => change.entity), ['hubs']);
  log('an edit to a hidden park does not bring it back');

  await inTransaction(async (client) => {
    await addPark(client, 'community-qa-new', 'community', -123.4, 48.45);
    await client.query("INSERT INTO kip_park_drafts.drafts (id, source, source_sha256, geometry, name, category, region, lat, lng, seed) VALUES ('municipal-qa-proposed', $1::jsonb, $2, $3::jsonb, 'Proposed Park', 'municipal', 'QA', 48.465, -123.405, 9)",
      [JSON.stringify({ proposal: { id: randomUUID(), name: 'Proposed Park' } }), 'a'.repeat(64), JSON.stringify(square(-123.41, 48.46))]);
    await addPark(client, 'municipal-qa-proposed', 'municipal', -123.41, 48.46);
    await addPark(client, 'osm-relation-77', 'community', -123.42, 48.47);
  });
  const withNew = await serve(createSnapshotHandler, { reader: '2' });
  assert.deepEqual(ids(withNew), ['municipal-qa-proposed', 'osm-relation-77', 'osm-way-4242', 'provincial-qa-keep']);
  const sinceHide = strict.parseContentChanges(await serve(createChangesHandler, { after: String(applied.revision), reader: '1' }), applied.revision);
  const strictNow = sinceHide.batches.reduce((state, batch) => strict.applyContentChangeBatch(state, batch), strictAfter);
  assert.deepEqual(strictNow.parks.map((park) => park.id).sort(), ['municipal-qa-proposed', 'osm-relation-77', 'osm-way-4242', 'provincial-qa-keep']);
  const sql = sqlClient(adapter.dbUrl);
  assert.equal(await isParkHidden(sql, 'community-qa-new'), true);
  assert.equal(await isParkHidden(sql, 'municipal-qa-proposed'), false);
  assert.equal(await isParkHidden(sql, 'provincial-qa-keep'), false);
  log('a new park in a hidden category is hidden on insert, and player proposals stay visible');

  const releaseDir = join(work, 'release');
  const release = python('content_catalogue.py', ['build', '--out', releaseDir, '--target-host', process.env.PGHOST, '--target-environment', 'local-qa']);
  const index = JSON.parse(await readFile(join(releaseDir, 'content', 'catalogue', 'index.json'), 'utf8'));
  assert.equal(release.parkCount, 4);
  assert.deepEqual(index.parks.map((park) => park.id).sort(), ['municipal-qa-proposed', 'osm-relation-77', 'osm-way-4242', 'provincial-qa-keep']);
  log('the CDN catalogue release leaves hidden parks out');

  const blocked = await store.recordVisit(holder, randomUUID(), 'municipal-qa-local', new Date().toISOString());
  assert.equal(blocked.status, 'park_not_found');
  const replay = await store.recordVisit(holder, visitId, 'municipal-qa-local', new Date().toISOString());
  assert.equal(replay.status, 'replayed');
  const summary = await store.summary(holder, new Date().toISOString());
  assert.equal(summary.parks[0]?.parkId, 'municipal-qa-local');
  assert.ok(summary.score >= 1);
  assert.equal(Number((await pool.query('SELECT count(*) FROM kip_game.visits WHERE account_id = $1', [holder])).rows[0].count), 1);
  log('hidden parks take no new visits; stored visits, flags and scores remain');

  const unhidePlan = plan(['unhide', '--category', 'municipal', '--category', 'community']);
  assert.equal(unhidePlan.total, 4);
  const headHidden = Number((await pool.query('SELECT revision FROM public.content_clock')).rows[0].revision);
  assert.equal(apply(unhidePlan).result, 'applied');
  assert.equal(apply(unhidePlan).result, 'already-current');
  const restored = await serve(createSnapshotHandler, { reader: '2' });
  assert.deepEqual(ids(restored), ['community-qa-hall', 'community-qa-new', 'municipal-qa-local', 'municipal-qa-proposed', 'osm-relation-77', 'osm-way-4242', 'provincial-qa-keep']);
  assert.equal(restored.parks.find((park) => park.id === 'municipal-qa-local').blurb, 'Edited while hidden.');
  const back = await serve(createChangesHandler, { after: String(headHidden), reader: '1' });
  const upserts = back.batches[0].changes.filter((change) => change.op === 'upsert').map((change) => `${change.entity}:${change.id}`).sort();
  assert.ok(['park:municipal-qa-local', 'boundary:municipal-qa-local', 'drive:municipal-qa-local', 'park:community-qa-new'].every((key) => upserts.includes(key)));
  assert.ok(!upserts.includes('park:municipal-qa-cdn'));
  const strictRestored = strict.applyContentChangeBatch(strictAfter, strict.parseContentChanges(back, headHidden).batches[0]);
  assert.ok(strictRestored.parks.some((park) => park.id === 'municipal-qa-local'));
  assert.notEqual((await store.recordVisit(holder, randomUUID(), 'municipal-qa-local', new Date().toISOString())).status, 'park_not_found');
  log('unhide restores the parks with their current values for every reader and reopens visits');
} finally {
  await pool.end();
  await rm(work, { recursive: true, force: true });
  await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  await admin.end();
}

// End-to-end check of the CDN catalogue path against a real PostgreSQL database:
// reader floors in the snapshot and changes SQL, the release builder and pointer
// tool, and the app's reader assembling the release back into one catalogue.
// It runs in its own throwaway database so the content triggers it installs do
// not affect the other SQL QA scripts.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = fileURLToPath(new URL('..', import.meta.url));
const baseDatabase = process.env.PGDATABASE;
assert.ok(['127.0.0.1', 'localhost', '::1'].includes(process.env.PGHOST), 'SQL QA only accepts a loopback PostgreSQL host');
assert.ok(baseDatabase === 'kip_accounts_qa' || baseDatabase?.startsWith('kip_qa_'), 'SQL QA requires a dedicated kip_qa_ database');
const database = `kip_qa_catalogue_${randomBytes(4).toString('hex')}`;
const admin = new pg.Client({ host: process.env.PGHOST, port: Number(process.env.PGPORT), user: process.env.PGUSER, password: process.env.PGPASSWORD, database: baseDatabase });
const log = (name) => process.stdout.write(`${name}: PASS\n`);

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
const reader = await import('../src/lib/content/manifest.ts');
const work = await mkdtemp(join(tmpdir(), 'parkdex-catalogue-qa-'));

async function serve(handler, query) {
  const res = response();
  await handler({ env: { DATABASE_URL: adapter.dbUrl } })({ method: 'GET', query, headers: {} }, res);
  assert.equal(res.statusCode, 200, res.body);
  return JSON.parse(res.body);
}

function python(args) {
  const result = spawnSync(process.env.PYTHON ?? 'python', [join(root, 'scripts', 'content_catalogue.py'), ...args], {
    env: { ...process.env, DATABASE_URL: adapter.dbUrl }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

try {
  for (const name of ['001_cloud_content.sql', 'migrations/content_001_sync.sql', 'migrations/content_002_authoring.sql', 'migrations/content_003_park_maps_link.sql', 'migrations/content_004_catalogue_release.sql', 'migrations/content_004_catalogue_release.sql', 'migrations/content_005_park_visibility.sql']) {
    await adapter.applyMigration(join(root, 'database', name));
  }
  const client = await adapter.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("INSERT INTO public.drive_hubs (position, name, lng, lat) VALUES (0, 'Downtown', -123.36, 48.42)");
    for (const [id, lng, lat] of [['municipal-qa-shared', -123.37, 48.42], ['provincial-qa-cdn', -120.3, 50.7]]) {
      await client.query(
        "INSERT INTO public.parks (id, name, short, category, region, lat, lng, biome, shape, rarity, scene, seed, blurb) VALUES ($1, $2, $3, 'municipal', 'QA', $4, $5, 'forest', 'circle', 'common', NULL, 7, 'A QA park.')",
        [id, `Park ${id}`, id, lat + 0.005, lng + 0.005],
      );
      await client.query('INSERT INTO public.boundaries (park_id, feature) VALUES ($1, $2::jsonb)', [id, JSON.stringify({ type: 'Feature', properties: { id, biome: 'forest' }, geometry: square(lng, lat) })]);
      await client.query('INSERT INTO public.park_drive_settings (park_id, walk_m) VALUES ($1, 0)', [id]);
      await client.query('INSERT INTO public.park_drive (park_id, hub_position, distance_km, duration_min) VALUES ($1, 0, NULL, NULL)', [id]);
    }
    await client.query("INSERT INTO public.content_park_reader_floor (park_id, minimum_reader) VALUES ('provincial-qa-cdn', 3)");
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  const older = await serve(createSnapshotHandler, { reader: '2' });
  assert.deepEqual(older.parks.map((park) => park.id), ['municipal-qa-shared']);
  assert.deepEqual(older.boundaries.features.map((feature) => feature.properties.id), ['municipal-qa-shared']);
  assert.deepEqual(Object.keys(older.drive.parks), ['municipal-qa-shared']);
  const unpublished = await serve(createSnapshotHandler, { reader: '3' });
  assert.deepEqual(unpublished.parks.map((park) => park.id), ['municipal-qa-shared', 'provincial-qa-cdn']);
  log('reader floors leave CDN-only parks out of older snapshots');

  const olderChanges = await serve(createChangesHandler, { after: '0', reader: '1' });
  assert.equal(olderChanges.batches.length, 1);
  assert.deepEqual(olderChanges.batches[0].changes.filter((change) => change.id === 'provincial-qa-cdn'), []);
  assert.ok(olderChanges.batches[0].changes.some((change) => change.id === 'municipal-qa-shared'));
  log('reader floors leave CDN-only parks out of older change batches');

  const releaseDir = join(work, 'release');
  const built = python(['build', '--out', releaseDir, '--target-host', process.env.PGHOST, '--target-environment', 'local-qa']);
  assert.equal(built.parkCount, 2);
  const dryRun = python(['point', '--release', releaseDir, '--expected-target-host', process.env.PGHOST, '--target-environment', 'local-qa', '--skip-cdn-check']);
  assert.equal(dryRun.result, 'dry-run');
  assert.equal((await serve(createSnapshotHandler, { reader: '3' })).parks.length, 2);
  const applied = python(['point', '--release', releaseDir, '--expected-target-host', process.env.PGHOST, '--target-environment', 'local-qa', '--skip-cdn-check', '--apply']);
  assert.equal(applied.result, 'applied');
  log('release build and pointer write, with a dry run first');

  const pointerBody = await serve(createSnapshotHandler, { reader: '3' });
  const pointer = reader.parseCatalogueSnapshotPointer(pointerBody);
  assert.equal(pointer.version, built.version);
  assert.equal(pointer.revision, built.revision);
  const readRelease = (path) => readFile(join(releaseDir, 'content', path));
  const indexBytes = await readRelease('catalogue/index.json');
  const indexFile = reader.catalogueIndexFile(pointer);
  await reader.assertFileBytes(indexFile, indexBytes.buffer.slice(indexBytes.byteOffset, indexBytes.byteOffset + indexBytes.byteLength));
  const index = reader.parseCatalogueIndex(JSON.parse(indexBytes.toString('utf8')), pointer);
  const features = [];
  for (const chunk of index.chunks) {
    const bytes = await readRelease(chunk.path);
    await reader.assertFileBytes(chunk, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    features.push(reader.parseCatalogueChunk(JSON.parse(bytes.toString('utf8')), chunk));
  }
  const state = reader.assembleCatalogueSnapshot(index, features);
  assert.deepEqual(state.parks.map((park) => park.id), ['municipal-qa-shared', 'provincial-qa-cdn']);
  assert.equal((await serve(createSnapshotHandler, { reader: '2' })).parks.length, 1);
  log('newer readers get the pointer and assemble the full catalogue; older readers do not');

  await adapter.pool.query("UPDATE public.parks SET blurb = 'Renamed after the release.' WHERE id = 'provincial-qa-cdn'");
  const newerChanges = await serve(createChangesHandler, { after: String(pointer.revision), reader: '3' });
  assert.equal(newerChanges.batches[0].changes.find((change) => change.entity === 'park').value.blurb, 'Renamed after the release.');
  const hiddenChanges = await serve(createChangesHandler, { after: String(pointer.revision), reader: '2' });
  assert.deepEqual(hiddenChanges.batches[0].changes.map((change) => change.entity), ['hubs']);
  log('changes after the release reach newer readers and stay hidden, as a no-op batch, from older ones');

  const replay = python(['point', '--release', releaseDir, '--expected-target-host', process.env.PGHOST, '--target-environment', 'local-qa', '--skip-cdn-check', '--apply']);
  assert.equal(replay.result, 'already-current');
  log('pointer replay is a no-op');
} finally {
  await adapter.pool.end();
  await rm(work, { recursive: true, force: true });
  await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  await admin.end();
}

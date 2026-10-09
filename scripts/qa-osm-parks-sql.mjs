import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// The OpenStreetMap outline table against real PostgreSQL: the migration replays, and the
// API's bounding-box query plus its own geometry test find the parks around a pin with every
// live service unreachable. Runs in its own throwaway kip_qa_ database.
const shared = process.env.PGDATABASE;
assert.ok(shared?.startsWith('kip_qa_') || shared === 'kip_accounts_qa', 'SQL QA requires a dedicated kip_qa_ database');
const owned = `kip_qa_osm_${randomBytes(8).toString('hex')}`;
const admin = new pg.Client({ host: process.env.PGHOST, port: Number(process.env.PGPORT), user: process.env.PGUSER, password: process.env.PGPASSWORD, database: shared });
await admin.connect();
await admin.query(`CREATE DATABASE "${owned}"`);
process.env.PGDATABASE = owned;
const { applyMigration, dbUrl, pool } = await import('./qa-postgres-adapter.mjs');
const { createSqlOsmParkTable } = await import('../worker/osmParkTable.ts');
const { databaseSqlRunner } = await import('../worker/proposalReview.ts');
const { createOsmClient } = await import('../worker/osmParks.ts');

const log = (name) => process.stdout.write(`${name}: PASS\n`);
const box = (west, south, east, north) => [[west, south], [east, south], [east, north], [west, north], [west, south]];
const SOURCE_DATE = '2026-10-07T20:20:00Z';

async function insert(type, id, name, kind, rings) {
  const geometry = { type: 'MultiPolygon', coordinates: [rings] };
  const points = rings.flat();
  const lats = points.map((point) => point[1]), lngs = points.map((point) => point[0]);
  await pool.query(
    `INSERT INTO kip_osm.parks (osm_type, osm_id, name, kind, tags, min_lat, max_lat, min_lng, max_lng, area_m2, geometry, source_date)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11::jsonb, $12)`,
    [type, id, name, kind, JSON.stringify(name ? { name } : {}), Math.min(...lats), Math.max(...lats), Math.min(...lngs), Math.max(...lngs), 1000, JSON.stringify(geometry), SOURCE_DATE],
  );
}

const noNetwork = async (url) => { throw new Error(`no network: ${url}`); };

try {
  const migration = fileURLToPath(new URL('../database/migrations/osm_parks_001_init.sql', import.meta.url));
  await applyMigration(migration);
  await applyMigration(migration);
  await assert.rejects(pool.query(
    "INSERT INTO kip_osm.parks (osm_type, osm_id, kind, min_lat, max_lat, min_lng, max_lng, area_m2, geometry, source_date) VALUES ('node', 1, 'leisure=park', 0, 0, 0, 0, 0, '{\"type\":\"MultiPolygon\"}', now())",
  ), /check constraint/);
  await assert.rejects(pool.query(
    "INSERT INTO kip_osm.parks (osm_type, osm_id, kind, min_lat, max_lat, min_lng, max_lng, area_m2, geometry, source_date) VALUES ('way', 1, 'leisure=park', 0, 0, 0, 0, 0, '{\"type\":\"Point\"}', now())",
  ), /check constraint/);
  log('the outline migration replays cleanly and refuses nodes and non-polygon outlines');

  await insert('way', 23938892, 'Paterson Park', 'leisure=park', [box(-123.062, 49.088, -123.058, 49.0902)]);
  await insert('relation', 1552698508, 'Watershed Park', 'leisure=nature_reserve', [box(-122.9, 49.108, -122.88, 49.118), box(-122.898, 49.11, -122.896, 49.112)]);
  await insert('way', 24926315, 'Sunbury Park', 'leisure=park', [box(-122.905, 49.12, -122.902, 49.122)]);
  await insert('way', 99, 'Far Park', 'leisure=park', [box(-123.2, 49.3, -123.19, 49.31)]);
  const client = createOsmClient({ NOMINATIM_URL: 'off', OVERPASS_URLS: 'https://overpass.invalid/api/interpreter' }, noNetwork, { table: createSqlOsmParkTable(databaseSqlRunner(dbUrl)) });

  const paterson = await client.search(49.089, -123.0601);
  assert.deepEqual(paterson.map((park) => [park.type, park.id, park.containsPin]), [['way', 23938892, true]]);
  const watershed = await client.search(49.1143, -122.8923);
  assert.deepEqual(watershed.map((park) => [park.id, park.containsPin]), [[1552698508, true], [24926315, false]]);
  assert.equal(watershed[0].geometry.coordinates[0].length, 2, 'the hole comes back');
  log('Paterson Park and Watershed Park come from the table with Nominatim off and Overpass unreachable');

  const inPond = await client.search(49.111, -122.897);
  assert.equal(inPond[0].id, 1552698508);
  assert.equal(inPond[0].containsPin, false, 'a pin in the hole is not inside the park');
  // Nothing near: the live services are asked, and here they are unreachable.
  await assert.rejects(client.search(49.5, -124), (error) => error.code === 'osm_unavailable');
  log('holes are respected and an empty neighbourhood falls through');

  const outline = await client.feature({ type: 'relation', id: 1552698508 });
  assert.equal(outline?.name, 'Watershed Park');
  log('the outline fetch at submit reads the table');
} finally {
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS "${owned}"`);
  await admin.end();
}

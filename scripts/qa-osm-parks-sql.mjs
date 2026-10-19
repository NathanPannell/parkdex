import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";

// The OpenStreetMap outline table against real PostgreSQL: the migration replays, and the
// API's bounding-box query plus its own geometry test find the parks around a pin with every
// live service unreachable, offering only the parks that contain the position. Runs in its own
// throwaway kip_qa_ database.
const shared = process.env.PGDATABASE;
assert.ok(shared?.startsWith("kip_qa_") || shared === "kip_accounts_qa", "SQL QA requires a dedicated kip_qa_ database");
const owned = `kip_qa_osm_${randomBytes(8).toString("hex")}`;
const admin = new pg.Client({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT),
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: shared,
});
await admin.connect();
await admin.query(`CREATE DATABASE "${owned}"`);
process.env.PGDATABASE = owned;
const { applyMigration, dbUrl, pool } = await import("./qa-postgres-adapter.mjs");
const { createSqlOsmParkTable } = await import("../worker/osmParkTable.ts");
const { databaseSqlRunner } = await import("../worker/proposalReview.ts");
const { createOsmClient } = await import("../worker/osmParks.ts");

const log = (name) => process.stdout.write(`${name}: PASS\n`);
const box = (west, south, east, north) => [
  [west, south],
  [east, south],
  [east, north],
  [west, north],
  [west, south],
];
const SOURCE_DATE = "2026-10-07T20:20:00Z";

// Without a source the outline is British Columbia's, as every outline loaded before osm_parks_002_sources.sql is.
async function insert(type, id, name, kind, rings, sourceId = null) {
  const geometry = { type: "MultiPolygon", coordinates: [rings] };
  const points = rings.flat();
  const lats = points.map((point) => point[1]),
    lngs = points.map((point) => point[0]);
  await pool.query(
    `INSERT INTO kip_osm.parks (osm_type, osm_id, name, kind, tags, min_lat, max_lat, min_lng, max_lng, area_m2, geometry, source_date${sourceId ? ", source_id" : ""})
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11::jsonb, $12${sourceId ? ", $13" : ""})`,
    [
      type,
      id,
      name,
      kind,
      JSON.stringify(name ? { name } : {}),
      Math.min(...lats),
      Math.max(...lats),
      Math.min(...lngs),
      Math.max(...lngs),
      1000,
      JSON.stringify(geometry),
      SOURCE_DATE,
      ...(sourceId ? [sourceId] : []),
    ],
  );
}

const noNetwork = async (url) => {
  throw new Error(`no network: ${url}`);
};

try {
  const migration = fileURLToPath(new URL("../database/migrations/osm_parks_001_init.sql", import.meta.url));
  const sources = fileURLToPath(new URL("../database/migrations/osm_parks_002_sources.sql", import.meta.url));
  await applyMigration(migration);
  // A table loaded before several sources: one BC outline and the singleton source row.
  await insert("way", 1, "Old Park", "leisure=park", [box(-123.3, 48.4, -123.29, 48.41)]);
  await pool.query(
    "INSERT INTO kip_osm.source (source_date, source_sha256, source_name, row_count) VALUES (now(), repeat('a', 64), 'british-columbia-latest.osm.pbf', 1)",
  );
  // Every deploy replays the inventory: 002 runs again, and 001 runs again after it.
  for (const path of [sources, sources, migration, sources]) await applyMigration(path);
  await assert.rejects(
    pool.query(
      "INSERT INTO kip_osm.parks (osm_type, osm_id, kind, min_lat, max_lat, min_lng, max_lng, area_m2, geometry, source_date) VALUES ('node', 1, 'leisure=park', 0, 0, 0, 0, 0, '{\"type\":\"MultiPolygon\"}', now())",
    ),
    /check constraint/,
  );
  await assert.rejects(
    pool.query(
      "INSERT INTO kip_osm.parks (osm_type, osm_id, kind, min_lat, max_lat, min_lng, max_lng, area_m2, geometry, source_date) VALUES ('way', 1, 'leisure=park', 0, 0, 0, 0, 0, '{\"type\":\"Point\"}', now())",
    ),
    /check constraint/,
  );
  log("the outline migration replays cleanly and refuses nodes and non-polygon outlines");

  assert.deepEqual((await pool.query("SELECT source_id, osm_id FROM kip_osm.parks")).rows, [{ source_id: "bc", osm_id: "1" }]);
  assert.deepEqual((await pool.query("SELECT source_id, row_count FROM kip_osm.source")).rows, [{ source_id: "bc", row_count: 1 }]);
  assert.equal(
    Number((await pool.query("SELECT count(*) FROM information_schema.columns WHERE table_schema = 'kip_osm' AND column_name = 'singleton'")).rows[0].count),
    0,
  );
  await pool.query(
    "INSERT INTO kip_osm.source (source_id, source_date, source_sha256, source_name, row_count) VALUES ('nova-scotia', now(), repeat('b', 64), 'nova-scotia-latest.osm.pbf', 0)",
  );
  await assert.rejects(
    pool.query(
      "INSERT INTO kip_osm.source (source_id, source_date, source_sha256, source_name, row_count) VALUES ('nova-scotia', now(), repeat('b', 64), 'x', 0)",
    ),
    /duplicate key/,
  );
  await assert.rejects(
    pool.query(
      "INSERT INTO kip_osm.source (source_id, source_date, source_sha256, source_name, row_count) VALUES ('Nova Scotia', now(), repeat('b', 64), 'x', 0)",
    ),
    /check constraint/,
  );
  await assert.rejects(insert("way", 2, "Bad Source", "leisure=park", [box(-123.3, 48.4, -123.29, 48.41)], "Nova_Scotia"), /check constraint/);
  await pool.query("DELETE FROM kip_osm.parks");
  log("osm_parks_002_sources backfills BC, replays cleanly and holds one source row per extract");

  await insert("way", 23938892, "Paterson Park", "leisure=park", [box(-123.062, 49.088, -123.058, 49.0902)]);
  await insert("relation", 1552698508, "Watershed Park", "leisure=nature_reserve", [
    box(-122.9, 49.108, -122.88, 49.118),
    box(-122.898, 49.11, -122.896, 49.112),
  ]);
  await insert("way", 24926315, "Sunbury Park", "leisure=park", [box(-122.905, 49.12, -122.902, 49.122)]);
  await insert("way", 99, "Far Park", "leisure=park", [box(-123.2, 49.3, -123.19, 49.31)]);
  // Nova Scotia's outlines sit in the same table under their own source.
  await insert("relation", 6707202, "Point Pleasant Park", "leisure=park", [box(-63.575, 44.617, -63.562, 44.628)], "nova-scotia");
  await insert("way", 3813085, "Public Gardens", "leisure=park", [box(-63.5835, 44.6418, -63.58, 44.6436)], "nova-scotia");
  const client = createOsmClient({ NOMINATIM_URL: "off", OVERPASS_URLS: "https://overpass.invalid/api/interpreter" }, noNetwork, {
    table: createSqlOsmParkTable(databaseSqlRunner(dbUrl)),
  });

  const paterson = await client.search(49.089, -123.0601, 35);
  assert.deepEqual(
    paterson.map((park) => [park.type, park.id, park.containsPin]),
    [["way", 23938892, true]],
  );
  // Sunbury Park is a few hundred metres away, so it is not offered.
  const watershed = await client.search(49.1143, -122.8923, 35);
  assert.deepEqual(
    watershed.map((park) => [park.id, park.containsPin]),
    [[1552698508, true]],
  );
  assert.equal(watershed[0].geometry.coordinates[0].length, 2, "the hole comes back");
  log("Paterson Park and Watershed Park come from the table with Nominatim off and Overpass unreachable");

  const gardens = await client.search(44.6427, -63.5822, 35);
  assert.deepEqual(
    gardens.map((park) => [park.type, park.id, park.name, park.containsPin]),
    [["way", 3813085, "Public Gardens", true]],
  );
  const pointPleasant = await client.search(44.6233, -63.5683, 35);
  assert.deepEqual(
    pointPleasant.map((park) => [park.id, park.containsPin]),
    [[6707202, true]],
  );
  log("a Halifax search finds the Nova Scotia outlines beside the BC ones");

  // In the pond, more than 35 m from its shore: not in the park, and the table settles it.
  assert.deepEqual(await client.search(49.111, -122.897, 35), []);
  // Nothing near: the live services are asked, and here they are unreachable.
  await assert.rejects(client.search(49.5, -124, 35), (error) => error.code === "osm_unavailable");
  log("holes are respected and an empty neighbourhood falls through");

  const outline = await client.feature({ type: "relation", id: 1552698508 });
  assert.equal(outline?.name, "Watershed Park");
  log("the outline fetch at submit reads the table");
} finally {
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS "${owned}"`);
  await admin.end();
}

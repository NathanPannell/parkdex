import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { publishStatements } from "../drafts.ts";
import { CONTENT_MIGRATIONS, insertDraft, openTestDatabase } from "../pgHarness.ts";
import type { MultiPolygon } from "./geometry.ts";
import { createSqlLiveParkStore, type LivePark, type LiveParkStore } from "./liveParks.ts";

// Runs live park edits against the real content triggers. Point OPERATOR_PARKS_TEST_DATABASE_URL
// at a disposable loopback database named kip_qa_* (separate from the drafts test database).
const DSN = process.env.OPERATOR_PARKS_TEST_DATABASE_URL;
const square = (x: number): [number, number][][] => [
  [
    [x, 48.4],
    [x + 0.01, 48.4],
    [x + 0.01, 48.41],
    [x, 48.41],
    [x, 48.4],
  ],
];

let pool: import("pg").Pool;
let parks: LiveParkStore;

before(async () => {
  if (!DSN) return;
  const opened = await openTestDatabase(DSN, [...CONTENT_MIGRATIONS, "database/migrations/park_drafts_002_proposals.sql"]);
  pool = opened.pool;
  // Publish one park through the same transaction park founding uses, so the live rows look like production.
  const updatedAt = await insertDraft(opened.runner, "regional-thetis-lake");
  await opened.runner.transaction(publishStatements("regional-thetis-lake", updatedAt, null));
  parks = createSqlLiveParkStore(opened.runner);
});

after(async () => {
  await pool?.end();
});

async function revision(): Promise<number> {
  return Number((await pool.query("SELECT revision FROM public.content_clock")).rows[0].revision);
}

async function current(): Promise<LivePark> {
  const { geometry: _geometry, ...park } = (await parks.get("regional-thetis-lake"))!;
  return park;
}

test("live parks read back with their boundary and region list", { skip: !DSN }, async () => {
  const listed = await parks.list();
  assert.deepEqual(
    listed.map((park) => park.id),
    ["regional-thetis-lake"],
  );
  const park = await parks.get("regional-thetis-lake");
  assert.equal(park?.geometry?.coordinates.length, 2);
  assert.deepEqual(await parks.regions(), ["Capital Region"]);
});

test("a text and pin edit is one content revision and leaves the boundary alone", { skip: !DSN }, async () => {
  const before = await revision();
  const boundaryBefore = (await pool.query("SELECT feature FROM public.boundaries WHERE park_id = 'regional-thetis-lake'")).rows[0].feature;
  const result = await parks.update("regional-thetis-lake", await current(), {
    name: "Thetis Lake Park",
    blurb: "Two lakes.",
    rarity: "rare",
    lat: 48.481,
    lng: -123.468,
  });
  assert.equal(result, before + 1);
  const row = (await pool.query("SELECT name, blurb, rarity, lat, lng FROM public.parks WHERE id = 'regional-thetis-lake'")).rows[0];
  assert.deepEqual(
    { ...row, lat: Number(row.lat), lng: Number(row.lng) },
    { name: "Thetis Lake Park", blurb: "Two lakes.", rarity: "rare", lat: 48.481, lng: -123.468 },
  );
  assert.deepEqual((await pool.query("SELECT feature FROM public.boundaries WHERE park_id = 'regional-thetis-lake'")).rows[0].feature, boundaryBefore);
});

test("a category, biome and boundary change passes the deferred consistency checks", { skip: !DSN }, async () => {
  const before = await revision();
  const drawn = { type: "MultiPolygon" as const, coordinates: [square(-123.5)] };
  await parks.update("regional-thetis-lake", await current(), { category: "provincial", biome: "forest", geometry: drawn });
  assert.equal(await revision(), before + 1);
  const park = (await pool.query("SELECT shape, biome FROM public.parks WHERE id = 'regional-thetis-lake'")).rows[0];
  assert.deepEqual(park, { shape: "shield", biome: "forest" });
  const feature = (await pool.query("SELECT feature FROM public.boundaries WHERE park_id = 'regional-thetis-lake'")).rows[0].feature;
  assert.deepEqual(feature.properties, { id: "regional-thetis-lake", biome: "forest" });
  assert.deepEqual(feature.geometry, drawn);

  // A biome change alone must still rewrite the boundary's biome, or the deferred check fails.
  await parks.update("regional-thetis-lake", await current(), { biome: "lake" });
  const after = (await pool.query("SELECT feature FROM public.boundaries WHERE park_id = 'regional-thetis-lake'")).rows[0].feature;
  assert.equal(after.properties.biome, "lake");
  assert.deepEqual(after.geometry, drawn, "the geometry is kept");
});

test("a stale edit is refused and changes nothing", { skip: !DSN }, async () => {
  const opened = await current();
  await parks.update("regional-thetis-lake", opened, { short: "Thetis" });
  const before = await revision();
  await assert.rejects(parks.update("regional-thetis-lake", opened, { short: "Other" }), (error: { code?: string }) => error.code === "park_changed");
  assert.equal(await revision(), before);
  assert.equal((await pool.query("SELECT short FROM public.parks WHERE id = 'regional-thetis-lake'")).rows[0].short, "Thetis");
});

test("an invalid boundary is rolled back by the content checks", { skip: !DSN }, async () => {
  const before = await revision();
  const broken: MultiPolygon = {
    type: "MultiPolygon",
    coordinates: [
      [
        [
          [-123.5, 48.4],
          [-123.49, 48.4],
          [-123.5, 48.4],
        ],
      ],
    ],
  };
  await assert.rejects(parks.update("regional-thetis-lake", await current(), { geometry: broken }));
  assert.equal(await revision(), before);
});

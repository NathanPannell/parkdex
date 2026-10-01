import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { badgeAsset } from "./badges.ts";
import { createSqlDraftStore, type SqlRunner } from "./drafts.ts";
import type { MultiPolygon } from "./legacy.ts";
import { createSqlLiveParkStore, type LivePark, type LiveParkStore } from "./liveParks.ts";

// Runs live park edits against the real content triggers. Point OPERATOR_PARKS_TEST_DATABASE_URL
// at a disposable loopback database named kip_qa_* (separate from the drafts test database).
const DSN = process.env.OPERATOR_PARKS_TEST_DATABASE_URL;
const root = fileURLToPath(new URL("../../", import.meta.url));
const square = (x: number): [number, number][][] => [[[x, 48.4], [x + 0.01, 48.4], [x + 0.01, 48.41], [x, 48.41], [x, 48.4]]];

let pool: import("pg").Pool;
let parks: LiveParkStore;

before(async () => {
  if (!DSN) return;
  const url = new URL(DSN);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || !url.pathname.slice(1).startsWith("kip_qa_")) {
    throw new Error("The live park integration test needs a loopback database named kip_qa_*.");
  }
  const pg = (await import("pg")).default;
  pool = new pg.Pool({ connectionString: DSN, max: 4 });
  for (const file of ["database/001_cloud_content.sql", "database/migrations/content_001_sync.sql", "database/migrations/park_drafts_001_init.sql", "database/migrations/park_drafts_002_proposals.sql"]) {
    await pool.query(await readFile(`${root}${file}`, "utf8"));
  }
  await pool.query("INSERT INTO public.drive_hubs (position, name, lng, lat) VALUES (0, 'Victoria', -123.36, 48.43), (1, 'Nanaimo', -123.94, 49.17)");
  const runner: SqlRunner = {
    query: async (text, params = []) => (await pool.query(text, params)).rows,
    async transaction(statements) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const results = [];
        for (const { text, params } of statements) results.push((await client.query(text, params)).rows);
        await client.query("COMMIT");
        return results;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  };
  // Publish one park through the dashboard's own path so the live rows look like production.
  const drafts = createSqlDraftStore(runner);
  const draft = await drafts.create({
    id: "regional-thetis-lake", source: { record: { id: "regional-thetis-lake" } }, sourceSha256: "a".repeat(64),
    geometry: { type: "MultiPolygon", coordinates: [square(-123.47), square(-123.45)] },
    name: "Thetis Lake Regional Park", short: "Thetis Lake", category: "regional", region: "Capital Region",
    lat: 48.48, lng: -123.47, biome: "lake", shape: "hex", rarity: "common", seed: 812, blurb: "",
  });
  await drafts.publish(draft.id, draft.updatedAt, null);
  parks = createSqlLiveParkStore(runner);
});

after(async () => {
  await pool?.end();
});

async function revision(): Promise<number> {
  return Number((await pool.query("SELECT revision FROM public.content_clock")).rows[0].revision);
}

async function current(): Promise<LivePark> {
  const { geometry: _geometry, badgeUrl: _badgeUrl, ...park } = (await parks.get("regional-thetis-lake"))!;
  return park;
}

test("live parks read back with their boundary and region list", { skip: !DSN }, async () => {
  const listed = await parks.list();
  assert.deepEqual(listed.map((park) => park.id), ["regional-thetis-lake"]);
  const park = await parks.get("regional-thetis-lake");
  assert.equal(park?.geometry?.coordinates.length, 2);
  assert.deepEqual(await parks.regions(), ["Capital Region"]);
});

test("a text and pin edit is one content revision and leaves the boundary alone", { skip: !DSN }, async () => {
  const before = await revision();
  const boundaryBefore = (await pool.query("SELECT feature FROM public.boundaries WHERE park_id = 'regional-thetis-lake'")).rows[0].feature;
  const result = await parks.update("regional-thetis-lake", await current(), { name: "Thetis Lake Park", blurb: "Two lakes.", rarity: "rare", lat: 48.481, lng: -123.468 }, null);
  assert.equal(result, before + 1);
  const row = (await pool.query("SELECT name, blurb, rarity, lat, lng FROM public.parks WHERE id = 'regional-thetis-lake'")).rows[0];
  assert.deepEqual({ ...row, lat: Number(row.lat), lng: Number(row.lng) }, { name: "Thetis Lake Park", blurb: "Two lakes.", rarity: "rare", lat: 48.481, lng: -123.468 });
  assert.deepEqual((await pool.query("SELECT feature FROM public.boundaries WHERE park_id = 'regional-thetis-lake'")).rows[0].feature, boundaryBefore);
});

test("a category, biome and boundary change passes the deferred consistency checks", { skip: !DSN }, async () => {
  const before = await revision();
  const drawn = { type: "MultiPolygon" as const, coordinates: [square(-123.5)] };
  await parks.update("regional-thetis-lake", await current(), { category: "provincial", biome: "forest", geometry: drawn }, null);
  assert.equal(await revision(), before + 1);
  const park = (await pool.query("SELECT shape, biome FROM public.parks WHERE id = 'regional-thetis-lake'")).rows[0];
  assert.deepEqual(park, { shape: "shield", biome: "forest" });
  const feature = (await pool.query("SELECT feature FROM public.boundaries WHERE park_id = 'regional-thetis-lake'")).rows[0].feature;
  assert.deepEqual(feature.properties, { id: "regional-thetis-lake", biome: "forest" });
  assert.deepEqual(feature.geometry, drawn);

  // A biome change alone must still rewrite the boundary's biome, or the deferred check fails.
  await parks.update("regional-thetis-lake", await current(), { biome: "lake" }, null);
  const after = (await pool.query("SELECT feature FROM public.boundaries WHERE park_id = 'regional-thetis-lake'")).rows[0].feature;
  assert.equal(after.properties.biome, "lake");
  assert.deepEqual(after.geometry, drawn, "the geometry is kept");
});

test("a stale edit is refused and changes nothing", { skip: !DSN }, async () => {
  const opened = await current();
  await parks.update("regional-thetis-lake", opened, { short: "Thetis" }, null);
  const before = await revision();
  await assert.rejects(parks.update("regional-thetis-lake", opened, { short: "Other" }, null), (error: { code?: string }) => error.code === "park_changed");
  assert.equal(await revision(), before);
  assert.equal((await pool.query("SELECT short FROM public.parks WHERE id = 'regional-thetis-lake'")).rows[0].short, "Thetis");
});

test("a new badge registers its object and switches the scene; a different image cannot reuse the slug", { skip: !DSN }, async () => {
  const asset = badgeAsset("regional-thetis-lake-0a1b2c3d", "0a1b2c3d".repeat(8), 1234);
  await parks.update("regional-thetis-lake", await current(), {}, asset);
  const park = await parks.get("regional-thetis-lake");
  assert.equal(park?.scene, "regional-thetis-lake-0a1b2c3d");
  assert.equal(park?.badgeUrl, asset.url);

  const second = badgeAsset("regional-thetis-lake-9f9f9f9f", "9f9f9f9f".repeat(8), 99);
  await parks.update("regional-thetis-lake", await current(), {}, second);
  assert.equal((await parks.get("regional-thetis-lake"))?.scene, "regional-thetis-lake-9f9f9f9f");

  const clash = { ...badgeAsset("regional-thetis-lake-0a1b2c3d", "ffffffff".repeat(8), 50) };
  await assert.rejects(parks.update("regional-thetis-lake", await current(), {}, clash), (error: { code?: string }) => error.code === "scene_taken");
});

test("an invalid boundary is rolled back by the content checks", { skip: !DSN }, async () => {
  const before = await revision();
  const broken: MultiPolygon = { type: "MultiPolygon", coordinates: [[[[-123.5, 48.4], [-123.49, 48.4], [-123.5, 48.4]]]] };
  await assert.rejects(parks.update("regional-thetis-lake", await current(), { geometry: broken }, null));
  assert.equal(await revision(), before);
});

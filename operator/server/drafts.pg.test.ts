import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { publishStatements, type BadgeAsset, type SqlRunner } from "./drafts.ts";
import { insertDraft, openTestDatabase } from "./pgHarness.ts";

// Runs the publish transaction that park founding uses against the real content triggers. Point
// OPERATOR_DRAFTS_TEST_DATABASE_URL at a disposable loopback database named kip_qa_*.
const DSN = process.env.OPERATOR_DRAFTS_TEST_DATABASE_URL;

let pool: import("pg").Pool;
let runner: SqlRunner;

before(async () => {
  if (!DSN) return;
  ({ pool, runner } = await openTestDatabase(DSN));
});

after(async () => {
  await pool?.end();
});

async function revision(): Promise<number> {
  return Number((await pool.query("SELECT revision FROM public.content_clock")).rows[0].revision);
}

test("a draft stays out of synchronized content until it is published", { skip: !DSN }, async () => {
  const before = await revision();
  await insertDraft(runner, "regional-thetis-lake");
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM public.parks")).rows[0].count, 0);
  assert.equal(await revision(), before, "a draft row emits no content revision");
});

test("publishing inserts the park, boundary and unknown-access drive rows in one revision", { skip: !DSN }, async () => {
  const updatedAt = new Date((await pool.query("SELECT updated_at FROM kip_park_drafts.drafts WHERE id = 'regional-thetis-lake'")).rows[0].updated_at).toISOString();
  const before = await revision();
  const results = await runner.transaction(publishStatements("regional-thetis-lake", updatedAt, null));
  assert.ok(Number(results[results.length - 1][0].published_revision) > before);
  const park = (await pool.query("SELECT * FROM public.parks WHERE id = 'regional-thetis-lake'")).rows[0];
  assert.deepEqual([park.rarity, park.scene, park.blurb, park.biome, park.seed], ["common", null, "", "lake", 812]);
  const feature = (await pool.query("SELECT feature FROM public.boundaries WHERE park_id = 'regional-thetis-lake'")).rows[0].feature;
  assert.deepEqual(feature.properties, { id: "regional-thetis-lake", biome: "lake" });
  assert.equal(feature.geometry.coordinates.length, 2);
  const drive = await pool.query("SELECT hub_position, distance_km, duration_min FROM public.park_drive WHERE park_id = 'regional-thetis-lake' ORDER BY hub_position");
  assert.deepEqual(drive.rows, [{ hub_position: 0, distance_km: null, duration_min: null }, { hub_position: 1, distance_km: null, duration_min: null }]);
  assert.equal((await pool.query("SELECT walk_m FROM public.park_drive_settings WHERE park_id = 'regional-thetis-lake'")).rows[0].walk_m, 0);
  assert.equal((await pool.query("SELECT status FROM kip_park_drafts.drafts WHERE id = 'regional-thetis-lake'")).rows[0].status, "published");
  const changes = await pool.query("SELECT DISTINCT entity FROM public.content_changes WHERE revision > $1 ORDER BY 1", [before]);
  assert.deepEqual(changes.rows.map((row: { entity: string }) => row.entity), ["boundary", "drive", "park"], "publication is recorded as synchronized changes");
});

test("a stale draft and an existing park are refused, and nothing is written", { skip: !DSN }, async () => {
  const updatedAt = await insertDraft(runner, "regional-mount-work", { lat: 48.53 });
  const before = await revision();
  await assert.rejects(runner.transaction(publishStatements("regional-mount-work", new Date(Date.parse(updatedAt) - 1000).toISOString(), null)), /draft_changed/);
  await assert.rejects(runner.transaction(publishStatements("regional-thetis-lake", new Date().toISOString(), null)), /draft_changed|park_exists/);
  assert.equal(await revision(), before);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM public.parks WHERE id = 'regional-mount-work'")).rows[0].count, 0);
});

test("a badge registers its immutable descriptor with the park, and a mismatch rolls back everything", { skip: !DSN }, async () => {
  const bytes = Buffer.from([82, 73, 70, 70, 4, 0, 0, 0, 87, 69, 66, 80]);
  const updated = await pool.query(
    "UPDATE kip_park_drafts.drafts SET badge_webp = $2, scene = 'regional-mount-work-0a1b2c3d', updated_at = now() WHERE id = $1 RETURNING updated_at, encode(sha256(badge_webp), 'hex') AS sha",
    ["regional-mount-work", bytes],
  );
  const updatedAt = new Date(updated.rows[0].updated_at).toISOString();
  const sha = String(updated.rows[0].sha);
  const asset: BadgeAsset = {
    logicalPath: "art/badges/scenes/regional-mount-work-0a1b2c3d.webp",
    objectKey: `releases/${sha}/art/badges/scenes/regional-mount-work-0a1b2c3d.webp`,
    url: `https://kip-assets.parkdex.app/releases/${sha}/art/badges/scenes/regional-mount-work-0a1b2c3d.webp`,
    sha256: sha,
    byteSize: bytes.byteLength,
    contentType: "image/webp",
  };
  await assert.rejects(runner.transaction(publishStatements("regional-mount-work", updatedAt, { ...asset, sha256: "f".repeat(64) })), /badge_changed/);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM public.parks WHERE id = 'regional-mount-work'")).rows[0].count, 0);

  await runner.transaction(publishStatements("regional-mount-work", updatedAt, asset));
  assert.equal((await pool.query("SELECT scene FROM public.parks WHERE id = 'regional-mount-work'")).rows[0].scene, "regional-mount-work-0a1b2c3d");
  const descriptor = (await pool.query("SELECT object_key, sha256 FROM public.r2_objects WHERE logical_path = $1", [asset.logicalPath])).rows[0];
  assert.deepEqual(descriptor, { object_key: asset.objectKey, sha256: sha });
});

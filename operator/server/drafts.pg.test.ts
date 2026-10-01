import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createSqlDraftStore, type DraftStore } from "./drafts.ts";

// Runs the draft store and publish transaction against real content triggers. Point
// OPERATOR_DRAFTS_TEST_DATABASE_URL at a disposable loopback database named kip_qa_*.
const DSN = process.env.OPERATOR_DRAFTS_TEST_DATABASE_URL;
const root = fileURLToPath(new URL("../../", import.meta.url));
const square = (x: number): [number, number][][] => [[[x, 48.4], [x + 0.01, 48.4], [x + 0.01, 48.41], [x, 48.41], [x, 48.4]]];

let pool: import("pg").Pool;
let store: DraftStore;

before(async () => {
  if (!DSN) return;
  const url = new URL(DSN);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || !url.pathname.slice(1).startsWith("kip_qa_")) {
    throw new Error("The draft integration test needs a loopback database named kip_qa_*.");
  }
  const pg = (await import("pg")).default;
  pool = new pg.Pool({ connectionString: DSN, max: 4 });
  for (const file of ["database/001_cloud_content.sql", "database/migrations/content_001_sync.sql", "database/migrations/park_drafts_001_init.sql"]) {
    await pool.query(await readFile(`${root}${file}`, "utf8"));
  }
  await pool.query("INSERT INTO public.drive_hubs (position, name, lng, lat) VALUES (0, 'Victoria', -123.36, 48.43), (1, 'Nanaimo', -123.94, 49.17)");
  store = createSqlDraftStore(async () => pool.connect());
});

after(async () => {
  await pool?.end();
});

async function seedDraft(id: string, overrides: Record<string, unknown> = {}) {
  return store.create({
    id,
    source: { record: { id, name: "Thetis Lake Regional Park" } },
    sourceSha256: "a".repeat(64),
    geometry: { type: "MultiPolygon", coordinates: [square(-123.47), square(-123.45)] },
    name: "Thetis Lake Regional Park",
    short: "Thetis Lake",
    category: "regional",
    region: "Capital Region",
    lat: 48.48,
    lng: -123.47,
    biome: "lake",
    shape: "circle",
    rarity: null,
    seed: 812,
    blurb: "",
    ...overrides,
  });
}

test("a draft stays out of synchronized content until it is published", { skip: !DSN }, async () => {
  const revisionBefore = Number((await pool.query("SELECT revision FROM public.content_clock")).rows[0].revision);
  const draft = await seedDraft("regional-thetis-lake");
  await store.update(draft.id, { blurb: "Draft text" });
  const parks = await pool.query("SELECT count(*)::int AS count FROM public.parks");
  assert.equal(parks.rows[0].count, 0);
  assert.equal(Number((await pool.query("SELECT revision FROM public.content_clock")).rows[0].revision), revisionBefore, "draft edits emit no content revision");
});

test("publishing a skeleton inserts the park, boundary and unknown-access drive rows in one revision", { skip: !DSN }, async () => {
  const edited = await store.update("regional-thetis-lake", { rarity: "uncommon", blurb: "" });
  const before = Number((await pool.query("SELECT revision FROM public.content_clock")).rows[0].revision);
  const result = await store.publish("regional-thetis-lake", edited!.updatedAt, null);
  assert.ok(result.revision !== null && result.revision > before);
  const park = (await pool.query("SELECT * FROM public.parks WHERE id = 'regional-thetis-lake'")).rows[0];
  assert.deepEqual([park.rarity, park.scene, park.blurb, park.biome, park.seed], ["uncommon", null, "", "lake", 812]);
  const feature = (await pool.query("SELECT feature FROM public.boundaries WHERE park_id = 'regional-thetis-lake'")).rows[0].feature;
  assert.deepEqual(feature.properties, { id: "regional-thetis-lake", biome: "lake" });
  assert.equal(feature.geometry.coordinates.length, 2);
  const drive = await pool.query("SELECT hub_position, distance_km, duration_min FROM public.park_drive WHERE park_id = 'regional-thetis-lake' ORDER BY hub_position");
  assert.deepEqual(drive.rows, [{ hub_position: 0, distance_km: null, duration_min: null }, { hub_position: 1, distance_km: null, duration_min: null }]);
  assert.equal((await pool.query("SELECT walk_m FROM public.park_drive_settings WHERE park_id = 'regional-thetis-lake'")).rows[0].walk_m, 0);
  const draft = await store.get("regional-thetis-lake");
  assert.equal(draft?.status, "published");
  const changes = await pool.query("SELECT DISTINCT entity FROM public.content_changes WHERE revision > $1 ORDER BY 1", [before]);
  assert.deepEqual(changes.rows.map((row: { entity: string }) => row.entity), ["boundary", "drive", "park"], "publication is recorded as synchronized changes");
});

test("a badge registers its immutable descriptor with the park, and failures roll back everything", { skip: !DSN }, async () => {
  const draft = await seedDraft("regional-mount-work", { rarity: "rare", lat: 48.53, lng: -123.47 });
  const bytes = new Uint8Array([82, 73, 70, 70, 4, 0, 0, 0, 87, 69, 66, 80]);
  const withBadge = await store.setBadge(draft.id, bytes, "regional-mount-work-0a1b2c3d");
  const sha = withBadge!.badgeSha256!;
  const asset = {
    logicalPath: "art/badges/scenes/regional-mount-work-0a1b2c3d.webp",
    objectKey: `releases/${sha}/art/badges/scenes/regional-mount-work-0a1b2c3d.webp`,
    url: `https://kip-assets.parkdex.app/releases/${sha}/art/badges/scenes/regional-mount-work-0a1b2c3d.webp`,
    sha256: sha,
    byteSize: bytes.byteLength,
    contentType: "image/webp" as const,
  };
  // A mismatched descriptor must not leave a park behind.
  await assert.rejects(store.publish(draft.id, withBadge!.updatedAt, { ...asset, sha256: "f".repeat(64) }), /badge changed/);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM public.parks WHERE id = $1", [draft.id])).rows[0].count, 0);

  await store.publish(draft.id, withBadge!.updatedAt, asset);
  const park = (await pool.query("SELECT scene FROM public.parks WHERE id = $1", [draft.id])).rows[0];
  assert.equal(park.scene, "regional-mount-work-0a1b2c3d");
  const descriptor = (await pool.query("SELECT object_key, sha256 FROM public.r2_objects WHERE logical_path = $1", [asset.logicalPath])).rows[0];
  assert.deepEqual(descriptor, { object_key: asset.objectKey, sha256: sha });
});

test("a draft cannot shadow or replace a park that already exists", { skip: !DSN }, async () => {
  await assert.rejects(seedDraft("regional-thetis-lake"), /already/);
  await assert.rejects(store.publish("regional-thetis-lake", new Date().toISOString(), null), /changed|already published/);
});

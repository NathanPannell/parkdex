import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { EXIF_GPS_JPEG } from "../../../worker/fixtures/exif-gps-jpeg.ts";
import { createDashboardApi, type DashboardEnv } from "../api.ts";
import { publishStatements, type SqlRunner } from "../drafts.ts";
import { insertDraft, openTestDatabase } from "../pgHarness.ts";
import { createSqlLiveParkStore } from "./liveParks.ts";
import { createSqlParkManagerStore } from "./manager.ts";
import { createSqlOsmStore } from "./osm.ts";

// The park manager's routes against the real content, visibility, founder and game triggers.
// Point OPERATOR_PARK_MANAGER_TEST_DATABASE_URL at a fresh loopback database named kip_qa_*
// (its own, not shared with the other integration tests).
const DSN = process.env.OPERATOR_PARK_MANAGER_TEST_DATABASE_URL;
const ORIGIN = "https://operator.example.test";
const env: DashboardEnv = { DATABASE_URL: "postgres://unused" };

const ring = (x: number, y: number, size = 0.004): [number, number][] => [
  [x, y],
  [x + size, y],
  [x + size, y + size],
  [x, y + size],
  [x, y],
];
const multi = (x: number, y: number, size?: number) => ({ type: "MultiPolygon" as const, coordinates: [[ring(x, y, size)]] });

let pool: import("pg").Pool;
let runner: SqlRunner;
let call: (path: string, init?: { method?: string; body?: unknown; origin?: string }) => Promise<Response>;
let founder: string;
let visitor: string;

/** Every migration a deploy applies, in deploy order (deployment.json), like scripts/qa-founders-sql.mjs. */
function inventory(): string[] {
  const config = JSON.parse(readFileSync(new URL("../../../deployment.json", import.meta.url), "utf8"));
  return [
    config.migrationPath,
    ...config.contentSync.supportingMigrationPaths,
    ...config.optionalMigrationPaths,
    ...config.contentSync.migrationPaths,
    ...config.independentMigrationPaths,
  ];
}

async function publish(id: string, overrides: Record<string, unknown>) {
  const updatedAt = await insertDraft(runner, id, overrides);
  await runner.transaction(publishStatements(id, updatedAt, null));
}

async function account(name: string): Promise<string> {
  const id = randomUUID();
  await pool.query("INSERT INTO kip_account.accounts (id, normalized_email, password_hash) VALUES ($1, $2, 'qa-hash')", [
    id,
    `parks-${name}-${id.slice(0, 6)}@example.test`,
  ]);
  await pool.query("INSERT INTO kip_game.players (account_id, handle, flag_seed) VALUES ($1, $2, kip_game.flag_seed($1))", [id, `qa_${name}`]);
  return id;
}

async function revision(): Promise<number> {
  return Number((await pool.query("SELECT revision FROM public.content_clock")).rows[0].revision);
}

async function changes(since: number) {
  const rows = await pool.query("SELECT entity, entity_id, operation FROM public.content_changes WHERE revision > $1 ORDER BY entity", [since]);
  return rows.rows.map((row: { entity: string; entity_id: string; operation: string }) => `${row.entity}:${row.entity_id}:${row.operation}`);
}

const count = async (sql: string, params: unknown[] = []) => Number((await pool.query(sql, params)).rows[0].count);
const json = async <T>(response: Response) => (await response.json()) as T;

before(async () => {
  if (!DSN) return;
  const opened = await openTestDatabase(DSN, inventory());
  pool = opened.pool;
  pool.on("error", () => undefined);
  runner = opened.runner;
  await publish("regional-thetis-lake", { geometry: multi(-123.47, 48.46), lat: 48.462, lng: -123.468 });
  await publish("municipal-beacon-hill", {
    name: "Beacon Hill Park",
    short: "Beacon Hill",
    category: "municipal",
    shape: "circle",
    region: "Victoria",
    geometry: multi(-123.37, 48.41),
    lat: 48.412,
    lng: -123.368,
  });
  founder = await account("founder");
  visitor = await account("visitor");
  const photo = Buffer.from(EXIF_GPS_JPEG);
  await pool.query(
    `INSERT INTO kip_founders.parks (park_id, account_id, attempt_id, source, photo_sha256, photo_bytes, photo_width, photo_height, moderation)
     VALUES ('regional-thetis-lake', $1, $2, 'existing', $3, $4, 16, 12, '{"version":1}'::jsonb)`,
    [founder, randomUUID(), createHash("sha256").update(photo).digest("hex"), photo],
  );
  for (const [accountId, at] of [
    [founder, "2026-10-08T17:00:00Z"],
    [visitor, "2026-10-09T17:00:00Z"],
    [visitor, "2026-08-01T17:00:00Z"],
  ]) {
    const result = await pool.query("SELECT kip_game.record_visit($1, $2, 'regional-thetis-lake', $3) AS r", [randomUUID(), accountId, at]);
    assert.equal(result.rows[0].r.status, "recorded");
  }
  // One outline that is Thetis Lake already, and one that is not in Parkdex.
  await pool.query(
    `INSERT INTO kip_osm.parks (osm_type, osm_id, name, kind, tags, min_lat, max_lat, min_lng, max_lng, area_m2, geometry, source_date) VALUES
     ('way', 111, 'Thetis Lake Regional Park', 'leisure=park', '{"leisure":"park"}', 48.46, 48.464, -123.47, -123.466, 130000, $1::jsonb, '2026-10-01'),
     ('relation', 222, 'Mill Hill Regional Park', 'leisure=park', '{"leisure":"park","operator":"CRD"}', 48.45, 48.453, -123.49, -123.487, 80000, $2::jsonb, '2026-10-01')`,
    [JSON.stringify(multi(-123.47, 48.46)), JSON.stringify(multi(-123.49, 48.45, 0.003))],
  );
  // Two extracts loaded side by side (osm_parks_002_sources.sql).
  await pool.query(
    `INSERT INTO kip_osm.source (source_id, source_date, source_sha256, source_name, row_count) VALUES
     ('bc', '2026-10-01T00:00:00Z', repeat('a', 64), 'british-columbia-latest.osm.pbf', 2),
     ('nova-scotia', '2026-10-12T20:21:35Z', repeat('b', 64), 'nova-scotia-latest.osm.pbf', 0)`,
  );
  const api = createDashboardApi({
    liveParkStore: () => createSqlLiveParkStore(runner),
    parkManagerStore: () => createSqlParkManagerStore(runner),
    osmStore: () => createSqlOsmStore(runner),
    now: () => Date.parse("2026-10-09T18:00:00Z"),
  });
  call = (path, init = {}) => {
    const headers = new Headers();
    const method = init.method ?? "GET";
    if (method !== "GET") headers.set("origin", init.origin ?? ORIGIN);
    if (init.body !== undefined) headers.set("content-type", "application/json");
    return api(new Request(`${ORIGIN}${path}`, { method, headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) }), env);
  };
});

after(async () => {
  await pool?.end();
});

test("the catalogue, stats and a park's activity read from the real tables", { skip: !DSN }, async () => {
  const { parks } = await json<{ parks: Array<{ id: string; source: string; founder: { handle: string } | null; visits: number; hidden: unknown }> }>(
    await call("/api/parks"),
  );
  assert.deepEqual(
    parks.map((park) => [park.id, park.source, park.founder?.handle ?? null, park.visits]),
    [
      ["municipal-beacon-hill", "curated", null, 0],
      ["regional-thetis-lake", "curated", "qa_founder", 3],
    ],
  );
  const { stats } = await json<{ stats: Record<string, unknown> }>(await call("/api/parks/stats"));
  assert.deepEqual(
    [stats.live, stats.hidden, stats.founded, stats.osmOutlines, stats.osmNotInParkdex],
    [2, 0, 1, 2, 1],
    "Mill Hill has no Parkdex pin in its box",
  );
  assert.equal(stats.osmSourceDate, "2026-10-01T00:00:00.000Z", "several extracts report the oldest");

  const { activity } = await json<{ activity: Record<string, any> }>(await call("/api/parks/regional-thetis-lake"));
  assert.deepEqual(activity.visits, { total: 3, last30Days: 2, uniquePlayers: 2 });
  assert.equal(activity.flag.handle, "qa_visitor", "the visitor took the flag on the latest visit");
  assert.equal(activity.flag.up, true);
  assert.equal(activity.founder.handle, "qa_founder");
  assert.equal(activity.founder.photoBytes, EXIF_GPS_JPEG.byteLength);
  assert.ok(
    activity.history.some(
      (change: { entity: string; operation: string; value: { name?: string } | null }) =>
        change.entity === "park" && change.operation === "upsert" && change.value?.name === "Thetis Lake Regional Park",
    ),
  );

  const cover = await call("/api/parks/regional-thetis-lake/cover");
  assert.equal(cover.status, 200);
  assert.equal(Buffer.from(await cover.arrayBuffer()).equals(Buffer.from(EXIF_GPS_JPEG)), true);

  const osm = await json<{ outlines: Array<{ id: number; inParkdex: { parkId: string } | null }> }>(
    await call("/api/parks/osm?bbox=-123.5,48.44,-123.44,48.47"),
  );
  assert.deepEqual(
    osm.outlines.map((outline) => [outline.id, outline.inParkdex?.parkId ?? null]),
    [
      [222, null],
      [111, "regional-thetis-lake"],
    ],
  );
  const outlines = await json<{ outlines: Array<{ id: string }> }>(await call("/api/parks/outlines?bbox=-123.5,48.44,-123.44,48.47"));
  assert.deepEqual(
    outlines.outlines.map((outline) => outline.id),
    ["regional-thetis-lake"],
  );
});

test("hide and unhide round trip through the visibility triggers, one revision each", { skip: !DSN }, async () => {
  const start = await revision();
  const hidden = await call("/api/parks/municipal-beacon-hill/hide", { method: "POST", body: { reason: "Closed for an event" } });
  assert.equal(hidden.status, 200, await hidden.clone().text());
  assert.equal((await json<{ revision: number }>(hidden)).revision, start + 1);
  assert.deepEqual(await changes(start), ["boundary:municipal-beacon-hill:delete", "drive:municipal-beacon-hill:delete", "park:municipal-beacon-hill:delete"]);
  assert.deepEqual((await pool.query("SELECT reason, source FROM public.content_park_hidden WHERE park_id = 'municipal-beacon-hill'")).rows, [
    { reason: "Closed for an event", source: "operator" },
  ]);
  assert.equal((await call("/api/parks/municipal-beacon-hill/hide", { method: "POST" })).status, 409);
  assert.equal(await revision(), start + 1, "a refused hide writes nothing");

  const middle = await revision();
  const shown = await call("/api/parks/municipal-beacon-hill/unhide", { method: "POST" });
  assert.equal(shown.status, 200);
  assert.equal((await json<{ revision: number }>(shown)).revision, middle + 1);
  assert.deepEqual(await changes(middle), ["boundary:municipal-beacon-hill:upsert", "drive:municipal-beacon-hill:upsert", "park:municipal-beacon-hill:upsert"]);
  assert.equal(await count("SELECT count(*) FROM public.content_park_hidden"), 0);
  assert.equal((await call("/api/parks/municipal-beacon-hill/unhide", { method: "POST" })).status, 409);
});

test("a stale edit is refused with 409 park_changed", { skip: !DSN }, async () => {
  const { park } = await json<{ park: Record<string, unknown> }>(await call("/api/parks/municipal-beacon-hill"));
  const { geometry: _geometry, ...expected } = park;
  assert.equal((await call("/api/parks/municipal-beacon-hill", { method: "PATCH", body: { expected, changes: { short: "Beacon" } } })).status, 200);
  const before = await revision();
  const stale = await call("/api/parks/municipal-beacon-hill", { method: "PATCH", body: { expected, changes: { short: "Other" } } });
  assert.equal(stale.status, 409);
  assert.equal((await json<{ error: { code: string } }>(stale)).error.code, "park_changed");
  assert.equal(await revision(), before);
});

test("an OpenStreetMap outline is created through the publish transaction, and a matched one is refused", { skip: !DSN }, async () => {
  const prefill = await json<{ draft: Record<string, unknown>; inParkdex: unknown }>(await call("/api/parks/osm/relation-222"));
  assert.equal(prefill.inParkdex, null);
  assert.deepEqual([prefill.draft.id, prefill.draft.category, prefill.draft.region], ["osm-relation-222", "regional", "Capital Region"]);
  const fields = {
    name: "Mill Hill Regional Park",
    short: "Mill Hill",
    category: "regional",
    region: "Capital Region",
    biome: "mountain",
    rarity: "common",
    blurb: "Garry oak meadows on a quiet hill.",
  };
  const before = await revision();
  const created = await call("/api/parks/osm/relation-222", { method: "POST", body: { park: fields } });
  assert.equal(created.status, 201, await created.clone().text());
  assert.equal((await json<{ revision: number }>(created)).revision, before + 1);
  const park = (await pool.query("SELECT name, short, category, shape, biome, region, blurb FROM public.parks WHERE id = 'osm-relation-222'")).rows[0];
  assert.deepEqual(park, {
    name: "Mill Hill Regional Park",
    short: "Mill Hill",
    category: "regional",
    shape: "hex",
    biome: "mountain",
    region: "Capital Region",
    blurb: "Garry oak meadows on a quiet hill.",
  });
  assert.equal(await count("SELECT count(*) FROM public.park_drive WHERE park_id = 'osm-relation-222'"), 2, "drive rows for every hub");
  assert.equal((await pool.query("SELECT status FROM kip_park_drafts.drafts WHERE id = 'osm-relation-222'")).rows[0].status, "published");
  assert.deepEqual(await changes(before), ["boundary:osm-relation-222:upsert", "drive:osm-relation-222:upsert", "park:osm-relation-222:upsert"]);

  assert.equal(
    (await call("/api/parks/osm/relation-222", { method: "POST", body: { park: fields } })).status,
    409,
    "an outline already published is matched by its id",
  );
  assert.equal(
    (await call("/api/parks/osm/way-111", { method: "POST", body: { park: fields } })).status,
    409,
    "an outline that is a catalogue park is refused",
  );
  assert.equal(await count("SELECT count(*) FROM public.parks WHERE id = 'osm-way-111'"), 0);
});

test("delete removes the park and its founder in one revision and keeps visits as history", { skip: !DSN }, async () => {
  // One clock for both reads, so an hour of holding cannot tick over between them.
  const scoredAt = new Date().toISOString();
  const scoreBefore = Number((await pool.query("SELECT score FROM kip_game.player_scores($2) WHERE account_id = $1", [founder, scoredAt])).rows[0].score);
  const start = await revision();
  const deleted = await call("/api/parks/regional-thetis-lake", { method: "DELETE" });
  assert.equal(deleted.status, 200, await deleted.clone().text());
  assert.equal((await json<{ revision: number }>(deleted)).revision, start + 1);
  assert.deepEqual(await changes(start), ["boundary:regional-thetis-lake:delete", "drive:regional-thetis-lake:delete", "park:regional-thetis-lake:delete"]);
  for (const table of [
    "public.parks WHERE id",
    "public.boundaries WHERE park_id",
    "public.park_drive WHERE park_id",
    "kip_founders.parks WHERE park_id",
    "kip_park_drafts.drafts WHERE id",
  ]) {
    assert.equal(await count(`SELECT count(*) FROM ${table} = 'regional-thetis-lake'`), 0, table);
  }
  assert.equal(await count("SELECT count(*) FROM kip_game.visits WHERE park_id = 'regional-thetis-lake'"), 3, "visits stay as history");
  const scoreAfter = Number((await pool.query("SELECT score FROM kip_game.player_scores($2) WHERE account_id = $1", [founder, scoredAt])).rows[0].score);
  assert.equal(scoreBefore - scoreAfter, 24, "the founder bonus goes with the founder row");
  assert.equal((await call("/api/parks/regional-thetis-lake", { method: "DELETE" })).status, 404);

  // Without the draft left behind, the same OpenStreetMap park can be published again.
  const recreated = await call("/api/parks/osm/way-111", {
    method: "POST",
    body: {
      park: { name: "Thetis Lake", short: "Thetis Lake", category: "regional", region: "Capital Region", biome: "lake", rarity: "common", blurb: "Two lakes." },
    },
  });
  assert.equal(recreated.status, 201, await recreated.clone().text());

  await pool.query("INSERT INTO public.park_enrichment_jobs (rank, park_id) VALUES (1, 'municipal-beacon-hill')");
  const refused = await call("/api/parks/municipal-beacon-hill", { method: "DELETE" });
  assert.equal(refused.status, 409);
  assert.equal(await count("SELECT count(*) FROM public.parks WHERE id = 'municipal-beacon-hill'"), 1);
});

test("clearing a founder and replacing a cover change only the founder row", { skip: !DSN }, async () => {
  const { parkId } = { parkId: "osm-way-111" };
  const photo = Buffer.from(EXIF_GPS_JPEG);
  await pool.query(
    `INSERT INTO kip_founders.parks (park_id, account_id, attempt_id, source, photo_sha256, photo_bytes, photo_width, photo_height, moderation)
     VALUES ($1, $2, $3, 'osm_new', $4, $5, 16, 12, '{"version":1}'::jsonb)`,
    [parkId, visitor, randomUUID(), createHash("sha256").update(photo).digest("hex"), photo],
  );
  const before = await revision();
  const replaced = await call(`/api/parks/${parkId}/cover`, { method: "PUT", body: { photo: { base64: photo.toString("base64") } } });
  assert.equal(replaced.status, 200, await replaced.clone().text());
  const row = (await pool.query("SELECT octet_length(photo_bytes) AS size, moderation FROM kip_founders.parks WHERE park_id = $1", [parkId])).rows[0];
  assert.ok(Number(row.size) < photo.byteLength, "the stored cover has its metadata removed");
  assert.equal(row.moderation.operatorCoverReplacedAt, "2026-10-09T18:00:00.000Z");
  assert.equal((await call(`/api/parks/${parkId}/founder`, { method: "DELETE" })).status, 200);
  assert.equal(await count("SELECT count(*) FROM kip_founders.parks WHERE park_id = $1", [parkId]), 0);
  assert.equal(await count("SELECT count(*) FROM public.parks WHERE id = $1", [parkId]), 1, "the park stays and can be founded again");
  assert.equal(await revision(), before, "founder moderation is not synchronized content");
});

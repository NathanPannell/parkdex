import assert from "node:assert/strict";
import { test } from "node:test";
import { EXIF_GPS_JPEG } from "../../../worker/fixtures/exif-gps-jpeg.ts";
import { createDashboardApi, type DashboardEnv } from "../api.ts";
import type { MultiPolygon } from "./geometry.ts";
import { deleteStatements, hideStatements, unhideStatements } from "./manager.ts";
import { memoryParks } from "./memory.ts";
import { parseOsmRef } from "./osm.ts";

const ORIGIN = "https://operator.example.test";
const env: DashboardEnv = { DATABASE_URL: "postgres://unused" };
const NOW = Date.parse("2026-10-09T18:00:00Z");

function box(lng: number, lat: number, size = 0.002): MultiPolygon {
  return {
    type: "MultiPolygon",
    coordinates: [
      [
        [
          [lng - size, lat - size],
          [lng + size, lat - size],
          [lng + size, lat + size],
          [lng - size, lat + size],
          [lng - size, lat - size],
        ],
      ],
    ],
  };
}

function setup() {
  const stores = memoryParks();
  const { live, manager, osm } = stores;
  const add = (id: string, name: string, lng: number, lat: number, extra: Partial<{ category: string; region: string }> = {}) =>
    live.parks.set(id, {
      id,
      name,
      short: name,
      category: extra.category ?? "municipal",
      region: extra.region ?? "Capital",
      lat,
      lng,
      biome: "forest",
      shape: "circle",
      rarity: "common",
      scene: null,
      seed: 1,
      blurb: "A park.",
      geometry: box(lng, lat),
    });
  add("beacon-hill", "Beacon Hill Park", -123.36, 48.41);
  add("legacy-park", "Legacy Park", -123.94, 49.17, { region: "Nanaimo" });
  add("osm-way-77", "Founded Green", -123.33, 48.45);
  manager.legacy.add("legacy-park");
  manager.founders.set("osm-way-77", {
    handle: "tester_one",
    foundedAt: "2026-10-01T10:00:00.000Z",
    source: "osm_new",
    width: 16,
    height: 12,
    photo: { bytes: new Uint8Array([1, 2, 3]), contentType: "image/jpeg", sha256: "a".repeat(64) },
  });
  manager.visits.push(
    { parkId: "beacon-hill", accountId: "a", visitedAt: "2026-10-08T10:00:00.000Z" },
    { parkId: "beacon-hill", accountId: "a", visitedAt: "2026-09-01T10:00:00.000Z" },
    { parkId: "beacon-hill", accountId: "b", visitedAt: "2026-10-02T10:00:00.000Z" },
  );
  manager.tenures.push({
    parkId: "beacon-hill",
    handle: "tester_two",
    startedAt: "2026-10-02T10:00:00.000Z",
    lastVisitAt: "2026-10-02T10:00:00.000Z",
    endedAt: null,
  });
  // One outline that is Beacon Hill, one that is not in Parkdex.
  osm.features.push(
    {
      type: "way",
      id: 1001,
      name: "Beacon Hill Park",
      kind: "leisure=park",
      tags: { leisure: "park" },
      geometry: box(-123.3601, 48.4101, 0.0018),
      areaM2: 90_000,
    },
    {
      type: "relation",
      id: 2002,
      name: "Gonzales Hill Regional Park",
      kind: "leisure=park",
      tags: { leisure: "park", operator: "Capital Regional District" },
      geometry: box(-123.32, 48.42, 0.001),
      areaM2: 20_000,
    },
  );
  const api = createDashboardApi({ ...stores.dependencies, now: () => NOW });
  const call = (path: string, init: { method?: string; body?: unknown; origin?: string } = {}) => {
    const headers = new Headers();
    const method = init.method ?? "GET";
    if (method !== "GET") headers.set("origin", init.origin ?? ORIGIN);
    if (init.body !== undefined) headers.set("content-type", "application/json");
    return api(new Request(`${ORIGIN}${path}`, { method, headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) }), env);
  };
  return { ...stores, call };
}

const body = async <T>(response: Response) => (await response.json()) as T;

test("the catalogue lists each park's source, visibility, founder and visits, with top-line stats", async () => {
  const { call, manager } = setup();
  manager.osmOutlines = 13_856;
  manager.osmNotInParkdex = 12_000;
  const { parks } = await body<{ parks: Array<{ id: string; source: string; hidden: unknown; founder: { handle: string } | null; visits: number }> }>(
    await call("/api/parks"),
  );
  assert.deepEqual(
    parks.map((park) => [park.id, park.source, park.visits, park.founder?.handle ?? null]),
    [
      ["beacon-hill", "curated", 3, null],
      ["osm-way-77", "founded", 0, "tester_one"],
      ["legacy-park", "legacy", 0, null],
    ],
  );
  const { stats } = await body<{ stats: Record<string, number> }>(await call("/api/parks/stats"));
  assert.deepEqual([stats.live, stats.hidden, stats.founded, stats.osmOutlines, stats.osmNotInParkdex], [3, 0, 1, 13_856, 12_000]);
});

test("outlines and OpenStreetMap layers load by view and refuse views too wide to load", async () => {
  const { call } = setup();
  const { outlines } = await body<{ outlines: Array<{ id: string }> }>(await call("/api/parks/outlines?bbox=-123.4,48.4,-123.3,48.46"));
  assert.deepEqual(outlines.map((outline) => outline.id).sort(), ["beacon-hill", "osm-way-77"]);
  assert.equal((await call("/api/parks/outlines?bbox=-125,47,-120,50")).status, 422, "a whole-province view asks to zoom in");
  assert.equal((await call("/api/parks/outlines?bbox=1,2,3")).status, 400);
  assert.equal((await call("/api/parks/osm?bbox=-123.3,48.4,-123.4,48.46")).status, 400, "west must be less than east");

  const osm = await body<{ outlines: Array<{ id: number; inParkdex: { parkId: string } | null }>; truncated: boolean }>(
    await call("/api/parks/osm?bbox=-123.4,48.4,-123.3,48.46"),
  );
  assert.deepEqual(
    osm.outlines.map((outline) => [outline.id, outline.inParkdex?.parkId ?? null]),
    [
      [2002, null],
      [1001, "beacon-hill"],
    ],
    "smallest first, matched by catalogueMatch",
  );
  assert.equal(osm.truncated, false);
});

test("a park opens with its activity: visits, the flag holder and its content history", async () => {
  const { call } = setup();
  const { park, activity } = await body<{ park: { id: string; geometry: unknown }; activity: Record<string, any> }>(await call("/api/parks/beacon-hill"));
  assert.equal(park.id, "beacon-hill");
  assert.ok(park.geometry);
  assert.deepEqual(activity.visits, { total: 3, last30Days: 2, uniquePlayers: 2 });
  assert.equal(activity.flag.handle, "tester_two");
  assert.equal(activity.flag.up, true);
  assert.equal(activity.flag.fallsAt, "2026-11-01T10:00:00.000Z", "a flag falls 720 hours after the last visit");
  assert.equal(activity.tenures, 1);
  assert.equal(activity.founder, null);
  assert.equal(activity.source, "curated");
  const founded = await body<{ activity: { founder: { handle: string; photoSha256: string } } }>(await call("/api/parks/osm-way-77"));
  assert.equal(founded.activity.founder.handle, "tester_one");
  assert.equal((await call("/api/parks/missing-park")).status, 404);
});

test("hide and unhide are one click each, reversible, and each is one content revision", async () => {
  const { call, live } = setup();
  const before = live.revision;
  const hidden = await call("/api/parks/beacon-hill/hide", { method: "POST", body: { reason: "  Trail closed  for repairs " } });
  assert.equal(hidden.status, 200);
  assert.equal((await body<{ revision: number }>(hidden)).revision, before + 1);
  const row = (await body<{ parks: Array<{ id: string; hidden: { reason: string; source: string } | null }> }>(await call("/api/parks"))).parks.find(
    (park) => park.id === "beacon-hill",
  )!;
  assert.deepEqual([row.hidden?.reason, row.hidden?.source], ["Trail closed for repairs", "operator"]);
  assert.equal((await call("/api/parks/beacon-hill/hide", { method: "POST" })).status, 409, "hiding twice says it is already hidden");
  assert.equal((await body<{ stats: { live: number; hidden: number } }>(await call("/api/parks/stats"))).stats.hidden, 1);

  assert.equal((await call("/api/parks/beacon-hill/unhide", { method: "POST" })).status, 200);
  assert.equal((await call("/api/parks/beacon-hill/unhide", { method: "POST" })).status, 409);
  const { activity } = await body<{ activity: { hidden: unknown; history: Array<{ operation: string; entity: string }> } }>(
    await call("/api/parks/beacon-hill"),
  );
  assert.equal(activity.hidden, null);
  assert.deepEqual(
    activity.history
      .slice(0, 6)
      .map((change) => `${change.entity}:${change.operation}`)
      .sort(),
    ["boundary:delete", "boundary:upsert", "drive:delete", "drive:upsert", "park:delete", "park:upsert"],
    "hiding writes tombstones and unhiding writes the park back",
  );

  assert.equal((await call("/api/parks/beacon-hill/hide", { method: "POST", origin: "https://evil.example" })).status, 403);
  assert.equal((await call("/api/parks/beacon-hill/hide", { method: "POST", body: { reason: "x".repeat(501) } })).status, 400);
  assert.equal((await call("/api/parks/beacon-hill/hide", { method: "POST", body: { reason: "ok", extra: 1 } })).status, 400);
  assert.equal((await call("/api/parks/no-such-park/hide", { method: "POST" })).status, 404);
});

test("delete removes the park and its founder, needs the dashboard origin, and refuses parks in the enrichment queue", async () => {
  const { call, live, manager } = setup();
  assert.equal((await call("/api/parks/osm-way-77", { method: "DELETE", origin: "https://evil.example" })).status, 403);
  const response = await call("/api/parks/osm-way-77", { method: "DELETE" });
  assert.equal(response.status, 200);
  assert.ok(!live.parks.has("osm-way-77"));
  assert.ok(!manager.founders.has("osm-way-77"), "the founder and cover go with the park");
  assert.equal((await call("/api/parks/osm-way-77")).status, 404);
  assert.equal((await call("/api/parks/osm-way-77", { method: "DELETE" })).status, 404);
  manager.enrichment.add("beacon-hill");
  assert.equal((await call("/api/parks/beacon-hill", { method: "DELETE" })).status, 409);
  assert.ok(live.parks.has("beacon-hill"));
});

test("an outline not in Parkdex prefills the create form and publishes once", async () => {
  const { call, live } = setup();
  const prefill = await body<{ inParkdex: unknown; draft: Record<string, unknown>; outline: { geometry: MultiPolygon } }>(
    await call("/api/parks/osm/relation-2002"),
  );
  assert.equal(prefill.inParkdex, null);
  assert.deepEqual(
    [prefill.draft.id, prefill.draft.name, prefill.draft.short, prefill.draft.category, prefill.draft.region, prefill.draft.rarity],
    ["osm-relation-2002", "Gonzales Hill Regional Park", "Gonzales Hill", "regional", "Capital", "common"],
    "the category is guessed from the operator tag and the region comes from the nearest park",
  );
  assert.ok(Math.abs(Number(prefill.draft.lng) + 123.32) < 0.001, "the pin sits inside the outline");

  const fields = {
    name: "Gonzales Hill Regional Park",
    short: "Gonzales Hill",
    category: "regional",
    region: "Capital",
    biome: "mountain",
    rarity: "uncommon",
    blurb: "A rocky summit with an observatory.",
  };
  assert.equal(
    (await call("/api/parks/osm/relation-2002", { method: "POST", body: { park: { ...fields, blurb: "" } } })).status,
    400,
    "claim backups need a description",
  );
  assert.equal((await call("/api/parks/osm/relation-2002", { method: "POST", body: { park: { ...fields, region: "" } } })).status, 400, "and a region");
  assert.equal((await call("/api/parks/osm/relation-2002", { method: "POST", body: { park: fields }, origin: "https://evil.example" })).status, 403);
  const created = await call("/api/parks/osm/relation-2002", { method: "POST", body: { park: fields } });
  assert.equal(created.status, 201);
  assert.equal((await body<{ parkId: string }>(created)).parkId, "osm-relation-2002");
  const park = live.parks.get("osm-relation-2002")!;
  assert.deepEqual([park.shape, park.biome, park.rarity, park.blurb], ["hex", "mountain", "uncommon", "A rocky summit with an observatory."]);
  assert.deepEqual(park.geometry, prefill.outline.geometry);

  const again = await call("/api/parks/osm/relation-2002", { method: "POST", body: { park: fields } });
  assert.equal(again.status, 409, "the same outline is not published twice");
  const matched = await call("/api/parks/osm/way-1001", { method: "POST", body: { park: fields } });
  assert.equal(matched.status, 409, "an outline that already is a Parkdex park is refused");
  assert.match((await body<{ error: { message: string } }>(matched)).error.message, /Beacon Hill Park/);
  assert.equal((await call("/api/parks/osm/way-99")).status, 404);
  assert.equal((await call("/api/parks/osm/node-5")).status, 404);
  assert.deepEqual(parseOsmRef("way-23938892"), { type: "way", id: 23938892 });
  assert.equal(parseOsmRef("way-0"), null);
});

test("covers are served from the database, can be replaced with a cleaned JPEG, and clearing the founder removes them", async () => {
  const { call, manager } = setup();
  const cover = await call("/api/parks/osm-way-77/cover");
  assert.equal(cover.status, 200);
  assert.equal(cover.headers.get("content-type"), "image/jpeg");
  assert.equal(cover.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(new Uint8Array(await cover.arrayBuffer()), new Uint8Array([1, 2, 3]));

  const photo = { base64: Buffer.from(EXIF_GPS_JPEG).toString("base64") };
  assert.equal(
    (await call("/api/parks/osm-way-77/cover", { method: "PUT", body: { photo: { base64: Buffer.from("not a jpeg").toString("base64") } } })).status,
    400,
  );
  const replaced = await call("/api/parks/osm-way-77/cover", { method: "PUT", body: { photo } });
  assert.equal(replaced.status, 200);
  const founder = manager.founders.get("osm-way-77")!;
  assert.deepEqual([founder.width, founder.height], [16, 12]);
  assert.ok(founder.photo.bytes.byteLength < EXIF_GPS_JPEG.byteLength, "EXIF, XMP and comments are removed");
  assert.ok(!Buffer.from(founder.photo.bytes).includes("GPS"), "no position survives");
  assert.equal((await call("/api/parks/beacon-hill/cover", { method: "PUT", body: { photo } })).status, 404, "a park without a founder has no cover");

  assert.equal((await call("/api/parks/osm-way-77/founder", { method: "DELETE", origin: "https://evil.example" })).status, 403);
  assert.equal((await call("/api/parks/osm-way-77/founder", { method: "DELETE" })).status, 200);
  assert.equal((await call("/api/parks/osm-way-77/cover")).status, 404);
  assert.equal((await call("/api/parks/osm-way-77/founder", { method: "DELETE" })).status, 404);
});

test("the moderation statements hold the park row and raise named guards", () => {
  for (const statements of [hideStatements("p", "why"), unhideStatements("p"), deleteStatements("p")]) {
    assert.match(statements[0].text, /FOR UPDATE/);
    assert.match(statements[1].text, /park_missing/);
    assert.match(statements[statements.length - 1].text, /content_clock/);
  }
  assert.ok(
    hideStatements("p", "why").some((statement) => /'operator'/.test(statement.text)),
    "the dashboard always hides as the operator",
  );
  const remove = deleteStatements("p").map((statement) => statement.text);
  assert.ok(remove.findIndex((text) => text.includes("kip_park_drafts.drafts")) < remove.findIndex((text) => text.includes("DELETE FROM public.parks")));
});

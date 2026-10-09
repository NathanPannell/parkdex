import assert from "node:assert/strict";
import { test } from "node:test";
import { createFeedbackWorker } from "./index.ts";
import { createSqlOsmParkTable, type OsmParkTable } from "./osmParkTable.ts";
import { createOsmClient, type MultiPolygon, type OsmFeature, type Position } from "./osmParks.ts";

const box = (west: number, south: number, east: number, north: number): Position[] =>
  [[west, south], [east, south], [east, north], [west, north], [west, south]];
const multi = (...rings: Position[][]): MultiPolygon => ({ type: "MultiPolygon", coordinates: [rings] });

// Paterson Park in Ladner contains the pin; a big reserve with a pond contains it too; one garden is 730 m away; one is 3 km away.
const PIN: [number, number] = [-123.0601, 49.089];
const PATERSON: OsmFeature = { type: "way", id: 23938892, name: "Paterson Park", kind: "leisure=park", tags: { name: "Paterson Park", leisure: "park" }, geometry: multi(box(-123.062, 49.088, -123.058, 49.0902)), areaM2: 71_000 };
const RESERVE: OsmFeature = { type: "relation", id: 77, name: "Big Reserve", kind: "leisure=nature_reserve", tags: { leisure: "nature_reserve" }, geometry: multi(box(-123.1, 49.07, -123.0, 49.11), box(-123.09, 49.075, -123.08, 49.08)), areaM2: 32_000_000 };
const NEARBY: OsmFeature = { type: "way", id: 55, name: null, kind: "leisure=garden", tags: { leisure: "garden" }, geometry: multi(box(-123.0601, 49.0956, -123.0595, 49.096)), areaM2: 2_000 };
const FAR: OsmFeature = { type: "way", id: 66, name: "Far Park", kind: "leisure=park", tags: {}, geometry: multi(box(-123.06, 49.117, -123.059, 49.118)), areaM2: 8_000 };

function table(features: OsmFeature[] | Error, calls: string[] = []): OsmParkTable {
  return {
    async near(lat, lng, radiusM) {
      calls.push(`near ${lat},${lng},${radiusM}`);
      if (features instanceof Error) throw features;
      return features;
    },
    async get(ref) {
      calls.push(`get ${ref.type}/${ref.id}`);
      if (features instanceof Error) throw features;
      return features.find((feature) => feature.type === ref.type && feature.id === ref.id) ?? null;
    },
  };
}

function noNetwork(calls: string[] = []): typeof fetch {
  return (async (url: string) => {
    calls.push(String(url));
    throw new Error("no network in this test");
  }) as unknown as typeof fetch;
}

test("the table narrows by bounding box and returns outlines as features", async () => {
  const seen: { text: string; params: unknown[] }[] = [];
  const sqlTable = createSqlOsmParkTable({
    async query(text, params = []) {
      seen.push({ text, params });
      return [
        { osm_type: "way", osm_id: "23938892", name: "Paterson Park", kind: "leisure=park", tags: { name: "Paterson Park", leisure: "park" }, area_m2: 71000.4, geometry: PATERSON.geometry },
        { osm_type: "node", osm_id: "1", name: "bad", kind: "leisure=park", tags: {}, area_m2: 1, geometry: PATERSON.geometry },
      ];
    },
  });
  const features = await sqlTable.near(PIN[1], PIN[0], 1_000);
  assert.deepEqual(features.map((feature) => [feature.type, feature.id, feature.name, feature.areaM2]), [["way", 23938892, "Paterson Park", 71000]]);
  assert.match(seen[0].text, /FROM kip_osm\.parks/);
  assert.match(seen[0].text, /min_lat <= \$2 AND max_lat >= \$1 AND min_lng <= \$4 AND max_lng >= \$3/);
  const [south, north, west, east] = seen[0].params as number[];
  assert.ok(south < PIN[1] && north > PIN[1] && west < PIN[0] && east > PIN[0]);
  assert.ok(Math.abs((north - south) * 110_540 - 2_000) < 1, "a 1 km radius each way");
  assert.equal((await sqlTable.get({ type: "way", id: 23938892 }))?.name, "Paterson Park");
  assert.deepEqual(seen[1].params, ["way", 23938892]);
});

test("search answers from the table without touching any live service", async () => {
  const network: string[] = [];
  const client = createOsmClient({}, noNetwork(network), { table: table([RESERVE, PATERSON, NEARBY, FAR]), nominatimSpacingMs: 0 });
  const parks = await client.search(PIN[1], PIN[0]);
  assert.deepEqual(network, []);
  // Both containing outlines first (smaller first), then the garden 730 m away; the far park is dropped by real distance.
  assert.deepEqual(parks.map((park) => [park.id, park.containsPin]), [[23938892, true], [77, true], [55, false]]);
  assert.ok(parks[2].distanceM > 650 && parks[2].distanceM < 800);
  assert.equal(parks[1].geometry.coordinates[0].length, 2, "the reserve keeps its pond");
});

test("tiny planters near the pin are left out unless the pin is inside one", async () => {
  const planter: OsmFeature = { type: "way", id: 88, name: null, kind: "leisure=garden", tags: { leisure: "garden" }, geometry: multi(box(-123.0575, 49.0895, -123.0574, 49.0896)), areaM2: 80 };
  const around: OsmFeature = { ...planter, id: 89, geometry: multi(box(-123.06015, 49.08895, -123.06005, 49.08905)) };
  const parks = await createOsmClient({}, noNetwork(), { table: table([PATERSON, planter, around]) }).search(PIN[1], PIN[0]);
  assert.deepEqual(parks.map((park) => park.id), [89, 23938892]);
});

test("with nothing in the table near the pin, or the table unreadable, the live services are asked", async () => {
  for (const contents of [[FAR], new Error("relation \"kip_osm.parks\" does not exist")]) {
    const network: string[] = [];
    const client = createOsmClient({ NOMINATIM_URL: "https://nominatim.example.test", OVERPASS_URLS: "https://overpass.example.test/api/interpreter" },
      noNetwork(network), { table: table(contents), nominatimSpacingMs: 0, overpassGraceMs: 0 });
    await assert.rejects(client.search(PIN[1], PIN[0]));
    assert.ok(network.some((url) => url.startsWith("https://nominatim.example.test/search")), "Nominatim was asked");
  }
});

test("the outline fetch at submit uses the table first", async () => {
  const network: string[] = [];
  const calls: string[] = [];
  const client = createOsmClient({}, noNetwork(network), { table: table([PATERSON], calls) });
  assert.equal((await client.feature({ type: "way", id: 23938892 }))?.name, "Paterson Park");
  assert.deepEqual(network, []);
  assert.deepEqual(calls, ["get way/23938892"]);
});

test("GET /api/osm/parks uses the table the worker builds, and still marks parks already on the map", async () => {
  const catalogue = [{ id: "municipal-delta-paterson", name: "Paterson Park", region: "South Coast", lat: 49.089, lng: -123.06, boundary: PATERSON.geometry }];
  const worker = createFeedbackWorker({
    fetch: noNetwork(),
    osmParkTable: () => table([PATERSON, NEARBY]),
    osmSearchAllowed: async () => true,
    createProposalReviewStore: () => ({ nearbyParks: async () => catalogue }) as never,
  });
  const response = await worker.fetch(new Request(`https://api.example.test/api/osm/parks?lat=${PIN[1]}&lng=${PIN[0]}`), { SESSION_SECRET: "test-session-secret-which-is-long-enough" } as never);
  assert.equal(response.status, 200);
  const body = await response.json() as { parks: { id: number; inCatalogue: unknown }[] };
  assert.deepEqual(body.parks.map((park) => [park.id, park.inCatalogue]), [
    [23938892, { parkId: "municipal-delta-paterson", name: "Paterson Park" }],
    [55, null],
  ]);
});

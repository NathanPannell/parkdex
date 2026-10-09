import assert from "node:assert/strict";
import { test } from "node:test";
import { createFeedbackWorker } from "./index.ts";
import {
  assembleRings,
  createOsmClient,
  DEFAULT_OVERPASS_URLS,
  nominatimBase,
  overpassEndpoints,
  distanceToMultiPolygon,
  multiPolygonArea,
  OSM_USER_AGENT,
  pointInMultiPolygon,
  type MultiPolygon,
  type OsmClient,
  type Position,
} from "./osmParks.ts";
import { HttpError } from "./validation.ts";

const pt = ([lon, lat]: Position) => ({ lat, lon });
const geometry = (positions: Position[]) => positions.map(pt);

// A park in two parts: a large square with a pond (hole), stitched from two open ways, one
// of them drawn backwards, plus a separate small island square.
const RELATION = {
  type: "relation",
  id: 1001,
  tags: { type: "multipolygon", leisure: "park", name: "Two Part Park", operator: "City of Victoria", "addr:street": "dropped" },
  bounds: { minlat: 48.45, minlon: -123.36, maxlat: 48.456, maxlon: -123.346 },
  members: [
    { type: "way", ref: 1, role: "outer", geometry: geometry([[-123.36, 48.45], [-123.35, 48.45], [-123.35, 48.456]]) },
    { type: "way", ref: 2, role: "outer", geometry: geometry([[-123.36, 48.45], [-123.36, 48.456], [-123.35, 48.456]]) },
    { type: "way", ref: 3, role: "inner", geometry: geometry([[-123.357, 48.452], [-123.353, 48.452], [-123.353, 48.454], [-123.357, 48.454], [-123.357, 48.452]]) },
    { type: "way", ref: 4, role: "outer", geometry: geometry([[-123.348, 48.45], [-123.346, 48.45], [-123.346, 48.452], [-123.348, 48.452], [-123.348, 48.45]]) },
    { type: "node", ref: 5, role: "label" },
  ],
};
const WAY = {
  type: "way",
  id: 2002,
  tags: { leisure: "garden", name: "Corner Garden" },
  bounds: { minlat: 48.4565, minlon: -123.3601, maxlat: 48.4572, maxlon: -123.359 },
  geometry: geometry([[-123.3601, 48.4565], [-123.359, 48.4565], [-123.359, 48.4572], [-123.3601, 48.4572], [-123.3601, 48.4565]]),
};
const PRIVATE = { type: "way", id: 3003, tags: { leisure: "garden", access: "private" }, bounds: { minlat: 48.451, minlon: -123.359, maxlat: 48.4512, maxlon: -123.3588 } };
const HUGE = { type: "relation", id: 4004, tags: { boundary: "protected_area", name: "Big Watershed" }, bounds: { minlat: 48.3, minlon: -123.7, maxlat: 48.6, maxlon: -123.3 } };
// Nominatim is first by default; these Overpass tests turn it off to see Overpass alone.
const OVERPASS_ONLY = { NOMINATIM_URL: "off" };
const summary = (element: Record<string, unknown>) => ({ type: element.type, id: element.id, tags: element.tags, bounds: element.bounds });

type Call = { query: string; headers: Headers };

function overpass(handler: (query: string) => unknown, calls: Call[] = []): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const query = decodeURIComponent(String(init?.body).replace(/^data=/, ""));
    calls.push({ query, headers: new Headers(init?.headers) });
    const body = handler(query);
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

function parkFixture(query: string) {
  if (query.includes("out tags bb")) return { elements: [summary(RELATION), summary(WAY), PRIVATE, HUGE] };
  return { elements: [RELATION, WAY] };
}

test("search assembles a relation with holes and several parts, and a plain way", async () => {
  const calls: Call[] = [];
  const client = createOsmClient(OVERPASS_ONLY, overpass(parkFixture, calls));
  const parks = await client.search(48.451, -123.359);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].headers.get("user-agent"), OSM_USER_AGENT);
  assert.match(calls[0].query, /is_in\(48\.451,-123\.359\)/);
  assert.match(calls[0].query, /around:250,48\.451,-123\.359/);
  // Private gardens and huge protected areas never get their geometry fetched.
  assert.match(calls[1].query, /way\(id:2002\);/);
  assert.match(calls[1].query, /relation\(id:1001\);/);
  assert.doesNotMatch(calls[1].query, /3003|4004/);

  assert.deepEqual(parks.map((park) => [park.type, park.id, park.containsPin]), [["relation", 1001, true], ["way", 2002, false]]);
  const relation = parks[0];
  assert.equal(relation.name, "Two Part Park");
  assert.equal(relation.kind, "leisure=park");
  assert.deepEqual(relation.tags, { name: "Two Part Park", leisure: "park", operator: "City of Victoria" });
  assert.equal(relation.geometry.coordinates.length, 2, "both parts are kept");
  assert.equal(relation.geometry.coordinates[0].length, 2, "the large part keeps its hole");
  assert.equal(relation.geometry.coordinates[1].length, 1);
  for (const polygon of relation.geometry.coordinates) {
    for (const ring of polygon) assert.deepEqual(ring[0], ring[ring.length - 1], "rings are closed");
  }
  // About 740 m x 667 m, minus a 296 m x 222 m pond, plus a 148 m x 222 m island.
  assert.ok(Math.abs(relation.areaM2 - (493_000 - 66_000 + 33_000)) < 10_000, `area ${relation.areaM2}`);
  assert.equal(parks[1].name, "Corner Garden");
  assert.ok(parks[1].distanceM > 500 && parks[1].distanceM < 700);
});

test("a pin in the pond is outside the park but close to it", async () => {
  const client = createOsmClient(OVERPASS_ONLY, overpass(parkFixture));
  const [relation] = await client.search(48.453, -123.355);
  assert.equal(relation.id, 1001);
  assert.equal(relation.containsPin, false);
  assert.ok(relation.distanceM > 100 && relation.distanceM < 150, `distance ${relation.distanceM}`);
});

test("nothing found returns an empty list without a geometry request", async () => {
  const calls: Call[] = [];
  const client = createOsmClient(OVERPASS_ONLY, overpass(() => ({ elements: [] }), calls));
  assert.deepEqual(await client.search(48.5, -123.4), []);
  assert.equal(calls.length, 1);
});

test("a slow Overpass answer times out cleanly", async () => {
  const hanging = ((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  })) as unknown as typeof fetch;
  const client = createOsmClient({ NOMINATIM_URL: "off" }, hanging, { timeoutMs: 30 });
  await assert.rejects(client.search(48.45, -123.36), (error: unknown) => error instanceof HttpError && error.status === 503 && error.code === "osm_unavailable");
});

const FIRST = "https://overpass.first.test/api/interpreter";
const SECOND = "https://overpass.second.test/api/interpreter";
// Nominatim is off here so these tests see Overpass alone; it has its own tests below.
const TWO = { OVERPASS_URLS: `${FIRST}, ${SECOND}`, NOMINATIM_URL: "off" };

/** Records which endpoint each request went to; `first` decides how the first endpoint fails. */
function failover(first: "timeout" | "504" | "429" | "remark" | "ok") {
  const urls: string[] = [];
  const good = overpass(parkFixture);
  const fetcher = ((url: string, init?: RequestInit) => {
    urls.push(String(url));
    if (String(url) === FIRST && first !== "ok") {
      if (first === "timeout") {
        return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
      }
      if (first === "remark") return Promise.resolve(new Response(JSON.stringify({ elements: [], remark: "runtime error: Query timed out in \"query\" at line 3 after 10 seconds." })));
      return Promise.resolve(new Response("<html>busy</html>", { status: first === "504" ? 504 : 429 }));
    }
    return good(url, init);
  }) as unknown as typeof fetch;
  return { urls, fetcher };
}

for (const failure of ["timeout", "504", "429", "remark"] as const) {
  test(`a first endpoint that fails with ${failure} hands the search to the next, which also answers the geometry`, async () => {
    const { urls, fetcher } = failover(failure);
    const parks = await createOsmClient(TWO, fetcher, { timeoutMs: 30 }).search(48.451, -123.359);
    assert.equal(parks.length, 2);
    assert.deepEqual(urls, [FIRST, SECOND, SECOND]);
  });
}

test("a healthy first endpoint answers both the search and the geometry", async () => {
  const { urls, fetcher } = failover("ok");
  await createOsmClient(TWO, fetcher).search(48.451, -123.359);
  assert.deepEqual(urls, [FIRST, FIRST]);
});

test("when every endpoint fails the search is a clean 503 after one try each", async () => {
  const urls: string[] = [];
  const busy = (async (url: string) => {
    urls.push(String(url));
    return new Response("Too many requests", { status: 429 });
  }) as unknown as typeof fetch;
  await assert.rejects(createOsmClient(TWO, busy).search(48.45, -123.36), (error: unknown) => error instanceof HttpError && error.status === 503 && error.code === "osm_unavailable");
  assert.deepEqual(urls, [FIRST, SECOND]);
  const remarkCalls: Call[] = [];
  const remark = createOsmClient(TWO, overpass(() => ({ elements: [], remark: "runtime error: out of memory" }), remarkCalls));
  await assert.rejects(remark.feature({ type: "way", id: 1 }), (error: unknown) => error instanceof HttpError && error.code === "osm_unavailable");
  assert.equal(remarkCalls.length, 2);
});

test("endpoints come from OVERPASS_URLS, then OVERPASS_URL, then the defaults", () => {
  assert.deepEqual(overpassEndpoints({}), [...DEFAULT_OVERPASS_URLS]);
  assert.equal(DEFAULT_OVERPASS_URLS[0], "https://overpass.private.coffee/api/interpreter");
  assert.deepEqual(overpassEndpoints({ OVERPASS_URL: FIRST }), [FIRST]);
  assert.deepEqual(overpassEndpoints({ OVERPASS_URLS: ` ${SECOND},${FIRST},${SECOND}`, OVERPASS_URL: "https://ignored.test/" }), [SECOND, FIRST]);
  assert.deepEqual(overpassEndpoints({ OVERPASS_URLS: "http://insecure.test/api, not a url" }), [...DEFAULT_OVERPASS_URLS]);
});

// ---------------------------------------------------------------- Nominatim first

const NOMINATIM = "https://nominatim.example.test";
const WITH_NOMINATIM = { OVERPASS_URLS: `${FIRST}, ${SECOND}`, NOMINATIM_URL: NOMINATIM };
const PIN: [number, number] = [-123.0630, 49.0105];
const box = (west: number, south: number, east: number, north: number): Position[] => [[west, south], [east, south], [east, north], [west, north], [west, south]];
// Like Boundary Bay Regional Park: the pin is inside, but the park's centre is about 2.5 km east.
const BIG_RING = box(-123.0660, 49.0050, -122.9960, 49.0160);
// A small park 400 m north of the pin.
const NEAR_RING = box(-123.0640, 49.0141, -123.0620, 49.0151);
// A reserve with a pond, 600 m west.
const RESERVE_OUTER = box(-123.0760, 49.0090, -123.0712, 49.0120);
const RESERVE_POND = box(-123.0745, 49.0100, -123.0730, 49.0110);
// Its bounding box is within 1 km, but its outline is 1.3 km away.
const SLIVER_RING = box(-123.0630, 49.0200, -123.0450, 49.0220);
const bb = (ring: Position[]) => {
  const lngs = ring.map((point) => point[0]), lats = ring.map((point) => point[1]);
  return [Math.min(...lats), Math.max(...lats), Math.min(...lngs), Math.max(...lngs)].map(String);
};
const PARK_RESULTS = [
  { osm_type: "way", osm_id: 24722692, category: "leisure", type: "park", name: "Boundary Bay Regional Park", boundingbox: bb(BIG_RING), extratags: { operator: "Metro Vancouver" } },
  { osm_type: "way", osm_id: 501, category: "leisure", type: "park", name: "Corner Park", boundingbox: bb(NEAR_RING) },
  { osm_type: "way", osm_id: 502, category: "leisure", type: "park", name: "Far Park", boundingbox: ["49.04", "49.05", "-123.04", "-123.03"] },
  { osm_type: "way", osm_id: 503, category: "leisure", type: "park", name: "Sliver Park", boundingbox: ["49.0185", "49.022", "-123.063", "-123.045"] },
  { osm_type: "node", osm_id: 9, category: "leisure", type: "park", name: "A park node" },
  { osm_type: "way", osm_id: 10, category: "amenity", type: "school", name: "Park School" },
  { osm_type: "way", osm_id: 11, category: "leisure", type: "garden", name: "Private Park Garden", extratags: { access: "private" } },
];
const RESERVE_RESULTS = [
  { osm_type: "relation", osm_id: 555, category: "leisure", type: "nature_reserve", name: "Pond Reserve", boundingbox: bb(RESERVE_OUTER), extratags: { operator: "Delta" } },
];
const OUTLINES: Record<string, unknown> = {
  W24722692: { type: "Feature", properties: { osm_type: "way", osm_id: 24722692, category: "leisure", type: "park", name: "Boundary Bay Regional Park" }, geometry: { type: "Polygon", coordinates: [BIG_RING] } },
  W501: { type: "Feature", properties: { osm_type: "way", osm_id: 501, category: "leisure", type: "park", name: "Corner Park" }, geometry: { type: "Polygon", coordinates: [NEAR_RING] } },
  W503: { type: "Feature", properties: { osm_type: "way", osm_id: 503, category: "leisure", type: "park", name: "Sliver Park" }, geometry: { type: "Polygon", coordinates: [SLIVER_RING] } },
  R555: { type: "Feature", properties: { osm_type: "relation", osm_id: 555, category: "leisure", type: "nature_reserve", name: "Pond Reserve", extratags: { operator: "Delta" } }, geometry: { type: "MultiPolygon", coordinates: [[RESERVE_OUTER, RESERVE_POND]] } },
};

type NominatimCall = { url: string; at: number; agent: string | null };

/** Nominatim answers from the fixtures; Overpass answers with `overpassBody` or refuses. */
function nominatimWorld(options: { parks?: unknown[]; reserves?: unknown[]; nominatimStatus?: number; overpassBody?: (query: string) => unknown } = {}) {
  const calls: NominatimCall[] = [];
  const good = options.overpassBody ? overpass(options.overpassBody) : null;
  const fetcher = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), at: Date.now(), agent: new Headers(init?.headers).get("user-agent") });
    if (!String(url).startsWith(NOMINATIM)) return good ? good(url, init) : new Response("<html>busy</html>", { status: 504 });
    if (options.nominatimStatus && options.nominatimStatus !== 200) return new Response("busy", { status: options.nominatimStatus });
    const params = new URL(String(url)).searchParams;
    if (String(url).includes("/lookup")) {
      const features = params.get("osm_ids")!.split(",").map((id) => OUTLINES[id]).filter(Boolean);
      return new Response(JSON.stringify({ type: "FeatureCollection", features }), { status: 200 });
    }
    const results = params.get("q") === "nature reserve" ? options.reserves ?? RESERVE_RESULTS : options.parks ?? PARK_RESULTS;
    return new Response(JSON.stringify(results), { status: 200 });
  }) as unknown as typeof fetch;
  const nominatim = () => calls.filter((call) => call.url.startsWith(NOMINATIM));
  return { calls, nominatim, fetcher };
}

test("Nominatim finds the park that contains the pin even when its centre is kilometres away", async () => {
  const { nominatim, fetcher } = nominatimWorld();
  const parks = await createOsmClient(WITH_NOMINATIM, fetcher, { nominatimSpacingMs: 0, overpassGraceMs: 0 }).search(PIN[1], PIN[0]);
  const requests = nominatim().map((call) => new URL(call.url));
  assert.deepEqual(requests.map((url) => `${url.pathname} ${url.searchParams.get("q") ?? ""}`.trim()), ["/search park", "/search nature reserve", "/lookup"]);
  const [west, north, east, south] = requests[0].searchParams.get("viewbox")!.split(",").map(Number);
  assert.ok(east - west > 0.07 && north - south > 0.05, "the search box is several km across");
  assert.equal(requests[0].searchParams.get("bounded"), "1");
  // One /lookup for every candidate whose bounding box is near; far parks, nodes, non-parks and private places are skipped.
  assert.deepEqual(requests[2].searchParams.get("osm_ids")!.split(",").sort(), ["R555", "W24722692", "W501", "W503"]);
  assert.equal(requests[2].searchParams.get("polygon_geojson"), "1");
  assert.ok(nominatim().every((call) => call.agent === OSM_USER_AGENT));

  // The sliver's outline is 1.3 km away, so it is dropped by real distance.
  assert.deepEqual(parks.map((park) => [park.type, park.id, park.containsPin]), [
    ["way", 24722692, true],
    ["way", 501, false],
    ["relation", 555, false],
  ]);
  assert.equal(parks[0].name, "Boundary Bay Regional Park");
  assert.equal(parks[2].geometry.coordinates[0].length, 2, "the reserve keeps its pond as a hole");
  assert.equal(parks[2].kind, "leisure=nature_reserve");
  assert.ok(parks[1].distanceM > 300 && parks[1].distanceM < 500);
});

test("a wide search cut off at its limit adds a tighter one for the small parks nearby", async () => {
  const filler = Array.from({ length: 40 }, (_, index) => ({ osm_type: "way", osm_id: 9000 + index, category: "leisure", type: "park", name: `Park ${index}`, boundingbox: ["49.09", "49.1", "-123.0", "-122.99"] }));
  const { nominatim, fetcher } = nominatimWorld({ parks: filler });
  await createOsmClient(WITH_NOMINATIM, fetcher, { nominatimSpacingMs: 0, overpassGraceMs: 0 }).search(PIN[1], PIN[0]);
  const searches = nominatim().map((call) => new URL(call.url)).filter((url) => url.pathname === "/search");
  assert.equal(searches.length, 3);
  const widths = searches.map((url) => { const [w, , e] = url.searchParams.get("viewbox")!.split(",").map(Number); return e - w; });
  assert.ok(widths[1] < widths[0] / 3, "the second search is the tight one");
});

test("Nominatim finding nothing returns an empty list without an outline request", async () => {
  const { nominatim, fetcher } = nominatimWorld({ parks: [], reserves: [] });
  assert.deepEqual(await createOsmClient(WITH_NOMINATIM, fetcher, { nominatimSpacingMs: 0, overpassGraceMs: 0 }).search(48.5, -123.4), []);
  assert.equal(nominatim().filter((call) => call.url.includes("/lookup")).length, 0);
});

test("when Nominatim fails the search waits for Overpass, and fails only when both do", async () => {
  const healthy = nominatimWorld({ nominatimStatus: 503, overpassBody: parkFixture });
  const parks = await createOsmClient(WITH_NOMINATIM, healthy.fetcher, { nominatimSpacingMs: 0 }).search(48.451, -123.359);
  assert.deepEqual(parks.map((park) => park.id), [1001, 2002]);
  const down = nominatimWorld({ nominatimStatus: 503 });
  await assert.rejects(createOsmClient(WITH_NOMINATIM, down.fetcher, { nominatimSpacingMs: 0 }).search(48.45, -123.36),
    (error: unknown) => error instanceof HttpError && error.code === "osm_unavailable");
});

test("Overpass results are merged in when Overpass answers in time", async () => {
  // Overpass finds an unnamed garden near the pin that a Nominatim name search cannot.
  const garden = { type: "way", id: 7007, tags: { leisure: "garden" }, bounds: { minlat: 49.0108, minlon: -123.0628, maxlat: 49.0112, maxlon: -123.0622 },
    geometry: geometry(box(-123.0628, 49.0108, -123.0622, 49.0112)) };
  const { fetcher } = nominatimWorld({ overpassBody: (query) => (query.includes("out tags bb") ? { elements: [summary(garden)] } : { elements: [garden] }) });
  const parks = await createOsmClient(WITH_NOMINATIM, fetcher, { nominatimSpacingMs: 0, overpassGraceMs: 1_000 }).search(PIN[1], PIN[0]);
  assert.deepEqual(parks.map((park) => park.id), [24722692, 7007, 501, 555]);
});

test("a failed Overpass endpoint is skipped for a while", async () => {
  let clock = 1_000_000;
  const { calls, fetcher } = nominatimWorld();
  const client = createOsmClient(WITH_NOMINATIM, fetcher, { nominatimSpacingMs: 0, overpassGraceMs: 1_000, now: () => clock });
  await client.search(PIN[1], PIN[0]);
  assert.ok(calls.some((call) => call.url === FIRST) && calls.some((call) => call.url === SECOND));
  calls.length = 0;
  await client.search(49.02, -123.07);
  assert.ok(!calls.some((call) => call.url === FIRST || call.url === SECOND), "no Overpass request while it cools down");
  clock += 3 * 60 * 1000;
  calls.length = 0;
  await client.search(49.03, -123.08);
  assert.ok(calls.some((call) => call.url === FIRST), "after the cooldown Overpass is tried again");
});

test("an outline fetch asks Nominatim /lookup first, keeps holes, and falls back to Overpass for ids Nominatim lacks", async () => {
  const { nominatim, calls, fetcher } = nominatimWorld({ overpassBody: () => ({ elements: [RELATION] }) });
  const client = createOsmClient(WITH_NOMINATIM, fetcher, { nominatimSpacingMs: 0 });
  const reserve = await client.feature({ type: "relation", id: 555 });
  assert.equal(new URL(nominatim()[0].url).searchParams.get("osm_ids"), "R555");
  assert.equal(reserve?.geometry.coordinates[0].length, 2);
  assert.ok(!calls.some((call) => call.url === FIRST));
  const fromOverpass = await client.feature({ type: "relation", id: 1001 });
  assert.equal(fromOverpass?.name, "Two Part Park");
  const nowhere = nominatimWorld();
  assert.equal(await createOsmClient(WITH_NOMINATIM, nowhere.fetcher, { nominatimSpacingMs: 0 }).feature({ type: "way", id: 999 }), null);
});

test("Nominatim requests are spaced out across clients", async () => {
  const { nominatim, fetcher } = nominatimWorld();
  await Promise.all([
    createOsmClient(WITH_NOMINATIM, fetcher, { nominatimSpacingMs: 60, overpassGraceMs: 0 }).search(PIN[1], PIN[0]),
    createOsmClient(WITH_NOMINATIM, fetcher, { nominatimSpacingMs: 60, overpassGraceMs: 0 }).search(49.05, -123.1),
  ]);
  const starts = nominatim().map((call) => call.at).sort((a, b) => a - b);
  assert.ok(starts.length >= 5, `${starts.length} requests`);
  for (let index = 1; index < starts.length; index += 1) assert.ok(starts[index] - starts[index - 1] >= 55, `gap ${starts[index] - starts[index - 1]}`);
});

test("NOMINATIM_URL can point elsewhere or turn Nominatim off", () => {
  assert.equal(nominatimBase({}), "https://nominatim.openstreetmap.org");
  assert.equal(nominatimBase({ NOMINATIM_URL: "https://nominatim.example.test/" }), "https://nominatim.example.test");
  assert.equal(nominatimBase({ NOMINATIM_URL: "off" }), null);
  assert.equal(nominatimBase({ NOMINATIM_URL: "http://insecure.test" }), null);
});

test("repeat searches near the same spot use the cache", async () => {
  const calls: Call[] = [];
  const client = createOsmClient(OVERPASS_ONLY, overpass(parkFixture, calls));
  await client.search(48.45101, -123.35901);
  await client.search(48.45102, -123.35902);
  assert.equal(calls.length, 2);
});

test("feature() fetches one outline by id with full detail", async () => {
  const calls: Call[] = [];
  const client = createOsmClient(OVERPASS_ONLY, overpass(() => ({ elements: [RELATION] }), calls));
  const feature = await client.feature({ type: "relation", id: 1001 });
  assert.equal(feature?.geometry.coordinates.length, 2);
  assert.match(calls[0].query, /relation\(id:1001\);/);
  assert.equal(await createOsmClient(OVERPASS_ONLY, overpass(() => ({ elements: [] }))).feature({ type: "way", id: 9 }), null);
});

test("rings are stitched from segments in any direction and open rings are dropped", () => {
  const rings = assembleRings([
    [[0, 0], [1, 0]],
    [[1, 1], [1, 0]],
    [[1, 1], [0, 1], [0, 0]],
    [[5, 5], [6, 6]],
  ]);
  assert.deepEqual(rings, [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]]);
});

test("point and distance checks respect holes", () => {
  const square: MultiPolygon = {
    type: "MultiPolygon",
    coordinates: [[
      [[-123.36, 48.45], [-123.35, 48.45], [-123.35, 48.456], [-123.36, 48.456], [-123.36, 48.45]],
      [[-123.357, 48.452], [-123.353, 48.452], [-123.353, 48.454], [-123.357, 48.454], [-123.357, 48.452]],
    ]],
  };
  assert.equal(pointInMultiPolygon([-123.359, 48.451], square), true);
  assert.equal(pointInMultiPolygon([-123.355, 48.453], square), false);
  assert.equal(distanceToMultiPolygon([-123.359, 48.451], square), 0);
  assert.ok(multiPolygonArea(square) > 400_000);
});

function fakeClient(result: Awaited<ReturnType<OsmClient["search"]>> | Error): OsmClient {
  return {
    async search() {
      if (result instanceof Error) throw result;
      return result;
    },
    async feature() { return null; },
  };
}

const SECRET = "test-session-secret-which-is-long-enough";

test("GET /api/osm/parks validates the pin, rate limits per client and returns candidates", async () => {
  const subjects: string[] = [];
  let allowed = true;
  const geometryValue: MultiPolygon = { type: "MultiPolygon", coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]]] };
  const worker = createFeedbackWorker({
    osmClient: fakeClient([{ type: "way", id: 7, name: "Pocket Park", kind: "leisure=park", tags: { leisure: "park" }, geometry: geometryValue, areaM2: 1200, containsPin: true, distanceM: 0 }]),
    osmSearchAllowed: async (subject) => {
      subjects.push(subject);
      return allowed;
    },
  });
  const env = { SESSION_SECRET: SECRET } as never;
  const call = (query: string, ip = "203.0.113.9") =>
    worker.fetch(new Request(`https://api.example.test/api/osm/parks${query}`, { headers: { "cf-connecting-ip": ip } }), env);

  assert.equal((await call("?lat=91&lng=0")).status, 400);
  assert.equal((await call("?lat=48.4")).status, 400);
  const ok = await call("?lat=48.45&lng=-123.36");
  assert.equal(ok.status, 200);
  const body = await ok.json() as { attribution: string; parks: Record<string, unknown>[] };
  assert.match(body.attribution, /OpenStreetMap/);
  assert.deepEqual(Object.keys(body.parks[0]).sort(), ["areaM2", "containsPin", "distanceM", "geometry", "id", "inCatalogue", "kind", "name", "type"]);
  assert.equal(subjects.length, 1);
  assert.match(subjects[0], /^[0-9a-f]{64}$/);
  assert.ok(!subjects[0].includes("203.0.113.9"));

  allowed = false;
  const limited = await call("?lat=48.45&lng=-123.36");
  assert.equal(limited.status, 429);
  assert.equal((await limited.json() as { code: string }).code, "rate_limited_osm");

  const post = await worker.fetch(new Request("https://api.example.test/api/osm/parks?lat=1&lng=1", { method: "POST" }), env);
  assert.equal(post.status, 405);
});

test("GET /api/osm/parks reports Overpass trouble as a 503", async () => {
  const worker = createFeedbackWorker({
    osmClient: fakeClient(new HttpError(503, "osm_unavailable", "OpenStreetMap is busy right now. Try again in a minute.")),
    osmSearchAllowed: async () => true,
  });
  const response = await worker.fetch(new Request("https://api.example.test/api/osm/parks?lat=48.45&lng=-123.36"), { SESSION_SECRET: SECRET } as never);
  assert.equal(response.status, 503);
  assert.equal((await response.json() as { code: string }).code, "osm_unavailable");
});

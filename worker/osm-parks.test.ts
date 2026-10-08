import assert from "node:assert/strict";
import { test } from "node:test";
import { createFeedbackWorker } from "./index.ts";
import {
  assembleRings,
  createOsmClient,
  DEFAULT_OVERPASS_URLS,
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
  const client = createOsmClient({}, overpass(parkFixture, calls));
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
  const client = createOsmClient({}, overpass(parkFixture));
  const [relation] = await client.search(48.453, -123.355);
  assert.equal(relation.id, 1001);
  assert.equal(relation.containsPin, false);
  assert.ok(relation.distanceM > 100 && relation.distanceM < 150, `distance ${relation.distanceM}`);
});

test("nothing found returns an empty list without a geometry request", async () => {
  const calls: Call[] = [];
  const client = createOsmClient({}, overpass(() => ({ elements: [] }), calls));
  assert.deepEqual(await client.search(48.5, -123.4), []);
  assert.equal(calls.length, 1);
});

test("a slow Overpass answer times out cleanly", async () => {
  const hanging = ((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  })) as unknown as typeof fetch;
  const client = createOsmClient({}, hanging, { timeoutMs: 30 });
  await assert.rejects(client.search(48.45, -123.36), (error: unknown) => error instanceof HttpError && error.status === 503 && error.code === "osm_unavailable");
});

const FIRST = "https://overpass.first.test/api/interpreter";
const SECOND = "https://overpass.second.test/api/interpreter";
const TWO = { OVERPASS_URLS: `${FIRST}, ${SECOND}` };

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

test("repeat searches near the same spot use the cache", async () => {
  const calls: Call[] = [];
  const client = createOsmClient({}, overpass(parkFixture, calls));
  await client.search(48.45101, -123.35901);
  await client.search(48.45102, -123.35902);
  assert.equal(calls.length, 2);
});

test("feature() fetches one outline by id with full detail", async () => {
  const calls: Call[] = [];
  const client = createOsmClient({}, overpass(() => ({ elements: [RELATION] }), calls));
  const feature = await client.feature({ type: "relation", id: 1001 });
  assert.equal(feature?.geometry.coordinates.length, 2);
  assert.match(calls[0].query, /relation\(id:1001\);/);
  assert.equal(await createOsmClient({}, overpass(() => ({ elements: [] }))).feature({ type: "way", id: 9 }), null);
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
  assert.deepEqual(Object.keys(body.parks[0]).sort(), ["areaM2", "containsPin", "distanceM", "geometry", "id", "kind", "name", "type"]);
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

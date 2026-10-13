import assert from "node:assert/strict";
import { test } from "node:test";
import { catalogueMatch, nameKey, type CataloguePark } from "./catalogueMatch.ts";
import { createFeedbackWorker } from "./index.ts";
import type { MultiPolygon, OsmCandidate, OsmClient, OsmFeature, Position } from "./osmParks.ts";
import type { ProposalReviewStore } from "./proposalReview.ts";

const box = (west: number, south: number, east: number, north: number): MultiPolygon =>
  ({ type: "MultiPolygon", coordinates: [[[[west, south], [east, south], [east, north], [west, north], [west, south]] as Position[]]] });

// Watershed Park in Delta, roughly: about 1.5 km by 1 km.
const WATERSHED: OsmFeature = {
  type: "way", id: 1552698508, name: "Watershed Park", kind: "leisure=nature_reserve", tags: { leisure: "nature_reserve" },
  geometry: box(-122.900, 49.108, -122.880, 49.118), areaM2: 1_600_000,
};
const park = (overrides: Partial<CataloguePark>): CataloguePark => ({ id: "x", name: "Somewhere", lat: 49.2, lng: -122.7, boundary: null, ...overrides });

test("an OSM park already published from a proposal matches by id", () => {
  assert.deepEqual(catalogueMatch(WATERSHED, [park({ id: "osm-way-1552698508", name: "Watershed Park" })]), { parkId: "osm-way-1552698508", name: "Watershed Park" });
});

test("an outline inside a catalogue park, or mostly covered by one, is that park", () => {
  const container = park({ id: "regional-big", name: "Big Regional Park", lat: 49.11, lng: -122.89, boundary: box(-122.95, 49.09, -122.85, 49.13) });
  assert.equal(catalogueMatch(WATERSHED, [container])?.parkId, "regional-big");
  // The same park drawn a little differently in the legacy import.
  const sameShape = park({ id: "municipal-watershed", name: "Delta Watershed", lat: 49.113, lng: -122.89, boundary: box(-122.899, 49.109, -122.882, 49.117) });
  assert.equal(catalogueMatch(WATERSHED, [sameShape])?.parkId, "municipal-watershed");
});

test("a small catalogue park inside a large outline does not make the outline a duplicate", () => {
  const playingField = park({ id: "municipal-pinewood", name: "Pinewood Playing Field", lat: 49.1102, lng: -122.8985, boundary: box(-122.899, 49.110, -122.898, 49.1105) });
  assert.equal(catalogueMatch(WATERSHED, [playingField]), null);
});

test("a catalogue park without a boundary matches by the same name close by, not far away", () => {
  // Pin-only legacy rows have nothing but a name and a pin to go on.
  const nearby = park({ id: "regional-watershed", name: "Watershed Regional Park", lat: 49.121, lng: -122.885 });
  assert.equal(catalogueMatch(WATERSHED, [nearby])?.parkId, "regional-watershed");
  const sameWords = park({ id: "municipal-park-watershed", name: "Park Watershed", lat: 49.121, lng: -122.885 });
  assert.equal(catalogueMatch(WATERSHED, [sameWords])?.parkId, "municipal-park-watershed", "word order and generic words don't matter");
  const far = park({ id: "community-watershed", name: "Watershed Park", lat: 49.3, lng: -123.1 });
  assert.equal(catalogueMatch(WATERSHED, [far]), null);
  // A name inside a longer one is another park, even with a pin right next to the outline.
  const longer = park({ id: "municipal-watershed-dog", name: "Watershed Dog Park", lat: 49.121, lng: -122.885 });
  assert.equal(catalogueMatch(WATERSHED, [longer]), null);
  assert.equal(nameKey("Château-Richer Provincial Park"), "chateau richer");
  assert.equal(nameKey("Park"), "");
});

test("a name never overrides the shapes: a catalogue park with a boundary next to the outline is another park", () => {
  // The same name, but its boundary is 300 m north of the outline.
  const beside = park({ id: "regional-watershed", name: "Watershed Regional Park", lat: 49.121, lng: -122.885, boundary: box(-122.886, 49.1205, -122.884, 49.1215) });
  assert.equal(catalogueMatch(WATERSHED, [beside]), null);
});

// Steveston, Richmond: the real OpenStreetMap outlines (way 179219507 and way 31902392). They
// touch neither each other nor share a name, but "steveston" is inside "steveston town square".
const TOWN_SQUARE: MultiPolygon = { type: "MultiPolygon", coordinates: [[[
  [-123.183254, 49.125553], [-123.182878, 49.125554], [-123.18288, 49.125276], [-123.183255, 49.125277], [-123.183254, 49.125553],
]]] };
const STEVESTON: MultiPolygon = { type: "MultiPolygon", coordinates: [[[
  [-123.180522, 49.125873], [-123.179685, 49.126405], [-123.179726, 49.127813], [-123.174312, 49.127932], [-123.174287, 49.125227],
  [-123.180991, 49.125252], [-123.18111, 49.125328], [-123.181113, 49.125879], [-123.180522, 49.125873],
]]] };

test("Steveston Community Park is not Steveston Town Square Park, in either order", () => {
  const steveston: OsmFeature = { type: "way", id: 31902392, name: "Steveston Community Park", kind: "leisure=park", tags: { leisure: "park" }, geometry: STEVESTON, areaM2: 123_477 };
  const townSquare: OsmFeature = { type: "way", id: 179219507, name: "Steveston Town Square Park", kind: "leisure=park", tags: { leisure: "park" }, geometry: TOWN_SQUARE, areaM2: 838 };
  const foundedSquare = park({ id: "osm-way-179219507", name: "Steveston Town Square Park", lat: 49.125415, lng: -123.183067, boundary: TOWN_SQUARE });
  const foundedSteveston = park({ id: "osm-way-31902392", name: "Steveston Community Park", lat: 49.126580, lng: -123.177200, boundary: STEVESTON });
  assert.equal(catalogueMatch(steveston, [foundedSquare]), null);
  assert.equal(catalogueMatch(townSquare, [foundedSteveston]), null);
  // Each is still itself once published.
  assert.equal(catalogueMatch(steveston, [foundedSquare, foundedSteveston])?.parkId, "osm-way-31902392");
  assert.equal(catalogueMatch(townSquare, [foundedSteveston, foundedSquare])?.parkId, "osm-way-179219507");
});

test("the same name and a good share of the same ground is the same park, even drawn differently", () => {
  // Two thin shoreline strips, each about 2 km by 30 m, offset along the shore so that neither
  // middle lies in the other but they share 45% of their length (Sheringham Point Park).
  const strip: OsmFeature = { type: "way", id: 2519257, name: "Sheringham Point Park", kind: "leisure=park", tags: { leisure: "park" }, geometry: box(-123.900, 48.380, -123.873, 48.3803), areaM2: 60_000 };
  const drawn = (name: string) => park({ id: "community-sheringham", name, lat: 48.3801, lng: -123.88, boundary: box(-123.88515, 48.38, -123.85815, 48.3803) });
  assert.equal(catalogueMatch(strip, [drawn("Sheringham Point Park")])?.parkId, "community-sheringham");
  assert.equal(catalogueMatch(strip, [drawn("Sheringham Point Lookout")]), null, "a longer name is not the same name");
  // Sharing only a sliver of ground is not enough.
  const sliver = park({ id: "community-sheringham", name: "Sheringham Point Park", lat: 48.3801, lng: -123.87, boundary: box(-123.8745, 48.38, -123.8475, 48.3803) });
  assert.equal(catalogueMatch(strip, [sliver]), null);
});

// Kejimkujik, roughly (#182): the pin is in the inland part, Seaside is a second part about 72 km
// away. Here Seaside is a 4 km by 4 km part with a 1 km hole of private land in it.
const ring = (west: number, south: number, east: number, north: number): Position[] =>
  [[west, south], [east, south], [east, north], [west, north], [west, south]];
const TWO_PARTS = park({
  id: "national-kejimkujik", name: "Kejimkujik National Park and National Historic Site", lat: 44.43829, lng: -65.2086,
  boundary: { type: "MultiPolygon", coordinates: [
    [ring(-65.45, 44.25, -65.05, 44.47)],
    [ring(-64.86, 43.83, -64.81, 43.87), ring(-64.84, 43.845, -64.83, 43.855)],
  ] },
});
const outline = (id: number, name: string, geometry: MultiPolygon): OsmFeature =>
  ({ type: "way", id, name, kind: "leisure=nature_reserve", tags: { leisure: "nature_reserve" }, geometry, areaM2: 1_000_000 });

test("an outline in a part far from the catalogue park's pin is that park; one in its hole or next to it is new", () => {
  // Kejimkujik National Park Seaside, inside the second part and outside its hole.
  const seaside = outline(342211953, "Kejimkujik National Park Seaside", box(-64.835, 43.835, -64.82, 43.843));
  assert.deepEqual(catalogueMatch(seaside, [TWO_PARTS]), { parkId: "national-kejimkujik", name: "Kejimkujik National Park and National Historic Site" });
  // A park in the hole is not part of the catalogue park.
  assert.equal(catalogueMatch(outline(1, "Hole Meadow", box(-64.838, 43.847, -64.832, 43.853)), [TWO_PARTS]), null);
  // A genuinely new park just outside the far part, its name unrelated.
  assert.equal(catalogueMatch(outline(2, "Neighbour Commons", box(-64.808, 43.84, -64.8, 43.846)), [TWO_PARTS]), null);
});

const SECRET = "test-session-secret-which-is-long-enough";

test("GET /api/osm/parks marks candidates that are already on the map", async () => {
  const candidates: OsmCandidate[] = [
    { ...WATERSHED, containsPin: true, distanceM: 0 },
    { type: "way", id: 24926315, name: "Sunbury Park", kind: "leisure=park", tags: { leisure: "park" }, geometry: box(-122.905, 49.120, -122.902, 49.122), areaM2: 60_000, containsPin: false, distanceM: 300 },
  ];
  const client: OsmClient = { search: async () => candidates, feature: async () => null };
  const catalogue = [park({ id: "regional-watershed", name: "Watershed Regional Park", lat: 49.113, lng: -122.89, boundary: box(-122.899, 49.109, -122.882, 49.117) })];
  const store = { nearbyParks: async () => catalogue.map((item) => ({ ...item, region: "Metro Vancouver" })) } as unknown as ProposalReviewStore;
  const worker = createFeedbackWorker({ osmClient: client, osmSearchAllowed: async () => true, createProposalReviewStore: () => store });
  const response = await worker.fetch(new Request("https://api.example.test/api/osm/parks?lat=49.1143&lng=-122.8923"), { SESSION_SECRET: SECRET } as never);
  assert.equal(response.status, 200);
  const body = await response.json() as { parks: { id: number; inCatalogue: unknown }[] };
  assert.deepEqual(body.parks.map((item) => [item.id, item.inCatalogue]), [
    [1552698508, { parkId: "regional-watershed", name: "Watershed Regional Park" }],
    [24926315, null],
  ]);

  // A failing catalogue lookup still returns the candidates, unmarked.
  const broken = createFeedbackWorker({ osmClient: client, osmSearchAllowed: async () => true,
    createProposalReviewStore: () => ({ nearbyParks: async () => { throw new Error("db down"); } }) as unknown as ProposalReviewStore });
  const unmarked = await (await broken.fetch(new Request("https://api.example.test/api/osm/parks?lat=49.1143&lng=-122.8923"), { SESSION_SECRET: SECRET } as never)).json() as { parks: { inCatalogue: unknown }[] };
  assert.deepEqual(unmarked.parks.map((item) => item.inCatalogue), [null, null]);
});

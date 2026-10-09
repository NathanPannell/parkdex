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

test("the same name close by matches, the same name far away does not", () => {
  const nearby = park({ id: "regional-watershed", name: "Watershed Regional Park", lat: 49.121, lng: -122.885, boundary: box(-122.886, 49.1205, -122.884, 49.1215) });
  assert.equal(catalogueMatch(WATERSHED, [nearby])?.parkId, "regional-watershed");
  const far = park({ id: "community-watershed", name: "Watershed Park", lat: 49.3, lng: -123.1, boundary: box(-123.101, 49.299, -123.099, 49.301) });
  assert.equal(catalogueMatch(WATERSHED, [far]), null);
  assert.equal(nameKey("Château-Richer Provincial Park"), "chateau richer");
  assert.equal(nameKey("Park"), "");
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

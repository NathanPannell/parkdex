import { describe, expect, it } from "vitest";
import { createSnapshotHandler } from "../../../../worker/content_sync";
import { validateParkSnapshot } from "../../../../worker/accounts/progress";
import { parkFromProposal } from "../../../../worker/parkPublish";
import type { OsmFeature } from "../../../../worker/osmParks";
import { claimPayload } from "../../accounts/personalStore";
import * as currentReader from "../manifest";
import * as readerV1 from "./reader-v1";
import snapshotFixture from "./fixtures/snapshot.json";

// A park published straight from a player's proposal must load in every supported build and
// survive a claim backup (docs/learnings/catalogue-cutover-validation.md).
const ring = (lng: number, lat: number, size: number): [number, number][] =>
  [[lng, lat], [lng + size, lat], [lng + size, lat + size], [lng, lat + size], [lng, lat]];
const FEATURES: OsmFeature[] = [
  {
    type: "relation", id: 9_876_543, name: "Swan Lake Christmas Hill Nature Sanctuary", kind: "leisure=nature_reserve",
    tags: { leisure: "nature_reserve" }, areaM2: 400_000,
    geometry: { type: "MultiPolygon", coordinates: [[ring(-123.38, 48.46, 0.01), ring(-123.376, 48.464, 0.002)], [ring(-123.36, 48.47, 0.002)]] },
  },
  {
    type: "way", id: 12, name: null, kind: "leisure=park", tags: { leisure: "park" }, areaM2: 2_000,
    geometry: { type: "MultiPolygon", coordinates: [[ring(-123.35, 48.44, 0.001)]] },
  },
];

const proposed = FEATURES.map((feature, index) => parkFromProposal(
  feature,
  { id: `00000000-0000-4000-8000-00000000000${index}`, name: "The pond trail", note: "", point: feature.geometry.coordinates[0][0][0], createdAt: "2026-10-07T12:00:00.000Z" },
  index === 0 ? "Capital Region" : "",
  [feature.geometry.coordinates[0][0][0][0] + 0.0005, feature.geometry.coordinates[0][0][0][1] + 0.0005],
));

function publicPark(park: (typeof proposed)[number]) {
  const { id, name, short, category, region, lat, lng, biome, shape, rarity, seed, blurb } = park;
  return { id, name, short, category, region, lat, lng, biome, shape, rarity, scene: null, seed, blurb };
}

function snapshotWithProposals() {
  const hubs = snapshotFixture.drive.hubs.length;
  return {
    ...snapshotFixture,
    parks: [...snapshotFixture.parks, ...proposed.map(publicPark)],
    boundaries: {
      ...snapshotFixture.boundaries,
      features: [
        ...snapshotFixture.boundaries.features,
        ...proposed.map((park) => ({ type: "Feature", properties: { id: park.id, biome: park.biome }, geometry: park.geometry })),
      ],
    },
    drive: {
      ...snapshotFixture.drive,
      // The publish transaction starts access unverified: walk 0 and no route to any hub.
      parks: { ...snapshotFixture.drive.parks, ...Object.fromEntries(proposed.map((park) => [park.id, { drive: Array(hubs).fill(null), walkM: 0 }])) },
    },
  };
}

async function served(): Promise<unknown> {
  let body = "";
  let status = 0;
  const res = { get statusCode() { return status; }, set statusCode(value: number) { status = value; }, setHeader() {}, end(value?: string) { body = value ?? ""; } };
  const repository = { snapshot: async () => snapshotWithProposals(), changes: async () => ({}), scene: async () => null };
  await createSnapshotHandler({ repository: repository as never })({ method: "GET", query: {}, headers: {} } as never, res as never);
  expect(status).toBe(200);
  return JSON.parse(body);
}

describe("parks published from proposals", () => {
  it.each([
    { name: "this build", reader: currentReader },
    { name: "installed builds up to 2026-09-30 (strict v1)", reader: readerV1 },
  ])("load in $name with every part and hole of their boundary", async ({ reader }) => {
    const state = reader.parseContentSnapshot(await served());
    for (const park of proposed) {
      expect(state.parks.find((entry) => entry.id === park.id)).toMatchObject({ id: park.id, scene: null });
      const boundary = state.boundaries.features.find((feature) => feature.properties.id === park.id);
      expect(boundary?.geometry.coordinates).toEqual(park.geometry.coordinates);
    }
  });

  it("pass the claim snapshot and account backup contracts", () => {
    for (const park of proposed) {
      const record = currentReader.validateParkRecord(publicPark(park));
      const payload = claimPayload({ parkId: park.id, claimedAt: "2026-10-07T12:30:00.000Z", parkSnapshot: record, contentReleaseId: "e".repeat(64) });
      expect(validateParkSnapshot(payload.parkSnapshot, park.id)).toEqual(publicPark(park));
    }
  });
});

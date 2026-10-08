import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { createChangesHandler, createSnapshotHandler } from "../../../worker/content_sync";
import { validateParkSnapshot } from "../../../worker/accounts/progress";
import { freezeParkSnapshot } from "../accounts/personalStore";
import { insideBoundary, type Boundary } from "../geo";
import type { Park } from "../parks";
import * as currentReader from "./manifest";
import * as readerV1 from "./compat/reader-v1";

// Every park the legacy BC import releases must pass the app's local claim
// snapshot check and the account API contract, or a claim of that park fails
// only when it is saved or backed up. The new parks reach older builds never,
// and newer builds through the CDN catalogue, so both paths are checked.

const BC = new URL("../../../database/imports/legacy-bc-20261007/", import.meta.url);
const ISLAND = new URL("../../../database/imports/provincial-regional-20260929/", import.meta.url);
const LIMIT = 4 * 1024 * 1024;
const HEADROOM = 512 * 1024;
const OLDER_READERS = [
  { name: "reader 2 builds", reader: currentReader },
  { name: "installed builds up to 2026-09-30 (strict v1)", reader: readerV1 },
] as const;
// Proposed in the operator flow with an empty region; fixing the row is a
// separate content correction. Listed so a new failure cannot hide behind it.
const KNOWN_INVALID_EXISTING = new Set(["proposed-bell-park-2f66"]);

type Json = Record<string, unknown>;
type Feature = { type: "Feature"; properties: Json; geometry: { type: string; coordinates: unknown } };
type Snapshot = {
  revision: number;
  parks: Json[];
  boundaries: { type: "FeatureCollection"; features: Feature[] };
  drive: { hubs: unknown[]; parks: Record<string, unknown> };
  [key: string]: unknown;
};
type Review = { parks: Record<string, { presentation: Json; walkM: number; drive: unknown[] }> };
type Place = { id: string; name: string; category: string; region: string; latitude: number; longitude: number };
type Added = { park: Json; feature: Feature; drive: Json }[];

const json = <T>(url: URL): T => JSON.parse(readFileSync(url, "utf8")) as T;
const gzJson = <T>(url: URL): T => JSON.parse(gunzipSync(readFileSync(url)).toString("utf8")) as T;

const staging = gzJson<Snapshot>(new URL("sources/staging-rev158-snapshot.json.gz", BC));
const production = json<Snapshot>(new URL("sources/baseline-snapshot.json", ISLAND));

// Mirrors the row scripts/import_legacy_parks.py inserts for a reviewed new park.
function importedParks(catalogue: Place[], review: Review, features: Feature[]): Added {
  const places = new Map(catalogue.map((place) => [place.id, place]));
  const geometry = new Map(features.map((feature) => [String(feature.properties.id), feature.geometry]));
  return Object.entries(review.parks).map(([id, item]) => {
    const place = places.get(id)!;
    const p = item.presentation;
    const park = {
      id, name: place.name, short: p.short, category: place.category, region: place.region,
      lat: place.latitude, lng: place.longitude, biome: p.biome, shape: p.shape, rarity: p.rarity,
      scene: p.scene ?? null, seed: p.seed, blurb: p.blurb,
    };
    const source = geometry.get(id)!;
    const coordinates = source.type === "Polygon" ? [source.coordinates] : source.coordinates;
    return { park, feature: { type: "Feature", properties: { id, biome: p.biome }, geometry: { type: "MultiPolygon", coordinates } }, drive: { drive: item.drive, walkM: item.walkM } };
  });
}

const bcParks = importedParks(json(new URL("catalogue.json", BC)), json(new URL("new-park-review.json", BC)), gzJson<{ features: Feature[] }>(new URL("boundaries.geojson.gz", BC)).features);
const islandParks = importedParks(json(new URL("catalogue.json", ISLAND)), json(new URL("new-park-review.json", ISLAND)), json<{ features: Feature[] }>(new URL("boundaries.geojson", ISLAND)).features);

function release(base: Snapshot, ...additions: Added[]): Snapshot {
  const added = additions.flat();
  return {
    ...base,
    revision: base.revision + additions.length,
    parks: [...base.parks, ...added.map((entry) => entry.park)],
    boundaries: { type: "FeatureCollection", features: [...base.boundaries.features, ...added.map((entry) => entry.feature)] },
    drive: { hubs: base.drive.hubs, parks: { ...base.drive.parks, ...Object.fromEntries(added.map((entry) => [String(entry.park.id), entry.drive])) } },
  };
}

// What readers 1 and 2 get: the new parks carry reader floor 3, so these do not change.
const OLDER_RELEASES = [
  { name: "staging revision 158", snapshot: release(staging) },
  { name: "production revision 26 plus the island bundle", snapshot: release(production, islandParks) },
];
// What reader 3 assembles from the CDN catalogue release.
const FULL_RELEASES = [
  { name: "staging with every legacy BC park", snapshot: release(staging, bcParks) },
  { name: "production with the island bundle and every legacy BC park", snapshot: release(production, islandParks, bcParks) },
];

function response() {
  let body = "";
  return { statusCode: 0, get body() { return body; }, setHeader() {}, end(value?: string) { body = value ?? ""; } };
}

async function served(snapshot: Snapshot, reader: string): Promise<{ status: number; body: string }> {
  const res = response();
  const repository = { snapshot: async () => snapshot, changes: async () => ({}), scene: async () => null };
  await createSnapshotHandler({ repository })({ method: "GET", query: { reader }, headers: {} }, res);
  return { status: res.statusCode, body: res.body };
}

function claimFailures(snapshot: Snapshot): string[] {
  const failures: string[] = [];
  for (const park of snapshot.parks) {
    const id = String(park.id);
    try {
      freezeParkSnapshot(park as unknown as Park);
      validateParkSnapshot({ ...park }, id);
    } catch {
      failures.push(id);
    }
  }
  return failures;
}

describe.each([...OLDER_RELEASES, ...FULL_RELEASES])("release catalogue: $name", ({ snapshot }) => {
  it("passes the local claim snapshot and account contract for every park", () => {
    const failures = claimFailures(snapshot);
    expect(failures.filter((id) => !KNOWN_INVALID_EXISTING.has(id))).toEqual([]);
    const present = snapshot.parks.map((park) => String(park.id)).filter((id) => KNOWN_INVALID_EXISTING.has(id));
    expect(failures.filter((id) => KNOWN_INVALID_EXISTING.has(id))).toEqual(present);
  });
});

describe.each(OLDER_RELEASES)("older readers: $name", ({ snapshot }) => {
  it.each(["1", "2"])("is served with headroom under the content sync limit to reader %s", async (reader) => {
    const result = await served(snapshot, reader);
    expect(result.status).toBe(200);
    expect(new TextEncoder().encode(result.body).byteLength).toBeLessThan(LIMIT - HEADROOM);
  });

  it.each(OLDER_READERS)("is read in full by $name", async ({ reader }) => {
    const state = reader.parseContentSnapshot(JSON.parse((await served(snapshot, "1")).body));
    expect(state.parks).toHaveLength(snapshot.parks.length);
  });
});

describe.each(FULL_RELEASES)("reader 3 catalogue: $name", ({ snapshot }) => {
  it("is far too large for one API response, so it must come from the CDN", async () => {
    expect((await served(snapshot, "3")).status).toBe(503);
  });

  it("is assembled in full from index and chunks by this build", () => {
    const accessFields = { googleMapsUrl: null, trailheadLat: null, trailheadLng: null };
    const parks: Json[] = snapshot.parks.map((park) => ({ ...accessFields, ...park }));
    const version = "a".repeat(64);
    const pointer = { revision: snapshot.revision, version, indexUrl: `https://kip-assets.parkdex.app/releases/${version}/catalogue/index.json`, indexSha256: version, indexBytes: 1000, parkCount: parks.length };
    // Releases group boundaries by area, so chunk order is not park order.
    const ids = parks.map((park) => String(park.id)).reverse();
    const chunkIds = Array.from({ length: Math.ceil(ids.length / 100) }, (_, index) => ids.slice(index * 100, index * 100 + 100));
    const index = currentReader.parseCatalogueIndex({
      schema: "parkdex.content-catalogue/v1", revision: snapshot.revision, parks, drive: snapshot.drive, assets: snapshot.assets, map: snapshot.map,
      boundaryChunks: chunkIds.map((parkIds, number) => ({ path: `catalogue/boundaries/${String(number).padStart(3, "0")}.json`, sha256: "b".repeat(64), byte_size: 1, parkIds })),
    }, pointer);
    const byId = new Map(snapshot.boundaries.features.map((feature) => [String(feature.properties.id), feature]));
    const chunks = index.chunks.map((chunk) => currentReader.parseCatalogueChunk({ schema: "parkdex.content-boundaries/v1", features: chunk.parkIds.map((id) => byId.get(id)) }, chunk));
    const state = currentReader.assembleCatalogueSnapshot(index, chunks);
    expect(state.parks).toHaveLength(snapshot.parks.length);
    expect(state.boundaries.features).toHaveLength(snapshot.parks.length);
  });

  it("reaches newer readers that are behind as a fresh snapshot, not one oversized change batch", async () => {
    const changes = bcParks.flatMap(({ park, feature, drive }) => [
      { entity: "park", op: "upsert", id: park.id, value: park },
      { entity: "boundary", op: "upsert", id: park.id, value: feature },
      { entity: "drive", op: "upsert", id: park.id, value: drive },
    ]);
    const res = response();
    const repository = {
      snapshot: async () => staging,
      changes: async () => ({ headRevision: staging.revision + 1, retentionFloor: 0, hasMore: false, hubs: staging.drive.hubs, batches: [{ revision: staging.revision + 1, changes }] }),
      scene: async () => null,
    };
    await createChangesHandler({ repository })({ method: "GET", query: { after: String(staging.revision), limit: "50", reader: "3" }, headers: {} }, res);
    expect(res.statusCode).toBe(413);
  });
});

describe("legacy BC boundaries in the app's containment check", () => {
  const report = json<{ parks: { id: string; status: string; probes?: { secondaryRegion?: [number, number]; hole?: [number, number] } }[] }>(new URL("comparison-report.json", BC));
  const byId = new Map(bcParks.map(({ park, feature }) => [String(park.id), feature.geometry as unknown as Boundary]));
  const probed = report.parks.filter((row) => row.status === "new" && row.probes && Object.keys(row.probes).length);

  it("counts a visit inside every secondary region and none inside a hole", () => {
    expect(probed.length).toBeGreaterThan(100);
    for (const row of probed) {
      const boundary = byId.get(row.id);
      if (row.probes?.secondaryRegion) expect(insideBoundary(row.probes.secondaryRegion, boundary), row.id).toBe(true);
      if (row.probes?.hole) expect(insideBoundary(row.probes.hole, boundary), row.id).toBe(false);
    }
  });
});

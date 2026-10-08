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

// Every park in the catalogue that the legacy BC import releases must pass the
// app's local claim snapshot check and the account API contract, or a claim of
// that park fails only when it is saved or backed up.

const BC = new URL("../../../database/imports/legacy-bc-20261007/", import.meta.url);
const ISLAND = new URL("../../../database/imports/provincial-regional-20260929/", import.meta.url);
const READERS = [
  { name: "this build", reader: currentReader },
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

const json = <T>(url: URL): T => JSON.parse(readFileSync(url, "utf8")) as T;
const gzJson = <T>(url: URL): T => JSON.parse(gunzipSync(readFileSync(url)).toString("utf8")) as T;

const staging = gzJson<Snapshot>(new URL("sources/staging-rev158-snapshot.json.gz", BC));
const production = json<Snapshot>(new URL("sources/baseline-snapshot.json", ISLAND));

// Mirrors the row scripts/import_legacy_parks.py inserts for a reviewed new park.
function importedParks(catalogueUrl: URL, reviewUrl: URL, boundariesUrl: URL) {
  const places = new Map(json<Place[]>(catalogueUrl).map((place) => [place.id, place]));
  const review = json<Review>(reviewUrl);
  const geometry = new Map(json<{ features: Feature[] }>(boundariesUrl).features.map((feature) => [String(feature.properties.id), feature.geometry]));
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
    const feature: Feature = { type: "Feature", properties: { id, biome: p.biome }, geometry: { type: "MultiPolygon", coordinates } };
    return { park, feature, drive: { drive: item.drive, walkM: item.walkM } };
  });
}

const phase1 = importedParks(new URL("catalogue.json", BC), new URL("phase-1/new-park-review.json", BC), new URL("phase-1/boundaries.geojson", BC));
const island = importedParks(new URL("catalogue.json", ISLAND), new URL("new-park-review.json", ISLAND), new URL("boundaries.geojson", ISLAND));

function release(base: Snapshot, ...additions: ReturnType<typeof importedParks>[]): Snapshot {
  const added = additions.flat();
  return {
    ...base,
    revision: base.revision + additions.length,
    parks: [...base.parks, ...added.map((entry) => entry.park)],
    boundaries: { type: "FeatureCollection", features: [...base.boundaries.features, ...added.map((entry) => entry.feature)] },
    drive: { hubs: base.drive.hubs, parks: { ...base.drive.parks, ...Object.fromEntries(added.map((entry) => [entry.park.id, entry.drive])) } },
  };
}

const RELEASES = [
  { name: "staging revision 158 plus phase 1", snapshot: release(staging, phase1) },
  { name: "production revision 26 plus the island bundle and phase 1", snapshot: release(production, island, phase1) },
];

function response() {
  let body = "";
  return { statusCode: 0, get body() { return body; }, setHeader() {}, end(value?: string) { body = value ?? ""; } };
}

async function served(snapshot: Snapshot, reader?: string): Promise<{ status: number; body: string }> {
  const res = response();
  const repository = { snapshot: async () => snapshot, changes: async () => ({}), scene: async () => null };
  await createSnapshotHandler({ repository })({ method: "GET", query: reader ? { reader } : {}, headers: {} }, res);
  return { status: res.statusCode, body: res.body };
}

describe.each(RELEASES)("release catalogue: $name", ({ snapshot }) => {
  it("passes the local claim snapshot and account contract for every park", () => {
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
    expect(failures.filter((id) => !KNOWN_INVALID_EXISTING.has(id))).toEqual([]);
    const present = snapshot.parks.map((park) => String(park.id)).filter((id) => KNOWN_INVALID_EXISTING.has(id));
    expect(failures.filter((id) => KNOWN_INVALID_EXISTING.has(id))).toEqual(present);
    expect(snapshot.parks.length).toBeGreaterThan(850);
  });

  it.each(["1", "2"])("is served under the content sync size limit to reader %s", async (reader) => {
    const result = await served(snapshot, reader);
    expect(result.status).toBe(200);
    expect(new TextEncoder().encode(result.body).byteLength).toBeLessThan(4 * 1024 * 1024 - 512 * 1024);
  });

  it.each(READERS)("is read in full by $name", async ({ reader }) => {
    const state = reader.parseContentSnapshot(JSON.parse((await served(snapshot, "1")).body));
    expect(state.parks).toHaveLength(snapshot.parks.length);
    expect(state.boundaries.features).toHaveLength(snapshot.parks.length);
  });
});

describe("phase 1 import change batch", () => {
  const base = staging;
  const changes = phase1.flatMap(({ park, feature, drive }) => [
    { entity: "park", op: "upsert", id: park.id, value: park },
    { entity: "boundary", op: "upsert", id: park.id, value: feature },
    { entity: "drive", op: "upsert", id: park.id, value: drive },
  ]);

  it.each(READERS)("fits one changes response and applies for $name", async ({ reader }) => {
    const res = response();
    const repository = {
      snapshot: async () => base,
      changes: async () => ({ headRevision: base.revision + 1, retentionFloor: 0, hasMore: false, batches: [{ revision: base.revision + 1, changes }] }),
      scene: async () => null,
    };
    await createChangesHandler({ repository })({ method: "GET", query: { after: String(base.revision), limit: "50" }, headers: {} }, res);
    expect(res.statusCode).toBe(200);
    const state = reader.parseContentSnapshot(base);
    const parsed = reader.parseContentChanges(JSON.parse(res.body), base.revision);
    const next = reader.applyContentChangeBatch(state, parsed.batches[0]!);
    expect(next.parks).toHaveLength(base.parks.length + phase1.length);
  });
});

describe("phase 1 boundaries in the app's containment check", () => {
  const report = json<{ parks: { id: string; status: string; probes?: { secondaryRegion?: [number, number]; hole?: [number, number] } }[] }>(new URL("comparison-report.json", BC));
  const byId = new Map(phase1.map(({ park, feature }) => [park.id, feature.geometry as unknown as Boundary]));
  const probed = report.parks.filter((row) => row.status === "new-phase-1" && row.probes && Object.keys(row.probes).length);

  it("counts a visit inside every secondary region and none inside a hole", () => {
    expect(probed.length).toBeGreaterThan(30);
    for (const row of probed) {
      const boundary = byId.get(row.id);
      if (row.probes?.secondaryRegion) expect(insideBoundary(row.probes.secondaryRegion, boundary), row.id).toBe(true);
      if (row.probes?.hole) expect(insideBoundary(row.probes.hole, boundary), row.id).toBe(false);
    }
  });
});

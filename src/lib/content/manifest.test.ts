import { describe, expect, it } from "vitest";
import baseline from "../../../database/content-manifest.json";
import {
  ContentValidationError,
  parseContentChannel,
  parseContentChanges,
  parseContentMapInventory,
  parseContentManifest,
  parseContentSnapshot,
  validateContentPayload,
} from "./manifest";
import { coreFiles } from "./manifest";

const releaseId = "a".repeat(64);

function file(path: string, byte_size = 1) {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const content_type = path.endsWith(".geojson") ? "application/geo+json" : path.endsWith(".webp") ? "image/webp" : path.endsWith(".pbf") ? "application/x-protobuf" : path.endsWith(".bin") ? "application/octet-stream" : "application/json";
  const sha256 = Array.from(path, (character) => character.charCodeAt(0).toString(16).padStart(2, "0")).join("").padEnd(64, "0").slice(0, 64);
  return {
    path,
    key: `releases/${releaseId}/${path}`,
    url: `https://kip-assets.parkdex.app/releases/${releaseId}/${encoded}`,
    sha256,
    byte_size,
    content_type,
  };
}

function fixtureManifest() {
  const paths = [
    "data/parks.json",
    "data/drive.json",
    "boundaries.geojson",
    "art/badges/scenes/coast-a.webp",
    "map/island/manifest.json",
    "map/island/000.bin",
    "map/fonts/Noto Sans Regular/0-255.pbf",
  ];
  const raw = {
    version: releaseId,
    sourceCommit: "b".repeat(40),
    cdnOrigin: "https://kip-assets.parkdex.app",
    files: paths.map((path) => file(path, path === "map/island/000.bin" || path.endsWith(".pbf") ? 1 : 8)),
    parkIds: ["provincial-one-park"],
    boundaryIds: ["provincial-one-park"],
    mapManifest: { size: 1, chunkBytes: 1, count: 1 },
  };
  const channel = parseContentChannel({
    schema: "parkdex.content-channel/v1",
    environment: "staging",
    generation: 1,
    releaseId,
    manifestUrl: `https://kip-assets.parkdex.app/releases/${releaseId}/manifest.json`,
    manifestSha256: "d".repeat(64),
    minimumReaderVersion: 1,
  }, "staging");
  return parseContentManifest(raw, channel);
}

describe("content manifest validation", () => {
  it("accepts the immutable published baseline and excludes bundled Kip/product artwork from downloads", () => {
    const channel = parseContentChannel({
      schema: "parkdex.content-channel/v1",
      environment: "staging",
      generation: 1,
      releaseId: baseline.version,
      manifestUrl: `https://kip-assets.parkdex.app/releases/${baseline.version}/manifest.json`,
      manifestSha256: "e".repeat(64),
      minimumReaderVersion: 1,
    }, "staging");
    const manifest = parseContentManifest(baseline, channel);
    const required = coreFiles(manifest).map((entry) => entry.path);
    expect(manifest.files.some((entry) => entry.path.startsWith("art/kip/"))).toBe(true);
    expect(manifest.files.some((entry) => entry.path.startsWith("art/products/"))).toBe(true);
    expect(required.some((path) => path.startsWith("art/kip/") || path.startsWith("art/products/"))).toBe(false);
    expect(required).toContain("data/parks.json");
    expect(required).toContain("map/island/manifest.json");
  });

  it("rejects a pointer that uses a non-approved origin or build environment", () => {
    const valid = {
      schema: "parkdex.content-channel/v1",
      environment: "staging",
      generation: 1,
      releaseId,
      manifestUrl: `https://kip-assets.parkdex.app/releases/${releaseId}/manifest.json`,
      manifestSha256: "f".repeat(64),
      minimumReaderVersion: 1,
    };
    expect(() => parseContentChannel({ ...valid, manifestUrl: `https://evil.example/releases/${releaseId}/manifest.json` }, "staging")).toThrow(ContentValidationError);
    expect(() => parseContentChannel(valid, "main")).toThrow(/environment/);
  });

  it("rejects traversal paths and an asset URL whose host or path differs from its immutable key", () => {
    const channel = {
      schema: "parkdex.content-channel/v1",
      environment: "staging",
      generation: 1,
      releaseId,
      manifestUrl: `https://kip-assets.parkdex.app/releases/${releaseId}/manifest.json`,
      manifestSha256: "f".repeat(64),
      minimumReaderVersion: 1,
    } as const;
    const validChannel = parseContentChannel(channel, "staging");
    const valid = {
      version: releaseId,
      sourceCommit: "b".repeat(40),
      cdnOrigin: "https://kip-assets.parkdex.app",
      files: [file("../parks.json")],
      parkIds: ["provincial-one-park"],
      boundaryIds: ["provincial-one-park"],
      mapManifest: { size: 1, chunkBytes: 1, count: 1 },
    };
    expect(() => parseContentManifest(valid, validChannel)).toThrow(/unsafe file path/);
    expect(() => parseContentManifest({ ...valid, files: [file("data/parks.json")] }, validChannel)).toThrow(/missing data\/drive.json/);
    expect(() => parseContentManifest({ ...valid, files: [file("data/parks.json"), ...fixtureManifest().files.slice(1).map((entry) => entry.path === "data/drive.json" ? { ...entry, url: entry.url.replace("kip-assets.parkdex.app", "evil.example") } : entry)] }, validChannel)).toThrow();
  });

  it("requires park fields, ignores later additions, and requires matching catalog, boundary, scene, and drive references", () => {
    const manifest = fixtureManifest();
    const park = {
      id: "provincial-one-park",
      name: "One Park",
      short: "One",
      category: "provincial",
      region: "South Island",
      lat: 48.4,
      lng: -123.4,
      biome: "coast",
      shape: "circle",
      rarity: "common",
      seed: 7,
      blurb: "A small example.",
      scene: "coast-a",
    };
    const boundaries = {
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        properties: { id: park.id, biome: park.biome },
        geometry: { type: "MultiPolygon", coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]]] },
      }],
    };
    const drive = { hubs: [{ name: "Victoria", lng: -123.3, lat: 48.4 }], parks: { [park.id]: { drive: [null], walkM: 0 } } };
    expect(validateContentPayload([park], boundaries, drive, manifest).parks).toEqual([park]);
    expect(validateContentPayload([{ ...park, addedLater: true }], boundaries, drive, manifest).parks).toEqual([park]);
    const { blurb: _blurb, ...missingBlurb } = park;
    expect(() => validateContentPayload([missingBlurb], boundaries, drive, manifest)).toThrow(/unsupported shape/);
    expect(() => validateContentPayload([park], { ...boundaries, features: [] }, drive, manifest)).toThrow(/boundary park references/);
    expect(() => validateContentPayload([park], boundaries, { ...drive, parks: {} }, manifest)).toThrow(/drive park references/);
  });
});

describe("incremental content validation", () => {
  const park = {
    id: "municipal-one-park",
    name: "One Municipal Park",
    short: "One Park",
    category: "municipal",
    region: "Victoria",
    lat: 48.4,
    lng: -123.4,
    biome: "coast",
    shape: "circle",
    rarity: "common",
    scene: null,
    seed: 7,
    blurb: "A park awaiting its badge.",
  };
  const boundaries = {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      properties: { id: park.id, biome: park.biome },
      geometry: { type: "MultiPolygon", coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]]] },
    }],
  };
  const drive = { hubs: [{ name: "Victoria", lng: -123.3, lat: 48.4 }], parks: { [park.id]: { drive: [null], walkM: 0 } } };

  it("accepts a scene-null municipal skeleton with its matching boundary and drive row", () => {
    const parsed = parseContentSnapshot({
      schema: "parkdex.content-sync/v1",
      revision: 0,
      parks: [park],
      boundaries,
      drive,
      assets: [],
      map: null,
    });
    expect(parsed.parks[0]?.scene).toBeNull();
    expect(parsed.parks[0]?.category).toBe("municipal");
    expect(parsed.assets).toEqual([]);
  });

  it("ignores fields and asset kinds added after this build", () => {
    const parsed = parseContentSnapshot({
      schema: "parkdex.content-sync/v1",
      revision: 2,
      parks: [{ ...park, proposedBy: "someone", accessibility: { stepFree: true } }],
      boundaries: { ...boundaries, generatedAt: "2026-10-01", features: [{ ...boundaries.features[0], properties: { ...boundaries.features[0]!.properties, area: 12 } }] },
      drive: { ...drive, transit: {} },
      assets: [{ path: "art/stickers/new.webp", key: "x", url: "y", sha256: "0".repeat(64), byte_size: 1, content_type: "image/webp" }],
      map: null,
      trails: [],
    });
    expect(parsed.parks).toEqual([park]);
    expect(parsed.boundaries.features[0]!.properties).toEqual({ id: park.id, biome: park.biome });
    expect(parsed.assets).toEqual([]);
  });

  it("shows enum values added after this build with neutral fallbacks", () => {
    const parsed = parseContentSnapshot({
      schema: "parkdex.content-sync/v1",
      revision: 2,
      parks: [{ ...park, category: "ecological-reserve", biome: "tundra", shape: "star", rarity: "mythic" }],
      boundaries: { ...boundaries, features: [{ ...boundaries.features[0], properties: { id: park.id, biome: "tundra" } }] },
      drive,
      assets: [],
      map: null,
    });
    expect(parsed.parks[0]).toMatchObject({ category: "community", biome: "forest", shape: "circle", rarity: "common" });
    expect(parsed.boundaries.features[0]!.properties.biome).toBe("forest");
  });

  it("leaves out an unreadable park with its boundary and drive row but keeps the rest", () => {
    const other = { ...park, id: "municipal-two-park", name: "Two Park" };
    const parsed = parseContentSnapshot({
      schema: "parkdex.content-sync/v1",
      revision: 3,
      parks: [{ ...other, lat: "north" }, park],
      boundaries: { ...boundaries, features: [{ ...boundaries.features[0], properties: { id: other.id, biome: other.biome } }, boundaries.features[0]] },
      drive: { ...drive, parks: { ...drive.parks, [other.id]: { drive: [null], walkM: 0 } } },
      assets: [],
      map: null,
    });
    expect(parsed.parks.map((entry) => entry.id)).toEqual([park.id]);
    expect(parsed.boundaries.features).toHaveLength(1);
    expect(Object.keys(parsed.drive.parks)).toEqual([park.id]);
    expect(() => parseContentSnapshot({
      schema: "parkdex.content-sync/v1", revision: 3, parks: [{ ...park, lat: "north" }], boundaries, drive, assets: [], map: null,
    })).toThrow(/no readable parks/);
  });

  it("still rejects a breaking snapshot schema", () => {
    expect(() => parseContentSnapshot({
      schema: "parkdex.content-sync/v2", revision: 0, parks: [park], boundaries, drive, assets: [], map: null,
    })).toThrow(/schema is unsupported/);
  });

  it("skips changes this build does not understand and unreadable park updates", () => {
    const parsed = parseContentChanges({
      schema: "parkdex.content-sync/v1",
      fromRevision: 4,
      throughRevision: 5,
      headRevision: 5,
      hasMore: false,
      batches: [{ revision: 5, changes: [
        { entity: "proposal", op: "upsert", id: "p1", value: {} },
        { entity: "park", op: "archive", id: park.id },
        { entity: "asset", op: "upsert", id: "art/stickers/new.webp", value: {} },
        { entity: "park", op: "upsert", id: "municipal-two-park", value: { ...park, id: "municipal-two-park", seed: "x" } },
        { entity: "boundary", op: "upsert", id: "municipal-two-park", value: { ...boundaries.features[0], properties: { id: "municipal-two-park", biome: "coast" } } },
        { entity: "park", op: "upsert", id: park.id, value: { ...park, extra: 1 }, note: "added later" },
      ] }],
    }, 4);
    expect(parsed.batches[0]!.changes).toEqual([{ entity: "park", op: "upsert", id: park.id, value: park }]);
  });

  it("rejects a skeleton whose scene is not present in the active asset inventory", () => {
    expect(() => parseContentSnapshot({
      schema: "parkdex.content-sync/v1",
      revision: 1,
      parks: [{ ...park, scene: "coast-one" }],
      boundaries,
      drive,
      assets: [],
      map: null,
    })).toThrow(/missing badge art/);
  });

  it("accepts whole contiguous revision batches and a no-change head", () => {
    const first = parseContentChanges({
      schema: "parkdex.content-sync/v1",
      fromRevision: 4,
      throughRevision: 5,
      headRevision: 6,
      hasMore: true,
      batches: [{ revision: 5, changes: [{ entity: "park", op: "upsert", id: park.id, value: park }] }],
    }, 4);
    expect(first.batches).toHaveLength(1);
    expect(first.throughRevision).toBe(5);
    expect(parseContentChanges({
      schema: "parkdex.content-sync/v1",
      fromRevision: 6,
      throughRevision: 6,
      headRevision: 6,
      hasMore: false,
      batches: [],
    }, 6).throughRevision).toBe(6);
  });

  it("rejects split or non-contiguous revision batches before client persistence", () => {
    const base = { schema: "parkdex.content-sync/v1", fromRevision: 4, throughRevision: 6, headRevision: 6, hasMore: false };
    expect(() => parseContentChanges({ ...base, batches: [{ revision: 5, changes: [{ entity: "park", op: "upsert", id: park.id, value: park }] }, { revision: 6, changes: [] }] }, 4)).toThrow(/non-empty/);
    expect(() => parseContentChanges({ ...base, batches: [{ revision: 6, changes: [{ entity: "park", op: "upsert", id: park.id, value: park }] }] }, 4)).toThrow(/contiguous/);
  });

  it("validates the independent map inventory and numbered chunk sizes", () => {
    const mapVersion = "e".repeat(64);
    const mapFile = (path: string, size: number) => {
      const key = `releases/${releaseId}/${path}`;
      return {
        path,
        key,
        url: `https://kip-assets.parkdex.app/${key.split("/").map(encodeURIComponent).join("/")}`,
        sha256: "f".repeat(64),
        byte_size: size,
        content_type: path.endsWith(".pbf") ? "application/x-protobuf" : path.endsWith(".bin") ? "application/octet-stream" : "application/json",
      };
    };
    const inventory = parseContentMapInventory({
      schema: "parkdex.content-map/v1",
      version: mapVersion,
      mapManifest: { size: 9, chunkBytes: 4, count: 3 },
      files: [
        mapFile("map/island/manifest.json", 32),
        mapFile("map/island/000.bin", 4),
        mapFile("map/island/001.bin", 4),
        mapFile("map/island/002.bin", 1),
        mapFile("map/fonts/Noto Sans Regular/0-255.pbf", 2),
      ],
    }, mapVersion);
    expect(inventory.mapManifest.count).toBe(3);
    expect(() => parseContentMapInventory({
      schema: "parkdex.content-map/v1",
      version: mapVersion,
      mapManifest: { size: 9, chunkBytes: 4, count: 3 },
      files: [mapFile("map/island/manifest.json", 32), mapFile("map/island/000.bin", 5)],
    }, mapVersion)).toThrow(/chunk inventory/);
  });
});

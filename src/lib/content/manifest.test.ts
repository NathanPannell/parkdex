import { describe, expect, it } from "vitest";
import baseline from "../../../database/content-manifest.json";
import {
  ContentValidationError,
  parseContentChannel,
  parseContentManifest,
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

  it("requires exact park fields and matching catalog, boundary, scene, and drive references", () => {
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
    expect(() => validateContentPayload([{ ...park, unexpected: true }], boundaries, drive, manifest)).toThrow(/unsupported shape/);
    expect(() => validateContentPayload([park], { ...boundaries, features: [] }, drive, manifest)).toThrow(/boundary park references/);
    expect(() => validateContentPayload([park], boundaries, { ...drive, parks: {} }, manifest)).toThrow(/drive park references/);
  });
});

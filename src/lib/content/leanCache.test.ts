import { describe, expect, it } from "vitest";
import type { CatalogueChunkRef, ContentFile, ContentSyncState } from "./contracts";
import {
  artToKeep,
  cacheGeneration,
  chunkForPark,
  chunksInView,
  chunksNear,
  chunksToEvict,
  cleanupKeepSet,
  filesToDelete,
  GUIDE_CACHE_BYTES,
} from "./leanCache";
import { applyContentChangeBatch, evictCatalogueChunks, mergeCatalogueChunks, validateContentSyncState } from "./manifest";

const DELTA: [number, number] = [-123.06, 49.09];
const parks = new Map([
  ["deas-island", { lng: -123.07, lat: 49.12 }],
  ["boundary-bay", { lng: -123.0, lat: 49.03 }],
  ["beacon-hill", { lng: -123.36, lat: 48.41 }],
  ["point-pleasant", { lng: -63.57, lat: 44.62 }],
]);

function chunk(path: string, parkIds: string[], byteSize = 500_000, bbox: CatalogueChunkRef["bbox"] = null): CatalogueChunkRef {
  return { path, url: `https://kip-assets.parkdex.app/releases/${"a".repeat(64)}/${path}`, sha256: "b".repeat(64), byte_size: byteSize, parkIds, bbox };
}

const chunks = [
  chunk("catalogue/boundaries/000.json", ["deas-island"]),
  chunk("catalogue/boundaries/001.json", ["boundary-bay", "beacon-hill"]),
  // Spans the country, like the real chunk 016: its box covers everything, its parks do not.
  chunk("catalogue/boundaries/002.json", ["point-pleasant"], 500_000, [-116, 43, -64, 51]),
];

describe("nearby selection", () => {
  it("picks boundary files by the parks near the player, not by their boxes", () => {
    expect(chunksNear(chunks, parks, DELTA, 50)).toEqual(["catalogue/boundaries/000.json", "catalogue/boundaries/001.json"]);
    expect(chunksNear(chunks, parks, DELTA, 1)).toEqual([]);
    expect(chunksNear(chunks, parks, [-63.57, 44.65], 50)).toEqual(["catalogue/boundaries/002.json"]);
  });

  it("picks the files with the most parks in view, up to a limit", () => {
    const view: [number, number, number, number] = [-123.5, 48.3, -122.9, 49.2];
    expect(chunksInView(chunks, parks, view)).toEqual(["catalogue/boundaries/001.json", "catalogue/boundaries/000.json"]);
    expect(chunksInView(chunks, parks, view, 1)).toEqual(["catalogue/boundaries/001.json"]);
    expect(chunksInView(chunks, parks, [0, 0, 1, 1])).toEqual([]);
  });

  it("finds the file holding a park", () => {
    expect(chunkForPark(chunks, "beacon-hill")).toBe("catalogue/boundaries/001.json");
    expect(chunkForPark(chunks, "missing")).toBeNull();
  });
});

describe("LRU cap", () => {
  const sizes = new Map([
    ["a", 1_000_000],
    ["b", 1_000_000],
    ["c", 1_000_000],
    ["d", 1_000_000],
  ]);

  it("evicts the least recently used files until the rest fit", () => {
    expect(chunksToEvict(["a", "b", "c", "d"], sizes, new Set(), 2_000_000)).toEqual(["a", "b"]);
    expect(chunksToEvict(["a", "b"], sizes, new Set(), 2_000_000)).toEqual([]);
  });

  it("never evicts nearby files, even above the cap", () => {
    expect(chunksToEvict(["a", "b", "c", "d"], sizes, new Set(["a", "b"]), 2_000_000)).toEqual(["c", "d"]);
    expect(chunksToEvict(["a", "b", "c"], sizes, new Set(["a", "b", "c"]), 1_000_000)).toEqual([]);
  });

  it("keeps park guides under 5 MB with the park index", () => {
    expect(GUIDE_CACHE_BYTES + 1_100_000).toBeLessThan(5_000_000);
  });
});

function file(path: string, sha: string, size = 100): ContentFile {
  return {
    path,
    key: `releases/${"a".repeat(64)}/${path}`,
    url: `https://kip-assets.parkdex.app/releases/${"a".repeat(64)}/${path}`,
    sha256: sha.repeat(64).slice(0, 64),
    byte_size: size,
    content_type: "application/octet-stream",
  };
}

describe("cleanup rules", () => {
  const layout = file("map/detail/manifest.json", "1");
  const glyph = file("map/fonts/Noto Sans Regular/0-255.pbf", "2");
  const nearChunk = file("map/detail/100.bin", "3");
  const farChunk = file("map/detail/900.bin", "4");
  const claimedArt = file("art/badges/scenes/claimed.webp", "5");
  const retained = "6".repeat(64);
  const oldMapChunk = "7".repeat(64);
  const farArt = "8".repeat(64);
  const downloading = "9".repeat(64);
  const stored = [layout.sha256, glyph.sha256, nearChunk.sha256, farChunk.sha256, claimedArt.sha256, retained, oldMapChunk, farArt, downloading].map(
    (hash) => ({ hash, size: 10 }),
  );

  it("keeps map labels, nearby detail, kept art and protected files, and deletes the rest", () => {
    const keep = cleanupKeepSet({
      mapFiles: [layout, glyph, nearChunk, farChunk],
      nearMapChunks: new Set([nearChunk.path]),
      art: [claimedArt],
      protectedHashes: [retained, downloading],
    });
    expect(
      filesToDelete(stored, keep)
        .map((entry) => entry.hash)
        .sort(),
    ).toEqual([farChunk.sha256, oldMapChunk, farArt].sort());
  });

  it("keeps every saved chunk of the current map until the player's surroundings are known", () => {
    const keep = cleanupKeepSet({ mapFiles: [layout, glyph, nearChunk, farChunk], nearMapChunks: null, art: [], protectedHashes: [] });
    expect(keep.has(farChunk.sha256)).toBe(true);
    expect(keep.has(oldMapChunk)).toBe(false);
  });

  it("is a no-op the second time", () => {
    const keep = cleanupKeepSet({ mapFiles: [layout, glyph, nearChunk], nearMapChunks: new Set([nearChunk.path]), art: [], protectedHashes: [] });
    const remaining = stored.filter((entry) => !filesToDelete(stored, keep).includes(entry));
    expect(filesToDelete(remaining, keep)).toEqual([]);
  });

  it("names a new generation for a new build or map", () => {
    expect(cacheGeneration("abc", "m1")).not.toBe(cacheGeneration("abd", "m1"));
    expect(cacheGeneration("abc", "m1")).not.toBe(cacheGeneration("abc", "m2"));
    expect(cacheGeneration("abc", null)).toBe("v1|abc|none");
  });

  it("keeps claimed parks' art and the nearest parks' art within a budget", () => {
    const scenes = ["claimed", "near-1", "near-2", "far"].map((scene, index) => ({ ...file(`art/badges/scenes/${scene}.webp`, String(index + 1), 900_000) }));
    const artParks = [
      { id: "p-claimed", lng: -63.57, lat: 44.62, scene: "claimed" },
      { id: "p-near-2", lng: -123.1, lat: 49.1, scene: "near-2" },
      { id: "p-near-1", lng: -123.06, lat: 49.09, scene: "near-1" },
      { id: "p-far", lng: -123.36, lat: 48.41, scene: "far" },
    ];
    const kept = artToKeep(artParks, scenes, new Set(["p-claimed"]), DELTA, 15, 1_000_000).map((entry) => entry.path);
    expect(kept).toEqual(["art/badges/scenes/claimed.webp", "art/badges/scenes/near-1.webp"]);
    expect(artToKeep(artParks, scenes, new Set(), null, 15).map((entry) => entry.path)).toEqual([]);
  });
});

describe("lean catalogue state", () => {
  const park = (id: string, lng: number, lat: number) => ({
    id,
    name: id,
    short: id,
    category: "municipal",
    region: "Delta",
    lat,
    lng,
    biome: "forest",
    shape: "circle",
    rarity: "common",
    scene: null,
    seed: 1,
    blurb: "A park.",
  });
  const boundary = (id: string) => ({
    type: "Feature" as const,
    properties: { id, biome: "forest" },
    geometry: {
      type: "MultiPolygon" as const,
      coordinates: [
        [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 0],
          ],
        ],
      ],
    },
  });
  const ids = ["deas-island", "boundary-bay", "beacon-hill"];
  const base = (): ContentSyncState =>
    validateContentSyncState({
      revision: 5,
      parks: ids.map((id, index) => park(id, -123 - index * 0.1, 49)) as ContentSyncState["parks"],
      boundaries: { type: "FeatureCollection", features: [boundary("deas-island")] as ContentSyncState["boundaries"]["features"] },
      drive: { hubs: [{ name: "Delta", lng: -123, lat: 49 }], parks: Object.fromEntries(ids.map((id) => [id, { drive: [null], walkM: 0 }])) },
      assets: [],
      map: null,
      catalogue: {
        version: "a".repeat(64),
        revision: 4,
        chunks: [chunk("catalogue/boundaries/000.json", ["deas-island"]), chunk("catalogue/boundaries/001.json", ["boundary-bay", "beacon-hill"])],
        loaded: ["catalogue/boundaries/000.json"],
        pinned: [],
      },
    });

  it("accepts a catalogue with only some boundaries", () => {
    expect(base().boundaries.features).toHaveLength(1);
    const { catalogue: _catalogue, ...whole } = base();
    expect(() => validateContentSyncState(whole)).toThrow(/boundary park references/);
  });

  it("adds a loaded chunk's boundaries and marks it most recently used", () => {
    const merged = mergeCatalogueChunks(base(), new Map([["catalogue/boundaries/001.json", [boundary("boundary-bay"), boundary("beacon-hill")]]]));
    expect(merged.boundaries.features.map((feature) => feature.properties.id)).toEqual(ids);
    expect(merged.catalogue?.loaded).toEqual(["catalogue/boundaries/000.json", "catalogue/boundaries/001.json"]);
    const touched = mergeCatalogueChunks(merged, new Map(), ["catalogue/boundaries/000.json"]);
    expect(touched.catalogue?.loaded).toEqual(["catalogue/boundaries/001.json", "catalogue/boundaries/000.json"]);
  });

  it("evicts a chunk's boundaries but keeps one changed after the release", () => {
    const merged = mergeCatalogueChunks(base(), new Map([["catalogue/boundaries/001.json", [boundary("boundary-bay"), boundary("beacon-hill")]]]));
    const changed = applyContentChangeBatch(merged, {
      revision: 6,
      changes: [{ entity: "boundary", op: "upsert", id: "beacon-hill", value: boundary("beacon-hill") }],
    });
    expect(changed.catalogue?.pinned).toEqual(["beacon-hill"]);
    const evicted = evictCatalogueChunks(changed, ["catalogue/boundaries/001.json"]);
    expect(evicted.boundaries.features.map((feature) => feature.properties.id)).toEqual(["deas-island", "beacon-hill"]);
    expect(evicted.catalogue?.loaded).toEqual(["catalogue/boundaries/000.json"]);
    // Loading the chunk again does not overwrite the newer boundary.
    const reloaded = mergeCatalogueChunks(
      validateContentSyncState(evicted),
      new Map([
        [
          "catalogue/boundaries/001.json",
          [
            boundary("boundary-bay"),
            {
              ...boundary("beacon-hill"),
              properties: { id: "beacon-hill", biome: "forest" },
              geometry: {
                type: "MultiPolygon",
                coordinates: [
                  [
                    [
                      [5, 5],
                      [6, 5],
                      [6, 6],
                      [5, 5],
                    ],
                  ],
                ],
              },
            },
          ],
        ],
      ]),
    );
    expect(reloaded.boundaries.features.find((feature) => feature.properties.id === "beacon-hill")?.geometry.coordinates[0]![0]![0]).toEqual([0, 0]);
  });

  it("refuses a chunk that is not part of the release", () => {
    expect(() => mergeCatalogueChunks(base(), new Map([["catalogue/boundaries/009.json", []]]))).toThrow(/not part of this catalogue/);
  });
});

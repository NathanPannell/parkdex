import { describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mapAreaTiles } from "./map-downloads";
import { prefetchMapArea } from "./map-downloads";
import { resetAllowedMapChunks, RuntimeChunkSource } from "../offlineTiles";
import type { ContentRuntime, ContentSnapshot, MapManifest } from "./contracts";
import { mapStyle } from "../mapStyle";

const VICTORIA: [number, number] = [-123.3656, 48.4284];

describe("map download coverage", () => {
  it("plans starter tiles around Victoria plus island-wide coarse tiles", () => {
    const tiles = mapAreaTiles(VICTORIA, "starter");
    const zooms = new Set(tiles.map((tile) => tile.z));

    expect([...zooms].sort((a, b) => a - b)).toEqual([6, 7, 8, 10, 11]);
    expect(new Set(tiles.map(({ z, x, y }) => `${z}/${x}/${y}`)).size).toBe(tiles.length);
    expect(tiles.filter((tile) => tile.z >= 10).length).toBeGreaterThan(0);
    expect(tiles.some((tile) => tile.z === 9 || tile.z > 11)).toBe(false);
  });

  it("expands nearby coverage through zoom 14 and follows its anchor", () => {
    const victoria = mapAreaTiles(VICTORIA, "nearby");
    const nanaimo = mapAreaTiles([-123.9401, 49.1659], "nearby");
    const zooms = new Set(victoria.map((tile) => tile.z));

    expect([...zooms].sort((a, b) => a - b)).toEqual([9, 10, 11, 12, 13, 14]);
    expect(victoria.length).toBeGreaterThan(mapAreaTiles(VICTORIA, "starter").length);
    expect(victoria.map(({ z, x, y }) => `${z}/${x}/${y}`)).not.toEqual(
      nanaimo.map(({ z, x, y }) => `${z}/${x}/${y}`),
    );
  });

  it("keys both tile and glyph requests by the content release", () => {
    const style = mapStyle("release-v2");
    const tiles = (style.sources?.protomaps as { tiles: string[] }).tiles;

    expect(tiles[0]).toContain("pmtiles://release-v2/");
    expect(style.glyphs).toContain("contentglyph://release-v2/");
  });

  it("blocks renderer reads outside prefetched chunks and forwards cancellation", async () => {
    const ensureFile = vi.fn(async () => undefined);
    const runtime = {
      ensureFile,
      readFile: async () => new Uint8Array([3, 4]).buffer,
    } as unknown as ContentRuntime;
    const controller = new AbortController();
    const source = new RuntimeChunkSource(
      runtime,
      "release-v2",
      { size: 4, chunkBytes: 2, count: 2 },
      () => new Set([1]),
      false,
      controller.signal,
    );

    await expect(source.getBytes(0, 1, controller.signal)).rejects.toThrow("has not been downloaded");
    await expect(source.getBytes(2, 2)).resolves.toMatchObject({ data: expect.any(ArrayBuffer) });

    expect(source.getKey()).toBe("release-v2");
    expect(ensureFile).toHaveBeenCalledOnce();
    expect(ensureFile).toHaveBeenCalledWith("release-v2", "map/island/001.bin", "nearby", controller.signal);
  });
});

const canonicalArchivePath = join(process.cwd(), "..", "..", "..", "parkdex-badge-mockup", ".tools", "island.pmtiles");

describe("canonical PMTiles chunk selection", () => {
  it.skipIf(!existsSync(canonicalArchivePath))("uses the archive index to find starter and nearby chunks", async () => {
    const archive = readFileSync(canonicalArchivePath);
    const mapManifest: MapManifest = { size: archive.byteLength, chunkBytes: 2 * 1024 * 1024, count: Math.ceil(archive.byteLength / (2 * 1024 * 1024)) };
    const releaseId = "map-census-fixture";
    const snapshot = {
      releaseId,
      manifest: {
        mapManifest,
        files: Array.from({ length: mapManifest.count }, (_, index) => {
          const path = `map/island/${String(index).padStart(3, "0")}.bin`;
          const start = index * mapManifest.chunkBytes;
          return { path, key: path, url: path, sha256: "", byte_size: Math.min(mapManifest.chunkBytes, archive.byteLength - start), content_type: "application/octet-stream" };
        }),
      },
    } as ContentSnapshot;
    const runtime = {
      getStatus: () => ({ snapshot }),
      ensureFile: async () => undefined,
      readFile: async (_id: string, path: string) => {
        const index = Number(path.match(/\/(\d{3})\.bin$/)?.[1]);
        if (!Number.isInteger(index)) throw new Error(`Unexpected fixture path: ${path}`);
        const start = index * mapManifest.chunkBytes;
        const chunk = archive.subarray(start, Math.min(start + mapManifest.chunkBytes, archive.byteLength));
        return chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as ArrayBuffer;
      },
    } as unknown as ContentRuntime;

    const starter = await prefetchMapArea(runtime, releaseId, VICTORIA, "starter", undefined, snapshot);
    expect(starter.chunkIds).toEqual([0, 1, 3, 6]);
    expect(starter.coveredBytes).toBe(8 * 1024 * 1024);

    resetAllowedMapChunks(releaseId);
    const nearby = await prefetchMapArea(runtime, releaseId, VICTORIA, "nearby", undefined, snapshot);
    expect(nearby.chunkIds).toEqual([0, 1, 2, 3, 6, 11, 12, 23, 24, 42, 43, 44]);
    expect(nearby.chunkIds).toHaveLength(12);
    expect(nearby.coveredBytes).toBe(24 * 1024 * 1024);
  }, 30000);
});

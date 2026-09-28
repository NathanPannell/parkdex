import { describe, expect, it, vi } from "vitest";
import { PMTiles } from "pmtiles";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mapAreaTiles } from "./map-downloads";
import { prefetchMapArea } from "./map-downloads";
import {
  BundledOverviewSource,
  getAllowedMapChunks,
  ISLAND_OVERVIEW_PATH,
  resetAllowedMapChunks,
  reloadDetailedMapSource,
  RuntimeChunkSource,
  setAllowedMapChunks,
  subscribeMapCoverage,
} from "../offlineTiles";
import type { ContentRuntime, ContentSnapshot, MapManifest } from "./contracts";
import { ISLAND_OVERVIEW_MAX_ZOOM, mapStyle } from "../mapStyle";

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
    const overview = style.sources?.islandOverview as { maxzoom: number; tiles: string[] };

    expect(tiles[0]).toContain("pmtiles://release-v2/");
    expect(style.glyphs).toContain("contentglyph://release-v2/");
    expect(overview.maxzoom).toBe(ISLAND_OVERVIEW_MAX_ZOOM);
    expect(overview.tiles[0]).toContain("pmtiles://bundled-island-overview-v1/");
    const ids = style.layers.map((layer) => layer.id);
    const overviewEarthIndex = ids.indexOf("overview-earth");
    expect(ids.indexOf("background")).toBeLessThan(overviewEarthIndex);
    expect(overviewEarthIndex).toBeLessThan(ids.indexOf("earth"));
    expect(style.layers.filter((layer) => layer.id.startsWith("overview-")).length).toBeGreaterThan(0);
    expect(style.layers.filter((layer) => layer.id.startsWith("overview-")).every((layer) => layer.type !== "symbol")).toBe(true);
    expect(ids).toContain("water_waterway_label");
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

describe("bundled overview PMTiles source", () => {
  it("loads a complete archive once and serves concurrent exact byte slices", async () => {
    const archiveBytes = new Uint8Array([10, 11, 12, 13, 14, 15]);
    let finishLoad: (archive: ArrayBuffer) => void = () => {};
    const pending = new Promise<ArrayBuffer>((resolve) => {
      finishLoad = resolve;
    });
    const loadArchive = vi.fn(() => pending);
    const source = new BundledOverviewSource(loadArchive);
    const aborted = new AbortController();
    const abortedRead = source.getBytes(1, 3, aborted.signal);
    const concurrentRead = source.getBytes(3, 8);
    aborted.abort();
    finishLoad(archiveBytes.buffer.slice(0));

    await expect(abortedRead).rejects.toMatchObject({ name: "AbortError" });
    await expect(concurrentRead).resolves.toMatchObject({ data: new Uint8Array([13, 14, 15]).buffer });
    await expect(source.getBytes(0, 2)).resolves.toMatchObject({ data: new Uint8Array([10, 11]).buffer });
    expect(source.getKey()).toBe("bundled-island-overview-v1");
    expect(loadArchive).toHaveBeenCalledOnce();
  });

  it("rejects unsafe ranges and retries a failed complete-archive load", async () => {
    const bytes = new Uint8Array([4, 5, 6]).buffer;
    const loadArchive = vi.fn()
      .mockRejectedValueOnce(new Error("offline fetch failed"))
      .mockResolvedValueOnce(bytes);
    const source = new BundledOverviewSource(loadArchive);

    await expect(source.getBytes(Number.MAX_SAFE_INTEGER, 2)).rejects.toThrow("Invalid bundled PMTiles byte range");
    await expect(source.getBytes(-1, 1)).rejects.toThrow("Invalid bundled PMTiles byte range");
    await expect(source.getBytes(0, 1)).rejects.toThrow("offline fetch failed");
    await expect(source.getBytes(1, 4)).resolves.toMatchObject({ data: new Uint8Array([5, 6]).buffer });
    expect(loadArchive).toHaveBeenCalledTimes(2);
  });

  it("loads the local whole-file asset without sending a byte-range request", async () => {
    const bytes = new Uint8Array([7, 8, 9]).buffer;
    const fetcher = vi.fn(async (_input: RequestInfo | URL) => ({ ok: true, status: 200, arrayBuffer: async () => bytes }) as Response);
    vi.stubGlobal("fetch", fetcher);
    try {
      const source = new BundledOverviewSource();
      await source.getBytes(0, 1);
      await source.getBytes(1, 2);

      expect(fetcher).toHaveBeenCalledOnce();
      expect(fetcher.mock.calls[0][0]).toBeInstanceOf(URL);
      expect((fetcher.mock.calls[0][0] as URL).pathname).toBe(ISLAND_OVERVIEW_PATH);
      expect(fetcher.mock.calls[0]).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reads the bundled Island archive at its declared zoom and coverage", async () => {
    const path = join(process.cwd(), "public", "map", "bootstrap", "island-overview.pmtiles");
    const file = readFileSync(path);
    const archive = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer;
    const pmtiles = new PMTiles(new BundledOverviewSource(async () => archive));
    const header = await pmtiles.getHeader();

    expect(header.minZoom).toBe(0);
    expect(header.maxZoom).toBe(ISLAND_OVERVIEW_MAX_ZOOM);
    expect([header.minLon, header.minLat, header.maxLon, header.maxLat]).toEqual([-128.45, 48.28, -123.25, 50.92]);
    const zoom = ISLAND_OVERVIEW_MAX_ZOOM;
    const scale = 2 ** zoom;
    const radians = (VICTORIA[1] * Math.PI) / 180;
    const x = Math.floor(((VICTORIA[0] + 180) / 360) * scale);
    const y = Math.floor(((1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2) * scale);
    const tile = await pmtiles.getZxy(zoom, x, y);
    expect(tile?.data.byteLength).toBeGreaterThan(0);
  });
});

describe("detail map coverage notifications", () => {
  it("notifies the map only when its allowed chunk set grows", () => {
    const releaseId = "coverage-listener-test";
    const listener = vi.fn();
    resetAllowedMapChunks(releaseId);
    const unsubscribe = subscribeMapCoverage(releaseId, listener);
    try {
      setAllowedMapChunks(releaseId, [1, 1]);
      setAllowedMapChunks(releaseId, [1]);
      expect(listener).toHaveBeenCalledOnce();
      setAllowedMapChunks(releaseId, [2]);
      expect(listener).toHaveBeenCalledTimes(2);
      expect(getAllowedMapChunks(releaseId)).toEqual([1, 2]);
      unsubscribe();
      setAllowedMapChunks(releaseId, [3]);
      expect(listener).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribe();
      resetAllowedMapChunks(releaseId);
    }
  });

  it("invalidates failed detail requests by reloading the source with its existing URLs", () => {
    const urls = ["pmtiles://release-v2/{z}/{x}/{y}"];
    const setTiles = vi.fn();
    const map = {
      getSource: vi.fn(() => ({ setTiles })),
      getStyle: () => ({ sources: { protomaps: { tiles: urls } } }),
    };

    expect(reloadDetailedMapSource(map)).toBe(true);
    expect(setTiles).toHaveBeenCalledOnce();
    expect(setTiles).toHaveBeenCalledWith(urls);
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

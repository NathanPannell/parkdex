import { describe, expect, it, vi } from "vitest";
import { PMTiles, Protocol, tileIdToZxy, zxyToTileId } from "pmtiles";
import type { StyleSpecification } from "maplibre-gl";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cellTileIdRanges, mapAreaTiles, NEARBY_CELL_ZOOM } from "./map-downloads";
import { prefetchMapArea } from "./map-downloads";
import {
  BundledOverviewSource,
  flushPendingDetailedMapSourceRefresh,
  getAllowedMapChunks,
  BASE_OVERVIEW_PATH,
  registerContentMapProtocols,
  resetAllowedMapChunks,
  reloadDetailedMapSource,
  RuntimeChunkSource,
  setAllowedMapChunks,
  subscribeMapCoverage,
} from "../offlineTiles";
import type { ContentRuntime, ContentSnapshot, MapManifest } from "./contracts";
import { BASE_OVERVIEW_BOUNDS, BASE_OVERVIEW_MAX_ZOOM, mapStyle } from "../mapStyle";

const VICTORIA: [number, number] = [-123.3656, 48.4284];

describe("map download coverage", () => {
  it("plans starter tiles as one viewport around the anchor", () => {
    const tiles = mapAreaTiles(VICTORIA, "starter");
    const zooms = new Set(tiles.map((tile) => tile.z));

    expect([...zooms].sort((a, b) => a - b)).toEqual([10, 11]);
    expect(new Set(tiles.map(({ z, x, y }) => `${z}/${x}/${y}`)).size).toBe(tiles.length);
    expect(tiles.filter((tile) => tile.z >= 10).length).toBeGreaterThan(0);
    expect(tiles.some((tile) => tile.z === 9 || tile.z > 11)).toBe(false);
  });

  it("plans nearby coverage as the anchor's own square and surrounding coverage as its 3x3 block", () => {
    const own = mapAreaTiles(VICTORIA, "nearby");
    expect(own).toHaveLength(1);
    const victoria = mapAreaTiles(VICTORIA, "surrounding");
    const kelowna = mapAreaTiles([-119.496, 49.888], "surrounding");
    expect(victoria).toContainEqual(own[0]);

    expect(victoria).toHaveLength(9);
    expect(new Set(victoria.map((tile) => tile.z))).toEqual(new Set([NEARBY_CELL_ZOOM]));
    const xs = victoria.map((tile) => tile.x);
    const ys = victoria.map((tile) => tile.y);
    expect(Math.max(...xs) - Math.min(...xs)).toBe(2);
    expect(Math.max(...ys) - Math.min(...ys)).toBe(2);
    expect(kelowna.map(({ x, y }) => `${x}/${y}`)).not.toEqual(victoria.map(({ x, y }) => `${x}/${y}`));
  });

  it("maps every descendant of a square to one contiguous tile ID range per zoom", () => {
    const cell = { z: NEARBY_CELL_ZOOM, x: 80, y: 178 };
    const ranges = cellTileIdRanges(cell);
    expect(ranges).toHaveLength(2 + (14 - NEARBY_CELL_ZOOM + 1));
    const inRanges = (id: number) => ranges.some(([a, b]) => id >= a && id <= b);
    for (const z of [9, 10, 12, 14]) {
      const shift = z - cell.z;
      const size = 2 ** shift;
      for (const [dx, dy] of [[0, 0], [size - 1, size - 1], [Math.floor(size / 2), 0], [0, size - 1]]) {
        expect(inRanges(zxyToTileId(z, (cell.x << shift) + dx, (cell.y << shift) + dy))).toBe(true);
      }
      // The neighbouring square's tiles stay outside.
      expect(inRanges(zxyToTileId(z, (cell.x + 1) << shift, cell.y << shift))).toBe(false);
    }
    expect(inRanges(zxyToTileId(8, cell.x >> 1, cell.y >> 1))).toBe(true);
    expect(inRanges(zxyToTileId(7, cell.x >> 2, cell.y >> 2))).toBe(true);
  });

  it("keys both tile and glyph requests by the content release", () => {
    const style = mapStyle("release-v2");
    const tiles = (style.sources?.protomaps as { tiles: string[] }).tiles;
    const overview = style.sources?.baseOverview as { maxzoom: number; tiles: string[] };

    expect(tiles[0]).toContain("pmtiles://release-v2/");
    expect(style.glyphs).toContain("contentglyph://release-v2/");
    expect(overview.maxzoom).toBe(BASE_OVERVIEW_MAX_ZOOM);
    expect(overview.tiles[0]).toContain("pmtiles://bundled-canada-overview-v1/");
    const ids = style.layers.map((layer) => layer.id);
    const overviewEarthIndex = ids.indexOf("overview-earth");
    expect(ids.indexOf("background")).toBeLessThan(overviewEarthIndex);
    expect(overviewEarthIndex).toBeLessThan(ids.indexOf("earth"));
    expect(style.layers.filter((layer) => layer.id.startsWith("overview-")).length).toBeGreaterThan(0);
    expect(style.layers.filter((layer) => layer.id.startsWith("overview-")).every((layer) => layer.type !== "symbol")).toBe(true);
    expect(ids).toContain("water_waterway_label");
  });

  it("builds a useful bundled-only style before a content release is available", () => {
    const style = mapStyle();
    const overview = style.sources?.baseOverview as { maxzoom: number; tiles: string[] };

    expect(style.sources?.protomaps).toBeUndefined();
    expect(style.glyphs).toBeUndefined();
    expect(overview.maxzoom).toBe(BASE_OVERVIEW_MAX_ZOOM);
    expect(overview.tiles[0]).toContain("pmtiles://bundled-canada-overview-v1/");
    expect(style.layers.some((layer) => layer.type === "background")).toBe(true);
    expect(style.layers.every((layer) => layer.type === "background" || layer.source === "baseOverview")).toBe(true);
    expect(style.layers.some((layer) => layer.type === "symbol")).toBe(false);
  });

  it("streams chunks outside downloaded coverage while online and refuses them offline", async () => {
    let online = false;
    const ensureFile = vi.fn(async () => {
      if (!online) throw Object.assign(new Error("offline"), { name: "ContentUnavailableOfflineError" });
    });
    const runtime = {
      ensureFile,
      readFile: async () => new Uint8Array([3, 4]).buffer,
    } as unknown as ContentRuntime;
    const controller = new AbortController();
    const allowed = new Set([1]);
    const source = new RuntimeChunkSource(
      runtime,
      "release-v2",
      { size: 4, chunkBytes: 2, count: 2 },
      () => allowed,
      false,
      controller.signal,
    );

    await expect(source.getBytes(0, 1, controller.signal)).rejects.toThrow("has not been downloaded");
    online = true;
    await expect(source.getBytes(2, 2)).resolves.toMatchObject({ data: expect.any(ArrayBuffer) });
    await expect(source.getBytes(0, 1, controller.signal)).resolves.toMatchObject({ data: expect.any(ArrayBuffer) });

    expect(source.getKey()).toBe("release-v2");
    expect(ensureFile).toHaveBeenCalledWith("release-v2", "map/island/000.bin", "nearby", controller.signal);
    expect(ensureFile).toHaveBeenCalledWith("release-v2", "map/island/001.bin", "nearby", controller.signal);
    expect(getAllowedMapChunks("release-v2")).toContain(0);
    resetAllowedMapChunks("release-v2");
  });;
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
    expect(source.getKey()).toBe("bundled-canada-overview-v1");
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
      expect((fetcher.mock.calls[0][0] as URL).pathname).toBe(BASE_OVERVIEW_PATH);
      expect(fetcher.mock.calls[0]).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reads the bundled Canada archive at its declared zoom and coverage, including the mainland", async () => {
    const path = join(process.cwd(), "public", "map", "bootstrap", "canada-overview.pmtiles");
    const file = readFileSync(path);
    const archive = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer;
    const pmtiles = new PMTiles(new BundledOverviewSource(async () => archive));
    const header = await pmtiles.getHeader();

    expect(header.minZoom).toBe(0);
    expect(header.maxZoom).toBe(BASE_OVERVIEW_MAX_ZOOM);
    expect([header.minLon, header.minLat, header.maxLon, header.maxLat]).toEqual([...BASE_OVERVIEW_BOUNDS]);
    const zoom = BASE_OVERVIEW_MAX_ZOOM;
    const scale = 2 ** zoom;
    // Victoria, Kelowna, Prince George and Toronto all render from the bundled map.
    for (const [lng, lat] of [VICTORIA, [-119.4960, 49.8880], [-122.7497, 53.9171], [-79.3832, 43.6532]]) {
      const radians = (lat * Math.PI) / 180;
      const x = Math.floor(((lng + 180) / 360) * scale);
      const y = Math.floor(((1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2) * scale);
      const tile = await pmtiles.getZxy(zoom, x, y);
      expect(tile?.data.byteLength).toBeGreaterThan(0);
    }
  });
});

describe("detail map coverage notifications", () => {
  it("rebuilds the detail source only when new coverage can fill a refused tile", async () => {
    const releaseId = "coverage-listener-test";
    const listener = vi.fn();
    resetAllowedMapChunks(releaseId);
    const unsubscribe = subscribeMapCoverage(releaseId, listener);
    let online = true;
    const runtime = {
      ensureFile: vi.fn(async () => {
        if (!online) throw Object.assign(new Error("offline"), { name: "ContentUnavailableOfflineError" });
      }),
      readFile: async () => new Uint8Array([1, 2]).buffer,
    } as unknown as ContentRuntime;
    const source = new RuntimeChunkSource(runtime, releaseId, { size: 8, chunkBytes: 2, count: 4 }, () => new Set(getAllowedMapChunks(releaseId)));
    try {
      // Coverage that arrives while every tile read succeeded needs no redraw.
      setAllowedMapChunks(releaseId, [1]);
      expect(listener).not.toHaveBeenCalled();
      // A refused read (offline, not downloaded) makes the next growth rebuild once.
      online = false;
      await expect(source.getBytes(4, 1)).rejects.toThrow("has not been downloaded");
      setAllowedMapChunks(releaseId, [1]);
      expect(listener).not.toHaveBeenCalled();
      setAllowedMapChunks(releaseId, [2]);
      expect(listener).toHaveBeenCalledOnce();
      setAllowedMapChunks(releaseId, [3]);
      expect(listener).toHaveBeenCalledOnce();
      expect(getAllowedMapChunks(releaseId)).toEqual([1, 2, 3]);
    } finally {
      unsubscribe();
      resetAllowedMapChunks(releaseId);
    }
  });;

  it("recreates the detail source through a style diff and preserves overview and live overlays", () => {
    const style: StyleSpecification = {
      version: 8,
      name: "map refresh fixture",
      glyphs: "contentglyph://release-v2/map/fonts/{fontstack}/{range}.pbf",
      center: [-123.36, 48.43],
      zoom: 10,
      sources: {
        protomaps: { type: "vector", tiles: ["pmtiles://release-v2/{z}/{x}/{y}"], maxzoom: 14 },
        baseOverview: { type: "vector", tiles: ["pmtiles://bundled-overview/{z}/{x}/{y}"], maxzoom: 7 },
        parks: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
        route: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
      },
      layers: [
        { id: "overview-land", type: "fill", source: "baseOverview", "source-layer": "land" },
        { id: "detail-water", type: "fill", source: "protomaps", "source-layer": "water" },
        { id: "park-fill", type: "fill", source: "parks" },
        { id: "route-line", type: "line", source: "route" },
      ],
    };
    const setStyle = vi.fn();
    const map = { getStyle: () => style, setStyle } as unknown as Parameters<typeof reloadDetailedMapSource>[0];

    expect(reloadDetailedMapSource(map)).toBe(true);
    expect(setStyle).toHaveBeenCalledOnce();
    expect(setStyle.mock.calls[0][1]).toEqual({ diff: true });
    const refreshed = setStyle.mock.calls[0][0] as StyleSpecification;
    const originalDetailUrl = style.sources.protomaps.type === "vector" ? style.sources.protomaps.tiles?.[0] : undefined;
    const refreshedDetailUrl = refreshed.sources.protomaps.type === "vector" ? refreshed.sources.protomaps.tiles?.[0] : undefined;
    expect(refreshedDetailUrl).not.toBe(originalDetailUrl);
    expect(refreshedDetailUrl).toMatch(/[?&]coverage=\d+/);
    expect(refreshed.sources.baseOverview).toEqual(style.sources.baseOverview);
    expect(refreshed.sources.parks).toEqual(style.sources.parks);
    expect(refreshed.sources.route).toEqual(style.sources.route);
    expect(refreshed.layers).toEqual(style.layers);
    expect(refreshed.center).toEqual(style.center);
    expect(refreshed.zoom).toBe(style.zoom);
  });

  it("leaves a missing detail source pending instead of applying an incomplete style", () => {
    const setStyle = vi.fn();
    const map = {
      getStyle: () => ({ version: 8, sources: {}, layers: [] } as unknown as StyleSpecification),
      setStyle,
    } as unknown as Parameters<typeof reloadDetailedMapSource>[0];
    const pending = { current: true };

    expect(flushPendingDetailedMapSourceRefresh(map, pending)).toBe(false);
    expect(pending.current).toBe(true);
    expect(setStyle).not.toHaveBeenCalled();
  });

  it("clears the pending flag before a synchronous style.load refresh callback", () => {
    const style: StyleSpecification = {
      version: 8,
      sources: { protomaps: { type: "vector", tiles: ["pmtiles://release-v2/{z}/{x}/{y}"], maxzoom: 14 } },
      layers: [{ id: "detail-water", type: "fill", source: "protomaps", "source-layer": "water" }],
    };
    const pending = { current: true };
    let map: Parameters<typeof reloadDetailedMapSource>[0];
    const setStyle = vi.fn(() => {
      flushPendingDetailedMapSourceRefresh(map, pending);
    });
    map = { getStyle: () => style, setStyle } as unknown as Parameters<typeof reloadDetailedMapSource>[0];

    expect(flushPendingDetailedMapSourceRefresh(map, pending)).toBe(true);
    expect(setStyle).toHaveBeenCalledOnce();
    expect(pending.current).toBe(false);
  });

  it("replaces a PMTiles reader whose header was denied before coverage arrived", async () => {
    const path = join(process.cwd(), "public", "map", "bootstrap", "canada-overview.pmtiles");
    const file = readFileSync(path);
    const archiveBytes = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer;
    const releaseId = "failed-header-retry-test";
    const manifest: MapManifest = { size: archiveBytes.byteLength, chunkBytes: archiveBytes.byteLength, count: 1 };
    let online = false;
    const runtime = {
      ensureFile: vi.fn(async () => {
        if (!online) throw Object.assign(new Error("offline"), { name: "ContentUnavailableOfflineError" });
      }),
      readFile: vi.fn(async () => archiveBytes),
    } as unknown as ContentRuntime;
    const snapshot = {
      releaseId,
      manifest: { mapManifest: manifest, files: [] },
    } as unknown as ContentSnapshot;
    const addArchive = vi.spyOn(Protocol.prototype, "add");
    resetAllowedMapChunks(releaseId);
    const unregister = registerContentMapProtocols(runtime, snapshot);
    try {
      const archives = () => addArchive.mock.calls.map(([pmtiles]) => pmtiles).filter((pmtiles) => pmtiles.source.getKey() === releaseId);
      const first = archives().at(-1)!;
      const zoom = BASE_OVERVIEW_MAX_ZOOM;
      const scale = 2 ** zoom;
      const radians = (VICTORIA[1] * Math.PI) / 180;
      const x = Math.floor(((VICTORIA[0] + 180) / 360) * scale);
      const y = Math.floor(((1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2) * scale);

      await expect(first.getZxy(zoom, x, y)).rejects.toThrow("has not been downloaded");
      online = true;
      setAllowedMapChunks(releaseId, [0]);
      await expect(first.getZxy(zoom, x, y)).rejects.toThrow("has not been downloaded");

      const replacement = archives().at(-1)!;
      expect(replacement).not.toBe(first);
      const tile = await replacement.getZxy(zoom, x, y);
      expect(tile?.data.byteLength).toBeGreaterThan(0);
    } finally {
      unregister();
      resetAllowedMapChunks(releaseId);
      addArchive.mockRestore();
    }
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
    expect(starter.chunkIds.length).toBeGreaterThan(0);
    expect(starter.chunkIds.length).toBeLessThanOrEqual(4);

    resetAllowedMapChunks(releaseId);
    const nearby = await prefetchMapArea(runtime, releaseId, VICTORIA, "nearby", undefined, snapshot);

    // Cross-check against a brute-force scan of every tile in the archive.
    const cells = new Set(mapAreaTiles(VICTORIA, "nearby").map(({ x, y }) => `${x}/${y}`));
    const pmtiles = new PMTiles(new BundledOverviewSource(async () => archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength) as ArrayBuffer));
    const header = await pmtiles.getHeader();
    const expected = new Set<number>();
    const walk = async (offset: number, length: number): Promise<void> => {
      for (const entry of await pmtiles.cache.getDirectory(pmtiles.source, offset, length, header)) {
        if (entry.runLength === 0) { await walk(header.leafDirectoryOffset + entry.offset, entry.length); continue; }
        for (let i = 0; i < entry.runLength; i += 1) {
          const [z, x, y] = tileIdToZxy(entry.tileId + i);
          const inCell = z >= 9 ? cells.has(`${x >> (z - 9)}/${y >> (z - 9)}`)
            : z >= 7 && [...cells].some((key) => { const [cx, cy] = key.split("/").map(Number); return cx >> (9 - z) === x && cy >> (9 - z) === y; });
          if (!inCell) continue;
          const start = header.tileDataOffset + entry.offset;
          for (let c = Math.floor(start / mapManifest.chunkBytes); c <= Math.floor((start + entry.length - 1) / mapManifest.chunkBytes); c += 1) expected.add(c);
        }
      }
    };
    await walk(header.rootDirectoryOffset, header.rootDirectoryLength);
    for (const chunk of expected) expect(nearby.chunkIds).toContain(chunk);
    // Anything extra holds directories, which sit before the tile data.
    for (const chunk of nearby.chunkIds.filter((id) => !expected.has(id))) {
      expect(chunk * mapManifest.chunkBytes).toBeLessThan(header.tileDataOffset);
    }
  }, 30000);
});

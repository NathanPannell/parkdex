import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ContentRuntime } from "./content/contracts";
import { cellChunkIds, cellKeyAt, loadCellIndex, parkCountsByCell, squareLabels, writeSavedSquares } from "./mapCells";
import { summarizeLocalStorage } from "./localStorageSummary";

const bundled = JSON.parse(readFileSync(join(process.cwd(), "public", "map", "cells.json"), "utf8"));

describe("local storage summary", () => {
  it("groups stored files into saved squares, map cache, labels, park content and unused files", async () => {
    const index = await loadCellIndex(async () => bundled);
    const victoria = cellKeyAt([-123.3656, 48.4284]);
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) });
    writeSavedSquares([victoria]);
    const savedChunk = cellChunkIds(index, victoria).at(-1)!;
    const otherChunk = 2753;
    const runtime = {
      listStoredFiles: async () => [
        { hash: "a", size: 500, path: `map/detail/${String(savedChunk).padStart(3, "0")}.bin` },
        { hash: "b", size: 300, path: `map/detail/${otherChunk}.bin` },
        { hash: "c", size: 40, path: "map/fonts/Noto Sans Regular/0-255.pbf" },
        { hash: "d", size: 70, path: "art/badges/scenes/beacon-hill.webp" },
        { hash: "e", size: 9, path: null },
        { hash: "f", size: 6, path: "map/detail/manifest.json" },
      ],
    } as unknown as ContentRuntime;
    try {
      expect(await summarizeLocalStorage(runtime)).toEqual({
        totalBytes: 925,
        savedSquaresBytes: 500,
        mapCacheBytes: 300,
        mapCacheChunks: [otherChunk],
        mapSupportBytes: 46,
        parkContentBytes: 70,
        unusedBytes: 9,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("labels each square with its size and the parks inside it", async () => {
    const index = await loadCellIndex(async () => bundled);
    const parks = [{ lng: -123.36, lat: 48.43 }, { lng: -123.37, lat: 48.44 }];
    const victoria = cellKeyAt([-123.3656, 48.4284]);
    expect(parkCountsByCell(parks).get(victoria)).toBe(2);
    const label = squareLabels(index, parks).features.find((feature) => feature.properties.key === victoria)!;
    expect(label.properties.label).toMatch(/MB\n2 parks$/);
  });
});

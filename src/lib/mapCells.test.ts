import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUILD_MAP_ARCHIVE, BUILD_MAP_POINTER, isPointInsideContentBounds, tileIntersectsContentBounds } from "./content/contracts";
import {
  CELL_ZOOM,
  bytesForChunks,
  cellKeyAt,
  cellRing,
  chunkIdsForCells,
  chunksToRemove,
  formatMegabytes,
  parseCellIndex,
  readSavedSquares,
  readSquaresToSaveAgain,
  surroundingCellKeys,
  writeSavedSquares,
  type CellIndex,
} from "./mapCells";

const bundled = JSON.parse(readFileSync(join(process.cwd(), "public", "map", "cells.json"), "utf8"));

function memoryStorage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) };
}

describe("map squares", () => {
  it("ships an index for this build's pinned BC and Nova Scotia map", () => {
    const index = parseCellIndex(bundled);
    expect(index.version).toBe(BUILD_MAP_POINTER.version);
    expect(Object.keys(index.cells).length).toBeGreaterThan(1150);
    const places: [number, number][] = [
      [-123.3656, 48.4284],
      [-123.12, 49.28],
      [-119.496, 49.888],
      [-122.75, 53.92], // Victoria, Vancouver, Kelowna, Prince George
      [-63.5752, 44.6488],
      [-65.2, 44.4],
      [-60.65, 46.73],
      [-66.12, 43.84], // Halifax, Kejimkujik, Cape Breton Highlands, Yarmouth
    ];
    for (const place of places) {
      expect(isPointInsideContentBounds(place)).toBe(true);
      expect(chunkIdsForCells(index, [cellKeyAt(place)]).size).toBeGreaterThan(0);
    }
    // Every square lies in a content area, so none offers ancestor tiles alone.
    for (const key of Object.keys(index.cells)) {
      const [x, y] = key.split("/").map(Number);
      expect(tileIntersectsContentBounds(CELL_ZOOM, x, y), key).toBe(true);
    }
    expect(chunkIdsForCells(index, [cellKeyAt([-79.38, 43.65])]).size).toBe(0); // Toronto
    expect(() => parseCellIndex({ ...bundled, version: "0".repeat(64) })).toThrow("does not match");
  });

  it("streams the same archive layout the square index was built from", () => {
    const index = parseCellIndex(bundled);
    expect(BUILD_MAP_ARCHIVE.chunkBytes).toBe(index.chunkBytes);
    expect(BUILD_MAP_ARCHIVE.size).toBe(index.size);
    expect(BUILD_MAP_ARCHIVE.count).toBe(Math.ceil(index.size / index.chunkBytes));
    expect(BUILD_MAP_ARCHIVE.chunkBaseUrl).toContain(BUILD_MAP_POINTER.version);
    expect(BUILD_MAP_ARCHIVE.chunkBaseUrl).toBe(`https://kip-assets.parkdex.app/releases/${BUILD_MAP_POINTER.version}/map/${BUILD_MAP_ARCHIVE.folder}`);
  });

  it("finds the square under a point and draws its outline around it", () => {
    const key = cellKeyAt([-123.3656, 48.4284]);
    const ring = cellRing(key);
    expect(ring).toHaveLength(5);
    const [[west, north], , [east, south]] = ring;
    expect(west).toBeLessThan(-123.3656);
    expect(east).toBeGreaterThan(-123.3656);
    expect(south).toBeLessThan(48.4284);
    expect(north).toBeGreaterThan(48.4284);
    expect(surroundingCellKeys([-123.3656, 48.4284])).toContain(key);
    expect(surroundingCellKeys([-123.3656, 48.4284])).toHaveLength(9);
  });

  it("keeps chunks a remaining square still shares when one is removed", () => {
    const index: CellIndex = {
      schema: "parkdex.map-cells/v1",
      version: BUILD_MAP_POINTER.version,
      zoom: 9,
      chunkBytes: 10,
      size: 95,
      cells: { "1/1": [0, [3, 5]], "2/1": [0, 5, 6], "3/1": [9] },
    };
    expect(chunksToRemove(index, ["1/1"], ["2/1"])).toEqual([3, 4]);
    expect(chunksToRemove(index, ["1/1", "2/1"], [])).toEqual([0, 3, 4, 5, 6]);
    // The last chunk is shorter than the others.
    expect(bytesForChunks(index, chunkIdsForCells(index, ["3/1"]))).toBe(5);
    expect(formatMegabytes(6_500_000)).toBe("6.5 MB");
  });

  it("remembers saved squares per device and ignores malformed entries", () => {
    const storage = memoryStorage();
    expect(readSavedSquares(storage)).toEqual([]);
    writeSavedSquares(["80/178", "81/178", "80/178"], storage);
    expect(readSavedSquares(storage)).toEqual(["80/178", "81/178"]);
    storage.setItem("parkdex-map-squares-v1", JSON.stringify({ keys: ["80/178", "../x", 4] }));
    expect(readSavedSquares(storage)).toEqual(["80/178"]);
    expect(readSquaresToSaveAgain(storage)).toEqual([]);
  });

  it("offers squares saved for an earlier map again instead of calling them saved", () => {
    const storage = memoryStorage();
    storage.setItem("parkdex-map-squares-v1", JSON.stringify({ version: "0".repeat(64), keys: ["80/177", "81/177"] }));
    expect(readSavedSquares(storage)).toEqual([]);
    expect(readSquaresToSaveAgain(storage)).toEqual(["80/177", "81/177"]);
    writeSavedSquares(["80/177"], storage);
    expect(readSavedSquares(storage)).toEqual(["80/177"]);
    expect(readSquaresToSaveAgain(storage)).toEqual([]);
  });
});

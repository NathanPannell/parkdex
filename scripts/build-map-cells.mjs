// Builds public/map/cells.json: for every zoom-9 square with detail in the map archive, the
// chunk IDs that hold its z7-z14 tiles and the directories needed to find them offline.
// The Download maps screen uses it to show exact sizes and to download chosen squares.
// Usage: node scripts/build-map-cells.mjs <archive.pmtiles> <chunkBytes> <map-version>
import { closeSync, openSync, readSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PMTiles, zxyToTileId } from "pmtiles";

const [archivePath, rawChunkBytes, version] = process.argv.slice(2);
const chunkBytes = Number(rawChunkBytes);
if (!archivePath || !Number.isSafeInteger(chunkBytes) || chunkBytes <= 0 || !/^[a-f0-9]{64}$/.test(version ?? "")) {
  throw new Error("Usage: node scripts/build-map-cells.mjs <archive.pmtiles> <chunkBytes> <map-version>");
}
const CELL_ZOOM = 9;
const MAX_ZOOM = 14;
const ANCESTOR_ZOOMS = [7, 8];

const fd = openSync(archivePath, "r");
const source = {
  getKey: () => archivePath,
  async getBytes(offset, length) {
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, offset);
    return { data: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + length) };
  },
};
const archive = new PMTiles(source);
const header = await archive.getHeader();

const chunksOf = (offset, length, into) => {
  for (let index = Math.floor(offset / chunkBytes); index <= Math.floor((offset + length - 1) / chunkBytes); index += 1) into.add(index);
};
const zoomBase = (z) => (4 ** z - 1) / 3;

function cellRanges(x, y) {
  const index = zxyToTileId(CELL_ZOOM, x, y) - zoomBase(CELL_ZOOM);
  const ranges = ANCESTOR_ZOOMS.map((z) => {
    const id = zxyToTileId(z, x >> (CELL_ZOOM - z), y >> (CELL_ZOOM - z));
    return [id, id];
  });
  for (let z = CELL_ZOOM; z <= MAX_ZOOM; z += 1) {
    const span = 4 ** (z - CELL_ZOOM);
    const start = zoomBase(z) + index * span;
    ranges.push([start, start + span - 1]);
  }
  return ranges;
}

async function cellChunks(x, y) {
  const ranges = cellRanges(x, y);
  const overlaps = (a, b) => ranges.some(([start, end]) => a <= end && b >= start);
  // The z7-z8 ancestors also cover squares just outside the archive's areas; only a
  // square with its own z9+ tiles has detail worth downloading.
  const ownRanges = ranges.slice(ANCESTOR_ZOOMS.length);
  const ownTile = (a, b) => ownRanges.some(([start, end]) => a <= end && b >= start);
  const chunks = new Set();
  let tiles = 0;
  chunksOf(0, 127, chunks);
  chunksOf(header.rootDirectoryOffset, header.rootDirectoryLength, chunks);
  const visit = async (offset, length, limit) => {
    const entries = await archive.cache.getDirectory(source, offset, length, header);
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      if (entry.runLength === 0) {
        const next = i + 1 < entries.length ? entries[i + 1].tileId : limit;
        if (!overlaps(entry.tileId, next - 1)) continue;
        chunksOf(header.leafDirectoryOffset + entry.offset, entry.length, chunks);
        await visit(header.leafDirectoryOffset + entry.offset, entry.length, next);
        continue;
      }
      if (!overlaps(entry.tileId, entry.tileId + entry.runLength - 1)) continue;
      if (ownTile(entry.tileId, entry.tileId + entry.runLength - 1)) tiles += 1;
      chunksOf(header.tileDataOffset + entry.offset, entry.length, chunks);
    }
  };
  await visit(header.rootDirectoryOffset, header.rootDirectoryLength, Number.MAX_SAFE_INTEGER);
  return { chunks: [...chunks].sort((a, b) => a - b), tiles };
}

// Runs of consecutive chunk IDs keep the bundled index small.
function runs(ids) {
  const out = [];
  for (const id of ids) {
    const last = out[out.length - 1];
    if (last && last[1] === id - 1) last[1] = id;
    else out.push([id, id]);
  }
  return out.map(([a, b]) => (a === b ? a : [a, b]));
}

const scale = 2 ** CELL_ZOOM;
const lngToX = (lng) => Math.floor(((lng + 180) / 360) * scale);
const latToY = (lat) => {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * scale);
};
const cells = {};
let total = 0;
for (let x = lngToX(header.minLon); x <= lngToX(header.maxLon); x += 1) {
  for (let y = latToY(header.maxLat); y <= latToY(header.minLat); y += 1) {
    const { chunks, tiles } = await cellChunks(x, y);
    if (!tiles) continue;
    cells[`${x}/${y}`] = runs(chunks);
    total += 1;
  }
}
closeSync(fd);

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(root, "public", "map", "cells.json");
writeFileSync(output, JSON.stringify({ schema: "parkdex.map-cells/v1", version, zoom: CELL_ZOOM, chunkBytes, size: statSync(archivePath).size, cells }));
console.log(`${total} squares written to ${output}`);

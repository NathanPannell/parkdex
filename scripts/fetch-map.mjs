// Builds the offline Vancouver Island basemap into public/map:
//   tiles/{z}/{x}/{y}.pbf  uncompressed vector tiles (Android compresses them in the APK)
//   fonts/{stack}/{range}.pbf  the glyph ranges the style needs
// Capacitor's local server ignores HTTP Range offsets, so a single .pmtiles
// archive can't be read on-device; plain tile files work with ordinary fetches.
// Usage: node scripts/fetch-map.mjs  (needs .tools/go-pmtiles.exe, see README)
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readSync, writeFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PMTiles } from "pmtiles";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(root, "public", "map");
const archive = join(root, ".tools", "island.pmtiles");
export const BBOX = [-128.45, 48.28, -123.25, 50.92];
const MAX_ZOOM = 14;
const BUILD = process.env.PROTOMAPS_BUILD ?? "20260925";
const FONTS = ["Noto Sans Regular", "Noto Sans Medium", "Noto Sans Italic"];
const RANGES = ["0-255", "256-511", "512-767", "768-1023", "7680-7935", "8192-8447"];

if (!existsSync(archive)) {
  console.log(`extracting island from Protomaps build ${BUILD}...`);
  execFileSync(
    join(root, ".tools", "go-pmtiles.exe"),
    ["extract", `https://build.protomaps.com/${BUILD}.pmtiles`, archive, `--bbox=${BBOX.join(",")}`, `--maxzoom=${MAX_ZOOM}`],
    { stdio: "inherit" },
  );
}

class FileSource {
  constructor(path) {
    this.fd = openSync(path, "r");
    this.path = path;
  }
  getKey() {
    return this.path;
  }
  async getBytes(offset, length) {
    const buf = Buffer.alloc(length);
    readSync(this.fd, buf, 0, length, offset);
    return { data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + length) };
  }
}

const lon2x = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
const lat2y = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
};

rmSync(join(out, "tiles"), { recursive: true, force: true });
const pm = new PMTiles(new FileSource(archive));
let count = 0;
let bytes = 0;
for (let z = 0; z <= MAX_ZOOM; z++) {
  const [x0, x1] = [lon2x(BBOX[0], z), lon2x(BBOX[2], z)];
  const [y0, y1] = [lat2y(BBOX[3], z), lat2y(BBOX[1], z)];
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      const tile = await pm.getZxy(z, x, y);
      if (!tile?.data?.byteLength) continue;
      const file = join(out, "tiles", String(z), String(x), `${y}.pbf`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, Buffer.from(tile.data));
      count++;
      bytes += tile.data.byteLength;
    }
  }
  console.log(`z${z}: ${count} tiles so far`);
}
console.log(`wrote ${count} tiles, ${(bytes / 1e6).toFixed(1)} MB uncompressed`);

for (const font of FONTS) {
  for (const range of RANGES) {
    const file = join(out, "fonts", font, `${range}.pbf`);
    if (existsSync(file) && statSync(file).size > 0) continue;
    const res = await fetch(`https://protomaps.github.io/basemaps-assets/fonts/${encodeURIComponent(font)}/${range}.pbf`);
    if (!res.ok) throw new Error(`font ${font} ${range}: ${res.status}`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
}
console.log("fonts ready");

// Builds the offline Vancouver Island basemap into public/map:
//   island/NNN.bin + manifest.json  the Protomaps archive split into 2 MB chunks
//   fonts/{stack}/{range}.pbf        the glyph ranges the style needs
// Capacitor's local server ignores HTTP Range offsets, so the app can't read a single
// .pmtiles file directly; src/lib/offlineTiles.ts reassembles ranges from the chunks.
// Usage: node scripts/fetch-map.mjs  (needs .tools/go-pmtiles.exe, see README)
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

// Split the archive into plain chunk files. The app reads byte ranges by loading
// whole chunks, which Capacitor serves correctly, and a few dozen files keep
// Android builds fast (59k loose tiles took over an hour to package).
const CHUNK_BYTES = 2 * 1024 * 1024;
const data = readFileSync(archive);
rmSync(join(out, "tiles"), { recursive: true, force: true });
rmSync(join(out, "island"), { recursive: true, force: true });
mkdirSync(join(out, "island"), { recursive: true });
const count = Math.ceil(data.length / CHUNK_BYTES);
for (let i = 0; i < count; i++) {
  writeFileSync(join(out, "island", `${String(i).padStart(3, "0")}.bin`), data.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES));
}
writeFileSync(join(out, "island", "manifest.json"), JSON.stringify({ size: data.length, chunkBytes: CHUNK_BYTES, count }));
console.log(`wrote ${count} chunks, ${(data.length / 1e6).toFixed(1)} MB`);

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

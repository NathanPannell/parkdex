import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const frontendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = resolve(frontendRoot, "out");
const requiredFiles = [
  "index.html",
  "auth/google/callback.html",
  "maplibre/maplibre-gl-worker.mjs",
  "data/boundaries.v1.geojson",
  "data/boundaries-display.v1.geojson",
  "data/exploration-territories.v1.geojson",
  "data/vancouver-island-focus-mask.v1.geojson",
  "places/place-placeholder.png",
  "_headers",
];

for (const relativePath of requiredFiles) {
  const path = resolve(outputRoot, relativePath);
  if (!statSync(path).isFile() || statSync(path).size === 0) {
    throw new Error(`Static export is missing ${relativePath}`);
  }
}

const headers = readFileSync(resolve(outputRoot, "_headers"), "utf8");
for (const value of ["/auth/google/callback", "Cache-Control: no-store", "Referrer-Policy: no-referrer", "X-Robots-Tag: noindex"]) {
  if (!headers.includes(value)) throw new Error(`Static export headers are missing ${value}`);
}

console.log(`Verified ${requiredFiles.length} required Cloudflare Pages files`);

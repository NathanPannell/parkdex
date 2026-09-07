import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { buildBoundaryIndex, serializeBoundaryIndex } from "./boundary-asset-lib.mjs";

const canonicalUrl = new URL("../../data/boundaries.geojson", import.meta.url);
const publicDirectoryUrl = new URL("../public/data/", import.meta.url);
const publicDataUrl = new URL("boundaries.v1.geojson", publicDirectoryUrl);
const publicIndexUrl = new URL("boundaries-index.v1.json", publicDirectoryUrl);
const collection = JSON.parse(await readFile(fileURLToPath(canonicalUrl), "utf8"));

await mkdir(fileURLToPath(publicDirectoryUrl), { recursive: true });
await Promise.all([
  copyFile(fileURLToPath(canonicalUrl), fileURLToPath(publicDataUrl)),
  writeFile(fileURLToPath(publicIndexUrl), serializeBoundaryIndex(buildBoundaryIndex(collection))),
]);
console.log(`Copied ${collection.features.length} boundaries and their compact fit index.`);

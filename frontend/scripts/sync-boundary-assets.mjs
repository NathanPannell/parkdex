import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { buildBoundaryIndex, serializeBoundaryIndex } from "./boundary-asset-lib.mjs";
import { readScopedBoundaryCollection } from "./catalogue-scope.mjs";

const publicDirectoryUrl = new URL("../public/data/", import.meta.url);
const publicDataUrl = new URL("boundaries.v1.geojson", publicDirectoryUrl);
const publicIndexUrl = new URL("boundaries-index.v1.json", publicDirectoryUrl);
const scoped = await readScopedBoundaryCollection();

await mkdir(fileURLToPath(publicDirectoryUrl), { recursive: true });
await Promise.all([
  writeFile(fileURLToPath(publicDataUrl), scoped.scope === "canonical" ? scoped.canonicalText : `${JSON.stringify(scoped.collection)}\n`),
  writeFile(fileURLToPath(publicIndexUrl), serializeBoundaryIndex(buildBoundaryIndex(scoped.collection))),
]);
console.log(`Copied ${scoped.collection.features.length} ${scoped.scope} boundaries and their compact fit index.`);

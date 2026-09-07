import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { buildBoundaryIndex, serializeBoundaryIndex } from "./boundary-asset-lib.mjs";

const canonicalUrl = new URL("../../data/boundaries.geojson", import.meta.url);
const publicUrl = new URL("../public/data/boundaries.v1.geojson", import.meta.url);
const publicIndexUrl = new URL("../public/data/boundaries-index.v1.json", import.meta.url);

async function digest(url) {
  const contents = await readFile(fileURLToPath(url));
  return { hash: createHash("sha256").update(contents).digest("hex"), bytes: contents.byteLength };
}

const [canonical, publicAsset, canonicalJson, publicIndex] = await Promise.all([
  digest(canonicalUrl),
  digest(publicUrl),
  readFile(fileURLToPath(canonicalUrl), "utf8"),
  readFile(fileURLToPath(publicIndexUrl), "utf8"),
]);
if (canonical.hash !== publicAsset.hash) {
  throw new Error("frontend/public/data/boundaries.v1.geojson is stale; copy data/boundaries.geojson before shipping");
}
const expectedIndex = serializeBoundaryIndex(buildBoundaryIndex(JSON.parse(canonicalJson)));
if (publicIndex !== expectedIndex) {
  throw new Error("frontend/public/data/boundaries-index.v1.json is stale; run npm run sync:boundaries before shipping");
}
console.log(`Boundary asset matches canonical data (${publicAsset.bytes.toLocaleString()} bytes, sha256 ${publicAsset.hash.slice(0, 12)}…).`);

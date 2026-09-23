import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { buildBoundaryIndex, serializeBoundaryIndex } from "./boundary-asset-lib.mjs";
import { readScopedBoundaryCollection } from "./catalogue-scope.mjs";

const publicUrl = new URL("../public/data/boundaries.v1.geojson", import.meta.url);
const publicIndexUrl = new URL("../public/data/boundaries-index.v1.json", import.meta.url);

async function digest(url) {
  const contents = await readFile(fileURLToPath(url));
  return { hash: createHash("sha256").update(contents).digest("hex"), bytes: contents.byteLength };
}

const scoped = await readScopedBoundaryCollection();
const expectedPublicText = scoped.scope === "canonical" ? scoped.canonicalText : `${JSON.stringify(scoped.collection)}\n`;
const [publicAsset, publicIndex] = await Promise.all([
  digest(publicUrl),
  readFile(fileURLToPath(publicIndexUrl), "utf8"),
]);
const expectedHash = createHash("sha256").update(expectedPublicText).digest("hex");
if (expectedHash !== publicAsset.hash) {
  throw new Error(`frontend/public/data/boundaries.v1.geojson is stale for ${scoped.scope} scope; run npm run sync:boundaries before shipping`);
}
const expectedIndex = serializeBoundaryIndex(buildBoundaryIndex(scoped.collection));
if (publicIndex !== expectedIndex) {
  throw new Error(`frontend/public/data/boundaries-index.v1.json is stale for ${scoped.scope} scope; run npm run sync:boundaries before shipping`);
}
console.log(`Boundary asset matches ${scoped.scope} data (${publicAsset.bytes.toLocaleString()} bytes, sha256 ${publicAsset.hash.slice(0, 12)}…).`);

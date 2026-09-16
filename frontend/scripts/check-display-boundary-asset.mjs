import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import booleanValid from "@turf/boolean-valid";
import { boundarySourceDescription, readScopedBoundaryCollection } from "./catalogue-scope.mjs";

const outputUrl = new URL("../public/data/boundaries-display.v1.geojson", import.meta.url);
const manifestUrl = new URL("../public/data/boundaries-display.v1.manifest.json", import.meta.url);
const [scoped, outputText, manifestText] = await Promise.all([
  readScopedBoundaryCollection(),
  readFile(fileURLToPath(outputUrl), "utf8"),
  readFile(fileURLToPath(manifestUrl), "utf8"),
]);
const manifest = JSON.parse(manifestText);
const output = JSON.parse(outputText);
const checksum = createHash("sha256").update(outputText).digest("hex");
const inputChecksum = createHash("sha256").update(scoped.inputText).digest("hex");
if (inputChecksum !== manifest.inputSha256 || manifest.input !== boundarySourceDescription(scoped.scope)) {
  throw new Error(`${scoped.scope} boundary checksum does not match the display manifest. Regenerate the asset.`);
}
if (checksum !== manifest.outputSha256) throw new Error("Display boundary checksum does not match its manifest. Regenerate the asset.");
if (output.type !== "FeatureCollection" || output.features.length !== manifest.featureCount || output.features.length !== scoped.collection.features.length) {
  throw new Error("Display boundary feature count does not match its manifest or scoped boundary data.");
}
if (!output.features.every((feature) => feature.geometry?.type === "Polygon" || feature.geometry?.type === "MultiPolygon")) {
  throw new Error("Display boundary asset contains unsupported geometry.");
}
if (!output.features.every((feature) => Array.isArray(feature.geometry.coordinates) && feature.geometry.coordinates.length > 0 && typeof feature.properties?.id === "string")) {
  throw new Error("Display boundary asset contains an empty geometry or missing id.");
}
function polygonParts(feature) {
  if (feature.geometry.type === "Polygon") return [feature];
  return feature.geometry.coordinates.map((coordinates) => ({
    type: "Feature",
    properties: feature.properties,
    geometry: { type: "Polygon", coordinates },
  }));
}
const invalidIds = output.features
  .filter((feature) => !polygonParts(feature).every((part) => booleanValid(part)))
  .map((feature) => feature.properties.id);
if (invalidIds.length) throw new Error(`Display boundary asset contains invalid polygon topology: ${invalidIds.join(", ")}`);
console.log(`Verified ${output.features.length} display boundaries (${checksum.slice(0, 12)}).`);

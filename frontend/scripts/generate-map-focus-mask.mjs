import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import polygonClipping from "polygon-clipping";
import { readCatalogueSource, readScopedBoundaryCollection } from "./catalogue-scope.mjs";

const displayUrl = new URL("../public/data/boundaries-display.v1.geojson", import.meta.url);
const outputUrl = new URL("../public/data/bc-focus-mask.v1.geojson", import.meta.url);

const [display, bcLand, scoped] = await Promise.all([
  readFile(fileURLToPath(displayUrl), "utf8").then(JSON.parse),
  readCatalogueSource("bc-land-focus.geojson").then(JSON.parse),
  readScopedBoundaryCollection(),
]);

function polygons(feature) {
  if (feature.geometry.type === "Polygon") return [[feature.geometry.coordinates[0]]];
  return feature.geometry.coordinates.map((polygon) => [polygon[0]]);
}

const nearbyIslands = display.features.filter((feature) => feature.properties?.category === "island");
// The province outline deliberately omits sub-kilometre islets. Every actual
// park boundary remains visible, including newly added and staging-only parks.
const excursionParks = display.features.filter((feature) => (
  feature.properties?.category !== "island" && feature.properties?.id
));
const focusFeatures = new Map([
  ...nearbyIslands.map((feature) => [feature.properties?.id, feature]),
  ...excursionParks.map((feature) => [feature.properties?.id, feature]),
]);
const focusPolygons = [bcLand, ...focusFeatures.values()].flatMap(polygons);
const extent = [[[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]]];
const coordinates = polygonClipping.difference(extent, ...focusPolygons);

const mask = {
  type: "FeatureCollection",
  features: [{
    type: "Feature",
    properties: {
      scope: "Outside British Columbia land and catalogued parks",
      sourceName: "Statistics Canada and park boundary providers",
      sourceUrl: bcLand.properties.sourceUrl,
    },
    geometry: { type: "MultiPolygon", coordinates },
  }],
};

await writeFile(fileURLToPath(outputUrl), `${JSON.stringify(mask)}\n`);
console.log(`Generated BC map focus mask around ${focusPolygons.length} focus polygons (${scoped.scope}).`);

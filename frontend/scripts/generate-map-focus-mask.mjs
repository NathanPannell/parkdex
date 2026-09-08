import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import polygonClipping from "polygon-clipping";

const displayUrl = new URL("../public/data/boundaries-display.v1.geojson", import.meta.url);
const mainIslandUrl = new URL("../../data/vancouver-island-focus.geojson", import.meta.url);
const outputUrl = new URL("../public/data/vancouver-island-focus-mask.v1.geojson", import.meta.url);

const [display, mainIsland] = await Promise.all([
  readFile(fileURLToPath(displayUrl), "utf8").then(JSON.parse),
  readFile(fileURLToPath(mainIslandUrl), "utf8").then(JSON.parse),
]);

function polygons(feature) {
  if (feature.geometry.type === "Polygon") return [[feature.geometry.coordinates[0]]];
  return feature.geometry.coordinates.map((polygon) => [polygon[0]]);
}

const nearbyIslands = display.features.filter((feature) => feature.properties?.category === "island");
const excursionIds = new Set([
  "provincial-mitlenatch-island-nature-park",
  "provincial-pirates-cove-marine-park",
  "provincial-saysutshun-newcastle-island-marine-park",
  "provincial-wallace-island-marine-park",
]);
const excursionParks = display.features.filter((feature) => excursionIds.has(feature.properties?.id));
if (excursionParks.length !== excursionIds.size) throw new Error("Map focus excursion park geometry is incomplete");
const focusPolygons = [mainIsland, ...nearbyIslands, ...excursionParks].flatMap(polygons);
const extent = [[[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]]];
const coordinates = polygonClipping.difference(extent, ...focusPolygons);

const mask = {
  type: "FeatureCollection",
  features: [{
    type: "Feature",
    properties: {
      scope: "Outside Vancouver Island and supported major islands",
      sourceName: "OpenStreetMap contributors",
      sourceUrl: "https://www.openstreetmap.org/copyright",
    },
    geometry: { type: "MultiPolygon", coordinates },
  }],
};

await writeFile(fileURLToPath(outputUrl), `${JSON.stringify(mask)}\n`);
console.log(`Generated map focus mask around ${focusPolygons.length} focus polygons.`);

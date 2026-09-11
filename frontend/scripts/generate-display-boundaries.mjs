import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import buffer from "@turf/buffer";
import booleanValid from "@turf/boolean-valid";
import simplify from "@turf/simplify";

const inputUrl = new URL("../../data/boundaries.geojson", import.meta.url);
const outputUrl = new URL("../public/data/boundaries-display.v1.geojson", import.meta.url);
const manifestUrl = new URL("../public/data/boundaries-display.v1.manifest.json", import.meta.url);
const MIN_BUFFER_METERS = 15;
const MAX_BUFFER_METERS = 180;
const BUFFER_PER_DIAGONAL = 0.002;
const MIN_ROUNDING_METERS = 35;
const MAX_ROUNDING_METERS = 800;
const ROUNDING_PER_DIAGONAL = 0.008;
const SIMPLIFY_PER_ROUNDING = 0.3;
const BUFFER_STEPS = 8;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function visitCoordinates(value, visit) {
  if (!Array.isArray(value)) return;
  if (value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number") {
    visit(value[0], value[1]);
    return;
  }
  value.forEach((child) => visitCoordinates(child, visit));
}

function diagonalKm(geometry) {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  visitCoordinates(geometry.coordinates, (longitude, latitude) => {
    west = Math.min(west, longitude);
    east = Math.max(east, longitude);
    south = Math.min(south, latitude);
    north = Math.max(north, latitude);
  });
  const centerLatitude = (south + north) / 2 * Math.PI / 180;
  return Math.hypot((east - west) * 111.32 * Math.cos(centerLatitude), (north - south) * 110.574);
}

export function displayBufferMeters(feature) {
  if (feature.properties?.category !== "island") return 0;
  return Math.min(MAX_BUFFER_METERS, Math.max(MIN_BUFFER_METERS, diagonalKm(feature.geometry) * 1000 * BUFFER_PER_DIAGONAL));
}

export function softenBoundary(feature) {
  const bufferMeters = displayBufferMeters(feature);
  const roundingMeters = Math.min(MAX_ROUNDING_METERS, Math.max(MIN_ROUNDING_METERS, diagonalKm(feature.geometry) * 1000 * ROUNDING_PER_DIAGONAL));
  const toleranceDegrees = roundingMeters / 111_320 * SIMPLIFY_PER_ROUNDING;
  const simplified = simplify(feature, { tolerance: toleranceDegrees, highQuality: true, mutate: false });
  const expanded = buffer(simplified, (bufferMeters + roundingMeters) / 1000, { units: "kilometers", steps: BUFFER_STEPS });
  const softened = expanded && buffer(expanded, -roundingMeters / 1000, { units: "kilometers", steps: BUFFER_STEPS });
  if (!softened) throw new Error(`Could not create display boundary for ${feature.properties?.id ?? "unknown"}`);
  return { ...softened, properties: feature.properties };
}

function polygonParts(feature) {
  if (feature.geometry.type === "Polygon") return [feature];
  return feature.geometry.coordinates.map((coordinates) => ({
    type: "Feature",
    properties: feature.properties,
    geometry: { type: "Polygon", coordinates },
  }));
}

function everyPolygonPartIsValid(feature) {
  return polygonParts(feature).every((part) => booleanValid(part));
}

export function roundBoundarySafely(feature) {
  for (const precision of [6, 7, 8, 9]) {
    const candidate = {
      ...feature,
      geometry: { ...feature.geometry, coordinates: roundCoordinatesTo(feature.geometry.coordinates, precision) },
    };
    if (everyPolygonPartIsValid(candidate)) return { feature: candidate, precision };
  }
  if (!everyPolygonPartIsValid(feature)) throw new Error(`Invalid softened boundary for ${feature.properties?.id ?? "unknown"}`);
  return { feature, precision: null };
}

function roundCoordinatesTo(value, precision) {
  if (!Array.isArray(value)) return value;
  if (value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number") {
    return [Number(value[0].toFixed(precision)), Number(value[1].toFixed(precision))];
  }
  return value.map((child) => roundCoordinatesTo(child, precision));
}

const inputText = await readFile(fileURLToPath(inputUrl), "utf8");
const normalizedInputText = inputText.replace(/\r\n/g, "\n");
const canonical = JSON.parse(inputText);
const rounded = canonical.features.map(softenBoundary).map(roundBoundarySafely);
const precisionCounts = rounded.reduce((counts, result) => {
  const key = result.precision == null ? "unrounded" : String(result.precision);
  counts[key] = (counts[key] ?? 0) + 1;
  return counts;
}, {});
const display = {
  type: "FeatureCollection",
  features: rounded.map((result) => result.feature),
};
const outputText = `${JSON.stringify(display)}\n`;
const manifest = {
  version: 1,
  input: "data/boundaries.geojson",
  output: "frontend/public/data/boundaries-display.v1.geojson",
  inputSha256: sha256(normalizedInputText),
  outputSha256: sha256(outputText),
  featureCount: display.features.length,
  algorithm: {
    name: "adaptive-simplify-rounded-category-offset",
    parkBufferMeters: 0,
    minBufferMeters: MIN_BUFFER_METERS,
    maxBufferMeters: MAX_BUFFER_METERS,
    bufferPerDiagonal: BUFFER_PER_DIAGONAL,
    minRoundingMeters: MIN_ROUNDING_METERS,
    maxRoundingMeters: MAX_ROUNDING_METERS,
    roundingPerDiagonal: ROUNDING_PER_DIAGONAL,
    simplifyPerRounding: SIMPLIFY_PER_ROUNDING,
    bufferSteps: BUFFER_STEPS,
    coordinatePrecisionCounts: precisionCounts,
  },
};
await Promise.all([
  writeFile(fileURLToPath(outputUrl), outputText),
  writeFile(fileURLToPath(manifestUrl), `${JSON.stringify(manifest, null, 2)}\n`),
]);
console.log(`Generated ${display.features.length} softened display boundaries (${manifest.outputSha256.slice(0, 12)}).`);

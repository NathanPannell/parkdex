import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import polygonClipping from "polygon-clipping";

import {
  EXPLORATION_CATEGORY_WEIGHTS,
  projectExplorationLocation,
  unprojectExplorationLocation,
  weightedTerritoryConstraint,
} from "../lib/exploration-geometry.ts";

const catalogueUrl = new URL("../../data/places.json", import.meta.url);
const displayUrl = new URL("../public/data/boundaries-display.v1.geojson", import.meta.url);
const mainIslandUrl = new URL("../../data/vancouver-island-focus.geojson", import.meta.url);
const outputUrl = new URL("../public/data/exploration-territories.v1.geojson", import.meta.url);
const CIRCLE_STEPS = 192;
const EXCURSION_IDS = new Set([
  "provincial-mitlenatch-island-nature-park",
  "provincial-pirates-cove-marine-park",
  "provincial-saysutshun-newcastle-island-marine-park",
  "provincial-wallace-island-marine-park",
]);

const [places, display, mainIsland] = await Promise.all([
  readFile(fileURLToPath(catalogueUrl), "utf8").then(JSON.parse),
  readFile(fileURLToPath(displayUrl), "utf8").then(JSON.parse),
  readFile(fileURLToPath(mainIslandUrl), "utf8").then(JSON.parse),
]);

function exteriorPolygons(feature) {
  if (feature.geometry.type === "Polygon") return [[feature.geometry.coordinates[0]]];
  return feature.geometry.coordinates.map((polygon) => [polygon[0]]);
}

const nearbyIslands = display.features.filter((feature) => feature.properties?.category === "island");
const excursionParks = display.features.filter((feature) => EXCURSION_IDS.has(feature.properties?.id));
if (excursionParks.length !== EXCURSION_IDS.size) throw new Error("Exploration territory excursion geometry is incomplete");
const landInputs = [mainIsland, ...nearbyIslands, ...excursionParks].flatMap(exteriorPolygons);
const land = polygonClipping.union(landInputs[0], ...landInputs.slice(1));

function everyPair(multiPolygon) {
  return multiPolygon.flatMap((polygon) => polygon.flatMap((ring) => ring));
}

const landProjected = everyPair(land).map(([longitude, latitude]) => projectExplorationLocation({ longitude, latitude }));
const xs = landProjected.map(([x]) => x);
const ys = landProjected.map(([, y]) => y);
const paddingKm = 20;
const bounds = {
  minX: Math.min(...xs) - paddingKm,
  minY: Math.min(...ys) - paddingKm,
  maxX: Math.max(...xs) + paddingKm,
  maxY: Math.max(...ys) + paddingKm,
};
const boundsRing = [
  [bounds.minX, bounds.minY],
  [bounds.maxX, bounds.minY],
  [bounds.maxX, bounds.maxY],
  [bounds.minX, bounds.maxY],
  [bounds.minX, bounds.minY],
];

function closeRing(ring) {
  if (!ring.length) return ring;
  const [firstX, firstY] = ring[0];
  const [lastX, lastY] = ring.at(-1);
  return firstX === lastX && firstY === lastY ? ring : [...ring, ring[0]];
}

function halfPlanePolygon({ x, y, limit }) {
  const ring = boundsRing.slice(0, -1);
  const output = [];
  for (let index = 0; index < ring.length; index += 1) {
    const start = ring[index];
    const end = ring[(index + 1) % ring.length];
    const startValue = x * start[0] + y * start[1] - limit;
    const endValue = x * end[0] + y * end[1] - limit;
    const startInside = startValue <= 1e-9;
    const endInside = endValue <= 1e-9;
    if (startInside) output.push(start);
    if (startInside !== endInside) {
      const fraction = startValue / (startValue - endValue);
      output.push([
        start[0] + fraction * (end[0] - start[0]),
        start[1] + fraction * (end[1] - start[1]),
      ]);
    }
  }
  return output.length >= 3 ? [[closeRing(output)]] : [];
}

const circleCache = new Map();

function circlePolygon({ center: [centerX, centerY], radius }, pairKey) {
  const cached = circleCache.get(pairKey);
  if (cached) return cached;
  const ring = Array.from({ length: CIRCLE_STEPS }, (_, index) => {
    const angle = index * 2 * Math.PI / CIRCLE_STEPS;
    return [centerX + radius * Math.cos(angle), centerY + radius * Math.sin(angle)];
  });
  const circle = [[closeRing(ring)]];
  circleCache.set(pairKey, circle);
  return circle;
}

function polygonBounds(multiPolygon) {
  const pairs = everyPair(multiPolygon);
  return {
    minX: Math.min(...pairs.map(([x]) => x)),
    minY: Math.min(...pairs.map(([, y]) => y)),
    maxX: Math.max(...pairs.map(([x]) => x)),
    maxY: Math.max(...pairs.map(([, y]) => y)),
  };
}

function circleIntersectsPolygon(circle, multiPolygon) {
  const cellBounds = polygonBounds(multiPolygon);
  const [x, y] = circle.center;
  return x + circle.radius >= cellBounds.minX
    && x - circle.radius <= cellBounds.maxX
    && y + circle.radius >= cellBounds.minY
    && y - circle.radius <= cellBounds.maxY;
}

function projectedTerritory(owner) {
  let cell = [[boundsRing]];
  const constraints = places
    .filter((competitor) => competitor.id !== owner.id)
    .map((competitor) => ({
      constraint: weightedTerritoryConstraint(owner, competitor),
      pairKey: [owner.id, competitor.id].sort().join("|"),
    }))
    .sort((left, right) => {
      const order = (constraint) => constraint.kind === "empty" ? 0
        : constraint.kind === "circle" && constraint.keep === "inside" ? 1
          : constraint.kind === "half-plane" ? 2 : constraint.kind === "circle" ? 3 : 4;
      return order(left.constraint) - order(right.constraint);
    });
  for (const { constraint, pairKey } of constraints) {
    if (!cell.length || constraint.kind === "empty") return [];
    if (constraint.kind === "all") continue;
    if (constraint.kind === "half-plane") {
      const allowed = halfPlanePolygon(constraint);
      cell = allowed.length ? polygonClipping.intersection(cell, allowed) : [];
      continue;
    }
    if (!circleIntersectsPolygon(constraint, cell)) {
      if (constraint.keep === "inside") return [];
      continue;
    }
    const circle = circlePolygon(constraint, pairKey);
    cell = constraint.keep === "inside"
      ? polygonClipping.intersection(cell, circle)
      : polygonClipping.difference(cell, circle);
  }
  return cell;
}

function toLongitudeLatitude(multiPolygon) {
  return multiPolygon.map((polygon) => polygon.map((ring) => ring.map((pair) => {
    const [longitude, latitude] = unprojectExplorationLocation(pair);
    return [Number(longitude.toFixed(6)), Number(latitude.toFixed(6))];
  })));
}

const features = places.map((place) => {
  const projected = projectedTerritory(place);
  const territory = projected.length
    ? polygonClipping.intersection(toLongitudeLatitude(projected), land)
    : [];
  if (!territory.length) return null;
  return {
    type: "Feature",
    properties: {
      id: place.id,
      category: place.category,
      weight: EXPLORATION_CATEGORY_WEIGHTS[place.category],
      kind: "estimated-territory",
    },
    geometry: { type: "MultiPolygon", coordinates: territory },
  };
}).filter(Boolean);

const asset = {
  type: "FeatureCollection",
  metadata: {
    algorithm: "multiplicatively-weighted-nearest-place",
    score: "projectedDistanceKmSquared/categoryWeight",
    categoryWeights: EXPLORATION_CATEGORY_WEIGHTS,
    circleSteps: CIRCLE_STEPS,
    activePlaceCount: places.length,
    territoryCount: features.length,
    note: "Display-only completion estimate; it does not represent land travelled, access, or ownership.",
  },
  features: [{
    type: "Feature",
    properties: { kind: "exploration-scope" },
    geometry: { type: "MultiPolygon", coordinates: land },
  }, ...features],
};
const serialized = `${JSON.stringify(asset)}\n`;

if (process.argv.includes("--check")) {
  const current = await readFile(fileURLToPath(outputUrl), "utf8").catch(() => "");
  if (current !== serialized) throw new Error("Exploration territory asset is stale; run npm run generate:exploration-territories");
  console.log(`Exploration territory asset is current (${features.length}/${places.length} places).`);
} else {
  await writeFile(fileURLToPath(outputUrl), serialized);
  console.log(`Generated smooth exploration territories for ${features.length}/${places.length} places.`);
}

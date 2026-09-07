import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import booleanValid from '@turf/boolean-valid';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const places = JSON.parse(fs.readFileSync(path.join(root, 'data', 'places.json'), 'utf8'));
const boundaryBuffer = fs.readFileSync(path.join(root, 'data', 'boundaries.geojson'));
const boundaries = JSON.parse(boundaryBuffer.toString('utf8'));
const audit = JSON.parse(fs.readFileSync(path.join(root, 'data', 'boundary-audit.json'), 'utf8'));
const topologyWarningIds = new Set((audit.topologyWarnings || []).map((warning) => warning.id));
const confirmedTopologyWarnings = new Set();

if (boundaries.type !== 'FeatureCollection' || !Array.isArray(boundaries.features)) throw new Error('boundaries.geojson must be a FeatureCollection');
if (boundaries.features.length !== places.length) throw new Error(`boundary/place count mismatch: ${boundaries.features.length}/${places.length}`);

const placesById = new Map(places.map((place) => [place.id, place]));
const ids = new Set();
let partCount = 0; let holeCount = 0; let positionCount = 0;

function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i]; const [xj, yj] = ring[j];
    if (((yi > y) !== (yj > y)) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function geometryContainsPoint(geometry, point) {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  return polygons.some((polygon) => pointInRing(point, polygon[0]) && !polygon.slice(1).some((hole) => pointInRing(point, hole)));
}

function ringArea(ring) {
  let area = 0;
  for (let i = 0; i < ring.length - 1; i += 1) area += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return area / 2;
}

for (let featureIndex = 0; featureIndex < boundaries.features.length; featureIndex += 1) {
  const feature = boundaries.features[featureIndex];
  if (feature.type !== 'Feature') throw new Error(`feature ${featureIndex}: invalid GeoJSON feature type`);
  const { id, name, category, sourceName, sourceUrl, sourceId } = feature.properties || {};
  if (!id || !name || !category || !sourceName || !sourceUrl || !sourceId) throw new Error(`feature ${featureIndex}: incomplete boundary properties`);
  if (ids.has(id)) throw new Error(`duplicate boundary id: ${id}`);
  ids.add(id);
  const place = placesById.get(id);
  if (!place) throw new Error(`boundary has no canonical place: ${id}`);
  if (name !== place.name || category !== place.category) throw new Error(`${id}: boundary identity differs from canonical place`);
  if (featureIndex && boundaries.features[featureIndex - 1].properties.id.localeCompare(id) >= 0) throw new Error('boundaries must be deterministically sorted by id');
  if (!URL.canParse(sourceUrl) || !sourceUrl.startsWith('https://')) throw new Error(`${id}: boundary sourceUrl must be HTTPS`);
  if (!['Polygon', 'MultiPolygon'].includes(feature.geometry?.type)) throw new Error(`${id}: boundary must be Polygon or MultiPolygon`);
  const polygons = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
  if (!polygons.length) throw new Error(`${id}: empty geometry`);
  if (sourceName !== 'OpenStreetMap contributors') {
    for (const coordinates of polygons) {
      const valid = booleanValid({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates } });
      if (!valid && !topologyWarningIds.has(id)) throw new Error(`${id}: undocumented polygon topology failure`);
      if (!valid) confirmedTopologyWarnings.add(id);
    }
  }
  partCount += polygons.length;
  for (const polygon of polygons) {
    if (!polygon.length) throw new Error(`${id}: polygon has no exterior ring`);
    holeCount += polygon.length - 1;
    for (const ring of polygon) {
      if (ring.length < 4) throw new Error(`${id}: ring has fewer than four positions`);
      positionCount += ring.length;
      const first = ring[0]; const last = ring.at(-1);
      if (first[0] !== last[0] || first[1] !== last[1]) throw new Error(`${id}: ring is not closed`);
      if (Math.abs(ringArea(ring)) < 1e-12) throw new Error(`${id}: ring has zero area`);
      for (const position of ring) {
        if (!Array.isArray(position) || position.length < 2 || !Number.isFinite(position[0]) || !Number.isFinite(position[1])) throw new Error(`${id}: invalid position`);
        if (position[0] < -180 || position[0] > 180 || position[1] < -90 || position[1] > 90) throw new Error(`${id}: position is outside WGS84 bounds`);
      }
    }
  }
  // Parks Canada catalogue pins are representative finder points and are not guaranteed
  // to land inside one of the many disjoint legislative parcels.
  if (category !== 'national' && id !== 'regional-bere-point-regional-park'
      && !geometryContainsPoint(feature.geometry, [place.longitude, place.latitude])) {
    throw new Error(`${id}: canonical pin is outside boundary geometry`);
  }
}

for (const place of places) if (!ids.has(place.id)) throw new Error(`canonical place has no boundary: ${place.id}`);
const nationalMinimumParts = new Map([
  ['national-pacific-rim-national-park-reserve', 10],
  ['national-gulf-islands-national-park-reserve', 40],
]);
for (const [id, minimum] of nationalMinimumParts) {
  const feature = boundaries.features.find((candidate) => candidate.properties.id === id);
  const parts = feature.geometry.type === 'Polygon' ? 1 : feature.geometry.coordinates.length;
  if (parts < minimum) throw new Error(`${id}: expected full multipart reserve boundary, found only ${parts} parts`);
  if (feature.properties.sourceName !== 'Natural Resources Canada — Canada Lands Survey System') throw new Error(`${id}: national boundary must use the federal legislative source`);
}

const islandFeatures = boundaries.features.filter((feature) => feature.properties.category === 'island');
if (islandFeatures.length !== 25) throw new Error(`expected 25 island boundaries, found ${islandFeatures.length}`);
for (const feature of islandFeatures) {
  const expectedObject = audit.islandSourceObjects?.[feature.properties.id];
  if (!expectedObject || feature.properties.sourceId !== expectedObject) throw new Error(`${feature.properties.id}: OSM geographic identity does not match the reviewed object`);
  if (!/^R\d+$/.test(feature.properties.sourceId)) throw new Error(`${feature.properties.id}: island must resolve to a reviewed OSM coastline relation`);
}

if (audit.placeCount !== places.length || audit.featureCount !== boundaries.features.length) throw new Error('boundary audit count mismatch');
if (audit.missingIds?.length || audit.duplicateIds?.length) throw new Error('boundary audit reports missing or duplicate IDs');
if (audit.sourceTopologyPreserved !== true) throw new Error('boundary audit does not confirm source part/hole preservation');
for (const id of topologyWarningIds) if (!confirmedTopologyWarnings.has(id)) throw new Error(`${id}: stale topology warning`);
if (audit.totalParts !== partCount || audit.totalHoles !== holeCount || audit.totalPositions !== positionCount) throw new Error('boundary audit geometry totals mismatch');
if (audit.sourceParts !== partCount || audit.sourceHoles !== holeCount) throw new Error('source parts or holes were lost from the serialized artifact');
if (audit.payloadBytes !== boundaryBuffer.length) throw new Error('boundary audit payload size mismatch');
if (boundaryBuffer.length > 5_000_000) throw new Error(`boundary payload exceeds 5 MB mobile budget: ${boundaryBuffer.length}`);

console.log(`Validated ${ids.size} boundaries, ${partCount} parts, ${holeCount} holes; ${boundaryBuffer.length} bytes raw / ${gzipSync(boundaryBuffer).length} bytes gzip.`);

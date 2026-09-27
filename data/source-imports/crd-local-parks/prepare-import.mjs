import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { classifyBcRegion } from '../../../scripts/bc-regions.mjs';
import polygonClipping from 'polygon-clipping';

const here = path.dirname(fileURLToPath(import.meta.url));
const manifestPath = path.join(here, 'import-manifest.json');
const snapshotPath = path.join(here, 'crd-municipal-community-source.geojson');
const officialSnapshotPath = path.join(here, 'official-boundary-crosschecks.geojson');

const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
const snapshotBytes = await fs.readFile(snapshotPath);
const actualSnapshotSha256 = createHash('sha256').update(snapshotBytes).digest('hex');
if (actualSnapshotSha256 !== manifest.sourceSnapshot.sha256) {
  throw new Error('CRD source snapshot hash differs from import-manifest.json');
}
const officialSnapshotBytes = await fs.readFile(officialSnapshotPath);
const actualOfficialSha256 = createHash('sha256').update(officialSnapshotBytes).digest('hex');
if (actualOfficialSha256 !== manifest.officialBoundaryReview.snapshotSha256) {
  throw new Error('Official boundary review snapshot hash differs from import-manifest.json');
}

const snapshot = JSON.parse(snapshotBytes.toString('utf8'));
if (snapshot.type !== 'FeatureCollection' || snapshot.features?.length !== manifest.sourceSnapshot.featureCount) {
  throw new Error('Frozen CRD source snapshot does not match its reviewed FeatureCollection count');
}
const byObjectId = new Map();
for (const feature of snapshot.features) {
  const objectId = Number(feature.properties?.OBJECTID);
  if (!Number.isInteger(objectId) || byObjectId.has(objectId)) throw new Error('CRD snapshot has a missing or duplicate OBJECTID');
  byObjectId.set(objectId, feature);
}

const categoryByType = new Map([['Municipal Park', 'municipal'], ['Community Park', 'community']]);
const dispositionIds = new Set();
const includedIds = new Set();
const placeIds = new Set();
const includedPlaces = [];
const boundaryFeatures = [];
const descriptionEntries = {};
const geometryAudit = [];

for (const entry of manifest.entries) {
  if (!Array.isArray(entry.sourceObjectIds) || entry.sourceObjectIds.length === 0) {
    throw new Error('Every manifest entry must list at least one CRD source OBJECTID');
  }
  if (!Array.isArray(entry.sourceNames) || entry.sourceNames.length !== entry.sourceObjectIds.length) {
    throw new Error('Every manifest entry must list one source name per source OBJECTID');
  }
  const sortedObjectIds = [...entry.sourceObjectIds].map(Number).sort((a, b) => a - b);
  if (JSON.stringify(sortedObjectIds) !== JSON.stringify(entry.sourceObjectIds)) {
    throw new Error('Manifest sourceObjectIds must be sorted numeric OBJECTIDs');
  }
  const sourceFeatures = entry.sourceObjectIds.map((objectId, index) => {
    if (dispositionIds.has(objectId)) throw new Error('CRD OBJECTID appears in more than one manifest disposition: ' + objectId);
    dispositionIds.add(objectId);
    const feature = byObjectId.get(objectId);
    if (!feature) throw new Error('Manifest references missing source OBJECTID ' + objectId);
    const properties = feature.properties ?? {};
    if (properties.Type !== entry.sourceType || properties.Jurisdic !== entry.jurisdiction
        || properties.Name !== entry.sourceNames[index]) {
      throw new Error('Manifest source identity changed for OBJECTID ' + objectId);
    }
    if (!categoryByType.has(properties.Type) || categoryByType.get(properties.Type) !== entry.category) {
      throw new Error('Manifest category does not match source Type for OBJECTID ' + objectId);
    }
    if (properties.LifeCycleStatus !== 'ACT') throw new Error('Included source candidate is no longer active: ' + objectId);
    return feature;
  });
  if (!['include', 'hold', 'exclude'].includes(entry.disposition)) throw new Error('Unknown import disposition');
  if (entry.disposition !== 'include') {
    if (entry.id !== null) throw new Error('Held or excluded entry must not have an import ID: ' + entry.name);
    continue;
  }
  if (!entry.id || placeIds.has(entry.id)) throw new Error('Included place ID is missing or duplicated: ' + entry.id);
  placeIds.add(entry.id);
  for (const objectId of entry.sourceObjectIds) includedIds.add(objectId);

  const geometry = unionSourceGeometry(sourceFeatures);
  const representative = geometryRepresentative(geometry);
  const region = classifyBcRegion(representative.longitude, representative.latitude);
  const jurisdiction = entry.jurisdiction.trim();
  const sourceName = jurisdiction + ' (CRD Park GIS)';
  const sourceUrl = manifest.sourceLayer;
  const sourceId = String(entry.sourceObjectIds[0]);
  const verb = entry.category === 'municipal' ? 'municipal park' : 'community park';
  const description = entry.name + ' is a ' + verb + ' in ' + readableJurisdiction(jurisdiction) + '.';
  const place = {
    id: entry.id,
    name: entry.name,
    category: entry.category,
    latitude: representative.latitude,
    longitude: representative.longitude,
    region,
    description,
    sourceUrl,
    sourceName,
    sourceId,
  };
  includedPlaces.push(place);

  boundaryFeatures.push({
    type: 'Feature',
    geometry,
    properties: {
      id: entry.id,
      name: entry.name,
      category: entry.category,
      sourceName,
      sourceUrl,
      sourceId,
      sourceObjectIds: entry.sourceObjectIds,
      sourceNames: entry.sourceNames,
      sourceType: entry.sourceType,
      jurisdiction: entry.jurisdiction,
    },
  });

  descriptionEntries[entry.id] = {
    status: 'source-derived',
    description,
    sourceName,
    sourceTitle: entry.name,
    sourceUrl,
    sourceSection: 'Name, classification, jurisdiction and mapped polygon fields',
    reviewedAt: manifest.sourceSnapshot.retrievedAtUtc.slice(0, 10),
  };
  geometryAudit.push(summarizeGeometry(entry, sourceFeatures, geometry));
}

if (dispositionIds.size !== byObjectId.size || [...byObjectId.keys()].some((objectId) => !dispositionIds.has(objectId))) {
  throw new Error('Manifest must account for every source snapshot OBJECTID exactly once');
}
const expected = manifest.dispositionCounts.sourceFeatures;
for (const disposition of ['include', 'hold', 'exclude']) {
  const actual = manifest.entries.filter((entry) => entry.disposition === disposition)
    .reduce((sum, entry) => sum + entry.sourceObjectIds.length, 0);
  if (actual !== expected[disposition]) throw new Error('Manifest disposition count mismatch for ' + disposition);
}
if (includedPlaces.length !== manifest.dispositionCounts.entries.include
    || includedIds.size !== expected.include) {
  throw new Error('Generated place count differs from the reviewed manifest');
}

includedPlaces.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name, 'en-CA'));
boundaryFeatures.sort((a, b) => a.properties.id.localeCompare(b.properties.id));
const placesOutput = `${JSON.stringify(includedPlaces, null, 2)}\n`;
const boundariesOutput = `${JSON.stringify({ type: 'FeatureCollection', features: boundaryFeatures }, null, 2)}\n`;
const descriptionsOutput = `${JSON.stringify({
  checkedAt: manifest.sourceSnapshot.retrievedAtUtc.slice(0, 10),
  descriptionMethod: 'Source-derived municipal/community designation and jurisdiction; no visitor activity claims.',
  entries: Object.fromEntries(Object.entries(descriptionEntries).sort(([a], [b]) => a.localeCompare(b))),
}, null, 2)}\n`;

const geometryUnionAudit = geometryAudit.filter((item) => item.sourceFeatureCount > 1);
const importAudit = {
  schemaVersion: 1,
  sourceLayer: manifest.sourceLayer,
  sourceSnapshot: manifest.sourceSnapshot,
  manifestFile: 'import-manifest.json',
  officialBoundaryReview: manifest.officialBoundaryReview,
  counts: {
    sourceFeatures: byObjectId.size,
    manifestEntries: manifest.entries.length,
    includedPlaces: includedPlaces.length,
    includedSourceFeatures: includedIds.size,
    heldEntries: manifest.dispositionCounts.entries.hold,
    heldSourceFeatures: expected.hold,
    excludedEntries: manifest.dispositionCounts.entries.exclude,
    excludedSourceFeatures: expected.exclude,
    generatedBoundaries: boundaryFeatures.length,
    generatedDescriptions: Object.keys(descriptionEntries).length,
  },
  existingCanonicalIdentity: manifest.existingCanonicalIdentity,
  boundaryConstruction: {
    operation: 'polygon-clipping union of original CRD GeoJSON coordinates for each approved multi-OBJECTID manifest entry; singleton geometry is copied unchanged',
    noBufferOrHull: true,
    sourcePartsAndHolesPreserved: true,
    groupCount: geometryUnionAudit.length,
    groups: geometryUnionAudit,
  },
  representativePointChecks: {
    method: 'interior representative point of the largest polygon part, rounded to six decimal places and checked against rings and holes',
    checkedPlaces: includedPlaces.length,
    allInsideOutputBoundary: true,
  },
  outputFiles: {
    places: 'places.json',
    boundaries: 'boundaries.geojson',
    descriptions: 'descriptions.catalogue.json',
  },
  dispositions: manifest.entries.filter((entry) => entry.disposition !== 'include')
    .map(({ id, name, category, jurisdiction, sourceObjectIds, disposition, reason }) => ({
      id, name, category, jurisdiction, sourceObjectIds, disposition, reason,
    })),
};
const auditOutput = `${JSON.stringify(importAudit, null, 2)}\n`;

await writeOrCheck('places.json', placesOutput);
await writeOrCheck('boundaries.geojson', boundariesOutput);
await writeOrCheck('descriptions.catalogue.json', descriptionsOutput);
await writeOrCheck('import-audit.json', auditOutput);
console.log('Prepared ' + includedPlaces.length + ' CRD municipal/community places and boundaries.');
console.log('Included source polygons: ' + includedIds.size + '; held: ' + expected.hold + '; excluded: ' + expected.exclude + '.');

async function writeOrCheck(name, content) {
  const outputPath = path.join(here, name);
  if (process.argv.includes('--check')) {
    const existing = await fs.readFile(outputPath, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') throw new Error(name + ' has not been generated yet');
      throw error;
    });
    if (existing !== content) throw new Error(name + ' is stale; rerun prepare-import.mjs');
    return;
  }
  await fs.writeFile(outputPath, content, 'utf8');
}

function unionSourceGeometry(features) {
  const geometries = features.map((feature) => feature.geometry);
  if (geometries.some((geometry) => !geometry || !['Polygon', 'MultiPolygon'].includes(geometry.type))) {
    throw new Error('Only Polygon and MultiPolygon CRD source geometries are accepted');
  }
  if (geometries.length === 1) return structuredClone(geometries[0]);
  const multiPolygons = geometries.map((geometry) => geometry.type === 'Polygon'
    ? [geometry.coordinates]
    : geometry.coordinates);
  const unioned = polygonClipping.union(...multiPolygons);
  if (!unioned.length) throw new Error('Polygon union returned an empty geometry');
  return unioned.length === 1
    ? { type: 'Polygon', coordinates: unioned[0] }
    : { type: 'MultiPolygon', coordinates: unioned };
}

function summarizeGeometry(entry, sourceFeatures, geometry) {
  const sourceParts = sourceFeatures.reduce((sum, feature) => sum + polygonCount(feature.geometry), 0);
  const sourceHoles = sourceFeatures.reduce((sum, feature) => sum + holeCount(feature.geometry), 0);
  const sourceAreaSum = sourceFeatures.reduce((sum, feature) => sum + sphericalGeometryArea(feature.geometry), 0);
  const unionArea = sphericalGeometryArea(geometry);
  const tolerance = Math.max(2, sourceAreaSum * 0.000001);
  if (unionArea > sourceAreaSum + tolerance) {
    throw new Error('Union area exceeds the sum of input areas for ' + entry.id);
  }
  return {
    id: entry.id,
    sourceObjectIds: entry.sourceObjectIds,
    sourceNames: entry.sourceNames,
    sourceFeatureCount: sourceFeatures.length,
    sourcePolygonParts: sourceParts,
    outputPolygonParts: polygonCount(geometry),
    sourceHoleCount: sourceHoles,
    outputHoleCount: holeCount(geometry),
    sourceAreaSumSqM: roundAudit(sourceAreaSum),
    unionAreaSqM: roundAudit(unionArea),
    overlappingAreaRemovedSqM: roundAudit(Math.max(0, sourceAreaSum - unionArea)),
    unionWithinSourceArea: unionArea <= sourceAreaSum + tolerance,
    unionRecipe: sourceFeatures.length === 1 ? 'copy original source geometry' : 'polygon-clipping.union of original source geometries',
  };
}

function polygonCount(geometry) {
  return geometry.type === 'Polygon' ? 1 : geometry.coordinates.length;
}

function holeCount(geometry) {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  return polygons.reduce((sum, polygon) => sum + Math.max(0, polygon.length - 1), 0);
}

function sphericalRingArea(ring) {
  const earthRadiusM = 6371008.8;
  let total = 0;
  for (let index = 0; index < ring.length - 1; index += 1) {
    const [longitude1, latitude1] = ring[index];
    const [longitude2, latitude2] = ring[index + 1];
    const deltaLongitude = (longitude2 - longitude1) * Math.PI / 180;
    const phi1 = latitude1 * Math.PI / 180;
    const phi2 = latitude2 * Math.PI / 180;
    total += deltaLongitude * (2 + Math.sin(phi1) + Math.sin(phi2));
  }
  return Math.abs(total * earthRadiusM * earthRadiusM / 2);
}

function sphericalGeometryArea(geometry) {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  return polygons.reduce((sum, polygon) => {
    const outer = sphericalRingArea(polygon[0]);
    const holes = polygon.slice(1).reduce((holeSum, ring) => holeSum + sphericalRingArea(ring), 0);
    return sum + outer - holes;
  }, 0);
}

function roundAudit(value) {
  return Number(value.toFixed(2));
}

function readableJurisdiction(jurisdiction) {
  if (jurisdiction === 'Islands Trust') return 'the Islands Trust area';
  if (/^(City|District|Town|Township|Village) of /.test(jurisdiction) || /Electoral Area/.test(jurisdiction)) {
    return 'the ' + jurisdiction;
  }
  return jurisdiction;
}

function roundPoint(value) {
  return Number(value.toFixed(6));
}

function pointInRing([longitude, latitude], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const crosses = ((yi > latitude) !== (yj > latitude))
      && longitude < ((xj - xi) * (latitude - yi)) / (yj - yi) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

function pointInPolygon(point, polygon) {
  return pointInRing(point, polygon[0]) && !polygon.slice(1).some((hole) => pointInRing(point, hole));
}

function ringCentroid(ring) {
  let twiceArea = 0;
  let longitude = 0;
  let latitude = 0;
  for (let index = 0; index < ring.length - 1; index += 1) {
    const [longitude1, latitude1] = ring[index];
    const [longitude2, latitude2] = ring[index + 1];
    const cross = longitude1 * latitude2 - longitude2 * latitude1;
    twiceArea += cross;
    longitude += (longitude1 + longitude2) * cross;
    latitude += (latitude1 + latitude2) * cross;
  }
  if (!twiceArea) return { area: 0, longitude: ring[0][0], latitude: ring[0][1] };
  return {
    area: Math.abs(twiceArea / 2),
    longitude: longitude / (3 * twiceArea),
    latitude: latitude / (3 * twiceArea),
  };
}

function scanlineInteriorPoint(polygon) {
  const yValues = [...new Set(polygon.flat().map(([, latitude]) => latitude))].sort((a, b) => a - b);
  let best = null;
  for (let index = 0; index < yValues.length - 1; index += 1) {
    if (yValues[index + 1] <= yValues[index]) continue;
    const latitude = (yValues[index] + yValues[index + 1]) / 2;
    const intersections = [];
    for (const ring of polygon) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [longitude1, latitude1] = ring[j];
        const [longitude2, latitude2] = ring[i];
        if ((latitude1 > latitude) !== (latitude2 > latitude)) {
          intersections.push(longitude1 + ((latitude - latitude1) * (longitude2 - longitude1)) / (latitude2 - latitude1));
        }
      }
    }
    intersections.sort((a, b) => a - b);
    for (let part = 0; part + 1 < intersections.length; part += 2) {
      const width = intersections[part + 1] - intersections[part];
      if (width > 0 && (!best || width > best.width)) {
        best = { longitude: (intersections[part] + intersections[part + 1]) / 2, latitude, width };
      }
    }
  }
  if (!best || !pointInPolygon([best.longitude, best.latitude], polygon)) {
    throw new Error('Could not find a guaranteed interior pin point');
  }
  return best;
}

function geometryRepresentative(geometry) {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  const largest = polygons.map((polygon) => ({ polygon, centroid: ringCentroid(polygon[0]) }))
    .sort((a, b) => b.centroid.area - a.centroid.area)[0];
  if (!largest) throw new Error('Cannot find an interior point for an empty geometry');
  const centroidPoint = [largest.centroid.longitude, largest.centroid.latitude];
  const representative = pointInPolygon(centroidPoint, largest.polygon)
    ? largest.centroid
    : { ...scanlineInteriorPoint(largest.polygon), area: largest.centroid.area };
  const rounded = { longitude: roundPoint(representative.longitude), latitude: roundPoint(representative.latitude) };
  if (!pointInPolygon([rounded.longitude, rounded.latitude], largest.polygon)) {
    const interior = scanlineInteriorPoint(largest.polygon);
    rounded.longitude = roundPoint(interior.longitude);
    rounded.latitude = roundPoint(interior.latitude);
    if (!pointInPolygon([rounded.longitude, rounded.latitude], largest.polygon)) {
      throw new Error('Rounded representative point falls outside the output polygon');
    }
  }
  return rounded;
}

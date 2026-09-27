import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const CRD_LOCAL_PARKS_SOURCE_URL = 'https://mapservices.crd.bc.ca/arcgis/rest/services/Basemap/Basemap/MapServer/3';
export const CRD_REGIONAL_SOURCE_NAME = `Capital Regional District ${String.fromCharCode(0x2014)} Park GIS layer`;
export const CRD_LOCAL_PARKS_SOURCE_DIRECTORY = path.join('data', 'source-imports', 'crd-local-parks');
export const CRD_LOCAL_PARK_CATEGORIES = Object.freeze(['municipal', 'community']);
export const PLACE_CATEGORIES = Object.freeze(['national', 'provincial', 'regional', 'island', ...CRD_LOCAL_PARK_CATEGORIES]);

const importedFiles = Object.freeze({
  manifest: 'import-manifest.json',
  places: 'places.json',
  boundaries: 'boundaries.geojson',
  descriptions: 'descriptions.catalogue.json',
  audit: 'import-audit.json',
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sourceNameFor(jurisdiction) {
  return `${jurisdiction.trim()} (CRD Park GIS)`;
}

function normalizedObjectIds(value, label) {
  assert(Array.isArray(value) && value.length > 0, `${label}: expected at least one source object id`);
  const ids = value.map((id) => Number(id));
  assert(ids.every((id) => Number.isSafeInteger(id) && id > 0), `${label}: source object ids must be positive integers`);
  assert(new Set(ids).size === ids.length, `${label}: duplicate source object ids`);
  const sorted = [...ids].sort((a, b) => a - b);
  assert(sameJson(ids, sorted), `${label}: source object ids must be numerically sorted`);
  return sorted;
}

function geometryPositionCount(geometry) {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  let parts = 0;
  let holes = 0;
  let positions = 0;
  for (const polygon of polygons) {
    assert(Array.isArray(polygon) && polygon.length > 0, 'boundary geometry: empty polygon');
    parts += 1;
    holes += polygon.length - 1;
    for (const ring of polygon) {
      assert(Array.isArray(ring) && ring.length >= 4, 'boundary geometry: ring must have at least four positions');
      for (const position of ring) {
        assert(Array.isArray(position) && position.length >= 2
          && Number.isFinite(position[0]) && Number.isFinite(position[1]), 'boundary geometry: invalid coordinate');
      }
      assert(sameJson(ring[0], ring.at(-1)), 'boundary geometry: ring is not closed');
      positions += ring.length;
    }
  }
  return { parts, holes, positions };
}

function entriesById(manifest) {
  return new Map(manifest.entries.filter((entry) => entry.disposition === 'include').map((entry) => [entry.id, entry]));
}

function validateDescription(entry, place, id) {
  assert(isRecord(entry), `descriptions.catalogue.json: missing entry for ${id}`);
  assert(entry.status === 'source-derived', `descriptions.catalogue.json: invalid status for ${id}`);
  assert(typeof entry.description === 'string' && entry.description.trim().length >= 20,
    `descriptions.catalogue.json: missing factual description for ${id}`);
  assert(entry.sourceName === place.sourceName, `descriptions.catalogue.json: source name mismatch for ${id}`);
  assert(entry.sourceTitle === place.name, `descriptions.catalogue.json: source title mismatch for ${id}`);
  assert(entry.sourceUrl === CRD_LOCAL_PARKS_SOURCE_URL, `descriptions.catalogue.json: source URL mismatch for ${id}`);
  assert(typeof entry.sourceSection === 'string' && entry.sourceSection.trim(), `descriptions.catalogue.json: missing source section for ${id}`);
  assert(/^\d{4}-\d{2}-\d{2}$/.test(entry.reviewedAt ?? ''), `descriptions.catalogue.json: invalid review date for ${id}`);
  assert(entry.description === place.description, `descriptions.catalogue.json: description mismatch for ${id}`);
}

function validateImportAudit(manifest, places, boundaries, descriptions, audit, sourceFeatureCount) {
  const dispositionCounts = { entries: {}, sourceFeatures: {} };
  for (const disposition of ['include', 'hold', 'exclude']) {
    const entries = manifest.entries.filter((entry) => entry.disposition === disposition);
    dispositionCounts.entries[disposition] = entries.length;
    dispositionCounts.sourceFeatures[disposition] = entries.reduce((sum, entry) => sum + entry.sourceObjectIds.length, 0);
  }
  assert(sameJson(manifest.dispositionCounts, dispositionCounts), 'import-manifest.json: disposition counts are stale');
  assert(audit.schemaVersion === 1 && audit.sourceLayer === manifest.sourceLayer
    && audit.sourceSnapshot?.sha256 === manifest.sourceSnapshot.sha256,
  'import-audit.json: frozen source identity differs from the manifest');
  assert(audit.counts?.sourceFeatures === sourceFeatureCount
    && audit.counts.manifestEntries === manifest.entries.length
    && audit.counts.includedPlaces === places.length
    && audit.counts.includedSourceFeatures === dispositionCounts.sourceFeatures.include
    && audit.counts.heldEntries === dispositionCounts.entries.hold
    && audit.counts.heldSourceFeatures === dispositionCounts.sourceFeatures.hold
    && audit.counts.excludedEntries === dispositionCounts.entries.exclude
    && audit.counts.excludedSourceFeatures === dispositionCounts.sourceFeatures.exclude
    && audit.counts.generatedBoundaries === boundaries.features.length
    && audit.counts.generatedDescriptions === Object.keys(descriptions.entries).length,
  'import-audit.json: disposition or output counts are stale');
  const construction = audit.boundaryConstruction;
  assert(isRecord(construction) && construction.noBufferOrHull === true
    && construction.sourcePartsAndHolesPreserved === true && Array.isArray(construction.groups),
  'import-audit.json: boundary construction evidence is incomplete');
  const expectedGroups = manifest.entries.filter((entry) => entry.disposition === 'include' && entry.sourceObjectIds.length > 1);
  assert(construction.groupCount === expectedGroups.length && construction.groups.length === expectedGroups.length,
    'import-audit.json: union group count differs from manifest');
  const groupsById = new Map(construction.groups.map((group) => [group.id, group]));
  const boundariesById = new Map(boundaries.features.map((feature) => [feature.properties.id ?? feature.properties.placeId, feature]));
  for (const entry of expectedGroups) {
    const group = groupsById.get(entry.id);
    const feature = boundariesById.get(entry.id);
    const outputMetrics = feature ? geometryPositionCount(feature.geometry) : null;
    assert(group && sameJson(group.sourceObjectIds, entry.sourceObjectIds)
      && sameJson(group.sourceNames, entry.sourceNames)
      && group.sourceFeatureCount === entry.sourceObjectIds.length
      && outputMetrics && group.outputPolygonParts === outputMetrics.parts
      && group.outputHoleCount === outputMetrics.holes
      && group.unionWithinSourceArea === true
      && Number.isFinite(group.sourceAreaSumSqM) && Number.isFinite(group.unionAreaSqM)
      && group.unionAreaSqM <= group.sourceAreaSumSqM + Math.max(2, group.sourceAreaSumSqM * 0.000001),
    `${entry.id}: union audit does not match the approved source group`);
  }
  assert(audit.representativePointChecks?.checkedPlaces === places.length
    && audit.representativePointChecks.allInsideOutputBoundary === true,
  'import-audit.json: representative point evidence is incomplete');
}

export function validateCrdLocalParksArtifacts({ manifest, places, boundaries, descriptions, audit, sourceSnapshot, sourceSnapshotSha256 }) {
  assert(isRecord(manifest) && manifest.schemaVersion === 1 && Array.isArray(manifest.entries),
    'import-manifest.json: expected schemaVersion 1 and entries[]');
  assert(isRecord(manifest.sourceSnapshot) && /^[a-f0-9]{64}$/i.test(manifest.sourceSnapshot.sha256 ?? ''),
    'import-manifest.json: expected frozen sourceSnapshot.sha256');
  assert(manifest.sourceLayer === CRD_LOCAL_PARKS_SOURCE_URL,
    'import-manifest.json: source layer differs from the reviewed CRD layer');
  assert(isRecord(sourceSnapshot) && Array.isArray(sourceSnapshot.features),
    'crd-municipal-community-source.geojson: expected a source FeatureCollection');
  assert(sourceSnapshotSha256 === manifest.sourceSnapshot.sha256,
    'crd-municipal-community-source.geojson: SHA-256 differs from the reviewed import manifest');
  assert(manifest.sourceSnapshot.featureCount === sourceSnapshot.features.length,
    'import-manifest.json: source snapshot feature count differs from the frozen source');
  assert(Array.isArray(places), 'places.json: expected an array');
  assert(isRecord(boundaries) && boundaries.type === 'FeatureCollection' && Array.isArray(boundaries.features),
    'boundaries.geojson: expected a FeatureCollection');
  assert(isRecord(descriptions) && isRecord(descriptions.entries), 'descriptions.catalogue.json: expected entries object');
  assert(isRecord(audit), 'import-audit.json: expected an object');

  const seenIds = new Set();
  const seenSourceIds = new Set();
  const sourceFeaturesById = new Map();
  for (const feature of sourceSnapshot.features) {
    const properties = feature?.properties;
    const sourceObjectId = Number(properties?.OBJECTID);
    assert(Number.isSafeInteger(sourceObjectId) && sourceObjectId > 0, 'source snapshot: invalid OBJECTID');
    assert(!sourceFeaturesById.has(sourceObjectId), `source snapshot: duplicate OBJECTID ${sourceObjectId}`);
    sourceFeaturesById.set(sourceObjectId, feature);
  }
  assert(sourceFeaturesById.size > 0, 'source snapshot: no park features');
  for (const entry of manifest.entries) {
    assert(isRecord(entry), 'import-manifest.json: invalid entry');
    assert(entry.id === null || entry.id === undefined || (typeof entry.id === 'string' && entry.id),
      'import-manifest.json: invalid entry id');
    assert(typeof entry.name === 'string' && entry.name.trim(), `${entry.id}: missing manifest name`);
    assert(CRD_LOCAL_PARK_CATEGORIES.includes(entry.category), `${entry.id}: invalid local park category`);
    assert(typeof entry.jurisdiction === 'string' && entry.jurisdiction.trim(), `${entry.id}: missing jurisdiction`);
    assert(entry.sourceType === (entry.category === 'municipal' ? 'Municipal Park' : 'Community Park'),
      `${entry.id}: source type and category do not match`);
    assert(['include', 'exclude', 'hold'].includes(entry.disposition), `${entry.id}: invalid disposition`);
    if (entry.disposition === 'include') assert(typeof entry.id === 'string' && entry.id, 'included manifest entry is missing id');
    const sourceObjectIds = normalizedObjectIds(entry.sourceObjectIds, entry.id);
    assert(Array.isArray(entry.sourceNames) && entry.sourceNames.length > 0
      && entry.sourceNames.every((name) => typeof name === 'string' && name.trim()), `${entry.id}: missing source name provenance`);
    const sourceNames = [];
    for (const [sourceIndex, objectId] of sourceObjectIds.entries()) {
      assert(!seenSourceIds.has(objectId), `${entry.id}: CRD object ${objectId} is assigned to more than one manifest entry`);
      seenSourceIds.add(objectId);
      const sourceFeature = sourceFeaturesById.get(objectId);
      assert(sourceFeature, `${entry.id}: source object ${objectId} is absent from the frozen CRD snapshot`);
      assert(sourceFeature.properties.Type === entry.sourceType, `${entry.id}: CRD object ${objectId} has a different source type`);
      assert(sourceFeature.properties.Jurisdic === entry.jurisdiction, `${entry.id}: CRD object ${objectId} has a different jurisdiction`);
      assert(typeof sourceFeature.properties.Name === 'string' && sourceFeature.properties.Name.trim(),
        `${entry.id}: CRD object ${objectId} is missing its source name`);
      assert(sourceFeature.properties.Name === entry.sourceNames[sourceIndex],
        `${entry.id}: CRD object ${objectId} has a different manifest source name`);
      sourceNames.push(sourceFeature.properties.Name);
    }
    assert(sameJson(sourceNames, entry.sourceNames), `${entry.id}: source name provenance differs from the frozen CRD snapshot`);
    if (entry.disposition !== 'include') continue;
    assert(!seenIds.has(entry.id), `import-manifest.json: duplicate included id ${entry.id}`);
    seenIds.add(entry.id);
  }
  assert(seenSourceIds.size === sourceFeaturesById.size,
    'import-manifest.json: source entries do not cover every frozen source feature');
  for (const sourceObjectId of sourceFeaturesById.keys()) {
    assert(seenSourceIds.has(sourceObjectId), `import-manifest.json: source object ${sourceObjectId} has no disposition`);
  }
  assert(isRecord(manifest.dispositionCounts), 'import-manifest.json: missing disposition counts');
  const existingCanonicalIdentity = manifest.existingCanonicalIdentity;
  if (existingCanonicalIdentity) {
    assert(Number.isSafeInteger(Number(existingCanonicalIdentity.sourceObjectId))
      && typeof existingCanonicalIdentity.placeId === 'string' && existingCanonicalIdentity.placeId,
    'import-manifest.json: invalid existing CRD canonical identity');
    assert(typeof existingCanonicalIdentity.action === 'string' && /exclude/i.test(existingCanonicalIdentity.action),
      'import-manifest.json: existing CRD canonical identity must be excluded from the new import');
    const existingSourceId = Number(existingCanonicalIdentity.sourceObjectId);
    const matchingEntries = manifest.entries.filter((entry) => entry.sourceObjectIds.some((id) => Number(id) === existingSourceId));
    assert(matchingEntries.length === 1 && matchingEntries[0].disposition !== 'include',
      `CRD source object ${existingSourceId}: existing canonical identity cannot be included again`);
    assert(matchingEntries[0].id !== existingCanonicalIdentity.placeId,
      `CRD source object ${existingSourceId}: existing canonical place id must remain outside the import`);
  }

  const expected = entriesById(manifest);
  const placesById = new Map();
  for (const place of places) {
    assert(isRecord(place) && typeof place.id === 'string', 'places.json: invalid place record');
    assert(!placesById.has(place.id), `places.json: duplicate id ${place.id}`);
    placesById.set(place.id, place);
  }
  assert(placesById.size === expected.size, 'places.json: included record count differs from import manifest');

  const boundaryById = new Map();
  for (const feature of boundaries.features) {
    const properties = feature?.properties;
    assert(isRecord(properties), 'boundaries.geojson: feature is missing properties');
    const id = properties.id ?? properties.placeId;
    assert(typeof id === 'string' && id, 'boundaries.geojson: feature is missing id');
    assert(!boundaryById.has(id), `boundaries.geojson: duplicate id ${id}`);
    assert(feature.type === 'Feature' && isRecord(feature.geometry)
      && ['Polygon', 'MultiPolygon'].includes(feature.geometry.type), `${id}: unsupported boundary geometry`);
    geometryPositionCount(feature.geometry);
    boundaryById.set(id, feature);
  }
  assert(boundaryById.size === expected.size, 'boundaries.geojson: included record count differs from import manifest');
  assert(Object.keys(descriptions.entries).length === expected.size,
    'descriptions.catalogue.json: included record count differs from import manifest');

  for (const [id, manifestEntry] of expected) {
    const place = placesById.get(id);
    const feature = boundaryById.get(id);
    assert(place && feature, `${id}: missing included place or boundary`);
    assert(place.name === manifestEntry.name, `${id}: place name differs from manifest`);
    assert(place.category === manifestEntry.category, `${id}: place category differs from manifest`);
    assert(place.sourceName === sourceNameFor(manifestEntry.jurisdiction), `${id}: place source name differs from jurisdiction`);
    assert(place.sourceUrl === CRD_LOCAL_PARKS_SOURCE_URL, `${id}: place source URL differs from CRD layer`);
    assert(String(place.sourceId) === String(manifestEntry.sourceObjectIds[0]), `${id}: place source id differs from manifest`);
    assert(typeof place.description === 'string' && place.description.trim(), `${id}: missing place description`);
    assert(Number.isFinite(place.latitude) && Number.isFinite(place.longitude), `${id}: invalid representative point`);
    assert(typeof place.region === 'string' && place.region.trim(), `${id}: missing region`);

    const properties = feature.properties;
    assert(properties.id === undefined || properties.id === id, `${id}: boundary id mismatch`);
    assert(properties.placeId === undefined || properties.placeId === id, `${id}: boundary place id mismatch`);
    assert(properties.name === undefined || properties.name === place.name, `${id}: boundary name mismatch`);
    assert(properties.category === undefined || properties.category === place.category, `${id}: boundary category mismatch`);
    assert(properties.jurisdiction === manifestEntry.jurisdiction, `${id}: boundary jurisdiction mismatch`);
    assert(properties.sourceType === manifestEntry.sourceType, `${id}: boundary source type mismatch`);
    assert(properties.sourceName === place.sourceName, `${id}: boundary source name mismatch`);
    assert(properties.sourceUrl === CRD_LOCAL_PARKS_SOURCE_URL, `${id}: boundary source URL mismatch`);
    assert(String(properties.sourceId) === String(manifestEntry.sourceObjectIds[0]), `${id}: boundary source id mismatch`);
    assert(sameJson(normalizedObjectIds(properties.sourceObjectIds, `${id} boundary`), manifestEntry.sourceObjectIds),
      `${id}: boundary source objects differ from manifest`);
    assert(Array.isArray(properties.sourceNames)
      && sameJson([...new Set(properties.sourceNames)].sort(), [...new Set(manifestEntry.sourceNames)].sort()),
    `${id}: boundary source names differ from manifest`);
    validateDescription(descriptions.entries[id], place, id);
  }
  validateImportAudit(manifest, places, boundaries, descriptions, audit, sourceFeaturesById.size);

  return { manifest, places, boundaries, descriptions, audit, entriesById: expected };
}

export function canonicalizeCrdLocalParkBoundaryFeature(feature) {
  const id = feature?.properties?.id ?? feature?.properties?.placeId;
  assert(typeof id === 'string' && id, 'CRD local park boundary is missing id');
  return feature.properties.id === id ? feature : {
    ...feature,
    properties: { ...feature.properties, id },
  };
}

export async function loadCrdLocalParksImport({ root = repositoryRoot } = {}) {
  const directory = path.join(root, CRD_LOCAL_PARKS_SOURCE_DIRECTORY);
  const parsed = {};
  for (const [key, filename] of Object.entries(importedFiles)) {
    const content = await fs.readFile(path.join(directory, filename), 'utf8');
    parsed[key] = JSON.parse(content);
  }
  const sourceSnapshotContent = await fs.readFile(path.join(directory, 'crd-municipal-community-source.geojson'));
  parsed.sourceSnapshot = JSON.parse(sourceSnapshotContent.toString('utf8'));
  parsed.sourceSnapshotSha256 = createHash('sha256').update(sourceSnapshotContent).digest('hex');
  return validateCrdLocalParksArtifacts(parsed);
}

export function readCrdLocalParksManifestSync({ root = repositoryRoot, optional = false } = {}) {
  const filename = path.join(root, CRD_LOCAL_PARKS_SOURCE_DIRECTORY, importedFiles.manifest);
  try {
    const manifest = JSON.parse(fsSync.readFileSync(filename, 'utf8'));
    assert(manifest.schemaVersion === 1 && Array.isArray(manifest.entries),
      'import-manifest.json: expected schemaVersion 1 and entries[]');
    return manifest;
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    throw error;
  }
}

export function crdLocalParksSourceContract(place, manifest) {
  if (!place || !CRD_LOCAL_PARK_CATEGORIES.includes(place.category)) return null;
  const entry = manifest.entries.find((candidate) => candidate.id === place.id && candidate.disposition === 'include');
  assert(entry, `${place.id}: no included CRD local park manifest identity`);
  const sourceName = sourceNameFor(entry.jurisdiction);
  assert(place.sourceName === sourceName, `${place.id}: unexpected CRD local park source name`);
  assert(place.sourceUrl === CRD_LOCAL_PARKS_SOURCE_URL, `${place.id}: unexpected CRD local park source URL`);
  assert(String(place.sourceId) === String(entry.sourceObjectIds[0]), `${place.id}: unexpected CRD local park object identity`);
  return { source: { name: sourceName, page: CRD_LOCAL_PARKS_SOURCE_URL }, sourceId: String(entry.sourceObjectIds[0]) };
}

export function crdLocalParkSourceCounts(manifest) {
  const counts = {};
  for (const entry of manifest.entries) {
    if (entry.disposition !== 'include') continue;
    const name = sourceNameFor(entry.jurisdiction);
    counts[name] = (counts[name] ?? 0) + 1;
  }
  return counts;
}

function verifyExistingCanonicalIdentity(manifest, places, boundaries) {
  const identity = manifest.existingCanonicalIdentity;
  if (!identity) return;
  const sourceId = String(identity.sourceObjectId);
  const place = places.find((candidate) => candidate.id === identity.placeId);
  assert(place && place.id === identity.placeId && place.category === 'regional'
    && place.sourceName === CRD_REGIONAL_SOURCE_NAME && place.sourceUrl === CRD_LOCAL_PARKS_SOURCE_URL
    && (place.sourceId == null || String(place.sourceId) === sourceId),
  `CRD source object ${sourceId}: canonical place identity or category changed`);
  const conflictingPlaces = places.filter((candidate) => candidate.sourceUrl === CRD_LOCAL_PARKS_SOURCE_URL
    && candidate.sourceId != null && String(candidate.sourceId) === sourceId);
  assert(conflictingPlaces.length === 0 || (conflictingPlaces.length === 1 && conflictingPlaces[0].id === identity.placeId),
    `CRD source object ${sourceId}: source identity is assigned to another canonical place`);
  const boundaryMatches = boundaries.features.filter((feature) => feature.properties?.sourceUrl === CRD_LOCAL_PARKS_SOURCE_URL
    && String(feature.properties?.sourceId) === sourceId);
  assert(boundaryMatches.length === 1, `CRD source object ${sourceId}: expected one preserved canonical boundary`);
  const feature = boundaryMatches[0];
  assert(feature.properties.id === identity.placeId && feature.properties.category === 'regional'
    && feature.properties.sourceName === CRD_REGIONAL_SOURCE_NAME,
  `CRD source object ${sourceId}: canonical boundary identity or category changed`);
}

function descriptionSourceIndexEntry(entry) {
  return {
    status: entry.status,
    sourceName: entry.sourceName,
    sourceTitle: entry.sourceTitle,
    sourceUrl: entry.sourceUrl,
    sourceSection: entry.sourceSection,
    reviewedAt: entry.reviewedAt,
  };
}

function featureMetrics(feature) {
  return geometryPositionCount(feature.geometry);
}

function uniqueCounts(values) {
  const result = {};
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return Object.fromEntries(Object.entries(result).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
}

function polygonGeometryCounts(features) {
  return Object.fromEntries(['Polygon', 'MultiPolygon'].map((type) => [
    type, features.filter((feature) => feature.geometry.type === type).length,
  ]));
}

async function readJson(filename) {
  return JSON.parse(await fs.readFile(filename, 'utf8'));
}

async function atomicWriteJson(filename, value, compact = false) {
  const content = `${JSON.stringify(value, null, compact ? 0 : 2)}\n`;
  const temporary = `${filename}.crd-import-tmp`;
  await fs.writeFile(temporary, content, 'utf8');
  await fs.rename(temporary, filename);
}

export async function applyCrdLocalParksImport({ root = repositoryRoot } = {}) {
  const bundle = await loadCrdLocalParksImport({ root });
  const dataDir = path.join(root, 'data');
  const frontendDir = path.join(root, 'frontend', 'lib');
  const importIds = new Set(bundle.places.map((place) => place.id));
  const [places, boundaries, coverageAudit, boundaryAudit, descriptionSources] = await Promise.all([
    readJson(path.join(dataDir, 'places.json')),
    readJson(path.join(dataDir, 'boundaries.geojson')),
    readJson(path.join(dataDir, 'coverage-audit.json')),
    readJson(path.join(dataDir, 'boundary-audit.json')),
    readJson(path.join(frontendDir, 'place-description-sources.catalogue.json')),
  ]);
  assert(Array.isArray(places), 'data/places.json: expected an array');
  assert(boundaries.type === 'FeatureCollection' && Array.isArray(boundaries.features),
    'data/boundaries.geojson: expected a FeatureCollection');
  verifyExistingCanonicalIdentity(bundle.manifest, places, boundaries);

  const existingPlaces = new Map(places.map((place) => [place.id, place]));
  const existingBoundaries = new Map(boundaries.features.map((feature) => [feature.properties?.id ?? feature.properties?.placeId, feature]));
  const placeOverlap = [...importIds].filter((id) => existingPlaces.has(id));
  const boundaryOverlap = [...importIds].filter((id) => existingBoundaries.has(id));
  const allAlreadyPresent = placeOverlap.length === importIds.size && boundaryOverlap.length === importIds.size;
  if (allAlreadyPresent) {
    assert(places.filter((place) => CRD_LOCAL_PARK_CATEGORIES.includes(place.category)).length === bundle.places.length,
      'canonical municipal/community count differs from the reviewed CRD import');
    for (const imported of bundle.places) {
      assert(sameJson(existingPlaces.get(imported.id), imported), `${imported.id}: existing place differs from reviewed import`);
      assert(sameJson(existingBoundaries.get(imported.id), canonicalizeCrdLocalParkBoundaryFeature(bundle.boundaries.features.find((feature) => (feature.properties.id ?? feature.properties.placeId) === imported.id))),
        `${imported.id}: existing boundary differs from reviewed import`);
    assert(sameJson(descriptionSources[imported.id], descriptionSourceIndexEntry(bundle.descriptions.entries[imported.id])),
      `${imported.id}: existing description source differs from reviewed import`);
    }
    const sortedDescriptionSources = Object.fromEntries(Object.entries(descriptionSources)
      .sort(([left], [right]) => left.localeCompare(right)));
    const currentSourceCounts = uniqueCounts(boundaries.features.map((feature) => feature.properties.sourceName));
    const currentGeometryStats = boundaries.features.map(featureMetrics);
    const currentSerialized = `${JSON.stringify(boundaries)}\n`;
    const currentCategoryCounts = Object.fromEntries(PLACE_CATEGORIES.map((category) => [
      category, places.filter((place) => place.category === category).length,
    ]));
    assert(boundaryAudit.placeCount === places.length && boundaryAudit.featureCount === boundaries.features.length,
      'boundary audit is stale after CRD local park import');
    assert(sameJson(boundaryAudit.sourceCounts, currentSourceCounts), 'boundary audit source counts are stale after CRD local park import');
    assert(sameJson(boundaryAudit.geometryCounts, polygonGeometryCounts(boundaries.features)),
      'boundary audit geometry counts are stale after CRD local park import');
    assert(boundaryAudit.totalParts === currentGeometryStats.reduce((sum, item) => sum + item.parts, 0)
      && boundaryAudit.totalHoles === currentGeometryStats.reduce((sum, item) => sum + item.holes, 0)
      && boundaryAudit.sourceParts === currentGeometryStats.reduce((sum, item) => sum + item.parts, 0)
      && boundaryAudit.sourceHoles === currentGeometryStats.reduce((sum, item) => sum + item.holes, 0)
      && boundaryAudit.totalPositions === currentGeometryStats.reduce((sum, item) => sum + item.positions, 0)
      && boundaryAudit.payloadBytes === Buffer.byteLength(currentSerialized),
    'boundary audit geometry metrics are stale after CRD local park import');
    assert(boundaryAudit.sourceTopologyPreserved === true && boundaryAudit.missingIds?.length === 0
      && boundaryAudit.duplicateIds?.length === 0,
    'boundary audit identity or topology status is stale after CRD local park import');
    assert(sameJson(coverageAudit.counts, currentCategoryCounts), 'coverage audit category counts are stale after CRD local park import');
    assert(coverageAudit.crdLocalParksImport?.includedCount === bundle.places.length
      && coverageAudit.crdLocalParksImport?.sourceUrl === CRD_LOCAL_PARKS_SOURCE_URL
      && coverageAudit.crdLocalParksImport?.snapshotSha256 === bundle.manifest.sourceSnapshot.sha256
      && sameJson(coverageAudit.crdLocalParksImport?.dispositionCounts, bundle.manifest.dispositionCounts)
      && sameJson(coverageAudit.crdLocalParksImport?.sourceCounts, crdLocalParkSourceCounts(bundle.manifest)),
    'coverage audit CRD import summary is missing or stale');
    if (!sameJson(descriptionSources, sortedDescriptionSources)) {
      await atomicWriteJson(path.join(frontendDir, 'place-description-sources.catalogue.json'), sortedDescriptionSources);
    }
    return { applied: false, placeCount: places.length, importedCount: bundle.places.length };
  }
  assert(placeOverlap.length === 0 && boundaryOverlap.length === 0,
    'CRD local park import is partially applied; refusing to change canonical data');

  for (const place of places) {
    assert(!importIds.has(place.id), `${place.id}: import id already exists`);
  }
  for (const feature of boundaries.features) {
    const id = feature.properties?.id ?? feature.properties?.placeId;
    assert(!importIds.has(id), `${id}: import boundary already exists`);
  }
  for (const id of importIds) assert(!Object.hasOwn(descriptionSources, id), `${id}: description source already exists`);

  const appendedPlaces = [...places, ...bundle.places];
  const appendedFeatures = [...boundaries.features, ...bundle.boundaries.features.map(canonicalizeCrdLocalParkBoundaryFeature)]
    .sort((left, right) => left.properties.id.localeCompare(right.properties.id));
  const sourceCounts = uniqueCounts(appendedFeatures.map((feature) => feature.properties.sourceName));
  const geometryStats = appendedFeatures.map(featureMetrics);
  const importedStats = bundle.boundaries.features.map(featureMetrics);
  const serializedBoundaries = `${JSON.stringify({ type: 'FeatureCollection', features: appendedFeatures })}\n`;
  const updatedBoundaryAudit = {
    ...boundaryAudit,
    generatedAt: new Date().toISOString(),
    placeCount: appendedPlaces.length,
    featureCount: appendedFeatures.length,
    missingIds: [],
    duplicateIds: [],
    sourceCounts,
    geometryCounts: polygonGeometryCounts(appendedFeatures),
    totalParts: geometryStats.reduce((sum, item) => sum + item.parts, 0),
    totalHoles: geometryStats.reduce((sum, item) => sum + item.holes, 0),
    sourceParts: (boundaryAudit.sourceParts ?? 0) + importedStats.reduce((sum, item) => sum + item.parts, 0),
    sourceHoles: (boundaryAudit.sourceHoles ?? 0) + importedStats.reduce((sum, item) => sum + item.holes, 0),
    totalPositions: geometryStats.reduce((sum, item) => sum + item.positions, 0),
    payloadBytes: Buffer.byteLength(serializedBoundaries),
  };
  const categoryCounts = Object.fromEntries(PLACE_CATEGORIES.map((category) => [
    category, appendedPlaces.filter((place) => place.category === category).length,
  ]));
  const extents = {
    south: Math.min(...appendedPlaces.map((place) => place.latitude)),
    north: Math.max(...appendedPlaces.map((place) => place.latitude)),
    west: Math.min(...appendedPlaces.map((place) => place.longitude)),
    east: Math.max(...appendedPlaces.map((place) => place.longitude)),
  };
  const updatedCoverageAudit = {
    ...coverageAudit,
    generatedAt: new Date().toISOString(),
    counts: categoryCounts,
    polygonPinsVerified: (coverageAudit.polygonPinsVerified ?? 0) + bundle.boundaries.features.length,
    extents,
    crdLocalParksImport: {
      sourceUrl: CRD_LOCAL_PARKS_SOURCE_URL,
      includedCount: bundle.places.length,
      sourceCounts: crdLocalParkSourceCounts(bundle.manifest),
      snapshotSha256: bundle.audit.sourceSnapshot?.sha256 ?? bundle.manifest.sourceSnapshot.sha256,
      dispositionCounts: bundle.manifest.dispositionCounts,
    },
  };
  const updatedDescriptionSources = { ...descriptionSources };
  for (const [id, entry] of Object.entries(bundle.descriptions.entries)) {
    updatedDescriptionSources[id] = descriptionSourceIndexEntry(entry);
  }
  const sortedDescriptionSources = Object.fromEntries(Object.entries(updatedDescriptionSources)
    .sort(([left], [right]) => left.localeCompare(right)));

  await atomicWriteJson(path.join(dataDir, 'places.json'), appendedPlaces);
  await atomicWriteJson(path.join(dataDir, 'boundaries.geojson'), { type: 'FeatureCollection', features: appendedFeatures }, true);
  await atomicWriteJson(path.join(dataDir, 'coverage-audit.json'), updatedCoverageAudit);
  await atomicWriteJson(path.join(dataDir, 'boundary-audit.json'), updatedBoundaryAudit);
  await atomicWriteJson(path.join(frontendDir, 'place-description-sources.catalogue.json'), sortedDescriptionSources);

  return { applied: true, placeCount: appendedPlaces.length, importedCount: bundle.places.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  if (command !== 'apply') throw new Error('Usage: node scripts/crd-local-parks.mjs apply');
  const result = await applyCrdLocalParksImport();
  console.log(result.applied
    ? `Applied ${result.importedCount} CRD local parks; canonical catalogue now has ${result.placeCount} places.`
    : `CRD local parks are already applied; canonical catalogue has ${result.placeCount} places.`);
}

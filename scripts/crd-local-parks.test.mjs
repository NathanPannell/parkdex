import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CRD_LOCAL_PARKS_SOURCE_URL,
  CRD_REGIONAL_SOURCE_NAME,
  applyCrdLocalParksImport,
  validateCrdLocalParksArtifacts,
} from './crd-local-parks.mjs';

const square = (west, south, east, north) => ({
  type: 'Polygon',
  coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]],
});

function makeBundle() {
  const sourceSnapshot = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: { OBJECTID: 2, Type: 'Municipal Park', Jurisdic: 'City of Victoria', Name: 'Central Park' }, geometry: square(-123.4, 48.4, -123.39, 48.41) },
      { type: 'Feature', properties: { OBJECTID: 3, Type: 'Community Park', Jurisdic: 'Islands Trust', Name: 'Village Green' }, geometry: square(-123.5, 48.5, -123.49, 48.51) },
      { type: 'Feature', properties: { OBJECTID: 1958, Type: 'Municipal Park', Jurisdic: 'District of Sooke', Name: 'Sooke River Park' }, geometry: square(-123.7, 48.7, -123.69, 48.71) },
    ],
  };
  const sourceSnapshotContent = `${JSON.stringify(sourceSnapshot, null, 2)}\n`;
  const sourceSnapshotSha256 = createHash('sha256').update(sourceSnapshotContent).digest('hex');
  const manifest = {
    schemaVersion: 1,
    sourceLayer: CRD_LOCAL_PARKS_SOURCE_URL,
    sourceSnapshot: { sha256: sourceSnapshotSha256, featureCount: sourceSnapshot.features.length },
    existingCanonicalIdentity: {
      sourceObjectId: 1958,
      placeId: 'regional-sooke-river-regional-park',
      action: 'exclude-from-new-import-preserve-existing-record-and-boundary',
    },
    entries: [
      { id: 'municipal-central-park', name: 'Central Park', category: 'municipal', jurisdiction: 'City of Victoria', sourceType: 'Municipal Park', sourceObjectIds: [2], sourceNames: ['Central Park'], disposition: 'include' },
      { id: 'community-village-green', name: 'Village Green', category: 'community', jurisdiction: 'Islands Trust', sourceType: 'Community Park', sourceObjectIds: [3], sourceNames: ['Village Green'], disposition: 'include' },
      { id: null, name: 'Sooke River Park', category: 'municipal', jurisdiction: 'District of Sooke', sourceType: 'Municipal Park', sourceObjectIds: [1958], sourceNames: ['Sooke River Park'], disposition: 'exclude', reason: 'Preserve the existing regional park identity' },
    ],
    dispositionCounts: {
      entries: { include: 2, hold: 0, exclude: 1 },
      sourceFeatures: { include: 2, hold: 0, exclude: 1 },
    },
  };
  const entries = manifest.entries.filter((entry) => entry.disposition === 'include');
  const places = entries.map((entry, index) => ({
    id: entry.id,
    name: entry.name,
    category: entry.category,
    latitude: 48.4 + index * 0.1,
    longitude: -123.4 - index * 0.1,
    region: 'Capital Region',
    description: `${entry.name} is a mapped ${entry.sourceType.toLowerCase()} in ${entry.jurisdiction}.`,
    sourceUrl: CRD_LOCAL_PARKS_SOURCE_URL,
    sourceName: `${entry.jurisdiction} (CRD Park GIS)`,
    sourceId: String(entry.sourceObjectIds[0]),
  }));
  const boundaries = {
    type: 'FeatureCollection',
    features: entries.map((entry, index) => ({
      type: 'Feature',
      properties: {
        id: entry.id,
        name: entry.name,
        category: entry.category,
        jurisdiction: entry.jurisdiction,
        sourceType: entry.sourceType,
        sourceName: `${entry.jurisdiction} (CRD Park GIS)`,
        sourceUrl: CRD_LOCAL_PARKS_SOURCE_URL,
        sourceId: String(entry.sourceObjectIds[0]),
        sourceObjectIds: entry.sourceObjectIds,
        sourceNames: entry.sourceNames,
      },
      geometry: square(-123.4 - index * 0.1, 48.4 + index * 0.1, -123.39 - index * 0.1, 48.41 + index * 0.1),
    })),
  };
  const descriptions = {
    entries: Object.fromEntries(places.map((place) => [place.id, {
      status: 'source-derived',
      description: place.description,
      sourceName: place.sourceName,
      sourceTitle: place.name,
      sourceUrl: CRD_LOCAL_PARKS_SOURCE_URL,
      sourceSection: 'Park GIS name and jurisdiction attributes',
      reviewedAt: '2026-09-27',
    }])),
  };
  const audit = {
    schemaVersion: 1,
    sourceLayer: CRD_LOCAL_PARKS_SOURCE_URL,
    sourceSnapshot: { sha256: sourceSnapshotSha256 },
    counts: {
      sourceFeatures: 3,
      manifestEntries: 3,
      includedPlaces: 2,
      includedSourceFeatures: 2,
      heldEntries: 0,
      heldSourceFeatures: 0,
      excludedEntries: 1,
      excludedSourceFeatures: 1,
      generatedBoundaries: 2,
      generatedDescriptions: 2,
    },
    boundaryConstruction: {
      operation: 'polygon union of original source geometries',
      noBufferOrHull: true,
      sourcePartsAndHolesPreserved: true,
      groupCount: 0,
      groups: [],
    },
    representativePointChecks: { checkedPlaces: 2, allInsideOutputBoundary: true },
  };
  return { manifest, places, boundaries, descriptions, audit, sourceSnapshot, sourceSnapshotSha256, sourceSnapshotContent };
}

async function writeJson(filename, value) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function writeImportBundle(root, bundle) {
  const directory = path.join(root, 'data', 'source-imports', 'crd-local-parks');
  await writeJson(path.join(directory, 'import-manifest.json'), bundle.manifest);
  await writeJson(path.join(directory, 'places.json'), bundle.places);
  await writeJson(path.join(directory, 'boundaries.geojson'), bundle.boundaries);
  await writeJson(path.join(directory, 'descriptions.catalogue.json'), bundle.descriptions);
  await writeJson(path.join(directory, 'import-audit.json'), bundle.audit);
  await fs.writeFile(path.join(directory, 'crd-municipal-community-source.geojson'), bundle.sourceSnapshotContent, 'utf8');
}

test('validates all included records against frozen CRD OIDs and provenance', () => {
  const bundle = makeBundle();
  const validated = validateCrdLocalParksArtifacts(bundle);
  assert.equal(validated.entriesById.size, 2);

  const altered = structuredClone(bundle);
  altered.manifest.entries[0].sourceObjectIds = [999];
  assert.throws(() => validateCrdLocalParksArtifacts(altered), /absent from the frozen CRD snapshot/);

  const duplicatedExistingIdentity = structuredClone(bundle);
  duplicatedExistingIdentity.manifest.entries.at(-1).disposition = 'include';
  duplicatedExistingIdentity.manifest.entries.at(-1).id = 'municipal-sooke-river-park';
  assert.throws(() => validateCrdLocalParksArtifacts(duplicatedExistingIdentity), /existing canonical identity cannot be included again/);

  const wrongHash = { ...bundle, sourceSnapshotSha256: '0'.repeat(64) };
  assert.throws(() => validateCrdLocalParksArtifacts(wrongHash), /SHA-256 differs/);
});

test('targeted apply appends imported records and keeps the prior catalogue and boundaries byte-for-value intact', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'parkdex-crd-import-'));
  try {
    const bundle = makeBundle();
    await writeImportBundle(root, bundle);
    const dataDir = path.join(root, 'data');
    const frontendLib = path.join(root, 'frontend', 'lib');
    const oldPlace = {
      id: 'regional-existing-park', name: 'Existing Park', category: 'regional', latitude: 48.3, longitude: -123.3,
      region: 'Capital Region', description: 'An existing regional park description with factual provenance.',
      sourceUrl: 'https://example.com/old', sourceName: 'Existing source',
    };
    const oldSookePlace = {
      id: 'regional-sooke-river-regional-park', name: 'Sooke River Park', category: 'regional', latitude: 48.7, longitude: -123.7,
      region: 'Capital Region', description: 'An existing regional park along the Sooke River with a reviewed CRD identity.',
      sourceUrl: CRD_LOCAL_PARKS_SOURCE_URL, sourceName: CRD_REGIONAL_SOURCE_NAME, sourceId: '1958',
    };
    const oldBoundary = {
      type: 'Feature',
      properties: { id: oldPlace.id, name: oldPlace.name, category: oldPlace.category, sourceName: oldPlace.sourceName, sourceUrl: oldPlace.sourceUrl, sourceId: 'old-1' },
      geometry: square(-123.3, 48.3, -123.29, 48.31),
    };
    const oldSookeBoundary = {
      type: 'Feature',
      properties: { id: oldSookePlace.id, name: oldSookePlace.name, category: oldSookePlace.category, sourceName: oldSookePlace.sourceName, sourceUrl: oldSookePlace.sourceUrl, sourceId: oldSookePlace.sourceId },
      geometry: square(-123.7, 48.7, -123.69, 48.71),
    };
    const oldPlaces = [oldPlace, oldSookePlace];
    const oldBoundaries = { type: 'FeatureCollection', features: [oldBoundary, oldSookeBoundary] };
    const oldBoundarySerialized = `${JSON.stringify(oldBoundaries)}\n`;
    await writeJson(path.join(dataDir, 'places.json'), oldPlaces);
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(path.join(dataDir, 'boundaries.geojson'), oldBoundarySerialized, 'utf8');
    await writeJson(path.join(dataDir, 'coverage-audit.json'), {
      counts: { national: 0, provincial: 0, regional: 2, island: 0 },
      polygonPinsVerified: 0,
      extents: { south: 48.3, north: 48.3, west: -123.3, east: -123.3 },
    });
    await writeJson(path.join(dataDir, 'boundary-audit.json'), {
      placeCount: 2,
      featureCount: 2,
      missingIds: [],
      duplicateIds: [],
      sourceCounts: { 'Existing source': 1, [CRD_REGIONAL_SOURCE_NAME]: 1 },
      geometryCounts: { Polygon: 2, MultiPolygon: 0 },
      totalParts: 2,
      totalHoles: 0,
      sourceParts: 2,
      sourceHoles: 0,
      totalPositions: 10,
      payloadBytes: Buffer.byteLength(oldBoundarySerialized),
      sourceTopologyPreserved: true,
      topologyWarnings: [],
    });
    await writeJson(path.join(frontendLib, 'place-description-sources.catalogue.json'), {});

    const result = await applyCrdLocalParksImport({ root });
    assert.equal(result.applied, true);
    const newPlaces = JSON.parse(await fs.readFile(path.join(dataDir, 'places.json'), 'utf8'));
    const newBoundaries = JSON.parse(await fs.readFile(path.join(dataDir, 'boundaries.geojson'), 'utf8'));
    assert.deepEqual(newPlaces.slice(0, oldPlaces.length), oldPlaces);
    assert.deepEqual(newBoundaries.features.find((feature) => feature.properties.id === oldPlace.id), oldBoundary);
    assert.deepEqual(newBoundaries.features.find((feature) => feature.properties.id === oldSookePlace.id), oldSookeBoundary);
    assert.equal(newPlaces.length, oldPlaces.length + 2);
    assert.equal(newBoundaries.features.length, oldBoundaries.features.length + 2);

    const repeatResult = await applyCrdLocalParksImport({ root });
    assert.equal(repeatResult.applied, false);
    const updatedAudit = JSON.parse(await fs.readFile(path.join(dataDir, 'boundary-audit.json'), 'utf8'));
    updatedAudit.featureCount = 1;
    await writeJson(path.join(dataDir, 'boundary-audit.json'), updatedAudit);
    await assert.rejects(() => applyCrdLocalParksImport({ root }), /boundary audit is stale/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

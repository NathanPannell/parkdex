import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { validateBoundarySource, validateBoundarySourceCounts } from './boundary-sources.mjs';

const places = JSON.parse(fs.readFileSync(new URL('../data/places.json', import.meta.url), 'utf8'));
const boundaries = JSON.parse(fs.readFileSync(new URL('../data/boundaries.geojson', import.meta.url), 'utf8'));
const audit = JSON.parse(fs.readFileSync(new URL('../data/boundary-audit.json', import.meta.url), 'utf8'));
const placesById = new Map(places.map((place) => [place.id, place]));

test('every serialized boundary matches its independently reviewed source contract', () => {
  for (const feature of boundaries.features) validateBoundarySource(placesById.get(feature.properties.id), feature.properties);
  validateBoundarySourceCounts(boundaries.features, audit.sourceCounts);
});

test('rejects provenance URL and OSM identity mutations', () => {
  const provincial = structuredClone(boundaries.features.find((feature) => feature.properties.category === 'provincial'));
  provincial.properties.sourceUrl = 'https://example.com/not-the-reviewed-source';
  assert.throws(() => validateBoundarySource(placesById.get(provincial.properties.id), provincial.properties), /source URL/);

  const island = structuredClone(boundaries.features.find((feature) => feature.properties.category === 'island'));
  island.properties.sourceId = 'R1';
  assert.throws(() => validateBoundarySource(placesById.get(island.properties.id), island.properties), /source object/);
});

test('rejects source-count drift even when a generated audit is changed with it', () => {
  const features = structuredClone(boundaries.features);
  const provincial = features.find((feature) => feature.properties.category === 'provincial');
  provincial.properties.sourceName = 'OpenStreetMap contributors';
  const coordinatedAuditMutation = {
    ...audit.sourceCounts,
    'BC Parks / DataBC — TANTALIS protected areas': audit.sourceCounts['BC Parks / DataBC — TANTALIS protected areas'] - 1,
    'OpenStreetMap contributors': audit.sourceCounts['OpenStreetMap contributors'] + 1,
  };
  assert.throws(() => validateBoundarySourceCounts(features, coordinatedAuditMutation), /reviewed contract/);
});

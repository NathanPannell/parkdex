import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createRdcoParkQueryUrl,
  fetchRdcoParks,
  normalizeRdcoParks,
  rdcoParkSource,
  rdcoRegionalParkDirectory,
} from './rdco-parks.mjs';

const polygon = (offset = 0) => ({
  type: 'Polygon',
  coordinates: [[[offset, 49], [offset + 0.01, 49], [offset + 0.01, 49.01], [offset, 49.01], [offset, 49]]],
});

function sourceFeature({ objectId, parkNumber, parkName, commonName, geometry = polygon(objectId), imageUrl = null, amenities = null }) {
  return {
    type: 'Feature',
    id: 'Parks_Main.' + objectId,
    properties: {
      OBJECTID: objectId,
      GlobalID: 'global-' + objectId,
      PrkNumb: parkNumber,
      PARK_NAME: parkName,
      CommonName: commonName,
      Area_ha: 12.5,
      ImageURL: imageUrl,
      AllAmenities: amenities,
      Address: '123 Park Road',
      Accessible: 'YES',
      DogsOnLeash: 'YES',
      Trails: 'YES',
      ParkTourURL: 'https://storymaps.arcgis.com/stories/example',
      IntActMapURL: 'https://arcg.is/example',
      GoogleDir: 'https://maps.google.com/example',
      PDFMapURL: 'https://www.rdco.com/map.pdf',
      prkHours: '6 a.m. to dusk',
    },
    geometry,
  };
}

test('query targets the official RDCO park polygon layer and requests WGS84 GeoJSON', () => {
  const url = createRdcoParkQueryUrl();
  assert.equal(url.origin + url.pathname, rdcoParkSource.layerUrl + '/query');
  assert.equal(url.searchParams.get('where'), '1=1');
  assert.equal(url.searchParams.get('returnGeometry'), 'true');
  assert.equal(url.searchParams.get('outSR'), '4326');
  assert.equal(url.searchParams.get('resultRecordCount'), '2000');
  assert.equal(url.searchParams.get('f'), 'geojson');
  assert.match(url.searchParams.get('outFields'), /PrkNumb/);
  assert.match(url.searchParams.get('outFields'), /ImageURL/);
});

test('keeps the official directory parks, groups split features, and excludes community parks', () => {
  const source = {
    type: 'FeatureCollection',
    features: [
      sourceFeature({ objectId: 8, parkNumber: '1', parkName: 'Hardy Falls', commonName: 'Hardy Falls Regional Park', imageUrl: 'https://www.rdco.com/hardy.jpg', amenities: 'Trails, Waterfall' }),
      sourceFeature({ objectId: 3, parkNumber: '1', parkName: 'Hardy Falls', commonName: 'Hardy Falls Regional Park', geometry: polygon(0.1) }),
      sourceFeature({ objectId: 20, parkNumber: '22', parkName: "Black Mountain / Sntsk'il'nten", commonName: 'Black Mountain', geometry: { type: 'MultiPolygon', coordinates: [polygon(0.2).coordinates, polygon(0.3).coordinates] } }),
      sourceFeature({ objectId: 21, parkNumber: '20', parkName: 'Stephens Coyote', commonName: 'Stephens Coyote Ridge Regional Park' }),
      sourceFeature({ objectId: 90, parkNumber: '51', parkName: 'Westshore Estates', commonName: 'Westshore Estates Community Park Regional Park' }),
      sourceFeature({ objectId: 91, parkNumber: '48', parkName: 'Killiney Community Hall', commonName: 'Killiney Community Hall Regional Park' }),
    ],
  };

  const normalized = normalizeRdcoParks(source);
  assert.equal(rdcoRegionalParkDirectory.length, 30);
  assert.equal(normalized.features.length, 3);
  assert.equal(normalized.metadata.parkCount, 3);
  assert.equal(normalized.metadata.excludedSourceFeatureCount, 2);

  const hardy = normalized.features.find((feature) => feature.properties.sourceParkNumber === '1');
  assert.equal(hardy.id, 'regional-central-okanagan-1');
  assert.equal(hardy.properties.name, 'Hardy Falls');
  assert.equal(hardy.properties.sourceId, '1');
  assert.deepEqual(hardy.properties.sourceObjectIds, ['3', '8']);
  assert.deepEqual(hardy.properties.sourceGlobalIds, ['global-3', 'global-8']);
  assert.equal(hardy.geometry.type, 'MultiPolygon');
  assert.equal(hardy.geometry.coordinates.length, 2);
  assert.equal(hardy.properties.imageUrl, 'https://www.rdco.com/hardy.jpg');
  assert.deepEqual(hardy.properties.amenities, ['Trails', 'Waterfall']);
  assert.equal(hardy.properties.category, 'regional');
  assert.equal(hardy.properties.license, null);

  const blackMountain = normalized.features.find((feature) => feature.properties.sourceParkNumber === '22');
  assert.equal(blackMountain.properties.name, "sntsk'il'ntən - Black Mountain");
  assert.equal(blackMountain.geometry.type, 'MultiPolygon');
  assert.equal(blackMountain.geometry.coordinates.length, 2);

  const stephens = normalized.features.find((feature) => feature.properties.sourceParkNumber === '20');
  assert.equal(stephens.properties.name, 'Stephens Coyote Ridge');
  assert.equal(stephens.geometry.type, 'Polygon');
});

test('requires stable IDs for directory parks and rejects conflicting park number assignments', () => {
  assert.throws(() => normalizeRdcoParks({ type: 'FeatureCollection', features: null }), /GeoJSON FeatureCollection/);
  assert.throws(() => normalizeRdcoParks({
    type: 'FeatureCollection',
    features: [sourceFeature({ objectId: 1, parkNumber: '', parkName: 'Hardy Falls', commonName: 'Hardy Falls Regional Park' })],
  }), /no PrkNumb/);
  assert.throws(() => normalizeRdcoParks({
    type: 'FeatureCollection',
    features: [
      sourceFeature({ objectId: 1, parkNumber: '5', parkName: 'Hardy Falls', commonName: 'Hardy Falls Regional Park' }),
      sourceFeature({ objectId: 2, parkNumber: '5', parkName: 'Antlers Beach', commonName: 'Antlers Beach Regional Park' }),
    ],
  }), /assigned to multiple directory parks/);
});

test('fetcher requests and normalizes the layer response', async () => {
  let calledUrl;
  let calledOptions;
  const expected = {
    type: 'FeatureCollection',
    features: [sourceFeature({ objectId: 1, parkNumber: '1', parkName: 'Hardy Falls', commonName: 'Hardy Falls Regional Park' })],
  };
  const result = await fetchRdcoParks({
    fetchImpl: async (url, options) => {
      calledUrl = url;
      calledOptions = options;
      return new Response(JSON.stringify(expected), { status: 200, headers: { 'content-type': 'application/geo+json' } });
    },
  });

  assert.equal(calledUrl.searchParams.get('f'), 'geojson');
  assert.equal(calledOptions.headers['user-agent'], 'parkdex-data-builder/1.0');
  assert.equal(result.features.length, 1);
  assert.equal(result.features[0].properties.sourceId, '1');
});

test('fetcher reports HTTP failures and incomplete transfers', async () => {
  await assert.rejects(fetchRdcoParks({
    fetchImpl: async () => new Response('unavailable', { status: 503, statusText: 'Unavailable' }),
  }), /returned 503 Unavailable/);
  await assert.rejects(fetchRdcoParks({
    fetchImpl: async () => new Response(JSON.stringify({ type: 'FeatureCollection', features: [], exceededTransferLimit: true }), { status: 200 }),
  }), /exceeded the requested record limit/);
});

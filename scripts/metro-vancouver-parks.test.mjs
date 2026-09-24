import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createMetroVancouverParkQueryUrl,
  fetchMetroVancouverParks,
  metroVancouverParkSource,
  normalizeMetroVancouverParks,
} from './metro-vancouver-parks.mjs';

const polygon = (offset = 0) => ({
  type: 'Polygon',
  coordinates: [[[offset, 49], [offset + 0.01, 49], [offset + 0.01, 49.01], [offset, 49.01], [offset, 49]]],
});

function sourceFeature({ objectId, parkcode, parkname, type = 'Regional Park', geometry = polygon(objectId), operatingarea = 'EAST' }) {
  return {
    type: 'Feature',
    id: `Regional_Parks_Boundaries.${objectId}`,
    properties: {
      OBJECTID: objectId,
      globalid: `global-${objectId}`,
      operatingarea,
      parkcode,
      parkname,
      parkshortname: parkname.replace(/ Regional Park$/, ''),
      type,
    },
    geometry,
  };
}

test('query targets the reviewed Metro Vancouver polygon layer in WGS84 GeoJSON', () => {
  const url = createMetroVancouverParkQueryUrl();
  assert.equal(url.origin + url.pathname, `${metroVancouverParkSource.layerUrl}/query`);
  assert.equal(url.searchParams.get('where'), '1=1');
  assert.equal(url.searchParams.get('returnGeometry'), 'true');
  assert.equal(url.searchParams.get('outSR'), '4326');
  assert.equal(url.searchParams.get('f'), 'geojson');
  assert.match(url.searchParams.get('outFields'), /parkcode/);
});

test('keeps regional parks, groups split features by parkcode, and excludes other classifications', () => {
  const source = {
    type: 'FeatureCollection',
    features: [
      sourceFeature({ objectId: 8, parkcode: 'ALD', parkname: 'Aldergrove Regional Park', geometry: polygon(-122.2) }),
      sourceFeature({ objectId: 3, parkcode: 'ALD', parkname: 'Aldergrove Regional Park', geometry: polygon(-122.1) }),
      sourceFeature({ objectId: 4, parkcode: 'BAR', parkname: 'Barnston Island Regional Park', geometry: polygon(-122.0) }),
      sourceFeature({ objectId: 10, parkcode: 'BFG', parkname: 'Brunette Fraser Regional Greenway', type: 'Regional Greenway' }),
      sourceFeature({ objectId: 11, parkcode: 'BLA', parkname: 'Blaney Bog Regional Park Reserve', type: 'Regional Park Reserve' }),
      sourceFeature({ objectId: 12, parkcode: 'BUB', parkname: 'Burns Bog Ecological Conservancy Area', type: 'Ecological Conservancy Area' }),
    ],
  };

  const normalized = normalizeMetroVancouverParks(source);
  assert.equal(normalized.features.length, 2);
  assert.equal(normalized.metadata.parkCount, 2);
  assert.deepEqual(normalized.metadata.sourceTypeCounts, {
    'Regional Park': 3,
    'Regional Greenway': 1,
    'Regional Park Reserve': 1,
    'Ecological Conservancy Area': 1,
  });

  const aldergrove = normalized.features[0];
  assert.equal(aldergrove.id, 'metro-vancouver-ald');
  assert.equal(aldergrove.properties.id, aldergrove.id);
  assert.equal(aldergrove.properties.parkcode, 'ALD');
  assert.equal(aldergrove.properties.sourceId, 'ALD');
  assert.deepEqual(aldergrove.properties.sourceObjectIds, ['3', '8']);
  assert.deepEqual(aldergrove.properties.sourceGlobalIds, ['global-3', 'global-8']);
  assert.equal(aldergrove.geometry.type, 'MultiPolygon');
  assert.equal(aldergrove.geometry.coordinates.length, 2);
  assert.equal(aldergrove.properties.category, 'regional');
  assert.equal(aldergrove.properties.sourceUrl, metroVancouverParkSource.page);
  assert.equal(aldergrove.properties.sourceDataUrl, metroVancouverParkSource.layerUrl);
  assert.equal(aldergrove.properties.license, 'Open Government Licence');

  const barnston = normalized.features[1];
  assert.equal(barnston.id, 'metro-vancouver-bar');
  assert.equal(barnston.geometry.type, 'Polygon');
  assert.equal(barnston.properties.sourceObjectIds.length, 1);
});

test('rejects malformed collections, missing stable codes, and conflicting split-park attributes', () => {
  assert.throws(() => normalizeMetroVancouverParks({ type: 'FeatureCollection', features: null }), /GeoJSON FeatureCollection/);
  assert.throws(() => normalizeMetroVancouverParks({ type: 'FeatureCollection', features: [sourceFeature({ objectId: 1, parkcode: '', parkname: 'Park' })] }), /no parkcode/);
  assert.throws(() => normalizeMetroVancouverParks({
    type: 'FeatureCollection',
    features: [
      sourceFeature({ objectId: 1, parkcode: 'XYZ', parkname: 'One Park' }),
      sourceFeature({ objectId: 2, parkcode: 'XYZ', parkname: 'Different Park' }),
    ],
  }), /conflicting source attributes/);
});

test('fetcher requests and normalizes the live layer response', async () => {
  let calledUrl;
  let calledOptions;
  const expected = { type: 'FeatureCollection', features: [sourceFeature({ objectId: 1, parkcode: 'ALD', parkname: 'Aldergrove Regional Park' })] };
  const result = await fetchMetroVancouverParks({
    fetchImpl: async (url, options) => {
      calledUrl = url;
      calledOptions = options;
      return new Response(JSON.stringify(expected), { status: 200, headers: { 'content-type': 'application/geo+json' } });
    },
  });

  assert.equal(calledUrl.searchParams.get('f'), 'geojson');
  assert.equal(calledOptions.headers['user-agent'], 'parkdex-data-builder/1.0');
  assert.equal(result.features.length, 1);
  assert.equal(result.features[0].id, 'metro-vancouver-ald');
});

test('fetcher reports HTTP failures', async () => {
  await assert.rejects(
    fetchMetroVancouverParks({ fetchImpl: async () => new Response('unavailable', { status: 503, statusText: 'Unavailable' }) }),
    /returned 503 Unavailable/,
  );
});

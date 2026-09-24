import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createRegionalGreenspacesReport,
  fetchArcgisRegionalParkAudit,
  fetchWfsRegionalParkFeatures,
  groupRegionalParkFeatures,
  normalizeParkName,
  regionalDistricts,
  regionalGreenspacesSource,
} from './regional-greenspaces.mjs';

function polygonFeature({
  id,
  name,
  district = 'Comox Valley',
  parkType = 'Regional',
  primaryUse = 'Park',
  geometry = { type: 'Polygon', coordinates: [[[ -125, 49 ], [ -124, 49 ], [ -124, 50 ], [ -125, 49 ]]] },
  municipality = 'Courtenay',
  updated = '2026-03-16Z',
}) {
  return {
    type: 'Feature',
    properties: {
      LOCAL_REG_GREENSPACE_ID: id,
      OBJECTID: id,
      PARK_NAME: name,
      PARK_TYPE: parkType,
      PARK_PRIMARY_USE: primaryUse,
      REGIONAL_DISTRICT: district,
      MUNICIPALITY: municipality,
      WHEN_UPDATED: updated,
      FEATURE_AREA_SQM: null,
    },
    geometry,
  };
}

function fakeResponse(body) {
  return { ok: true, json: async () => body };
}

test('normalizes punctuation and diacritics for stable park name grouping', () => {
  assert.equal(normalizeParkName('  Côte & Cedar Park '), 'cote and cedar park');
});

test('groups source rows by district and name while retaining every polygon and source ID', () => {
  const source = [
    polygonFeature({ id: 100, name: 'Union Bay Nature Park' }),
    polygonFeature({ id: 101, name: 'UNION BAY NATURE PARK', geometry: {
      type: 'MultiPolygon',
      coordinates: [
        [[[ -125, 49 ], [ -124.9, 49 ], [ -124.9, 49.1 ], [ -125, 49 ]]],
        [[[ -124.8, 49 ], [ -124.7, 49 ], [ -124.7, 49.1 ], [ -124.8, 49 ]]],
      ],
    }, municipality: 'Union Bay' }),
  ];
  const { groups, excluded } = groupRegionalParkFeatures(source);
  assert.equal(excluded.length, 0);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].properties.sourceIds, ['100', '101']);
  assert.equal(groups[0].properties.sourceFeatureCount, 2);
  assert.equal(groups[0].geometry.type, 'MultiPolygon');
  assert.equal(groups[0].geometry.coordinates.length, 3);
  assert.deepEqual(groups[0].properties.municipalityNames, ['Courtenay', 'Union Bay']);
  assert.equal(groups[0].properties.sourceAreaSqmSum, null);
});

test('excludes unidentifiable, undeveloped, existing-authority, invalid-geometry, and wrong-filter records', () => {
  const source = [
    polygonFeature({ id: 1, name: null }),
    polygonFeature({ id: 7, name: '<Null>' }),
    polygonFeature({ id: 2, name: 'Ness Lake (undeveloped)' }),
    polygonFeature({ id: 3, name: 'Existing Capital Park', district: 'Capital' }),
    polygonFeature({ id: 4, name: 'No Geometry Park', geometry: null }),
    polygonFeature({ id: 5, name: 'Not Regional', parkType: 'Municipal' }),
    polygonFeature({ id: 6, name: 'Valid Park' }),
  ];
  const { groups, excluded } = groupRegionalParkFeatures(source, { localAuthorityDistricts: ['Capital'] });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].properties.name, 'Valid Park');
  assert.deepEqual(excluded.map((feature) => feature.reason), [
    'park_name_missing',
    'park_name_missing',
    'undeveloped_site_not_confirmed_as_a_visitor_park',
    'existing_local_authority_inventory_has_precedence',
    'polygon_geometry_missing_or_unsupported',
    'outside_requested_park_type_and_primary_use_filter',
  ]);
});

test('paginates DataBC WFS results until numberMatched is satisfied', async () => {
  const requests = [];
  const sourceFeatures = [
    polygonFeature({ id: 10, name: 'Park 10' }),
    polygonFeature({ id: 11, name: 'Park 11' }),
    polygonFeature({ id: 12, name: 'Park 12' }),
  ];
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    requests.push(parsed);
    const start = Number(parsed.searchParams.get('startIndex'));
    const pageSize = Number(parsed.searchParams.get('count'));
    return fakeResponse({
      type: 'FeatureCollection',
      numberMatched: '3',
      features: sourceFeatures.slice(start, start + pageSize),
    });
  };
  const result = await fetchWfsRegionalParkFeatures({ fetchImpl, pageSize: 2 });
  assert.equal(result.features.length, 3);
  assert.equal(result.matchedCount, 3);
  assert.deepEqual(requests.map((url) => url.searchParams.get('startIndex')), ['0', '2']);
  assert.ok(requests.every((url) => url.searchParams.get('CQL_FILTER') === regionalGreenspacesSource.filter));
  assert.ok(requests.every((url) => url.searchParams.get('srsName') === 'EPSG:4326'));
});

test('paginates ArcGIS layer 40 and applies the same requested filter', async () => {
  const requests = [];
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    requests.push(parsed);
    if (parsed.searchParams.get('returnCountOnly') === 'true') return fakeResponse({ count: 3 });
    const start = Number(parsed.searchParams.get('resultOffset'));
    const rows = [
      { LOCAL_REG_GREENSPACE_ID: 10, OBJECTID: 100 },
      { LOCAL_REG_GREENSPACE_ID: 11, OBJECTID: 101 },
      { LOCAL_REG_GREENSPACE_ID: 12, OBJECTID: 102 },
    ];
    return fakeResponse({ features: rows.slice(start, start + 2).map((attributes) => ({ attributes })) });
  };
  const result = await fetchArcgisRegionalParkAudit({ fetchImpl, pageSize: 2 });
  assert.equal(result.features.length, 3);
  assert.equal(result.matchedCount, 3);
  const featureRequests = requests.filter((url) => url.searchParams.has('resultOffset'));
  assert.deepEqual(featureRequests.map((url) => url.searchParams.get('resultOffset')), ['0', '2']);
  assert.ok(requests.every((url) => url.searchParams.get('where') === regionalGreenspacesSource.filter));
});

test('reports all 27 legal regional districts, zero coverage, authority overlaps, and service count conflicts', () => {
  const capital = polygonFeature({ id: 21, name: 'Existing Park', district: 'Capital' });
  const source = [
    polygonFeature({ id: 1, name: 'New Park', district: 'Comox Valley' }),
    capital,
    polygonFeature({ id: 4, name: 'New Park', district: 'Comox Valley' }),
    polygonFeature({ id: 2, name: 'Northern Rockies Park', district: 'Northern Rockies' }),
    polygonFeature({ id: 3, name: 'Stikine Park', district: 'Stikine' }),
  ];
  const grouped = groupRegionalParkFeatures(source, { localAuthorityDistricts: ['Capital'] });
  const report = createRegionalGreenspacesReport({
    wfs: { features: source, matchedCount: 5, pageSize: 2 },
    arcgis: { features: [{ LOCAL_REG_GREENSPACE_ID: 1 }, { LOCAL_REG_GREENSPACE_ID: 5 }], matchedCount: 2, pageSize: 2 },
    grouped,
    catalogue: [{ category: 'regional', name: 'Existing Park', sourceName: 'Capital Regional District park GIS' }],
    retrievedAt: '2026-09-23T00:00:00.000Z',
  });
  assert.equal(report.coverage.officialRegionalDistrictCount, 27);
  assert.equal(report.coverage.byRegionalDistrict.length, 27);
  assert.equal(report.coverage.byRegionalDistrict.find((district) => district.regionalDistrict === 'Comox Valley').wfsFilteredSourceFeatureCount, 2);
  assert.equal(report.coverage.byRegionalDistrict.find((district) => district.regionalDistrict === 'Bulkley-Nechako').wfsFilteredSourceFeatureCount, 0);
  assert.equal(report.coverage.nonRegionalDistrictAuthorities[0].wfsFilteredSourceFeatureCount, 1);
  assert.equal(report.coverage.nonRegionalDistrictAuthorities[1].wfsFilteredSourceFeatureCount, 1);
  assert.equal(report.existingLocalAuthorityPrecedence[0].exactNormalizedNameMatchCount, 1);
  assert.equal(report.sourceDiscrepancy.commonLocalGreenspaceIdCount, 1);
  assert.deepEqual(report.sourceDiscrepancy.wfsOnlyLocalGreenspaceIds, ['2', '3', '4', '21']);
  assert.deepEqual(report.sourceDiscrepancy.arcgisOnlyLocalGreenspaceIds, ['5']);
  assert.equal(report.selection.duplicateNameGroupCount, 1);
  assert.equal(report.selection.mergedAdditionalSourceFeatureCount, 1);
  assert.equal(report.generatedAt, '2026-09-23T00:00:00.000Z');
  assert.equal(regionalDistricts.length, 27);
});

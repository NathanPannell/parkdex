import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const regionalGreenspacesSource = Object.freeze({
  datasetName: 'BC Local and Regional Greenspaces',
  datasetId: '6a2fea1b-0cc4-4fc2-8017-eaf755d516da',
  cataloguePage: 'https://catalogue.data.gov.bc.ca/dataset/6a2fea1b-0cc4-4fc2-8017-eaf755d516da',
  wfsEndpoint: 'https://openmaps.gov.bc.ca/geo/pub/WHSE_BASEMAPPING.GBA_LOCAL_REG_GREENSPACES_SP/ows',
  arcgisLayer: 'https://delivery.maps.gov.bc.ca/arcgis/rest/services/whse/bcgw_pub_whse_basemapping/MapServer/40',
  license: 'Open Government Licence - British Columbia',
  licenseUrl: 'https://www2.gov.bc.ca/gov/content/data/open-data/open-government-licence-bc',
  filter: "PARK_TYPE='Regional' AND PARK_PRIMARY_USE='Park'",
  attribution: 'Contains information licensed under the Open Government Licence - British Columbia.',
});

export const regionalDistricts = Object.freeze([
  { name: 'Alberni-Clayoquot', sourceNames: ['Alberni-Clayoquot'] },
  { name: 'Bulkley-Nechako', sourceNames: ['Bulkley-Nechako'] },
  { name: 'Capital', sourceNames: ['Capital'] },
  { name: 'Cariboo', sourceNames: ['Cariboo'] },
  { name: 'Central Coast', sourceNames: ['Central Coast'] },
  { name: 'Central Kootenay', sourceNames: ['Central Kootenay'] },
  { name: 'Central Okanagan', sourceNames: ['Central Okanagan'] },
  { name: 'Columbia-Shuswap', sourceNames: ['Columbia-Shuswap', 'Columbia Shuswap'] },
  { name: 'Comox Valley', sourceNames: ['Comox Valley'] },
  { name: 'Cowichan Valley', sourceNames: ['Cowichan Valley'] },
  { name: 'East Kootenay', sourceNames: ['East Kootenay'] },
  { name: 'Fraser-Fort George', sourceNames: ['Fraser-Fort George'] },
  { name: 'Fraser Valley', sourceNames: ['Fraser Valley'] },
  { name: 'Kitimat-Stikine', sourceNames: ['Kitimat-Stikine'] },
  { name: 'Kootenay Boundary', sourceNames: ['Kootenay Boundary'] },
  { name: 'Metro Vancouver', sourceNames: ['Metro Vancouver'] },
  { name: 'Mount Waddington', sourceNames: ['Mount Waddington'] },
  { name: 'Nanaimo', sourceNames: ['Nanaimo'] },
  { name: 'North Coast', sourceNames: ['North Coast'] },
  { name: 'North Okanagan', sourceNames: ['North Okanagan'] },
  { name: 'Okanagan-Similkameen', sourceNames: ['Okanagan-Similkameen'] },
  { name: 'Peace River', sourceNames: ['Peace River'] },
  { name: 'qathet', sourceNames: ['qathet', 'Powell River'] },
  { name: 'Squamish-Lillooet', sourceNames: ['Squamish-Lillooet'] },
  { name: 'Strathcona', sourceNames: ['Strathcona'] },
  { name: 'Sunshine Coast', sourceNames: ['Sunshine Coast'] },
  { name: 'Thompson-Nicola', sourceNames: ['Thompson-Nicola'] },
]);

const NON_DISTRICT_AUTHORITIES = Object.freeze([
  { name: 'Northern Rockies Regional Municipality', sourceNames: ['Northern Rockies'] },
  { name: 'Stikine Region', sourceNames: ['Stikine', 'Stikine Region'] },
]);

// These three regional authorities have local park inventories already used
// by Parkdex. Their local datasets remain authoritative for those places.
const LOCAL_AUTHORITY_PRECEDENCE = Object.freeze([
  {
    sourceDistrict: 'Capital',
    catalogueSourcePattern: /Capital Regional District/i,
    sourceName: 'Capital Regional District park GIS',
  },
  {
    sourceDistrict: 'Cowichan Valley',
    catalogueSourcePattern: /Cowichan Valley Regional District/i,
    sourceName: 'Cowichan Valley Regional District parks GIS',
  },
  {
    sourceDistrict: 'Nanaimo',
    catalogueSourcePattern: /Regional District of Nanaimo/i,
    sourceName: 'Regional District of Nanaimo regional parks spatial data',
  },
  {
    sourceDistrict: 'Mount Waddington',
    catalogueSourcePattern: /Regional District of Mount Waddington/i,
    sourceName: 'Regional District of Mount Waddington verified park records',
  },
]);

const PAGE_SIZE = 100;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT_DIR = resolve(ROOT, 'data/source-imports/regional-greenspaces');
const USER_AGENT = 'Parkdex regional greenspaces source importer';

function districtForSourceName(sourceName) {
  const value = String(sourceName ?? '').trim();
  for (const district of regionalDistricts) {
    if (district.sourceNames.some((name) => name.toLowerCase() === value.toLowerCase())) return district.name;
  }
  for (const authority of NON_DISTRICT_AUTHORITIES) {
    if (authority.sourceNames.some((name) => name.toLowerCase() === value.toLowerCase())) return authority.name;
  }
  return value || 'Unknown';
}

export function normalizeParkName(name) {
  return String(name ?? '')
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function numericOrTextCompare(a, b) {
  const left = String(a ?? '');
  const right = String(b ?? '');
  if (/^\d+$/.test(left) && /^\d+$/.test(right)) return Number(left) - Number(right);
  return left.localeCompare(right, 'en', { numeric: true, sensitivity: 'base' });
}

function uniqueSorted(values) {
  return [...new Set(values.filter((value) => value !== null && value !== undefined && String(value).trim() !== '').map((value) => String(value).trim()))]
    .sort(numericOrTextCompare);
}

function featureSourceId(feature) {
  const id = feature?.properties?.LOCAL_REG_GREENSPACE_ID;
  return id === null || id === undefined || String(id).trim() === '' ? null : String(id);
}

function geometryPolygons(geometry) {
  if (geometry?.type === 'Polygon' && Array.isArray(geometry.coordinates)) return [geometry.coordinates];
  if (geometry?.type === 'MultiPolygon' && Array.isArray(geometry.coordinates)) return geometry.coordinates;
  return null;
}

function safeArea(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isUndevelopedRecord(name) {
  return /\bundeveloped\b/i.test(String(name ?? ''));
}

function isMissingParkName(name) {
  const value = String(name ?? '').trim();
  return !normalizeParkName(value) || /^<\s*null\s*>$/i.test(value) || /^null$/i.test(value);
}

function sourceRecord(feature) {
  const p = feature.properties ?? {};
  return {
    sourceId: featureSourceId(feature),
    sourceObjectId: p.OBJECTID === null || p.OBJECTID === undefined ? null : String(p.OBJECTID),
    sourceName: p.PARK_NAME ?? null,
    sourceDistrict: p.REGIONAL_DISTRICT ?? null,
    municipality: p.MUNICIPALITY ?? null,
    whenUpdated: p.WHEN_UPDATED ?? null,
    websiteUrl: p.WEBSITE_URL ?? null,
    licenceComments: p.LICENCE_COMMENTS ?? null,
    areaSqm: safeArea(p.FEATURE_AREA_SQM),
    lengthM: safeArea(p.FEATURE_LENGTH_M),
  };
}

function compareSourceRecord(a, b) {
  return numericOrTextCompare(a.sourceId, b.sourceId) || numericOrTextCompare(a.sourceObjectId, b.sourceObjectId);
}

export function groupRegionalParkFeatures(features, { localAuthorityDistricts = [] } = {}) {
  const precedence = new Set(localAuthorityDistricts);
  const excluded = [];
  const includedByKey = new Map();

  for (const feature of features) {
    const properties = feature.properties ?? {};
    const sourceId = featureSourceId(feature);
    const rawDistrict = String(properties.REGIONAL_DISTRICT ?? '').trim();
    const district = districtForSourceName(rawDistrict);
    const name = String(properties.PARK_NAME ?? '').trim();
    const nameKey = normalizeParkName(name);
    const geometry = geometryPolygons(feature.geometry);
    let exclusionReason = null;
    if (properties.PARK_TYPE !== 'Regional' || properties.PARK_PRIMARY_USE !== 'Park') {
      exclusionReason = 'outside_requested_park_type_and_primary_use_filter';
    } else if (isMissingParkName(name)) {
      exclusionReason = 'park_name_missing';
    } else if (isUndevelopedRecord(name)) {
      exclusionReason = 'undeveloped_site_not_confirmed_as_a_visitor_park';
    } else if (precedence.has(district)) {
      exclusionReason = 'existing_local_authority_inventory_has_precedence';
    } else if (!geometry) {
      exclusionReason = 'polygon_geometry_missing_or_unsupported';
    }

    if (exclusionReason) {
      excluded.push({
        sourceId,
        sourceObjectId: properties.OBJECTID ?? null,
        name: name || null,
        regionalDistrict: district,
        sourceRegionalDistrict: rawDistrict || null,
        reason: exclusionReason,
      });
      continue;
    }

    const key = `${district}\u0000${nameKey}`;
    if (!includedByKey.has(key)) {
      includedByKey.set(key, {
        name,
        nameKey,
        district,
        sourceDistricts: new Set(),
        records: [],
        polygons: [],
      });
    }
    const group = includedByKey.get(key);
    group.sourceDistricts.add(rawDistrict);
    group.records.push(sourceRecord(feature));
    group.polygons.push(...geometry);
  }

  const groups = [...includedByKey.values()].map((group) => {
    const records = group.records.sort(compareSourceRecord);
    const sourceIds = uniqueSorted(records.map(({ sourceId }) => sourceId));
    const sourceObjectIds = uniqueSorted(records.map(({ sourceObjectId }) => sourceObjectId));
    const municipalities = uniqueSorted(records.map(({ municipality }) => municipality));
    const websites = uniqueSorted(records.map(({ websiteUrl }) => websiteUrl));
    const latestUpdate = uniqueSorted(records.map(({ whenUpdated }) => whenUpdated)).sort().at(-1) ?? null;
    const areas = records.map(({ areaSqm }) => areaSqm).filter(Number.isFinite);
    const lengths = records.map(({ lengthM }) => lengthM).filter(Number.isFinite);

    return {
      type: 'Feature',
      id: `bc-regional-${slug(group.district)}-${slug(group.name)}-${sourceIds[0] ?? sourceObjectIds[0] ?? 'unknown'}`,
      properties: {
        name: group.name,
        category: 'regional',
        regionalDistrict: group.district,
        sourceRegionalDistricts: uniqueSorted([...group.sourceDistricts]),
        municipalityNames: municipalities,
        sourceIds,
        sourceObjectIds,
        sourceFeatureCount: records.length,
        sourceUpdatedAt: latestUpdate,
        sourceAreaSqmSum: areas.length ? areas.reduce((sum, value) => sum + value, 0) : null,
        sourceLengthMSum: lengths.length ? lengths.reduce((sum, value) => sum + value, 0) : null,
        sourceWebsiteUrls: websites,
        sourceRecords: records,
        sourceDataset: regionalGreenspacesSource.datasetName,
        sourceDatasetId: regionalGreenspacesSource.datasetId,
        sourceUrl: regionalGreenspacesSource.cataloguePage,
        sourceDataUrl: regionalGreenspacesSource.wfsEndpoint,
        sourceLayerUrl: regionalGreenspacesSource.arcgisLayer,
        sourceFilter: regionalGreenspacesSource.filter,
        sourceLicense: regionalGreenspacesSource.license,
        sourceAttribution: regionalGreenspacesSource.attribution,
        geometryMerge: records.length > 1 ? 'MultiPolygon contains all source polygon components; no topological dissolve was applied.' : 'Source polygon retained as a one-part MultiPolygon.',
      },
      geometry: { type: 'MultiPolygon', coordinates: group.polygons },
    };
  }).sort((a, b) => numericOrTextCompare(a.properties.regionalDistrict, b.properties.regionalDistrict)
    || a.properties.name.localeCompare(b.properties.name, 'en', { sensitivity: 'base' }));

  return { groups, excluded };
}

function slug(value) {
  return normalizeParkName(value).replace(/\s+/g, '-').replace(/^-|-$/g, '') || 'unknown';
}

function parseMatchedCount(collection) {
  const raw = collection?.numberMatched ?? collection?.totalFeatures ?? collection?.numberOfFeatures;
  const count = Number(raw);
  return Number.isFinite(count) && count >= 0 ? count : null;
}

async function fetchJson(url, fetchImpl, label) {
  const response = await fetchImpl(url, { headers: { 'user-agent': USER_AGENT } });
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status} for ${url}`);
  return response.json();
}

export async function fetchWfsRegionalParkFeatures({ fetchImpl = fetch, pageSize = PAGE_SIZE } = {}) {
  const features = [];
  let matched = null;
  let startIndex = 0;
  while (startIndex < 100000) {
    const url = new URL(regionalGreenspacesSource.wfsEndpoint);
    url.search = new URLSearchParams({
      service: 'WFS',
      version: '2.0.0',
      request: 'GetFeature',
      typeNames: 'pub:WHSE_BASEMAPPING.GBA_LOCAL_REG_GREENSPACES_SP',
      outputFormat: 'application/json',
      srsName: 'EPSG:4326',
      count: String(pageSize),
      startIndex: String(startIndex),
      CQL_FILTER: regionalGreenspacesSource.filter,
    }).toString();
    const collection = await fetchJson(url, fetchImpl, 'BC DataBC WFS');
    if (collection.type !== 'FeatureCollection' || !Array.isArray(collection.features)) {
      throw new Error(`BC DataBC WFS returned an unexpected response at offset ${startIndex}`);
    }
    matched ??= parseMatchedCount(collection);
    features.push(...collection.features);
    if (collection.features.length === 0) break;
    startIndex += collection.features.length;
    if (matched !== null && startIndex >= matched) break;
    if (collection.features.length < pageSize && matched === null) break;
  }
  if (startIndex >= 100000) throw new Error('BC DataBC WFS pagination exceeded its safety limit');
  if (matched !== null && features.length !== matched) {
    throw new Error(`BC DataBC WFS pagination returned ${features.length} of ${matched} matched records`);
  }
  const ids = features.map(featureSourceId).filter(Boolean);
  if (new Set(ids).size !== ids.length) throw new Error('BC DataBC WFS pagination returned duplicate LOCAL_REG_GREENSPACE_ID values');
  return { features, matchedCount: matched, pageSize };
}

export async function fetchArcgisRegionalParkAudit({ fetchImpl = fetch, pageSize = 1000 } = {}) {
  const queryEndpoint = `${regionalGreenspacesSource.arcgisLayer}/query`;
  const countUrl = new URL(queryEndpoint);
  countUrl.search = new URLSearchParams({
    where: regionalGreenspacesSource.filter,
    returnCountOnly: 'true',
    f: 'json',
  }).toString();
  const countResponse = await fetchJson(countUrl, fetchImpl, 'BC GeoBC ArcGIS layer 40 count query');
  if (countResponse.error) throw new Error(`BC GeoBC ArcGIS layer 40 count query failed: ${JSON.stringify(countResponse.error)}`);
  const expectedCount = Number(countResponse.count);
  if (!Number.isFinite(expectedCount)) throw new Error('BC GeoBC ArcGIS layer 40 did not return a count');

  const features = [];
  let resultOffset = 0;
  while (resultOffset < 100000) {
    const url = new URL(queryEndpoint);
    url.search = new URLSearchParams({
      where: regionalGreenspacesSource.filter,
      outFields: 'LOCAL_REG_GREENSPACE_ID,REGIONAL_DISTRICT,PARK_NAME,OBJECTID',
      returnGeometry: 'false',
      resultOffset: String(resultOffset),
      resultRecordCount: String(pageSize),
      orderByFields: 'OBJECTID ASC',
      f: 'json',
    }).toString();
    const response = await fetchJson(url, fetchImpl, 'BC GeoBC ArcGIS layer 40 feature query');
    if (response.error) throw new Error(`BC GeoBC ArcGIS layer 40 query failed at offset ${resultOffset}: ${JSON.stringify(response.error)}`);
    if (!Array.isArray(response.features)) throw new Error(`BC GeoBC ArcGIS layer 40 returned no feature array at offset ${resultOffset}`);
    features.push(...response.features.map(({ attributes }) => attributes ?? {}));
    resultOffset += response.features.length;
    if (response.features.length === 0 || resultOffset >= expectedCount) break;
    if (response.features.length < pageSize && !response.exceededTransferLimit) break;
  }
  if (resultOffset >= 100000) throw new Error('BC GeoBC ArcGIS layer 40 pagination exceeded its safety limit');
  if (features.length !== expectedCount) {
    throw new Error(`BC GeoBC ArcGIS layer 40 pagination returned ${features.length} of ${expectedCount} matched records`);
  }
  const ids = features.map((feature) => feature.LOCAL_REG_GREENSPACE_ID).filter((id) => id !== null && id !== undefined).map(String);
  if (new Set(ids).size !== ids.length) throw new Error('BC GeoBC ArcGIS layer 40 pagination returned duplicate LOCAL_REG_GREENSPACE_ID values');
  return { features, matchedCount: expectedCount, pageSize };
}

function localAuthorityInventory(catalogue, wfsFeatures) {
  const regionalPlaces = Array.isArray(catalogue)
    ? catalogue.filter((place) => place?.category === 'regional')
    : [];
  return LOCAL_AUTHORITY_PRECEDENCE.map((authority) => {
    const existingPlaces = regionalPlaces.filter((place) => authority.catalogueSourcePattern.test(String(place.sourceName ?? '')));
    const existingByName = new Map();
    for (const place of existingPlaces) {
      const key = normalizeParkName(place.name);
      if (key) existingByName.set(key, place.name);
    }

    const wfsByName = new Map();
    const matchingWfsFeatures = wfsFeatures.filter((feature) => districtForSourceName(feature.properties?.REGIONAL_DISTRICT) === authority.sourceDistrict);
    for (const feature of matchingWfsFeatures) {
      const name = String(feature.properties?.PARK_NAME ?? '').trim();
      const key = normalizeParkName(name);
      if (key) wfsByName.set(key, name);
    }
    const exactMatchKeys = [...existingByName.keys()].filter((key) => wfsByName.has(key));
    return {
      authority: authority.sourceDistrict,
      existingInventorySource: authority.sourceName,
      existingCatalogueRecordCount: existingPlaces.length,
      wfsFilteredFeatureCount: matchingWfsFeatures.length,
      wfsDistinctNamedParkCount: wfsByName.size,
      exactNormalizedNameMatchCount: exactMatchKeys.length,
      exactNormalizedNameMatches: exactMatchKeys.sort().map((key) => ({ catalogueName: existingByName.get(key), sourceName: wfsByName.get(key) })),
      catalogueNamesWithoutExactWfsMatch: [...existingByName.entries()].filter(([key]) => !wfsByName.has(key)).map(([, name]) => name).sort(),
      wfsNamesWithoutExactCatalogueMatch: [...wfsByName.entries()].filter(([key]) => !existingByName.has(key)).map(([, name]) => name).sort(),
      note: 'Name comparison uses normalized spelling only. Unmatched names need review and do not prove that either inventory is complete.',
    };
  });
}

function coverageReport(features, grouped) {
  const districtCounts = new Map();
  const candidateCounts = new Map();
  const excludedCounts = new Map();
  for (const feature of features) {
    const name = districtForSourceName(feature.properties?.REGIONAL_DISTRICT);
    districtCounts.set(name, (districtCounts.get(name) ?? 0) + 1);
  }
  for (const feature of grouped.groups) {
    const name = feature.properties.regionalDistrict;
    candidateCounts.set(name, (candidateCounts.get(name) ?? 0) + 1);
  }
  for (const feature of grouped.excluded) {
    const name = feature.regionalDistrict;
    excludedCounts.set(name, (excludedCounts.get(name) ?? 0) + 1);
  }
  return regionalDistricts.map(({ name }) => ({
    regionalDistrict: name,
    wfsFilteredSourceFeatureCount: districtCounts.get(name) ?? 0,
    normalizedIntegrationCandidateParkCount: candidateCounts.get(name) ?? 0,
    excludedSourceFeatureCount: excludedCounts.get(name) ?? 0,
    representedByFilteredSource: (districtCounts.get(name) ?? 0) > 0,
  }));
}

function sourceNameRange(features) {
  const dates = uniqueSorted(features.map((feature) => feature.properties?.WHEN_UPDATED)).sort();
  return { earliestWhenUpdated: dates[0] ?? null, latestWhenUpdated: dates.at(-1) ?? null };
}

function discrepancyReport(wfs, arcgis) {
  const wfsById = new Map(wfs.map((feature) => [featureSourceId(feature), feature]).filter(([id]) => id));
  const arcgisById = new Map(arcgis.map((feature) => [String(feature.LOCAL_REG_GREENSPACE_ID), feature]).filter(([id]) => id && id !== 'null' && id !== 'undefined'));
  const commonIds = [...wfsById.keys()].filter((id) => arcgisById.has(id));
  return {
    wfsFilteredFeatureCount: wfs.length,
    arcgisLayer40FilteredFeatureCount: arcgis.length,
    commonLocalGreenspaceIdCount: commonIds.length,
    wfsOnlyLocalGreenspaceIds: [...wfsById.keys()].filter((id) => !arcgisById.has(id)).sort(numericOrTextCompare),
    arcgisOnlyLocalGreenspaceIds: [...arcgisById.keys()].filter((id) => !wfsById.has(id)).sort(numericOrTextCompare),
    comparisonField: 'LOCAL_REG_GREENSPACE_ID',
    note: 'The WFS and ArcGIS layer 40 are separate official service publications. Their count and ID differences are recorded as a source discrepancy, not treated as pagination loss or silently reconciled.',
  };
}

function duplicateNameGroups(features, candidateGroups) {
  const candidateKeys = new Set(candidateGroups.map((feature) => `${feature.properties.regionalDistrict}\u0000${normalizeParkName(feature.properties.name)}`));
  const byKey = new Map();
  for (const feature of features) {
    const district = districtForSourceName(feature.properties?.REGIONAL_DISTRICT);
    const name = String(feature.properties?.PARK_NAME ?? '').trim();
    const nameKey = normalizeParkName(name);
    const key = `${district}\u0000${nameKey}`;
    if (!byKey.has(key)) byKey.set(key, { district, nameKey, names: new Set(), records: [] });
    const group = byKey.get(key);
    if (name) group.names.add(name);
    group.records.push(sourceRecord(feature));
  }
  return [...byKey.entries()]
    .filter(([, group]) => group.records.length > 1)
    .map(([key, group]) => ({
      regionalDistrict: group.district,
      names: [...group.names].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' })),
      sourceFeatureCount: group.records.length,
      additionalPolygonFeatureCount: group.records.length - 1,
      sourceIds: uniqueSorted(group.records.map(({ sourceId }) => sourceId)),
      includedInCandidateGeojson: candidateKeys.has(key),
    }))
    .sort((a, b) => numericOrTextCompare(a.regionalDistrict, b.regionalDistrict)
      || a.names.join('|').localeCompare(b.names.join('|'), 'en', { sensitivity: 'base' }));
}

function dateIso(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.valueOf()) ? new Date().toISOString() : date.toISOString();
}

export function createRegionalGreenspacesReport({ wfs, arcgis, grouped, catalogue = [], retrievedAt = new Date() }) {
  const regionCounts = new Map();
  const otherAuthorities = NON_DISTRICT_AUTHORITIES.map(({ name, sourceNames }) => {
    const count = wfs.features.filter((feature) => sourceNames.some((sourceName) => String(feature.properties?.REGIONAL_DISTRICT ?? '').trim().toLowerCase() === sourceName.toLowerCase())).length;
    regionCounts.set(name, count);
    return { authority: name, wfsFilteredSourceFeatureCount: count };
  });
  const representedDistricts = coverageReport(wfs.features, grouped).filter((entry) => entry.representedByFilteredSource).length;
  const reviewItems = grouped.excluded.filter((item) => item.reason !== 'existing_local_authority_inventory_has_precedence');
  const byExclusionReason = {};
  for (const item of grouped.excluded) byExclusionReason[item.reason] = (byExclusionReason[item.reason] ?? 0) + 1;
  const duplicateGroups = duplicateNameGroups(wfs.features, grouped.groups);

  return {
    schemaVersion: 1,
    generatedAt: dateIso(retrievedAt),
    sources: {
      primaryPolygons: {
        name: regionalGreenspacesSource.datasetName,
        datasetId: regionalGreenspacesSource.datasetId,
        cataloguePage: regionalGreenspacesSource.cataloguePage,
        serviceUrl: regionalGreenspacesSource.wfsEndpoint,
        featureType: 'pub:WHSE_BASEMAPPING.GBA_LOCAL_REG_GREENSPACES_SP',
        filter: regionalGreenspacesSource.filter,
        pagination: { pageSize: wfs.pageSize, matchedCount: wfs.matchedCount, retrievedFeatureCount: wfs.features.length },
        licence: regionalGreenspacesSource.license,
        licenceUrl: regionalGreenspacesSource.licenseUrl,
        attribution: regionalGreenspacesSource.attribution,
        sourceUpdateField: 'WHEN_UPDATED',
        sourceUpdateRange: sourceNameRange(wfs.features),
      },
      officialCrossCheck: {
        name: 'GeoBC provincial base mapping service, Local and Regional Greenspaces layer 40',
        serviceUrl: regionalGreenspacesSource.arcgisLayer,
        queryUrl: `${regionalGreenspacesSource.arcgisLayer}/query`,
        filter: regionalGreenspacesSource.filter,
        pagination: { pageSize: arcgis.pageSize, matchedCount: arcgis.matchedCount, retrievedFeatureCount: arcgis.features.length },
        purpose: 'Independent count and LOCAL_REG_GREENSPACE_ID cross-check. WFS supplies output polygon geometry.',
      },
    },
    sourceDiscrepancy: discrepancyReport(wfs.features, arcgis.features),
    coverage: {
      officialRegionalDistrictCount: regionalDistricts.length,
      districtsRepresentedByFilteredWfsRecords: representedDistricts,
      districtsWithNoFilteredWfsRecords: coverageReport(wfs.features, grouped).filter((entry) => !entry.representedByFilteredSource).map((entry) => entry.regionalDistrict),
      byRegionalDistrict: coverageReport(wfs.features, grouped),
      nonRegionalDistrictAuthorities: otherAuthorities,
    },
    selection: {
      requestedFilter: regionalGreenspacesSource.filter,
      sourceFeatureCount: wfs.features.length,
      normalizedIntegrationCandidateParkCount: grouped.groups.length,
      candidateSourceFeatureCount: grouped.groups.reduce((sum, feature) => sum + feature.properties.sourceFeatureCount, 0),
      excludedSourceFeatureCount: grouped.excluded.length,
      exclusionCounts: byExclusionReason,
      reviewItems,
      duplicateNameGroupCount: duplicateGroups.length,
      mergedAdditionalSourceFeatureCount: duplicateGroups.filter((group) => group.includedInCandidateGeojson).reduce((sum, group) => sum + group.additionalPolygonFeatureCount, 0),
      duplicateNameGroups: duplicateGroups,
      grouping: 'Features are grouped by canonical regional district and normalized park name. Their polygon components are retained together as a MultiPolygon, and every LOCAL_REG_GREENSPACE_ID and OBJECTID remains in properties.sourceRecords.',
    },
    existingLocalAuthorityPrecedence: localAuthorityInventory(catalogue, wfs.features),
    integrationNotes: [
      'Use the local Capital, Cowichan Valley, and Nanaimo GIS inventories where they are already integrated. Their provincial WFS records are excluded from the candidate GeoJSON and listed in the authority comparison.',
      'The WFS has no filtered source features for Mount Waddington. Parkdex already has four Mount Waddington records; retain that existing source until an authority polygon source is available.',
      'Blank park names and names containing Undeveloped are excluded for review because the filter alone does not confirm an identifiable visitor park.',
      'Repeated name rows in one district are merged as geometry components, without dissolving polygon topology. Review the grouped source IDs before treating the result as final park boundaries.',
      'The dataset is an irregularly updated official inventory. A zero count means no feature matched this dataset filter at retrieval time, not that the regional district has no parks.',
    ],
  };
}

async function loadCatalogue(path) {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
    return Array.isArray(value) ? value : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export async function runRegionalGreenspacesImport({ root = ROOT, fetchImpl = fetch, retrievedAt = new Date() } = {}) {
  const wfs = await fetchWfsRegionalParkFeatures({ fetchImpl });
  const arcgis = await fetchArcgisRegionalParkAudit({ fetchImpl });
  const localAuthorityDistricts = LOCAL_AUTHORITY_PRECEDENCE
    .filter(({ sourceDistrict }) => ['Capital', 'Cowichan Valley', 'Nanaimo'].includes(sourceDistrict))
    .map(({ sourceDistrict }) => sourceDistrict);
  const grouped = groupRegionalParkFeatures(wfs.features, { localAuthorityDistricts });
  const cataloguePath = resolve(root, 'data/places.json');
  const catalogue = await loadCatalogue(cataloguePath);
  const report = createRegionalGreenspacesReport({ wfs, arcgis, grouped, catalogue, retrievedAt });
  const geojson = {
    type: 'FeatureCollection',
    name: 'Parkdex candidate BC regional parks from DataBC Local and Regional Greenspaces',
    metadata: {
      datasetName: regionalGreenspacesSource.datasetName,
      datasetId: regionalGreenspacesSource.datasetId,
      sourceUrl: regionalGreenspacesSource.cataloguePage,
      serviceUrl: regionalGreenspacesSource.wfsEndpoint,
      retrievedAt: dateIso(retrievedAt),
      filter: regionalGreenspacesSource.filter,
      licence: regionalGreenspacesSource.license,
      attribution: regionalGreenspacesSource.attribution,
      candidateCount: grouped.groups.length,
      sourceFeatureCount: wfs.features.length,
    },
    features: grouped.groups,
  };
  const outputDirectory = resolve(root, 'data/source-imports/regional-greenspaces');
  await mkdir(outputDirectory, { recursive: true });
  const geojsonPath = resolve(outputDirectory, 'new-regional-parks.geojson');
  const reportPath = resolve(outputDirectory, 'integration-report.json');
  await Promise.all([
    writeFile(geojsonPath, `${JSON.stringify(geojson)}\n`, 'utf8'),
    writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8'),
  ]);
  return { geojsonPath, reportPath, candidateCount: grouped.groups.length, report };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const result = await runRegionalGreenspacesImport();
    process.stdout.write(`${JSON.stringify({
      geojsonPath: result.geojsonPath,
      reportPath: result.reportPath,
      candidateCount: result.candidateCount,
      sourceDiscrepancy: {
        wfsCount: result.report.sourceDiscrepancy.wfsFilteredFeatureCount,
        arcgisLayer40Count: result.report.sourceDiscrepancy.arcgisLayer40FilteredFeatureCount,
        commonLocalGreenspaceIdCount: result.report.sourceDiscrepancy.commonLocalGreenspaceIdCount,
        wfsOnlyIdCount: result.report.sourceDiscrepancy.wfsOnlyLocalGreenspaceIds.length,
        arcgisOnlyIdCount: result.report.sourceDiscrepancy.arcgisOnlyLocalGreenspaceIds.length,
      },
      districtsRepresented: result.report.coverage.districtsRepresentedByFilteredWfsRecords,
      districtsWithoutRecords: result.report.coverage.districtsWithNoFilteredWfsRecords,
    }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  }
}

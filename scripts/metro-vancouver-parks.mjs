import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const metroVancouverParkSource = Object.freeze({
  name: 'Metro Vancouver Regional Parks',
  page: 'https://open-data-portal-metrovancouver.hub.arcgis.com/datasets/metrovancouver::regional-parks-boundaries-open-data',
  layerUrl: 'https://services6.arcgis.com/56eqCzQ5SZhBaDST/ArcGIS/rest/services/Regional_Parks_Boundaries/FeatureServer/11',
  layerId: 11,
  layerName: 'Regional Parks Boundaries',
  sourceItemId: '2fbf1ad2936a404fa79ad8e0ae83f45c',
  copyright: 'Metro Vancouver - Regional Parks',
  license: 'Open Government Licence',
  description: 'Park boundary polygons are split by developed roads, exclude in-holdings, and include undeveloped dedicated road areas.',
  includeType: 'Regional Park',
  excludeTypes: Object.freeze(['Regional Greenway', 'Regional Park Reserve', 'Ecological Conservancy Area']),
});

const sourceFields = 'OBJECTID,globalid,operatingarea,parkcode,parkname,parkshortname,type';

export function createMetroVancouverParkQueryUrl() {
  const url = new URL(`${metroVancouverParkSource.layerUrl}/query`);
  url.searchParams.set('where', '1=1');
  url.searchParams.set('outFields', sourceFields);
  url.searchParams.set('returnGeometry', 'true');
  url.searchParams.set('outSR', '4326');
  url.searchParams.set('f', 'geojson');
  return url;
}

function field(properties, name) {
  const lowerName = name.toLowerCase();
  const key = Object.keys(properties).find((candidate) => candidate.toLowerCase() === lowerName);
  return key === undefined ? undefined : properties[key];
}

function requiredText(properties, fieldName, featureIndex) {
  const value = field(properties, fieldName);
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Metro Vancouver source feature ${featureIndex} has no ${fieldName}`);
  }
  return value.trim();
}

function polygonParts(geometry, featureIndex) {
  if (geometry?.type === 'Polygon' && Array.isArray(geometry.coordinates) && geometry.coordinates.length) {
    return [geometry.coordinates];
  }
  if (geometry?.type === 'MultiPolygon' && Array.isArray(geometry.coordinates) && geometry.coordinates.length) {
    return geometry.coordinates;
  }
  throw new Error(`Metro Vancouver source feature ${featureIndex} has unsupported or empty geometry`);
}

function compareSourceIds(left, right) {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber - rightNumber;
  return String(left).localeCompare(String(right));
}

function stableId(parkcode) {
  return `metro-vancouver-${parkcode.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

export function normalizeMetroVancouverParks(collection) {
  if (collection?.type !== 'FeatureCollection' || !Array.isArray(collection.features)) {
    throw new Error('Metro Vancouver source must return a GeoJSON FeatureCollection');
  }

  const parksByCode = new Map();
  const sourceTypeCounts = {};

  collection.features.forEach((feature, featureIndex) => {
    const properties = feature?.properties;
    if (!properties || typeof properties !== 'object') {
      throw new Error(`Metro Vancouver source feature ${featureIndex} has no properties`);
    }
    const type = field(properties, 'type');
    const typeName = typeof type === 'string' ? type.trim() : '';
    sourceTypeCounts[typeName || '(missing)'] = (sourceTypeCounts[typeName || '(missing)'] || 0) + 1;
    if (typeName !== metroVancouverParkSource.includeType) return;

    const parkcode = requiredText(properties, 'parkcode', featureIndex).toUpperCase();
    const name = requiredText(properties, 'parkname', featureIndex);
    const shortName = requiredText(properties, 'parkshortname', featureIndex);
    const operatingArea = requiredText(properties, 'operatingarea', featureIndex);
    const parts = polygonParts(feature.geometry, featureIndex);
    const objectId = field(properties, 'OBJECTID');
    const globalId = field(properties, 'globalid');

    let park = parksByCode.get(parkcode);
    if (!park) {
      park = {
        parkcode,
        name,
        shortName,
        operatingArea,
        parts: [],
        sourceObjectIds: new Set(),
        sourceGlobalIds: new Set(),
      };
      parksByCode.set(parkcode, park);
    } else if (park.name !== name || park.shortName !== shortName || park.operatingArea !== operatingArea) {
      throw new Error(`Metro Vancouver park code ${parkcode} has conflicting source attributes`);
    }

    park.parts.push(...parts);
    if (objectId !== undefined && objectId !== null) park.sourceObjectIds.add(String(objectId));
    if (globalId !== undefined && globalId !== null && String(globalId).trim()) park.sourceGlobalIds.add(String(globalId));
  });

  const features = [...parksByCode.values()]
    .sort((left, right) => left.parkcode.localeCompare(right.parkcode))
    .map((park) => {
      const id = stableId(park.parkcode);
      const geometry = park.parts.length === 1
        ? { type: 'Polygon', coordinates: park.parts[0] }
        : { type: 'MultiPolygon', coordinates: park.parts };
      const sourceObjectIds = [...park.sourceObjectIds].sort(compareSourceIds);
      const sourceGlobalIds = [...park.sourceGlobalIds].sort((left, right) => left.localeCompare(right));
      return {
        type: 'Feature',
        id,
        properties: {
          id,
          name: park.name,
          shortName: park.shortName,
          category: 'regional',
          parkcode: park.parkcode,
          parkType: metroVancouverParkSource.includeType,
          operatingArea: park.operatingArea,
          sourceName: metroVancouverParkSource.name,
          sourceUrl: metroVancouverParkSource.page,
          sourceDataUrl: metroVancouverParkSource.layerUrl,
          sourceId: park.parkcode,
          sourceObjectIds,
          sourceGlobalIds,
          sourceCopyright: metroVancouverParkSource.copyright,
          license: metroVancouverParkSource.license,
        },
        geometry,
      };
    });

  return {
    type: 'FeatureCollection',
    name: 'Metro Vancouver Regional Parks',
    metadata: {
      sourceName: metroVancouverParkSource.name,
      sourceUrl: metroVancouverParkSource.page,
      sourceDataUrl: metroVancouverParkSource.layerUrl,
      sourceItemId: metroVancouverParkSource.sourceItemId,
      sourceLayerId: metroVancouverParkSource.layerId,
      sourceLayerName: metroVancouverParkSource.layerName,
      copyright: metroVancouverParkSource.copyright,
      license: metroVancouverParkSource.license,
      includedType: metroVancouverParkSource.includeType,
      excludedTypes: metroVancouverParkSource.excludeTypes,
      geometryDescription: metroVancouverParkSource.description,
      sourceTypeCounts,
      parkCount: features.length,
    },
    features,
  };
}

export async function fetchMetroVancouverParks({ fetchImpl = fetch } = {}) {
  const url = createMetroVancouverParkQueryUrl();
  const response = await fetchImpl(url, {
    headers: { 'user-agent': 'parkdex-data-builder/1.0' },
  });
  if (!response.ok) throw new Error(`Metro Vancouver park source returned ${response.status} ${response.statusText}`);
  return normalizeMetroVancouverParks(await response.json());
}

async function runCli() {
  const collection = await fetchMetroVancouverParks();
  const serialized = `${JSON.stringify(collection)}\n`;
  const outputIndex = process.argv.indexOf('--output');
  if (outputIndex !== -1) {
    const outputPath = process.argv[outputIndex + 1];
    if (!outputPath) throw new Error('--output requires a file path');
    await writeFile(resolve(outputPath), serialized);
    process.stderr.write(`Wrote ${collection.features.length} Metro Vancouver park boundaries to ${resolve(outputPath)}.\n`);
    return;
  }
  process.stdout.write(serialized);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

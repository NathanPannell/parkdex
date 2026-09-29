import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const rdcoParkSource = Object.freeze({
  name: 'Regional District of Central Okanagan Regional Parks',
  page: 'https://www.rdco.com/parktours',
  layerUrl: 'https://www.rdcogis.com/arcgis/rest/services/DataDownload/RDCO_Parks_Data_Download/FeatureServer/9',
  layerId: 9,
  layerName: 'Parks Main',
  copyright: 'RDCO',
  license: null,
  licenseNote: 'The official FeatureServer does not declare a reuse license.',
});

// This is the RDCO directory's regional-park list, mapped to the names used by
// the polygon layer. Community-park rows can have "Regional Park" in CommonName,
// so inclusion intentionally depends on this official directory match instead.
const directoryEntries = [
  ['Antlers Beach', ['Antlers Beach']],
  ['Bertram Creek', ['Bertram Creek']],
  ['Coldham', ['Coldham']],
  ['Gellatly Heritage', ['Gellatly Heritage']],
  ['Gellatly Nut Farm', ['Gellatly Nut Farm']],
  ['Glen Canyon', ['Glen Canyon']],
  ['Goats Peak', ['Goats Peak']],
  ['Hardy Falls', ['Hardy Falls']],
  ['Johns Family Nature Conservancy', ['Johns Family Nature Conservancy']],
  ['Kalamoir', ['Kalamoir']],
  ['Kaloya', ['Kaloya']],
  ['KLO Creek', ['KLO Creek']],
  ['Kopje', ['Kopje']],
  ['Lebanon Creek Greenway', ['Lebanon Creek Greenway']],
  ['McCulloch Station', ['McCulloch Station']],
  ['Mill Creek', ['Mill Creek']],
  ['Mission Creek Greenway', ['Mission Creek Greenway']],
  ['Mission Creek', ['Mission Creek']],
  ['Okanagan Centre Safe Harbour', ['Okanagan Centre Safe Harbour']],
  ['Raymer Bay', ['Raymer Bay']],
  ['Reiswig', ['Reiswig']],
  ['Robert Lake', ['Robert Lake']],
  ['Rose Valley', ['Rose Valley']],
  ['Scenic Canyon', ['Scenic Canyon']],
  ['Shannon Lake', ['Shannon Lake']],
  ["sntsk'il'ntən - Black Mountain", ["Black Mountain / Sntsk'il'nten"]],
  ['Stephens Coyote Ridge', ['Stephens Coyote']],
  ['Traders Cove', ['Traders Cove']],
  ['Trepanier Creek Greenway', ['Trepanier Creek Greenway']],
  ['Woodhaven Nature Conservancy', ['Woodhaven Nature Conservancy']],
];

function normalizeParkName(value) {
  return value.normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase('en-CA').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export const rdcoRegionalParkDirectory = Object.freeze(directoryEntries.map(([name]) => name));
const directoryNameByLayerName = new Map();
for (const [directoryName, layerNames] of directoryEntries) {
  for (const layerName of [...layerNames, directoryName]) {
    directoryNameByLayerName.set(normalizeParkName(layerName), directoryName);
  }
}

const sourceFields = [
  'OBJECTID', 'GlobalID', 'PrkNumb', 'PARK_NAME', 'CommonName', 'Area_ha',
  'ImageURL', 'AllAmenities', 'Address', 'Accessible', 'Dog_OnL', 'DogsOnLeash',
  'Trails', 'ParkTourURL', 'IntActMapURL', 'GoogleDir', 'PDFMapURL', 'prkHours',
  'PARKING', 'Playground', 'Washrooms', 'Swimming', 'Boat_launc', 'Boat_Beach',
  'Picnic_Are', 'Camping', 'SPORTS', 'Docking_Fa', 'Viewpoints', 'Waterfall',
].join(',');

export function createRdcoParkQueryUrl() {
  const url = new URL(rdcoParkSource.layerUrl + '/query');
  url.searchParams.set('where', '1=1');
  url.searchParams.set('outFields', sourceFields);
  url.searchParams.set('returnGeometry', 'true');
  url.searchParams.set('outSR', '4326');
  url.searchParams.set('resultRecordCount', '2000');
  url.searchParams.set('f', 'geojson');
  return url;
}

function field(properties, name) {
  const lowerName = name.toLowerCase();
  const key = Object.keys(properties).find((candidate) => candidate.toLowerCase() === lowerName);
  return key === undefined ? undefined : properties[key];
}

function cleanText(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text && text !== '~' ? text : null;
}

function requiredText(properties, name, featureIndex) {
  const value = cleanText(field(properties, name));
  if (!value) throw new Error('RDCO source feature ' + featureIndex + ' has no ' + name);
  return value;
}

function polygonParts(geometry, featureIndex) {
  if (geometry?.type === 'Polygon' && Array.isArray(geometry.coordinates) && geometry.coordinates.length) {
    return [geometry.coordinates];
  }
  if (geometry?.type === 'MultiPolygon' && Array.isArray(geometry.coordinates) && geometry.coordinates.length) {
    return geometry.coordinates;
  }
  throw new Error('RDCO source feature ' + featureIndex + ' has unsupported or empty geometry');
}

function compareIds(left, right) {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber - rightNumber;
  return String(left).localeCompare(String(right), 'en-CA');
}

function stableId(parkNumber) {
  return 'regional-central-okanagan-' + parkNumber.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function firstText(park, properties, fieldName) {
  if (park[fieldName] !== undefined && park[fieldName] !== null) return;
  const value = cleanText(field(properties, fieldName));
  if (value) park[fieldName] = value;
}

export function normalizeRdcoParks(collection) {
  if (collection?.type !== 'FeatureCollection' || !Array.isArray(collection.features)) {
    throw new Error('RDCO source must return a GeoJSON FeatureCollection');
  }

  const parksByNumber = new Map();
  let excludedFeatureCount = 0;
  collection.features.forEach((feature, featureIndex) => {
    const properties = feature?.properties;
    if (!properties || typeof properties !== 'object') {
      throw new Error('RDCO source feature ' + featureIndex + ' has no properties');
    }
    const sourceParkName = requiredText(properties, 'PARK_NAME', featureIndex);
    const name = directoryNameByLayerName.get(normalizeParkName(sourceParkName));
    if (!name) {
      excludedFeatureCount += 1;
      return;
    }

    const parkNumber = requiredText(properties, 'PrkNumb', featureIndex);
    const parts = polygonParts(feature.geometry, featureIndex);
    let park = parksByNumber.get(parkNumber);
    if (!park) {
      park = {
        parkNumber,
        name,
        parts: [],
        sourceParkNames: new Set(),
        sourceCommonNames: new Set(),
        sourceObjectIds: new Set(),
        sourceGlobalIds: new Set(),
      };
      parksByNumber.set(parkNumber, park);
    } else if (park.name !== name) {
      throw new Error('RDCO park number ' + parkNumber + ' is assigned to multiple directory parks');
    }

    park.parts.push(...parts);
    park.sourceParkNames.add(sourceParkName);
    const commonName = cleanText(field(properties, 'CommonName'));
    if (commonName) park.sourceCommonNames.add(commonName);
    const objectId = field(properties, 'OBJECTID');
    if (objectId !== undefined && objectId !== null) park.sourceObjectIds.add(String(objectId));
    const globalId = cleanText(field(properties, 'GlobalID'));
    if (globalId) park.sourceGlobalIds.add(globalId);
    if (park.Area_ha === undefined) {
      const sourceArea = field(properties, 'Area_ha');
      const area = sourceArea === null || sourceArea === undefined ? Number.NaN : Number(sourceArea);
      if (Number.isFinite(area)) park.Area_ha = area;
    }
    for (const fieldName of [
      'ImageURL', 'AllAmenities', 'Address', 'Accessible', 'Dog_OnL', 'DogsOnLeash',
      'Trails', 'ParkTourURL', 'IntActMapURL', 'GoogleDir', 'PDFMapURL', 'prkHours', 'Parking',
      'Playground', 'Washrooms', 'Swimming', 'Boat_launc', 'Boat_Beach', 'Picnic_Are', 'Camping',
      'SPORTS', 'Docking_Fa', 'Viewpoints', 'Waterfall',
    ]) firstText(park, properties, fieldName);
  });

  const features = [...parksByNumber.values()]
    .sort((left, right) => compareIds(left.parkNumber, right.parkNumber))
    .map((park) => {
      const id = stableId(park.parkNumber);
      const amenities = (park.AllAmenities ?? '').split(',').map((item) => item.trim()).filter(Boolean);
      const geometry = park.parts.length === 1
        ? { type: 'Polygon', coordinates: park.parts[0] }
        : { type: 'MultiPolygon', coordinates: park.parts };
      const properties = {
        id,
        name: park.name,
        category: 'regional',
        region: 'Central Okanagan',
        sourceName: rdcoParkSource.name,
        sourceUrl: rdcoParkSource.page,
        sourceDataUrl: rdcoParkSource.layerUrl,
        sourceId: park.parkNumber,
        sourceParkNumber: park.parkNumber,
        sourceParkNames: [...park.sourceParkNames].sort((left, right) => left.localeCompare(right, 'en-CA')),
        sourceCommonNames: [...park.sourceCommonNames].sort((left, right) => left.localeCompare(right, 'en-CA')),
        sourceObjectIds: [...park.sourceObjectIds].sort(compareIds),
        sourceGlobalIds: [...park.sourceGlobalIds].sort((left, right) => left.localeCompare(right, 'en-CA')),
        sourceCopyright: rdcoParkSource.copyright,
        license: rdcoParkSource.license,
        licenseNote: rdcoParkSource.licenseNote,
        areaHectares: Number.isFinite(Number(park.Area_ha)) ? Number(park.Area_ha) : null,
        imageUrl: park.ImageURL ?? null,
        amenities,
        address: park.Address ?? null,
        accessible: park.Accessible ?? null,
        dogPolicy: park.DogsOnLeash ?? park.Dog_OnL ?? null,
        trails: park.Trails ?? null,
        parkTourUrl: park.ParkTourURL ?? null,
        interactiveMapUrl: park.IntActMapURL ?? null,
        directionsUrl: park.GoogleDir ?? null,
        mapUrl: park.PDFMapURL ?? null,
        seasonalHours: park.prkHours ?? null,
      };
      return { type: 'Feature', id, properties, geometry };
    });

  return {
    type: 'FeatureCollection',
    name: 'Regional District of Central Okanagan Regional Parks',
    metadata: {
      sourceName: rdcoParkSource.name,
      sourceUrl: rdcoParkSource.page,
      sourceDataUrl: rdcoParkSource.layerUrl,
      sourceLayerId: rdcoParkSource.layerId,
      sourceLayerName: rdcoParkSource.layerName,
      copyright: rdcoParkSource.copyright,
      license: rdcoParkSource.license,
      licenseNote: rdcoParkSource.licenseNote,
      inclusionRule: 'PARK_NAME must match a park in the RDCO official regional park directory.',
      directoryParkNames: rdcoRegionalParkDirectory,
      sourceFeatureCount: collection.features.length,
      includedSourceFeatureCount: collection.features.length - excludedFeatureCount,
      excludedSourceFeatureCount: excludedFeatureCount,
      parkCount: features.length,
    },
    features,
  };
}

export async function fetchRdcoParks({ fetchImpl = fetch } = {}) {
  const url = createRdcoParkQueryUrl();
  const response = await fetchImpl(url, {
    headers: { 'user-agent': 'parkdex-data-builder/1.0' },
  });
  if (!response.ok) throw new Error('RDCO park source returned ' + response.status + ' ' + response.statusText);
  const data = await response.json();
  if (data.exceededTransferLimit) throw new Error('RDCO park source exceeded the requested record limit');
  return normalizeRdcoParks(data);
}

async function runCli() {
  const collection = await fetchRdcoParks();
  const serialized = JSON.stringify(collection) + '\n';
  const outputIndex = process.argv.indexOf('--output');
  if (outputIndex !== -1) {
    const outputPath = process.argv[outputIndex + 1];
    if (!outputPath) throw new Error('--output requires a file path');
    await writeFile(resolve(outputPath), serialized);
    process.stderr.write('Wrote ' + collection.features.length + ' RDCO regional park boundaries to ' + resolve(outputPath) + '.\n');
    return;
  }
  process.stdout.write(serialized);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli().catch((error) => {
    process.stderr.write((error.stack ?? error) + '\n');
    process.exitCode = 1;
  });
}

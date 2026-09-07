import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import booleanValid from '@turf/boolean-valid';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, 'data');
const places = JSON.parse(await fs.readFile(path.join(dataDir, 'places.json'), 'utf8'));
const placeById = new Map(places.map((place) => [place.id, place]));
const preservationChecks = [];
const topologyWarnings = [];

const sources = {
  bcParks: {
    name: 'BC Parks / DataBC — TANTALIS protected areas',
    page: 'https://catalogue.data.gov.bc.ca/dataset/parks-ecological-reserves-and-protected-areas',
    data: 'https://openmaps.gov.bc.ca/geo/pub/WHSE_TANTALIS.TA_PARK_ECORES_PA_SVW/ows?service=WFS&version=2.0.0&request=GetFeature&typeNames=pub:WHSE_TANTALIS.TA_PARK_ECORES_PA_SVW&outputFormat=json&srsName=EPSG:4326&bbox=48.2,-128.8,51.2,-123.0,urn:ogc:def:crs:EPSG::4326',
  },
  crd: {
    name: 'Capital Regional District — Park GIS layer',
    page: 'https://mapservices.crd.bc.ca/arcgis/rest/services/Basemap/Basemap/MapServer/3',
    data: "https://mapservices.crd.bc.ca/arcgis/rest/services/Basemap/Basemap/MapServer/3/query?where=Type%3D%27Regional%20Park%27&outFields=*&returnGeometry=true&outSR=4326&f=geojson",
  },
  cvrd: {
    name: 'Cowichan Valley Regional District — Parks GIS layer',
    page: 'https://maps.cvrd.ca/mapservices/rest/services/Parks/MapServer/2',
    data: "https://maps.cvrd.ca/mapservices/rest/services/Parks/MapServer/2/query?where=Park_Type%3D%27Regional%20Park%27&outFields=*&returnGeometry=true&outSR=4326&f=geojson",
  },
  rdn: {
    name: 'Regional District of Nanaimo — Regional Parks spatial data',
    page: 'https://rdn.bc.ca/spatial-data-files',
    data: 'https://rdn.bc.ca/sites/default/files/RegionalParks_14.kmz',
  },
  national: {
    name: 'Natural Resources Canada — Canada Lands Survey System',
    page: 'https://open.canada.ca/data/en/dataset/9e1507cd-f25c-4c64-995b-6563bf9d65bd',
    data: "https://proxyinternet.nrcan-rncan.gc.ca/arcgis/rest/services/CLSS-SATC/CLSS_Administrative_Boundaries/MapServer/1/query?where=adminAreaId%20IN%20(%27PRIM%27%2C%27GULF%27)&outFields=adminAreaId%2CadminAreaNameEng%2CNID&returnGeometry=true&outSR=4326&f=geojson",
  },
  osm: {
    name: 'OpenStreetMap contributors',
    page: 'https://www.openstreetmap.org/copyright',
    lookup: 'https://nominatim.openstreetmap.org/lookup',
  },
};

// Reviewed OSM coastline objects corresponding to the 25 canonical BCGN island names.
// Stable object IDs avoid ambiguous name-based geocoding during rebuilds.
const osmObjects = new Map([
  ['island-cormorant-island', 'R8357754'], ['island-cortes-island', 'R2143895'],
  ['island-denman-island', 'R8237801'], ['island-flores-island', 'R2142418'],
  ['island-gabriola-island', 'R2141945'], ['island-galiano-island', 'R1194085'],
  ['island-hornby-island', 'R5825282'], ['island-lasqueti-island', 'R2143890'],
  ['island-malcolm-island', 'R8357750'], ['island-maurelle-island', 'R4153658'],
  ['island-mayne-island', 'R8332721'], ['island-meares-island', 'R2142331'],
  ['island-nootka-island', 'R2143304'], ['island-north-pender-island', 'R2140392'],
  ['island-penelakut-island', 'R5553189'], ['island-quadra-island', 'R2143327'],
  ['island-read-island', 'R2143965'], ['island-saltspring-island', 'R1019863'],
  ['island-saturna-island', 'R1725547'], ['island-sonora-island', 'R2143966'],
  ['island-south-pender-island', 'R8335965'], ['island-thetis-island', 'R5553191'],
  ['island-valdes-island', 'R8338288'], ['island-vancouver-island', 'R2249770'],
  ['island-vargas-island', 'R8371770'], ['regional-bere-point-regional-park', 'W449016643'],
]);

function slugify(value) {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function titleCaseParkName(name) {
  return name.toLocaleLowerCase('en-CA').replace(/(^|[\s(/-])\p{L}/gu, (letter) => letter.toLocaleUpperCase('en-CA'))
    .replace(/A\.k\.a\./g, 'a.k.a.').replace(/Bc /g, 'BC ');
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { 'user-agent': 'every-park-data-builder/1.0 (https://github.com/NathanPannell/every-park)' } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
  return response.json();
}

async function fetchBuffer(url) {
  const response = await fetch(url, { headers: { 'user-agent': 'every-park-data-builder/1.0 (https://github.com/NathanPannell/every-park)' } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

function extractZipEntry(zip, wantedName) {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i -= 1) {
    if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Invalid KMZ: end-of-central-directory record not found');
  const entries = zip.readUInt16LE(eocd + 10);
  let offset = zip.readUInt32LE(eocd + 16);
  for (let i = 0; i < entries; i += 1) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) throw new Error('Invalid KMZ central directory');
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const localOffset = zip.readUInt32LE(offset + 42);
    const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (name === wantedName) {
      const localNameLength = zip.readUInt16LE(localOffset + 26);
      const localExtraLength = zip.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = zip.subarray(start, start + compressedSize);
      if (method === 0) return compressed;
      if (method === 8) return inflateRawSync(compressed);
      throw new Error(`Unsupported KMZ compression method ${method}`);
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`KMZ entry not found: ${wantedName}`);
}

function decodeXml(value) {
  return value.replace(/&amp;/g, '&').replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function parseKmlRing(block) {
  const match = block.match(/<coordinates>([\s\S]*?)<\/coordinates>/);
  if (!match) return null;
  return match[1].trim().split(/\s+/).map((tuple) => tuple.split(',').slice(0, 2).map(Number));
}

function parseRdnKml(xml) {
  return [...xml.matchAll(/<Placemark[\s\S]*?<name>([\s\S]*?)<\/name>([\s\S]*?)<\/Placemark>/g)].map((match) => {
    const polygons = [...match[2].matchAll(/<Polygon[\s\S]*?<\/Polygon>/g)].map(([block]) => {
      const outerBlock = block.match(/<outerBoundaryIs>([\s\S]*?)<\/outerBoundaryIs>/)?.[1];
      const outer = outerBlock ? parseKmlRing(outerBlock) : null;
      const holes = [...block.matchAll(/<innerBoundaryIs>([\s\S]*?)<\/innerBoundaryIs>/g)]
        .map((entry) => parseKmlRing(entry[1])).filter(Boolean);
      return outer ? [outer, ...holes] : null;
    }).filter(Boolean);
    if (!polygons.length) return null;
    return {
      name: decodeXml(match[1].trim()),
      geometry: polygons.length === 1 ? { type: 'Polygon', coordinates: polygons[0] } : { type: 'MultiPolygon', coordinates: polygons },
    };
  }).filter(Boolean);
}

function squaredSegmentDistance(point, start, end) {
  let x = start[0]; let y = start[1];
  let dx = end[0] - x; let dy = end[1] - y;
  if (dx || dy) {
    const t = ((point[0] - x) * dx + (point[1] - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) { x = end[0]; y = end[1]; } else if (t > 0) { x += dx * t; y += dy * t; }
  }
  dx = point[0] - x; dy = point[1] - y;
  return dx * dx + dy * dy;
}

function simplifyLine(points, squaredTolerance) {
  if (points.length <= 2) return points;
  let maxDistance = squaredTolerance; let index = 0;
  for (let i = 1; i < points.length - 1; i += 1) {
    const distance = squaredSegmentDistance(points[i], points[0], points.at(-1));
    if (distance > maxDistance) { index = i; maxDistance = distance; }
  }
  if (!index) return [points[0], points.at(-1)];
  return [...simplifyLine(points.slice(0, index + 1), squaredTolerance).slice(0, -1), ...simplifyLine(points.slice(index), squaredTolerance)];
}

function signedArea(ring) {
  let area = 0;
  for (let i = 0; i < ring.length - 1; i += 1) area += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return area / 2;
}

function compactRing(rawRing, tolerance = 0.00004) {
  let rounded;
  for (const precision of [5, 6, 7]) {
    rounded = rawRing.map(([x, y]) => [Number(x.toFixed(precision)), Number(y.toFixed(precision))])
      .filter((point, index, points) => index === 0 || point[0] !== points[index - 1][0] || point[1] !== points[index - 1][1]);
    if (rounded.length > 1 && rounded[0][0] === rounded.at(-1)[0] && rounded[0][1] === rounded.at(-1)[1]) rounded.pop();
    if (rounded.length >= 3) break;
  }
  if (rounded.length < 3) throw new Error('Source ring collapses after coordinate rounding');
  const simplified = tolerance ? simplifyLine(rounded, tolerance * tolerance) : rounded;
  const candidate = [...(simplified.length >= 3 ? simplified : rounded), (simplified.length >= 3 ? simplified : rounded)[0]];
  const original = [...rounded, rounded[0]];
  if (Math.abs(signedArea(candidate)) < 1e-12 || Math.sign(signedArea(candidate)) !== Math.sign(signedArea(original))) return original;
  return candidate;
}

function compactGeometry(geometry, tolerance = 0.00004) {
  if (!geometry || !['Polygon', 'MultiPolygon'].includes(geometry.type)) throw new Error(`Unsupported boundary geometry: ${geometry?.type}`);
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  const coordinates = polygons.map((polygon) => polygon.map((ring) => compactRing(ring, tolerance)));
  return coordinates.length === 1 ? { type: 'Polygon', coordinates: coordinates[0] } : { type: 'MultiPolygon', coordinates };
}

function makeFeature(place, geometry, source, sourceId) {
  let compacted = compactGeometry(geometry);
  const polygonFeatures = (candidate) => (candidate.type === 'Polygon' ? [candidate.coordinates] : candidate.coordinates)
    .map((coordinates) => ({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates } }));
  if (source !== sources.osm) {
    const sourceValid = polygonFeatures(geometry).every((feature) => booleanValid(feature));
    if (!polygonFeatures(compacted).every((feature) => booleanValid(feature))) compacted = compactGeometry(geometry, 0);
    if (!polygonFeatures(compacted).every((feature) => booleanValid(feature))) {
      if (sourceValid) compacted = geometry;
      else topologyWarnings.push({ id: place.id, reason: 'Official source polygon fails strict self-intersection topology validation; geometry retained without vertex simplification.' });
    }
  }
  const before = coordinateStats(geometry);
  const after = coordinateStats(compacted);
  if (before.parts !== after.parts || before.holes !== after.holes) {
    throw new Error(`${place.id}: simplification dropped source parts or holes`);
  }
  preservationChecks.push({ id: place.id, sourceParts: before.parts, sourceHoles: before.holes });
  return {
    type: 'Feature',
    properties: { id: place.id, name: place.name, category: place.category, sourceName: source.name, sourceUrl: source.page, sourceId: String(sourceId) },
    geometry: compacted,
  };
}

function requirePlace(id) {
  const place = placeById.get(id);
  if (!place) throw new Error(`Boundary source emitted non-canonical id: ${id}`);
  return place;
}

async function buildProvincial() {
  const collection = await fetchJson(sources.bcParks.data);
  return collection.features.filter((feature) => feature.properties.PROTECTED_LANDS_DESIGNATION === 'PROVINCIAL PARK')
    .map((feature) => {
      const id = `provincial-${slugify(titleCaseParkName(feature.properties.PROTECTED_LANDS_NAME))}`;
      if (!placeById.has(id)) return null;
      return makeFeature(requirePlace(id), feature.geometry, sources.bcParks, feature.properties.ADMIN_AREA_SID);
    }).filter(Boolean);
}

async function buildCrd() {
  const collection = await fetchJson(sources.crd.data);
  return collection.features.map((feature) => {
    const name = feature.properties.Name;
    const id = `regional-${slugify(name)}`;
    if (!placeById.has(id)) return null;
    return makeFeature(requirePlace(id), feature.geometry, sources.crd, feature.properties.OBJECTID);
  }).filter(Boolean);
}

async function buildCvrd() {
  const collection = await fetchJson(sources.cvrd.data);
  return collection.features.map((feature) => {
    const id = `regional-${slugify(feature.properties.PARK_NAME)}`;
    if (!placeById.has(id)) return null;
    return makeFeature(requirePlace(id), feature.geometry, sources.cvrd, feature.properties.OBJECTID);
  }).filter(Boolean);
}

async function buildRdn() {
  const xml = extractZipEntry(await fetchBuffer(sources.rdn.data), 'doc.kml').toString('utf8');
  return parseRdnKml(xml).map(({ name, geometry }) => {
    const id = `regional-${slugify(name)}`;
    if (!placeById.has(id)) return null;
    return makeFeature(requirePlace(id), geometry, sources.rdn, `rdn-${slugify(name)}`);
  }).filter(Boolean);
}

async function buildNational() {
  const collection = await fetchJson(sources.national.data);
  const ids = new Map([['PRIM', 'national-pacific-rim-national-park-reserve'], ['GULF', 'national-gulf-islands-national-park-reserve']]);
  return collection.features.map((feature) => {
    const id = ids.get(feature.properties.adminAreaId);
    return makeFeature(requirePlace(id), feature.geometry, sources.national, feature.properties.NID || feature.properties.adminAreaId);
  });
}

async function buildOsm() {
  const url = new URL(sources.osm.lookup);
  url.searchParams.set('osm_ids', [...osmObjects.values()].join(','));
  url.searchParams.set('format', 'geojson');
  url.searchParams.set('polygon_geojson', '1');
  url.searchParams.set('polygon_threshold', '0.00004');
  const collection = await fetchJson(url);
  const idByObject = new Map([...osmObjects].map(([id, object]) => [object, id]));
  return collection.features.map((feature) => {
    const prefix = feature.properties.osm_type === 'relation' ? 'R' : feature.properties.osm_type === 'way' ? 'W' : 'N';
    const object = `${prefix}${feature.properties.osm_id}`;
    const id = idByObject.get(object);
    if (!id) throw new Error(`Unexpected OSM object returned: ${object}`);
    return makeFeature(requirePlace(id), feature.geometry, sources.osm, object);
  });
}

function coordinateStats(geometry) {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  return {
    parts: polygons.length,
    holes: polygons.reduce((total, polygon) => total + Math.max(0, polygon.length - 1), 0),
    positions: polygons.reduce((total, polygon) => total + polygon.reduce((sum, ring) => sum + ring.length, 0), 0),
  };
}

const groups = await Promise.all([buildNational(), buildProvincial(), buildCrd(), buildCvrd(), buildRdn(), buildOsm()]);
const features = groups.flat().sort((a, b) => a.properties.id.localeCompare(b.properties.id));
const emittedIds = new Set(features.map((feature) => feature.properties.id));
const missingIds = places.filter((place) => !emittedIds.has(place.id)).map((place) => place.id);
const duplicateIds = features.map((feature) => feature.properties.id).filter((id, index, ids) => ids.indexOf(id) !== index);
if (missingIds.length || duplicateIds.length || features.length !== places.length) {
  throw new Error(`Boundary coverage failed: ${features.length}/${places.length}; missing=${missingIds.join(',')}; duplicates=${duplicateIds.join(',')}`);
}

const collection = { type: 'FeatureCollection', features };
const serialized = `${JSON.stringify(collection)}\n`;
const stats = features.map((feature) => coordinateStats(feature.geometry));
const audit = {
  generatedAt: new Date().toISOString(),
  placeCount: places.length,
  featureCount: features.length,
  missingIds,
  duplicateIds,
  sourceCounts: Object.fromEntries([...new Set(features.map((feature) => feature.properties.sourceName))].sort()
    .map((name) => [name, features.filter((feature) => feature.properties.sourceName === name).length])),
  geometryCounts: Object.fromEntries(['Polygon', 'MultiPolygon'].map((type) => [type, features.filter((feature) => feature.geometry.type === type).length])),
  totalParts: stats.reduce((sum, value) => sum + value.parts, 0),
  totalHoles: stats.reduce((sum, value) => sum + value.holes, 0),
  sourceParts: preservationChecks.reduce((sum, value) => sum + value.sourceParts, 0),
  sourceHoles: preservationChecks.reduce((sum, value) => sum + value.sourceHoles, 0),
  totalPositions: stats.reduce((sum, value) => sum + value.positions, 0),
  payloadBytes: Buffer.byteLength(serialized),
  nationalParts: Object.fromEntries(features.filter((feature) => feature.properties.category === 'national')
    .map((feature) => [feature.properties.id, coordinateStats(feature.geometry).parts])),
  islandSourceObjects: Object.fromEntries([...osmObjects].filter(([id]) => id.startsWith('island-'))),
  sourceTopologyPreserved: preservationChecks.length === features.length,
  topologyWarnings,
};

await fs.writeFile(path.join(dataDir, 'boundaries.geojson'), serialized);
await fs.writeFile(path.join(dataDir, 'boundary-audit.json'), `${JSON.stringify(audit, null, 2)}\n`);
console.log(`Wrote ${features.length} boundaries (${audit.totalParts} parts, ${audit.totalHoles} holes, ${audit.payloadBytes} bytes).`);

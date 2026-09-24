import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { provincialNameCorrections } from './place-name-corrections.mjs';
import { classifyBcRegion } from './bc-regions.mjs';
import { BC_MAJOR_ISLANDS } from './bc-major-islands.mjs';
import { fetchOfficialRegionalParks } from './bc-regional-catalogue.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const dataDir = path.join(root, 'data');
const existingPlaces = JSON.parse(await fs.readFile(path.join(dataDir, 'places.json'), 'utf8'));
const polygonInteriorFallbacks = [];
const placeDescriptionEntries = new Map();

for (const filename of ['place-descriptions.catalogue.json', 'nonprovincial-descriptions.catalogue.json']) {
  let raw;
  try {
    raw = await fs.readFile(path.join(dataDir, filename), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT' && filename === 'nonprovincial-descriptions.catalogue.json') continue;
    throw error;
  }
  const catalogue = JSON.parse(raw);
  if (!catalogue.entries || typeof catalogue.entries !== 'object' || Array.isArray(catalogue.entries)) {
    throw new Error(`${filename}: expected an entries object`);
  }
  for (const [id, entry] of Object.entries(catalogue.entries)) {
    if (placeDescriptionEntries.has(id)) throw new Error(`Duplicate description entry: ${id}`);
    if (!['summary', 'no-overview'].includes(entry.status)
        || typeof entry.description !== 'string' || entry.description.trim().length < 40
        || !entry.sourceUrl?.startsWith('https://') || !entry.sourceName || !entry.sourceTitle || !entry.sourceSection) {
      throw new Error(`${filename}: incomplete description or source provenance for ${id}`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.reviewedAt ?? '')
        || (entry.status === 'no-overview' && !entry.description.startsWith('No visitor overview is available'))) {
      throw new Error(`${filename}: invalid description status or review date for ${id}`);
    }
    placeDescriptionEntries.set(id, entry);
  }
}
const existingProvincialBySourceId = new Map(existingPlaces.filter((place) => place.category === 'provincial'
  && placeDescriptionEntries.has(place.id)).map((place) => [String(place.sourceId), place]));
// These mainland valleys fall inside the Strathcona Regional District,
// whose broad administrative footprint otherwise maps to Northern Vancouver Island.
const mainlandDistrictRegionOverrides = new Map([
  ['505', 'Central Coast'], // Bishop River Park, east of Bute Inlet
  ['751', 'Central Coast'], // Homathko Estuary Park, at the Bute Inlet head
]);

const sources = {
  bcParks: {
    name: 'BC Parks / DataBC — TANTALIS protected areas',
    page: 'https://catalogue.data.gov.bc.ca/dataset/parks-ecological-reserves-and-protected-areas',
    data: 'https://openmaps.gov.bc.ca/geo/pub/WHSE_TANTALIS.TA_PARK_ECORES_PA_SVW/ows?service=WFS&version=2.0.0&request=GetFeature&typeNames=pub:WHSE_TANTALIS.TA_PARK_ECORES_PA_SVW&outputFormat=json&srsName=EPSG:4326&CQL_FILTER=PROTECTED_LANDS_DESIGNATION%3D%27PROVINCIAL%20PARK%27&count=1000',
  },
  crd: {
    name: 'Capital Regional District — Park GIS layer',
    page: 'https://mapservices.crd.bc.ca/arcgis/rest/services/Basemap/Basemap/MapServer/3',
    data: "https://mapservices.crd.bc.ca/arcgis/rest/services/Basemap/Basemap/MapServer/3/query?where=Type%3D%27Regional%20Park%27%20OR%20OBJECTID%3D1958&outFields=*&returnGeometry=true&outSR=4326&f=geojson",
  },
  rdn: {
    name: 'Regional District of Nanaimo — Regional Parks spatial data',
    page: 'https://rdn.bc.ca/spatial-data-files',
    data: 'https://rdn.bc.ca/sites/default/files/RegionalParks_14.kmz',
  },
  cvrd: {
    name: 'Cowichan Valley Regional District — Parks GIS layer',
    page: 'https://maps.cvrd.ca/mapservices/rest/services/Parks/MapServer/2',
    data: "https://maps.cvrd.ca/mapservices/rest/services/Parks/MapServer/2/query?where=Park_Type%3D%27Regional%20Park%27&outFields=*&returnGeometry=true&outSR=4326&f=geojson",
  },
  parksCanada: {
    name: 'Parks Canada',
    page: 'https://parks.canada.ca/pn-np/recherche-parcs-parks-search',
  },
  bcNames: {
    name: 'BC Geographical Names Office',
    page: 'https://apps.gov.bc.ca/pub/bcgnws/web/',
    search: 'https://apps.gov.bc.ca/pub/bcgnws/names/official/search',
  },
};

const mainIslandMask = [
  [-123.24, 48.19], [-124.86, 48.27], [-125.48, 48.68], [-126.34, 49.02],
  [-127.45, 49.65], [-128.73, 50.47], [-128.52, 50.88], [-127.12, 50.92],
  [-126.35, 50.73], [-125.67, 50.21], [-125.18, 49.72], [-124.65, 49.40],
  [-123.94, 49.08], [-123.24, 48.67], [-123.24, 48.19],
];

const nearbyIslandParks = new Set([
  'ANDERSON BAY PARK', 'ARBUTUS GROVE PARK', 'BEAVER POINT PARK', 'BELLHOUSE PARK',
  'BODEGA RIDGE PARK', 'BOYLE POINT PARK', 'BURGOYNE BAY PARK',
  'COLLINSON POINT PARK', 'CORMORANT CHANNEL MARINE PARK', 'DENMAN ISLAND PARK',
  'DIONISIO POINT PARK', 'DISCOVERY ISLAND MARINE PARK', 'DRUMBEG PARK', 'ECHO BAY MARINE PARK',
  'ELK FALLS PARK', 'FILLONGLEY PARK', 'GABRIOLA SANDS PARK', 'GERALD ISLAND PARK', "GOD'S POCKET MARINE PARK",
  'HATHAYIM MARINE PARK [A.K.A. VON DONOP MARINE PARK', 'HELLIWELL PARK', 'HEMER PARK',
  "JAJI7EM AND KW'ULH MARINE PARK [A.K.A SANDY ISLAND",
  'JEDEDIAH ISLAND MARINE PARK', 'KIN BEACH PARK', 'KITTY COLEMAN BEACH PARK', 'LANZ AND COX ISLANDS PARK',
  'LOVELAND BAY PARK', 'MAIN LAKE PARK', 'MANSONS LANDING PARK', 'MIRACLE BEACH PARK',
  'MITLENATCH ISLAND NATURE PARK', 'MORDEN COLLIERY HISTORIC PARK', 'MORTON LAKE PARK',
  'MONTAGUE HARBOUR MARINE PARK', 'MOUNT GEOFFREY ESCARPMENT PARK',
  'MOUNT MAXWELL PARK', 'OCTOPUS ISLANDS MARINE PARK', 'PETROGLYPH PARK', 'PIRATES COVE MARINE PARK',
  'READ ISLAND PARK', 'REBECCA SPIT MARINE PARK', 'RENDEZVOUS ISLAND SOUTH PARK',
  'RATHTREVOR BEACH PARK', 'ROBERTS MEMORIAL PARK', 'ROCK BAY MARINE PARK', 'ROSCOE BAY PARK',
  'RUCKLE PARK', 'SABINE CHANNEL MARINE PARK', 'SANDWELL PARK',
  'SAYSUTSHUN (NEWCASTLE ISLAND MARINE) PARK', 'SMALL INLET MARINE PARK', 'SMELT BAY PARK',
  'SQUITTY BAY PARK', 'SURGE NARROWS PARK', 'THURSTON BAY MARINE PARK', 'TRIBUNE BAY PARK', 'WAKES COVE PARK',
  'WALLACE ISLAND MARINE PARK', 'WALSH COVE PARK', 'WHALEBOAT ISLAND MARINE PARK',
]);

const mainIslandParkNames = new Set([
  'ARBUTUS GROVE PARK', 'ELK FALLS PARK', 'HEMER PARK', 'KIN BEACH PARK', 'KITTY COLEMAN BEACH PARK',
  'LOVELAND BAY PARK', 'MIRACLE BEACH PARK', 'MORDEN COLLIERY HISTORIC PARK', 'MORTON LAKE PARK',
  'PETROGLYPH PARK', 'RATHTREVOR BEACH PARK', 'ROBERTS MEMORIAL PARK', 'ROCK BAY MARINE PARK',
]);

// Reviewed against the published park polygons and the mapped boundaries for
// Vancouver Island plus every island in `islandNames`. These parks sit wholly
// on other offshore islands, so they remain valid source records but are not
// part of Parkdex's active geographic collection.
const outOfScopeOffshoreParks = new Set([
  'ANDERSON BAY PARK', 'BLIGH ISLAND MARINE PARK', 'BROUGHTON ARCHIPELAGO PARK',
  'CATALA ISLAND MARINE PARK', 'CORMORANT CHANNEL MARINE PARK', 'DISCOVERY ISLAND MARINE PARK',
  'DIXIE COVE MARINE PARK', 'ECHO BAY MARINE PARK', 'EPPER PASSAGE PARK', 'GERALD ISLAND PARK',
  "GOD'S POCKET MARINE PARK", "JAJI7EM AND KW'ULH MARINE PARK [A.K.A SANDY ISLAND",
  'JEDEDIAH ISLAND MARINE PARK', 'LANZ AND COX ISLANDS PARK',
  'RENDEZVOUS ISLAND SOUTH PARK', 'ROSCOE BAY PARK',
  'SABINE CHANNEL MARINE PARK', 'WALSH COVE PARK', 'WHALEBOAT ISLAND MARINE PARK',
]);

const parkIslandRegions = new Map([
  ...[
    'BEAVER POINT PARK', 'BELLHOUSE PARK', 'BODEGA RIDGE PARK', 'BURGOYNE BAY PARK',
    'COLLINSON POINT PARK', 'DIONISIO POINT PARK', 'DISCOVERY ISLAND MARINE PARK', 'DRUMBEG PARK',
    'GABRIOLA SANDS PARK', 'MONTAGUE HARBOUR MARINE PARK', 'MOUNT ERSKINE PARK', 'MOUNT MAXWELL PARK',
    'PIRATES COVE MARINE PARK', 'RUCKLE PARK', 'SANDWELL PARK', 'SAYSUTSHUN (NEWCASTLE ISLAND MARINE) PARK',
    'WAKES COVE PARK', 'WALLACE ISLAND MARINE PARK', 'WHALEBOAT ISLAND MARINE PARK',
  ].map((name) => [name, 'Gulf Islands']),
  ...[
    'ANDERSON BAY PARK', 'BOYLE POINT PARK', 'DENMAN ISLAND PARK', 'FILLONGLEY PARK',
    'GERALD ISLAND PARK', 'HELLIWELL PARK', "JAJI7EM AND KW'ULH MARINE PARK [A.K.A SANDY ISLAND",
    'JEDEDIAH ISLAND MARINE PARK', 'MOUNT GEOFFREY ESCARPMENT PARK', 'SABINE CHANNEL MARINE PARK',
    'SQUITTY BAY PARK', 'TRIBUNE BAY PARK',
  ].map((name) => [name, 'Northern Gulf Islands']),
  ...[
    'MAIN LAKE PARK', 'MANSONS LANDING PARK',
    'MITLENATCH ISLAND NATURE PARK', 'OCTOPUS ISLANDS MARINE PARK', 'READ ISLAND PARK',
    'REBECCA SPIT MARINE PARK', 'RENDEZVOUS ISLAND SOUTH PARK', 'ROSCOE BAY PARK',
    'SMALL INLET MARINE PARK', 'SMELT BAY PARK', 'SURGE NARROWS PARK', 'THURSTON BAY MARINE PARK',
    'WALSH COVE PARK',
  ].map((name) => [name, 'Discovery Islands']),
  [provincialNameCorrections.get('728').name, 'Discovery Islands'],
  ...[
    'BROUGHTON ARCHIPELAGO PARK', 'CORMORANT CHANNEL MARINE PARK', 'ECHO BAY MARINE PARK',
    "GOD'S POCKET MARINE PARK", 'LANZ AND COX ISLANDS PARK',
  ].map((name) => [name, 'Northern Islands']),
  ...['FLORES ISLAND PARK', 'VARGAS ISLAND PARK'].map((name) => [name, 'West Coast Islands']),
]);

const cvrdEligibilityExclusions = new Map([
  ['Siddoo Regional Park', { sourceId: '980473', status: 'Undeveloped', publicAccess: 'No' }],
  ['Stocking/Heart Lake Regional Park', { sourceId: '980187', status: 'Undeveloped', publicAccess: 'No' }],
]);

const curatedIslandRegions = new Map([
  ...['Flores Island', 'Meares Island', 'Nootka Island', 'Vargas Island'].map((name) => [name, 'West Coast Islands']),
  ...['Cortes Island', 'Maurelle Island', 'Quadra Island', 'Read Island', 'Sonora Island'].map((name) => [name, 'Discovery Islands']),
  ...['Cormorant Island', 'Malcolm Island'].map((name) => [name, 'Northern Islands']),
  ...['Denman Island', 'Hornby Island', 'Lasqueti Island'].map((name) => [name, 'Northern Gulf Islands']),
  ...[
    'Gabriola Island', 'Galiano Island', 'Mayne Island', 'North Pender Island', 'Penelakut Island',
    'Saltspring Island', 'Saturna Island', 'South Pender Island', 'Thetis Island', 'Valdes Island',
  ].map((name) => [name, 'Gulf Islands']),
  ...BC_MAJOR_ISLANDS.map(({ name, displayGroup }) => [name,
    displayGroup === 'Haida Gwaii' || displayGroup === 'North Coast' ? 'North Coast & Haida Gwaii'
      : displayGroup === 'Howe Sound' || displayGroup === 'Northern Strait of Georgia' ? 'South Coast'
        : 'Central Coast']),
]);

const islandNames = [
  'Saltspring Island', 'Gabriola Island', 'Galiano Island', 'Mayne Island',
  'Saturna Island', 'North Pender Island', 'South Pender Island', 'Thetis Island',
  'Penelakut Island', 'Valdes Island', 'Denman Island', 'Hornby Island', 'Lasqueti Island',
  'Quadra Island', 'Cortes Island', 'Read Island', 'Sonora Island', 'Maurelle Island',
  'Malcolm Island', 'Cormorant Island', 'Nootka Island', 'Flores Island', 'Meares Island',
  'Vargas Island',
  ...BC_MAJOR_ISLANDS.map(({ name }) => name),
];

function slugify(value) {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function pointInPolygon([x, y], polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]; const [xj, yj] = polygon[j];
    const crosses = ((yi > y) !== (yj > y)) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

function pointInPolygonWithHoles(point, polygon) {
  return pointInPolygon(point, polygon[0]) && !polygon.slice(1).some((hole) => pointInPolygon(point, hole));
}

function ringCentroid(ring) {
  let twiceArea = 0; let x = 0; let y = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    const [x1, y1] = ring[i]; const [x2, y2] = ring[i + 1];
    const cross = x1 * y2 - x2 * y1;
    twiceArea += cross; x += (x1 + x2) * cross; y += (y1 + y2) * cross;
  }
  if (!twiceArea) return { area: 0, longitude: ring[0][0], latitude: ring[0][1] };
  return { area: Math.abs(twiceArea / 2), longitude: x / (3 * twiceArea), latitude: y / (3 * twiceArea) };
}

function scanlineInteriorPoint(polygon) {
  const yValues = [...new Set(polygon.flat().map(([, y]) => y))].sort((a, b) => a - b);
  const candidateYs = [];
  for (let i = 0; i < yValues.length - 1; i += 1) {
    if (yValues[i + 1] > yValues[i]) candidateYs.push((yValues[i] + yValues[i + 1]) / 2);
  }

  let best = null;
  for (const y of candidateYs) {
    const intersections = [];
    for (const ring of polygon) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
        const [x1, y1] = ring[j];
        const [x2, y2] = ring[i];
        if ((y1 > y) !== (y2 > y)) intersections.push(x1 + ((y - y1) * (x2 - x1)) / (y2 - y1));
      }
    }
    intersections.sort((a, b) => a - b);
    for (let i = 0; i + 1 < intersections.length; i += 2) {
      const width = intersections[i + 1] - intersections[i];
      if (width > 0 && (!best || width > best.width)) {
        best = { longitude: (intersections[i] + intersections[i + 1]) / 2, latitude: y, width };
      }
    }
  }
  if (!best || !pointInPolygonWithHoles([best.longitude, best.latitude], polygon)) {
    throw new Error('Unable to find a guaranteed interior point for source polygon');
  }
  return best;
}

function geometryRepresentative(geometry) {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  const polygon = polygons.map((candidate) => ({ candidate, centroid: ringCentroid(candidate[0]) }))
    .sort((a, b) => b.centroid.area - a.centroid.area)[0];
  if (!polygon) throw new Error(`Unsupported or empty geometry: ${geometry.type}`);
  const centroidPoint = [polygon.centroid.longitude, polygon.centroid.latitude];
  const representative = pointInPolygonWithHoles(centroidPoint, polygon.candidate)
    ? { ...polygon.centroid, method: 'centroid' }
    : { ...scanlineInteriorPoint(polygon.candidate), area: polygon.centroid.area, method: 'scanline-interior' };
  const rounded = { ...representative, longitude: round(representative.longitude), latitude: round(representative.latitude) };
  if (!pointInPolygonWithHoles([rounded.longitude, rounded.latitude], polygon.candidate)) {
    const interior = scanlineInteriorPoint(polygon.candidate);
    const roundedInterior = { ...interior, longitude: round(interior.longitude), latitude: round(interior.latitude), area: polygon.centroid.area, method: 'scanline-interior' };
    if (!pointInPolygonWithHoles([roundedInterior.longitude, roundedInterior.latitude], polygon.candidate)) {
      throw new Error('Rounded representative point falls outside its source polygon');
    }
    return roundedInterior;
  }
  return rounded;
}

function mainIslandRegion(latitude) {
  if (latitude < 49.0) return 'South Island';
  if (latitude < 49.75) return 'Central Island';
  return 'North Island';
}

function isTrailName(name) {
  return /\btrail\b/i.test(name);
}

function titleCaseParkName(name) {
  return name.toLocaleLowerCase('en-CA').replace(/(^|[\s(/-])\p{L}/gu, (letter) => letter.toLocaleUpperCase('en-CA'))
    .replace(/A\.k\.a\./g, 'a.k.a.').replace(/Bc /g, 'BC ');
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { 'user-agent': 'every-park-data-builder/1.0' } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
  return response.json();
}

async function fetchBuffer(url) {
  const response = await fetch(url, { headers: { 'user-agent': 'every-park-data-builder/1.0' } });
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

async function buildProvincial() {
  const collection = await fetchJson(sources.bcParks.data);
  const excluded = [];
  const included = collection.features.filter((feature) => feature.properties.PROTECTED_LANDS_DESIGNATION === 'PROVINCIAL PARK')
    .map((feature) => ({ feature, point: geometryRepresentative(feature.geometry) }));

  const places = included.map(({ feature, point }) => {
    const p = feature.properties;
    const existing = existingProvincialBySourceId.get(String(p.ADMIN_AREA_SID));
    const correction = provincialNameCorrections.get(String(p.ADMIN_AREA_SID));
    const name = correction?.name ?? existing?.name ?? titleCaseParkName(p.PROTECTED_LANDS_NAME);
    if (point.method !== 'centroid') polygonInteriorFallbacks.push({ source: 'BC Parks', name, method: point.method });
    const region = correction?.region ?? existing?.region
      ?? mainlandDistrictRegionOverrides.get(String(p.ADMIN_AREA_SID))
      ?? classifyBcRegion(point.longitude, point.latitude);
    return {
      id: correction?.id ?? existing?.id ?? `provincial-${slugify(name)}`, name, category: 'provincial',
      latitude: round(point.latitude), longitude: round(point.longitude), region,
      description: `${correction ? `${correction.alias} ` : ''}A BC provincial park in the ${region} collection. The map pin represents the largest official park polygon, not an entrance or trailhead.`,
      sourceUrl: sources.bcParks.page, sourceName: sources.bcParks.name,
      sourceId: String(p.ADMIN_AREA_SID),
    };
  });
  return { places, excluded, sourceFeatures: collection.features.length };
}

async function buildCrd() {
  const collection = await fetchJson(sources.crd.data);
  const grouped = new Map();
  for (const feature of collection.features) {
    const name = feature.properties.Name?.trim();
    if (!name || isTrailName(name) || /Former Royal Oak/i.test(name)) continue;
    const point = geometryRepresentative(feature.geometry);
    if (point.method !== 'centroid') polygonInteriorFallbacks.push({ source: 'CRD', name, method: point.method });
    if (!grouped.has(name) || point.area > grouped.get(name).area) grouped.set(name, point);
  }
  return [...grouped].map(([name, point]) => ({
    id: name === 'Sooke River Park' ? 'regional-sooke-river-regional-park' : `regional-${slugify(name)}`,
    name, category: 'regional', latitude: round(point.latitude),
    longitude: round(point.longitude), region: point.longitude > -123.3 ? 'Gulf Islands' : 'Capital Region',
    description: name === 'Sooke River Park'
      ? 'A Capital Regional District municipal park along the Sooke River. The map pin represents the official GIS parcel, not an entrance or trailhead.'
      : 'A Capital Regional District regional park. The map pin represents the largest official GIS parcel, not an entrance or trailhead.',
    sourceUrl: sources.crd.page, sourceName: sources.crd.name,
  }));
}

async function buildCvrd() {
  const canonicalRegionalParks = new Set([
    'Chemainus River Provincial Park', 'Osborne Bay Regional Park',
    'Sandy Pool Regional Park', 'Siddoo Regional Park', 'Spectacle Lake Regional Park',
    'Stocking/Heart Lake Regional Park', 'Stoney Hill Regional Park',
  ]);
  const duplicateProvincial = new Set(['Chemainus River Provincial Park', 'Spectacle Lake Regional Park']);
  const collection = await fetchJson(sources.cvrd.data);
  return collection.features.filter((feature) => {
    const properties = feature.properties;
    if (!canonicalRegionalParks.has(properties.PARK_NAME) || duplicateProvincial.has(properties.PARK_NAME)
        || isTrailName(properties.PARK_NAME)) return false;
    const exclusion = cvrdEligibilityExclusions.get(properties.PARK_NAME);
    if (!exclusion) return true;
    if (String(properties.OBJECTID) !== exclusion.sourceId || properties.STATUS !== exclusion.status
        || properties.Public_Access !== exclusion.publicAccess) {
      throw new Error(`CVRD eligibility fields changed; review ${properties.PARK_NAME}`);
    }
    return false;
  })
    .map((feature) => ({ feature, point: geometryRepresentative(feature.geometry) }))
    .map(({ feature, point }) => {
      const name = feature.properties.PARK_NAME;
      if (point.method !== 'centroid') polygonInteriorFallbacks.push({ source: 'CVRD', name, method: point.method });
      return {
        id: `regional-${slugify(name)}`, name, category: 'regional', latitude: round(point.latitude), longitude: round(point.longitude),
        region: 'Cowichan Valley',
        description: 'A Cowichan Valley Regional District regional park. The pin represents the largest official GIS polygon, not an entrance or trailhead.',
        sourceUrl: sources.cvrd.page, sourceName: sources.cvrd.name, sourceId: String(feature.properties.OBJECTID),
      };
    });
}

function decodeXml(value) {
  return value.replace(/&amp;/g, '&').replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

async function buildRdn() {
  const xml = extractZipEntry(await fetchBuffer(sources.rdn.data), 'doc.kml').toString('utf8');
  const matches = [...xml.matchAll(/<Placemark[\s\S]*?<name>([\s\S]*?)<\/name>([\s\S]*?)<\/Placemark>/g)];
  return matches.map((match) => {
    const name = decodeXml(match[1].trim());
    const rings = [...match[2].matchAll(/<coordinates>([\s\S]*?)<\/coordinates>/g)]
      .map((entry) => entry[1].trim().split(/\s+/).map((tuple) => tuple.split(',').slice(0, 2).map(Number)))
      .filter((ring) => ring.length > 2);
    const point = rings.map((ring) => geometryRepresentative({ type: 'Polygon', coordinates: [ring] }))
      .sort((a, b) => b.area - a.area)[0];
    return { name, point };
  }).filter(({ name, point }) => name && name !== 'RegionalParks' && !isTrailName(name) && point)
    .map(({ name, point }) => {
      if (point.method !== 'centroid') polygonInteriorFallbacks.push({ source: 'RDN', name, method: point.method });
      return {
        id: `regional-${slugify(name)}`, name, category: 'regional', latitude: round(point.latitude),
        longitude: round(point.longitude), region: /Coats Marsh|Descanso Bay/i.test(name) ? 'Gulf Islands' : 'Central Island',
        description: 'A Regional District of Nanaimo regional park or conservation area. The pin represents the largest official GIS polygon, not an entrance or trailhead.',
        sourceUrl: sources.rdn.page, sourceName: sources.rdn.name,
      };
    });
}

async function buildOfficialRegional() {
  const imported = await fetchOfficialRegionalParks();
  const places = imported.features.map((feature) => {
    const point = geometryRepresentative(feature.geometry);
    const sourceName = feature.properties.sourceName;
    const region = sourceName.includes('Metro Vancouver') ? 'South Coast'
      : sourceName.includes('Central Okanagan') ? 'Thompson & Okanagan'
        : sourceName.includes('Fraser-Fort George') ? 'Cariboo & Central Interior'
          : classifyBcRegion(point.longitude, point.latitude);
    if (point.method !== 'centroid') polygonInteriorFallbacks.push({ source: sourceName, name: feature.properties.name, method: point.method });
    return {
      id: feature.id, name: feature.properties.name, category: 'regional',
      latitude: round(point.latitude), longitude: round(point.longitude), region,
      description: `An officially mapped regional park in the ${region} collection. The pin represents its largest published polygon, not an entrance or trailhead.`,
      sourceUrl: feature.properties.sourceUrl, sourceName,
      sourceId: feature.properties.sourceId,
    };
  });
  return { places, counts: imported.counts, excludedGreenspaces: imported.excludedGreenspaces };
}

function buildNational() {
  return [
    ['Pacific Rim National Park Reserve', 49.060406, -125.722799, 'West Coast', 'https://parks.canada.ca/pn-np/bc/pacificrim'],
    ['Gulf Islands National Park Reserve', 48.66552, -123.407929, 'Gulf Islands', 'https://parks.canada.ca/pn-np/bc/gulf'],
    ['Glacier National Park', 51.2679, -117.5235, 'Kootenays', 'https://parks.canada.ca/pn-np/bc/glacier'],
    ['Gwaii Haanas National Park Reserve', 52.39, -131.41, 'North Coast & Haida Gwaii', 'https://parks.canada.ca/pn-np/bc/gwaiihaanas'],
    ['Kootenay National Park', 50.944013, -115.983967, 'Kootenays', 'https://parks.canada.ca/pn-np/bc/kootenay'],
    ['Mount Revelstoke National Park', 51.0938, -118.0451, 'Kootenays', 'https://parks.canada.ca/pn-np/bc/revelstoke'],
    ['Yoho National Park', 51.398117, -116.491798, 'Kootenays', 'https://parks.canada.ca/pn-np/bc/yoho'],
  ].map(([name, latitude, longitude, region, sourceUrl]) => ({
    id: `national-${slugify(name)}`, name, category: 'national', latitude, longitude, region,
    description: 'A Parks Canada national park or park reserve. This single check-off represents the whole park; its map pin is a representative location, not an entrance or trailhead.',
    sourceUrl, sourceName: sources.parksCanada.name,
  }));
}

function buildVerifiedRegionalPoints() {
  return [
    {
      id: 'regional-bere-point-regional-park',
      name: 'Bere Point Regional Park',
      category: 'regional',
      latitude: 50.670833,
      longitude: -127.056667,
      region: 'Northern Islands',
      description: 'A Regional District of Mount Waddington park on Malcolm Island. The pin uses the official BC Geographical Names position for Bere Point, not an entrance or campsite.',
      sourceUrl: 'https://www.rdmw.bc.ca/recreation-leisure/camping-information/bere-point/',
      sourceName: 'Regional District of Mount Waddington + BC Geographical Names Office',
      sourceId: 'bcgnis-22727',
    },
    {
      id: 'regional-kwaksistah-regional-park',
      name: 'Kwaksistah Regional Park',
      category: 'regional',
      latitude: 50.521979,
      longitude: -128.027444,
      region: 'North Island',
      description: 'A Regional District of Mount Waddington park and rustic campground at Winter Harbour. The pin represents the reviewed mapped park feature, not a campsite.',
      sourceUrl: 'https://www.rdmw.bc.ca/recreation-leisure/camping-information/kwaksistah-regional-park/',
      sourceName: 'Regional District of Mount Waddington + OpenStreetMap contributors',
      sourceId: 'W827164115',
    },
    {
      id: 'regional-little-huson-cave-regional-park',
      name: 'Little Huson Cave Regional Park',
      category: 'regional',
      latitude: 50.28532,
      longitude: -126.950779,
      region: 'North Island',
      description: 'A Regional District of Mount Waddington day-use park protecting caves and karst formations along Atluck Creek. The pin represents the reviewed mapped park feature, not the parking area.',
      sourceUrl: 'https://www.rdmw.bc.ca/media/Huson%20Cave%20Park%20Overview%281%29.pdf',
      sourceName: 'Regional District of Mount Waddington + OpenStreetMap contributors',
      sourceId: 'W816998556',
    },
    {
      id: 'regional-mount-cain-alpine-park',
      name: 'Mount Cain Alpine Park',
      category: 'regional',
      latitude: 50.222771,
      longitude: -126.345699,
      region: 'North Island',
      description: 'A Regional District of Mount Waddington alpine park with a community-operated ski area. The pin represents the reviewed mapped park feature, not an access road or facility.',
      sourceUrl: 'https://www.rdmw.bc.ca/recreation-leisure/',
      sourceName: 'Regional District of Mount Waddington + OpenStreetMap contributors',
      sourceId: 'W579980733',
    },
  ];
}

async function buildIslands() {
  const places = [];
  for (const requestedName of islandNames) {
    const url = new URL(sources.bcNames.search);
    Object.entries({ name: requestedName, exactSpelling: '1', itemsPerPage: '20', startIndex: '1', outputFormat: 'json', outputStyle: 'detail', outputSRS: '4326' })
      .forEach(([key, value]) => url.searchParams.set(key, value));
    const result = await fetchJson(url);
    const feature = result.features.find((item) => item.properties.name.toLocaleLowerCase('en-CA') === requestedName.toLocaleLowerCase('en-CA') && item.properties.featureType === 'Island');
    if (!feature) throw new Error(`No exact official island result for ${requestedName}`);
    const p = feature.properties;
    const name = p.name;
    const reviewed = BC_MAJOR_ISLANDS.find((candidate) => candidate.name === name);
    if (reviewed) {
      // The URI suffix is the BCGN name-page ID; feature.id is the separate
      // source identity retained in place.sourceId below.
      const nameIdMatch = String(p.uri).match(/\/names\/(\d+)$/);
      const bcgnNameId = nameIdMatch ? Number(nameIdMatch[1]) : NaN;
      if (bcgnNameId !== reviewed.bcgnNameId || Number(p.feature.id) !== reviewed.bcgnFeatureId) {
        throw new Error(`Official name identity changed for ${name}: name ${p.uri}, feature ${p.feature.id}`);
      }
    }
    places.push({
      id: `island-${slugify(name)}`, name, category: 'island', latitude: round(Number(p.featurePoint.lat)),
      longitude: round(Number(p.featurePoint.lon)), region: curatedIslandRegions.get(name),
      description: `${p.relativeLocation || 'An officially named island in British Columbia'}. The pin is the official approximate centre of the feature.`,
      sourceUrl: `https://${p.uri}.html`, sourceName: sources.bcNames.name, sourceId: String(p.feature.id),
    });
  }
  return places;
}

function round(value) { return Number(value.toFixed(6)); }

function validate(places) {
  const ids = new Set();
  for (const place of places) {
    for (const field of ['id', 'name', 'category', 'latitude', 'longitude', 'region', 'description', 'sourceUrl', 'sourceName']) {
      if (place[field] === undefined || place[field] === '') throw new Error(`${place.id || place.name}: missing ${field}`);
    }
    if (ids.has(place.id)) throw new Error(`Duplicate id: ${place.id}`);
    ids.add(place.id);
    if (!['national', 'provincial', 'regional', 'island'].includes(place.category)) throw new Error(`${place.id}: invalid category`);
    if (place.latitude < 47 || place.latitude > 61 || place.longitude < -141 || place.longitude > -113) throw new Error(`${place.id}: coordinate outside British Columbia scope`);
  }
  for (const required of [
    'Strathcona Park', 'Cape Scott Park', 'Pacific Rim National Park Reserve', 'Gulf Islands National Park Reserve',
    'Arbutus Grove Park', 'Elk Falls Park', 'Hemer Park', 'Kin Beach Park', 'Kitty Coleman Beach Park',
    'Loveland Bay Park', 'Miracle Beach Park', 'Morden Colliery Historic Park', 'Morton Lake Park',
    'Petroglyph Park', 'Rathtrevor Beach Park', 'Roberts Memorial Park', 'Rock Bay Marine Park',
    'Sandwell Park', 'Mitlenatch Island Nature Park', 'Thurston Bay Marine Park',
    'Kwaksistah Regional Park', 'Little Huson Cave Regional Park', 'Mount Cain Alpine Park',
  ]) {
    if (!places.some((place) => place.name === required)) throw new Error(`Required coverage missing: ${required}`);
  }
  for (const required of ['Alice Lake Park', 'Garibaldi Park', 'Shannon Falls Park', 'Stawamus Chief Park']) {
    if (!places.some((place) => place.name === required)) throw new Error(`Mainland coverage missing: ${required}`);
  }
  for (const excluded of [
    'Siddoo Regional Park', 'Stocking/Heart Lake Regional Park', 'Morden Colliery Regional Trail',
  ]) {
    if (places.some((place) => place.name === excluded)) throw new Error(`Ineligible regional feature regression: ${excluded}`);
  }
  if (places.some((place) => place.category === 'regional' && isTrailName(place.name))) {
    throw new Error('Regional trail regression: trail emitted as a park');
  }
  for (const [name, region] of curatedIslandRegions) {
    if (!places.some((place) => place.name === name && place.region === region)) throw new Error(`Island region regression: ${name} must be ${region}`);
  }
  for (const name of ['Arbutus Grove Park', 'Hemer Park', 'Morden Colliery Historic Park', 'Petroglyph Park', 'Rathtrevor Beach Park', 'Roberts Memorial Park']) {
    if (!places.some((place) => place.name === name && place.region === 'Central Island')) throw new Error(`Main-island region regression: ${name}`);
  }
  for (const existing of existingProvincialBySourceId.values()) {
    if (!places.some((place) => place.sourceId === existing.sourceId && place.id === existing.id && place.region === existing.region)) {
      throw new Error(`Existing provincial identity or region changed: ${existing.id}`);
    }
  }
}

const [provincial, crd, cvrd, rdn, officialRegional, islands] = await Promise.all([
  buildProvincial(), buildCrd(), buildCvrd(), buildRdn(), buildOfficialRegional(), buildIslands(),
]);
const places = [...buildNational(), ...buildVerifiedRegionalPoints(), ...provincial.places,
  ...crd, ...cvrd, ...rdn, ...officialRegional.places, ...islands]
  .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name, 'en-CA'));
const generatedDescriptionEntries = {};
for (const place of places) {
  let entry = placeDescriptionEntries.get(place.id);
  if (!entry && ['provincial', 'national', 'island', 'regional'].includes(place.category)) {
    entry = {
      status: 'source-derived',
      description: place.description,
      sourceName: place.category === 'provincial' ? 'BC Parks / DataBC' : place.category === 'national' ? 'Parks Canada' : place.category === 'island' ? sources.bcNames.name : place.sourceName,
      sourceTitle: place.category === 'provincial' ? 'Parks, Ecological Reserves and Protected Areas' : place.name,
      sourceUrl: place.sourceUrl,
      sourceSection: place.category === 'provincial' ? 'Designation and geometry attributes' : place.category === 'national' ? 'National park listing' : place.category === 'island' ? 'Official island name and approximate centre' : 'Official regional park GIS record and boundary',
      reviewedAt: new Date().toISOString().slice(0, 10),
    };
    placeDescriptionEntries.set(place.id, entry);
    generatedDescriptionEntries[place.id] = entry;
  }
  if (!entry) throw new Error(`Missing visitor-facing description entry: ${place.id}`);
  place.description = entry.description;
}
if (placeDescriptionEntries.size !== places.length) throw new Error('Description catalogues contain unknown place ids');
validate(places);
await fs.writeFile(path.join(dataDir, 'bc-expansion-descriptions.catalogue.json'), `${JSON.stringify({
  checkedAt: new Date().toISOString().slice(0, 10),
  descriptionMethod: 'Source-derived designation and representative-point descriptions; no visitor activity claims.',
  entries: generatedDescriptionEntries,
}, null, 2)}\n`);
await fs.writeFile(path.join(dataDir, 'places.json'), `${JSON.stringify(places, null, 2)}\n`);
const descriptionSources = Object.fromEntries([...placeDescriptionEntries].sort(([a], [b]) => a.localeCompare(b)).map(([id, entry]) => [id, {
  status: entry.status,
  sourceName: entry.sourceName,
  sourceTitle: entry.sourceTitle,
  sourceUrl: entry.sourceUrl,
  sourceSection: entry.sourceSection,
  reviewedAt: entry.reviewedAt,
}]));
await fs.writeFile(path.join(root, 'frontend', 'lib', 'place-description-sources.catalogue.json'), `${JSON.stringify(descriptionSources, null, 2)}\n`);
await fs.writeFile(path.join(dataDir, 'coverage-audit.json'), `${JSON.stringify({
  generatedAt: new Date().toISOString(), counts: Object.fromEntries(['national', 'provincial', 'regional', 'island'].map((category) => [category, places.filter((p) => p.category === category).length])),
  bcParksBroadBboxFeatures: provincial.sourceFeatures,
  polygonPinsVerified: provincial.places.length + crd.length + cvrd.length + rdn.length + officialRegional.places.length,
  officialRegionalSourceCounts: officialRegional.counts,
  excludedOfficialGreenspaces: officialRegional.excludedGreenspaces,
  polygonInteriorFallbacks,
  excludedCvrdRegionalParks: [...cvrdEligibilityExclusions].map(([name, evidence]) => ({ name, ...evidence })),
  scopeRetirements: [],
  excludedProvincialParksOutsideMask: provincial.excluded.sort((a, b) => a.name.localeCompare(b.name)),
  extents: { south: Math.min(...places.map((p) => p.latitude)), north: Math.max(...places.map((p) => p.latitude)), west: Math.min(...places.map((p) => p.longitude)), east: Math.max(...places.map((p) => p.longitude)) },
}, null, 2)}\n`);
console.log(`Wrote ${places.length} places: ${[...new Set(places.map((p) => p.category))].map((category) => `${places.filter((p) => p.category === category).length} ${category}`).join(', ')}`);

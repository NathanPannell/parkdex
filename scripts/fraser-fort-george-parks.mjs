import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';

export const fraserFortGeorgeParksSource = Object.freeze({
  name: 'Regional District of Fraser-Fort George Regional Parks GIS',
  page: 'https://www.rdffg.ca/maps',
  inventoryPage: 'https://www.rdffg.ca/your-community/parks',
  data: 'https://geo2.rdffg.bc.ca/gisdownloads/kml/RegionalParks_kml.zip',
  archiveEntry: 'Regional_Parks_ex.kmz',
  kmlEntry: 'doc.kml',
  format: 'ZIP containing KMZ (KML)',
  coordinateReferenceSystem: 'EPSG:4326',
  license: null,
  licenseNote: 'The official GIS download page does not state a reuse license.',
});

const officialParkNamesBySourceId = Object.freeze({
  PROP00005: 'Harold Mann Regional Park',
  PROP00014: 'Giscome Portage-Huble Homestead Regional Park',
});

function extractZipEntry(zip, wantedName) {
  if (!Buffer.isBuffer(zip)) zip = Buffer.from(zip);
  let endOfCentralDirectory = -1;
  const minimumOffset = Math.max(0, zip.length - 65_557);
  for (let offset = zip.length - 22; offset >= minimumOffset; offset -= 1) {
    if (zip.readUInt32LE(offset) === 0x06054b50) {
      endOfCentralDirectory = offset;
      break;
    }
  }
  if (endOfCentralDirectory < 0) throw new Error('Invalid ZIP: end-of-central-directory record not found');

  const entryCount = zip.readUInt16LE(endOfCentralDirectory + 10);
  let centralOffset = zip.readUInt32LE(endOfCentralDirectory + 16);
  for (let index = 0; index < entryCount; index += 1) {
    if (centralOffset + 46 > zip.length || zip.readUInt32LE(centralOffset) !== 0x02014b50) {
      throw new Error('Invalid ZIP central directory');
    }
    const method = zip.readUInt16LE(centralOffset + 10);
    const compressedSize = zip.readUInt32LE(centralOffset + 20);
    const nameLength = zip.readUInt16LE(centralOffset + 28);
    const extraLength = zip.readUInt16LE(centralOffset + 30);
    const commentLength = zip.readUInt16LE(centralOffset + 32);
    const localOffset = zip.readUInt32LE(centralOffset + 42);
    const name = zip.subarray(centralOffset + 46, centralOffset + 46 + nameLength).toString('utf8');

    if (name === wantedName) {
      if (localOffset + 30 > zip.length || zip.readUInt32LE(localOffset) !== 0x04034b50) {
        throw new Error(`Invalid ZIP local header for ${wantedName}`);
      }
      const localNameLength = zip.readUInt16LE(localOffset + 26);
      const localExtraLength = zip.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const dataEnd = dataStart + compressedSize;
      if (dataEnd > zip.length) throw new Error(`Invalid ZIP entry length for ${wantedName}`);
      const compressed = zip.subarray(dataStart, dataEnd);
      if (method === 0) return compressed;
      if (method === 8) return inflateRawSync(compressed);
      throw new Error(`Unsupported ZIP compression method ${method} for ${wantedName}`);
    }

    centralOffset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`ZIP entry not found: ${wantedName}`);
}

function decodeEntities(value) {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|apos|quot|lt|gt|nbsp);/gi, (entity, code) => {
    if (code[0] === '#') {
      const numeric = code[1]?.toLowerCase() === 'x'
        ? Number.parseInt(code.slice(2), 16)
        : Number.parseInt(code.slice(1), 10);
      return Number.isInteger(numeric) && numeric >= 0 && numeric <= 0x10ffff
        ? String.fromCodePoint(numeric)
        : entity;
    }
    return ({ amp: '&', apos: "'", quot: '"', lt: '<', gt: '>', nbsp: '\u00a0' })[code.toLowerCase()];
  });
}

function tagExpression(name, global = false) {
  const flags = global ? 'gi' : 'i';
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`<(?:(?:[A-Za-z_][\\w.-]*):)?${escaped}\\b[^>]*>([\\s\\S]*?)<\\/(?:(?:[A-Za-z_][\\w.-]*):)?${escaped}\\s*>`, flags);
}

function tagContents(block, name) {
  return block.match(tagExpression(name))?.[1] ?? null;
}

function tagBlocks(block, name) {
  return [...block.matchAll(tagExpression(name, true))].map((match) => match[1]);
}

function plainText(value) {
  return decodeEntities(value.replace(/<[^>]*>/g, '').trim());
}

function readDescriptionField(description, field) {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const expression = new RegExp(`<td\\b[^>]*>\\s*${escaped}\\s*<\\/td>\\s*<td\\b[^>]*>([\\s\\S]*?)<\\/td>`, 'i');
  const match = description.match(expression);
  return match ? plainText(match[1]) : null;
}

function parseRing(boundaryBlock, context) {
  const coordinateText = tagContents(boundaryBlock, 'coordinates');
  if (!coordinateText) throw new Error(`${context}: polygon boundary has no coordinates`);
  const ring = coordinateText.trim().split(/\s+/u).filter(Boolean).map((tuple) => {
    const values = tuple.split(',');
    if (values.length < 2) throw new Error(`${context}: invalid KML coordinate tuple ${tuple}`);
    const longitude = Number(values[0]);
    const latitude = Number(values[1]);
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)
      || longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) {
      throw new Error(`${context}: coordinate outside EPSG:4326 bounds (${tuple})`);
    }
    return [longitude, latitude];
  });

  if (ring.length < 4) throw new Error(`${context}: polygon ring must contain at least four positions`);
  const first = ring[0];
  const last = ring.at(-1);
  if (first[0] !== last[0] || first[1] !== last[1]) throw new Error(`${context}: polygon ring is not closed`);
  if (new Set(ring.slice(0, -1).map(([longitude, latitude]) => `${longitude},${latitude}`)).size < 3) {
    throw new Error(`${context}: polygon ring must contain at least three distinct positions`);
  }
  return ring;
}

function parsePolygon(block, context) {
  const outerBoundary = tagContents(block, 'outerBoundaryIs');
  if (!outerBoundary) throw new Error(`${context}: polygon has no outer boundary`);
  const holes = tagBlocks(block, 'innerBoundaryIs').map((inner, index) => parseRing(inner, `${context} inner ring ${index + 1}`));
  return [parseRing(outerBoundary, `${context} outer ring`), ...holes];
}

function parsePlacemark(block, index) {
  const nameContents = tagContents(block, 'name');
  const name = nameContents === null ? '' : plainText(nameContents);
  if (!name) throw new Error(`KML placemark ${index + 1}: missing park name`);

  const descriptionContents = tagContents(block, 'description') ?? '';
  const description = descriptionContents.replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '');
  const sourceId = readDescriptionField(description, 'prop_id')?.toUpperCase();
  if (!sourceId || !/^PROP\d+$/.test(sourceId)) {
    throw new Error(`${name}: missing or invalid stable prop_id in source attributes`);
  }
  const tenureStatus = readDescriptionField(description, 'tenure_sta');
  const polygons = tagBlocks(block, 'Polygon').map((polygon, polygonIndex) => parsePolygon(polygon, `${name} polygon ${polygonIndex + 1}`));
  if (!polygons.length) throw new Error(`${name}: source placemark has no polygon geometry`);

  return { sourceId, name, tenureStatus, polygons };
}

function pointKey([longitude, latitude]) {
  return `${longitude},${latitude}`;
}

function hasSharedEdge(left, right) {
  const directed = new Set();
  for (let index = 0; index < left.length - 1; index += 1) {
    directed.add(`${pointKey(left[index])}>${pointKey(left[index + 1])}`);
  }
  for (let index = 0; index < right.length - 1; index += 1) {
    if (directed.has(`${pointKey(right[index + 1])}>${pointKey(right[index])}`)) return true;
  }
  return false;
}

function dissolveSharedEdgeGroup(polygons) {
  if (polygons.some((polygon) => polygon.length !== 1)) return null;
  const edges = new Map();
  let sharedEdgeCount = 0;
  for (const [outer] of polygons) {
    for (let index = 0; index < outer.length - 1; index += 1) {
      const start = outer[index];
      const end = outer[index + 1];
      const key = `${pointKey(start)}>${pointKey(end)}`;
      const reverseKey = `${pointKey(end)}>${pointKey(start)}`;
      if (edges.has(reverseKey)) {
        edges.delete(reverseKey);
        sharedEdgeCount += 1;
      } else if (edges.has(key)) {
        return null;
      } else {
        edges.set(key, { start, end });
      }
    }
  }
  if (!sharedEdgeCount || !edges.size) return null;

  const rings = [];
  while (edges.size) {
    const firstKey = edges.keys().next().value;
    const firstEdge = edges.get(firstKey);
    const startKey = pointKey(firstEdge.start);
    const ring = [firstEdge.start];
    let current = firstEdge;
    let steps = 0;
    while (true) {
      edges.delete(`${pointKey(current.start)}>${pointKey(current.end)}`);
      ring.push(current.end);
      const endKey = pointKey(current.end);
      if (endKey === startKey) break;
      const next = [...edges.entries()].filter(([, edge]) => pointKey(edge.start) === endKey);
      if (next.length !== 1) return null;
      current = next[0][1];
      steps += 1;
      if (steps > polygons.reduce((sum, polygon) => sum + polygon[0].length, 0)) return null;
    }
    rings.push(ring);
  }

  return rings.length === 1 ? [[rings[0]]] : null;
}

function dissolveTouchingParkParts(polygons) {
  if (polygons.length < 2) return polygons;
  const parent = polygons.map((_, index) => index);
  const find = (index) => {
    if (parent[index] !== index) parent[index] = find(parent[index]);
    return parent[index];
  };
  const join = (left, right) => { parent[find(right)] = find(left); };

  for (let left = 0; left < polygons.length; left += 1) {
    if (polygons[left].length !== 1) continue;
    for (let right = left + 1; right < polygons.length; right += 1) {
      if (polygons[right].length === 1 && hasSharedEdge(polygons[left][0], polygons[right][0])) join(left, right);
    }
  }

  const groups = new Map();
  polygons.forEach((polygon, index) => {
    const root = find(index);
    const group = groups.get(root) ?? [];
    group.push(polygon);
    groups.set(root, group);
  });

  return [...groups.values()].flatMap((group) => {
    if (group.length < 2) return group;
    return dissolveSharedEdgeGroup(group) ?? group;
  });
}

export function parseFraserFortGeorgeParksKml(xml) {
  if (typeof xml !== 'string') throw new TypeError('KML input must be a string');
  const placemarkBlocks = [...xml.matchAll(/<(?:(?:[A-Za-z_][\w.-]*):)?Placemark\b[^>]*>([\s\S]*?)<\/(?:(?:[A-Za-z_][\w.-]*):)?Placemark\s*>/gi)]
    .map((match) => match[1]);
  if (!placemarkBlocks.length) throw new Error('RDFFG KML contains no placemarks');

  const parksBySourceId = new Map();
  placemarkBlocks.forEach((block, index) => {
    const placemark = parsePlacemark(block, index);
    const status = placemark.tenureStatus?.trim().toLowerCase();
    if (status && status !== 'active') return;

    const existing = parksBySourceId.get(placemark.sourceId);
    if (existing) {
      if (existing.name !== placemark.name) {
        throw new Error(`${placemark.sourceId}: source ID is assigned to multiple park names`);
      }
      existing.polygons.push(...placemark.polygons);
      return;
    }
    parksBySourceId.set(placemark.sourceId, { ...placemark, polygons: [...placemark.polygons] });
  });

  if (!parksBySourceId.size) throw new Error('RDFFG KML contains no active regional park polygons');

  const features = [...parksBySourceId.values()]
    .sort((left, right) => left.name.localeCompare(right.name, 'en-CA'))
    .map(({ sourceId, name, polygons }) => {
      const boundaryParts = dissolveTouchingParkParts(polygons);
      const stableId = `regional-fraser-fort-george-${sourceId.toLowerCase()}`;
      const officialName = officialParkNamesBySourceId[sourceId] ?? name;
      return {
        type: 'Feature',
        id: stableId,
        properties: {
          id: stableId,
          name: officialName,
          sourceFeatureName: name,
          category: 'regional',
          region: 'Fraser-Fort George',
          sourceName: fraserFortGeorgeParksSource.name,
          sourceUrl: fraserFortGeorgeParksSource.page,
          sourceDataUrl: fraserFortGeorgeParksSource.data,
          sourceInventoryUrl: fraserFortGeorgeParksSource.inventoryPage,
          sourceId,
          sourceLicense: fraserFortGeorgeParksSource.license,
        },
        geometry: boundaryParts.length === 1
          ? { type: 'Polygon', coordinates: boundaryParts[0] }
          : { type: 'MultiPolygon', coordinates: boundaryParts },
      };
    });

  return { type: 'FeatureCollection', features };
}

export function parseFraserFortGeorgeParksArchive(archive) {
  const kmz = extractZipEntry(Buffer.from(archive), fraserFortGeorgeParksSource.archiveEntry);
  const kml = extractZipEntry(kmz, fraserFortGeorgeParksSource.kmlEntry).toString('utf8');
  return parseFraserFortGeorgeParksKml(kml);
}

export async function fetchFraserFortGeorgeParks({ fetchImpl = fetch } = {}) {
  const response = await fetchImpl(fraserFortGeorgeParksSource.data, {
    headers: { 'user-agent': 'parkdex-bc-expansion/1.0 (official GIS source importer)' },
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${fraserFortGeorgeParksSource.data}`);
  return parseFraserFortGeorgeParksArchive(Buffer.from(await response.arrayBuffer()));
}

async function runCli() {
  const collection = await fetchFraserFortGeorgeParks();
  const json = `${JSON.stringify(collection, null, 2)}\n`;
  const outputPath = process.argv[2];
  if (outputPath) await fs.writeFile(path.resolve(outputPath), json, 'utf8');
  else process.stdout.write(json);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runCli().catch((error) => {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  });
}

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  fraserFortGeorgeParksSource,
  parseFraserFortGeorgeParksArchive,
  parseFraserFortGeorgeParksKml,
} from './fraser-fort-george-parks.mjs';

function ring(points) {
  return points.map(([longitude, latitude]) => `${longitude},${latitude},0`).join(' ');
}

function polygon(exterior, holes = []) {
  const innerBoundaries = holes.map((coordinates) => `<innerBoundaryIs><LinearRing><coordinates>${ring(coordinates)}</coordinates></LinearRing></innerBoundaryIs>`).join('');
  return `<Polygon><outerBoundaryIs><LinearRing><coordinates>${ring(exterior)}</coordinates></LinearRing></outerBoundaryIs>${innerBoundaries}</Polygon>`;
}

function placemark({ name, propId, tenure = 'Active', polygons }) {
  return `<Placemark><name>${name}</name><description><![CDATA[<table><tr><td>prop_id</td><td>${propId}</td></tr><tr><td>tenure_sta</td><td>${tenure}</td></tr></table>]]></description><MultiGeometry>${polygons.join('')}</MultiGeometry></Placemark>`;
}

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function zip(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;

  for (const [name, dataValue] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name, 'utf8');
    const data = Buffer.isBuffer(dataValue) ? dataValue : Buffer.from(dataValue);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    const checksum = crc32(data);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localParts.push(localHeader, nameBytes, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralParts.push(centralHeader, nameBytes);
    localOffset += localHeader.length + nameBytes.length + data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(Object.keys(entries).length, 8);
  endRecord.writeUInt16LE(Object.keys(entries).length, 10);
  endRecord.writeUInt32LE(centralDirectory.length, 12);
  endRecord.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, endRecord]);
}

const square = (west, south, east, north) => [
  [west, south], [east, south], [east, north], [west, north], [west, south],
];

const firstName = 'Forest &amp; Lake Regional Park';
const xml = `<?xml version="1.0" encoding="UTF-8"?><kml><Document>
  ${placemark({
    name: firstName,
    propId: 'PROP00191',
    polygons: [polygon(square(-122, 53, -121.9, 53.1), [square(-121.98, 53.02, -121.96, 53.04)])],
  })}
  ${placemark({ name: firstName, propId: 'PROP00191', polygons: [polygon(square(-121.8, 53, -121.7, 53.1))] })}
  ${placemark({ name: 'Giscome Portage Regional Park', propId: 'PROP00014', polygons: [polygon(square(-123, 53, -122.9, 53.1))] })}
  ${placemark({ name: 'Harold Mann Regional Park Lot 2', propId: 'PROP00005', polygons: [polygon(square(-124, 53, -123.9, 53.1))] })}
  ${placemark({ name: 'Shared Boundary Regional Park', propId: 'PROP00020', polygons: [polygon(square(-122, 53, -121.9, 53.1))] })}
  ${placemark({ name: 'Shared Boundary Regional Park', propId: 'PROP00020', polygons: [polygon(square(-121.9, 53, -121.8, 53.1))] })}
  ${placemark({ name: 'Closed Regional Park', propId: 'PROP00999', tenure: 'Inactive', polygons: [polygon(square(-124, 53, -123.9, 53.1))] })}
</Document></kml>`;

test('parses official KML fields, preserves polygon rings, and joins records by stable property ID', () => {
  const collection = parseFraserFortGeorgeParksKml(xml);
  assert.equal(collection.type, 'FeatureCollection');
  assert.equal(collection.features.length, 4);

  const first = collection.features.find((feature) => feature.properties.sourceId === 'PROP00191');
  assert.ok(first);
  assert.equal(first.id, 'regional-fraser-fort-george-prop00191');
  assert.equal(first.properties.id, first.id);
  assert.equal(first.properties.name, 'Forest & Lake Regional Park');
  assert.equal(first.properties.category, 'regional');
  assert.equal(first.properties.region, 'Fraser-Fort George');
  assert.equal(first.properties.sourceName, fraserFortGeorgeParksSource.name);
  assert.equal(first.properties.sourceUrl, fraserFortGeorgeParksSource.page);
  assert.equal(first.properties.sourceDataUrl, fraserFortGeorgeParksSource.data);
  assert.equal(first.properties.sourceInventoryUrl, fraserFortGeorgeParksSource.inventoryPage);
  assert.equal(first.properties.sourceLicense, null);
  assert.equal(first.geometry.type, 'MultiPolygon');
  assert.equal(first.geometry.coordinates.length, 2);
  assert.equal(first.geometry.coordinates[0].length, 2, 'the interior ring is retained');
  assert.equal(first.geometry.coordinates[0][0].length, 5, 'the exterior ring is retained without simplification');
  assert.equal(first.geometry.coordinates[0][0][0].length, 2, 'KML altitude is discarded for GeoJSON');
  assert.deepEqual(collection.features.map((feature) => feature.properties.sourceId), ['PROP00191', 'PROP00014', 'PROP00005', 'PROP00020']);
  const giscome = collection.features.find((feature) => feature.properties.sourceId === 'PROP00014');
  assert.equal(giscome.properties.name, 'Giscome Portage-Huble Homestead Regional Park');
  assert.equal(giscome.properties.sourceFeatureName, 'Giscome Portage Regional Park');
  const harold = collection.features.find((feature) => feature.properties.sourceId === 'PROP00005');
  assert.equal(harold.properties.name, 'Harold Mann Regional Park');
  assert.equal(harold.properties.sourceFeatureName, 'Harold Mann Regional Park Lot 2');
  const joined = collection.features.find((feature) => feature.properties.sourceId === 'PROP00020');
  assert.equal(joined.geometry.type, 'Polygon', 'a shared source edge is removed from the internal boundary');
  assert.equal(joined.geometry.coordinates[0].length, 7);
});

test('reads the official nested ZIP/KMZ container', () => {
  const kmz = zip({ 'doc.kml': xml });
  const archive = zip({ [fraserFortGeorgeParksSource.archiveEntry]: kmz });
  const fromArchive = parseFraserFortGeorgeParksArchive(archive);
  assert.deepEqual(fromArchive, parseFraserFortGeorgeParksKml(xml));
});

test('rejects a polygon without a stable source identity', () => {
  const missingId = xml.replace('<td>PROP00191</td>', '<td>unknown</td>');
  assert.throws(() => parseFraserFortGeorgeParksKml(missingId), /missing or invalid stable prop_id/);
});

test('rejects open polygon rings rather than emitting invalid boundaries', () => {
  const openRing = xml.replace('-122,53,0 -121.9,53,0 -121.9,53.1,0 -122,53.1,0 -122,53,0', '-122,53,0 -121.9,53,0 -121.9,53.1,0 -122,53.1,0');
  assert.throws(() => parseFraserFortGeorgeParksKml(openRing), /polygon ring is not closed/);
});

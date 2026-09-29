import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sourceLayer = 'https://mapservices.crd.bc.ca/arcgis/rest/services/Basemap/Basemap/MapServer/3';
const queryUrl = sourceLayer + '/query';
const where = "Type IN ('Municipal Park','Community Park')";
const pageSize = 1000;
const previewPath = path.join(here, 'source-refresh-preview.geojson');
const reportPath = path.join(here, 'source-refresh-report.json');
const frozenSnapshotPath = path.join(here, 'crd-municipal-community-source.geojson');

const features = [];
const offsets = [];
for (let offset = 0; ; offset += pageSize) {
  offsets.push(offset);
  const query = new URLSearchParams({
    where,
    outFields: '*',
    returnGeometry: 'true',
    outSR: '4326',
    f: 'geojson',
    orderByFields: 'OBJECTID ASC',
    resultOffset: String(offset),
    resultRecordCount: String(pageSize),
  });
  const response = await fetch(queryUrl + '?' + query.toString(), {
    headers: { 'user-agent': 'parkdex-crd-local-parks-source-refresh/1.0' },
  });
  if (!response.ok) throw new Error('CRD query returned ' + response.status + ' ' + response.statusText);
  const page = await response.json();
  if (page.error) throw new Error('CRD query error: ' + JSON.stringify(page.error));
  if (page.type !== 'FeatureCollection' || !Array.isArray(page.features)) {
    throw new Error('CRD query did not return a GeoJSON FeatureCollection');
  }
  features.push(...page.features);
  if (page.features.length < pageSize) break;
}

features.sort((a, b) => Number(a.properties?.OBJECTID) - Number(b.properties?.OBJECTID));
const objectIds = features.map((feature) => Number(feature.properties?.OBJECTID));
if (objectIds.some((objectId) => !Number.isSafeInteger(objectId) || objectId <= 0)
    || new Set(objectIds).size !== objectIds.length) {
  throw new Error('Refreshed CRD data contains invalid or duplicate OBJECTIDs');
}
const preview = { type: 'FeatureCollection', features };
const previewBytes = Buffer.from(JSON.stringify(preview, null, 2) + '\n', 'utf8');
const now = new Date().toISOString();
const report = {
  refreshedAtUtc: now,
  sourceLayer,
  where,
  outFields: '*',
  returnGeometry: true,
  outSR: 4326,
  orderByFields: 'OBJECTID ASC',
  pageSize,
  offsets,
  featureCount: features.length,
  objectIdRange: features.length ? [objectIds[0], objectIds.at(-1)] : [],
  sha256: createHash('sha256').update(previewBytes).digest('hex'),
  preview: path.basename(previewPath),
  adoption: 'Review changed records and explicitly update import-manifest.json before replacing the frozen snapshot. This command does not modify the accepted snapshot or generated outputs.',
};

if (path.resolve(previewPath) === path.resolve(frozenSnapshotPath)) {
  throw new Error('Refusing to overwrite the accepted frozen source snapshot');
}
await fs.writeFile(previewPath, previewBytes);
await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log('Wrote source refresh preview with ' + features.length + ' CRD features.');
console.log('The accepted snapshot and manifest were not changed.');

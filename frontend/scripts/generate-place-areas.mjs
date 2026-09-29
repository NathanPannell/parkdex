import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const boundaryPath = new URL('../../data/boundaries.geojson', import.meta.url);
const cataloguePath = new URL('../lib/place-areas.catalogue.json', import.meta.url);
const earthRadiusMeters = 6_371_008.8;

function ringAreaKm2(ring) {
  if (!Array.isArray(ring) || ring.length < 4) throw new Error('Invalid boundary ring');
  let sum = 0;
  for (let index = 0; index < ring.length; index += 1) {
    const current = ring[index];
    const next = ring[(index + 1) % ring.length];
    let longitudeDelta = next[0] - current[0];
    while (longitudeDelta > 180) longitudeDelta -= 360;
    while (longitudeDelta < -180) longitudeDelta += 360;
    sum += longitudeDelta * Math.PI / 180
      * (2 + Math.sin(current[1] * Math.PI / 180) + Math.sin(next[1] * Math.PI / 180));
  }
  return Math.abs(sum) * earthRadiusMeters ** 2 / 2 / 1_000_000;
}

function polygonAreaKm2(polygon) {
  const outer = ringAreaKm2(polygon[0]);
  const holes = polygon.slice(1).reduce((sum, ring) => sum + ringAreaKm2(ring), 0);
  const area = outer - holes;
  if (!(area > 0)) throw new Error('Boundary polygon has no positive area');
  return area;
}

const boundaries = JSON.parse(readFileSync(boundaryPath, 'utf8'));
const entries = boundaries.features.map((feature) => {
  const { id } = feature.properties;
  const polygons = feature.geometry.type === 'Polygon'
    ? [feature.geometry.coordinates]
    : feature.geometry.coordinates;
  const area = polygons.reduce((sum, polygon) => sum + polygonAreaKm2(polygon), 0);
  const rounded = Number(area.toFixed(6));
  if (!id || !(rounded > 0)) throw new Error(`${id}: boundary area rounds to zero`);
  return [id, rounded];
});
const ids = entries.map(([id]) => id);
if (new Set(ids).size !== ids.length) throw new Error('Duplicate boundary IDs');
const output = `${JSON.stringify(Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b))), null, 2)}\n`;

if (process.argv.includes('--check')) {
  if (readFileSync(cataloguePath, 'utf8') !== output) {
    throw new Error('Place area catalogue is stale; run generate-place-areas.mjs');
  }
  console.log(`Verified ${entries.length} place areas`);
} else {
  writeFileSync(cataloguePath, output);
  console.log(`Wrote ${entries.length} place areas to ${fileURLToPath(cataloguePath)}`);
}

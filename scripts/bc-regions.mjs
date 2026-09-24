// GeoBC's legally defined regional districts are the geographic authority for
// assigning new catalogue records to a short list of BC collection regions.
// The Stikine Region is included in the layer but is not a regional district.
export const regionalDistrictBoundarySource = Object.freeze({
  name: 'Province of British Columbia - Regional Districts (legal administrative areas)',
  page: 'https://delivery.maps.gov.bc.ca/arcgis/rest/services/whse/bcgw_pub_whse_legal_admin_boundaries/MapServer/16',
  data: 'https://delivery.maps.gov.bc.ca/arcgis/rest/services/whse/bcgw_pub_whse_legal_admin_boundaries/MapServer/16/query?where=1%3D1&outFields=ADMIN_AREA_NAME%2CADMIN_AREA_ABBREVIATION&returnGeometry=true&outSR=4326&geometryPrecision=4&maxAllowableOffset=0.001&f=geojson',
});

export const districtCollectionRegion = Object.freeze({
  CAPRD: 'Southern Vancouver Island',
  CVRD: 'Southern Vancouver Island',
  RDN: 'Southern Vancouver Island',
  RDAC: 'Southern Vancouver Island',
  CMXRD: 'Northern Vancouver Island',
  STRD: 'Northern Vancouver Island',
  RDMW: 'Northern Vancouver Island',
  qRD: 'South Coast',
  SCRD: 'South Coast',
  SLRD: 'South Coast',
  MVRD: 'South Coast',
  FVRD: 'South Coast',
  RDOS: 'Thompson & Okanagan',
  TNRD: 'Thompson & Okanagan',
  RDCO: 'Thompson & Okanagan',
  RDNO: 'Thompson & Okanagan',
  CSRD: 'Thompson & Okanagan',
  RDCK: 'Kootenays',
  RDEK: 'Kootenays',
  RDKB: 'Kootenays',
  CRD: 'Cariboo & Central Interior',
  RDFFG: 'Cariboo & Central Interior',
  CCRD: 'Central Coast',
  NCRD: 'North Coast & Haida Gwaii',
  RDKS: 'North Coast & Haida Gwaii',
  RDBN: 'Nechako',
  'Stikine Region': 'Nechako',
  PRRD: 'Northeast',
});

function ringContains([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

function polygonContains(point, polygon) {
  return ringContains(point, polygon[0]) && !polygon.slice(1).some((ring) => ringContains(point, ring));
}

function polygonsFor(geometry) {
  if (geometry.type === 'Polygon') return [geometry.coordinates];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates;
  throw new Error(`Unexpected regional district geometry: ${geometry.type}`);
}

function distanceToRing([longitude, latitude], ring) {
  const longitudeScale = Math.cos(latitude * Math.PI / 180);
  let closest = Infinity;
  for (let i = 1; i < ring.length; i++) {
    const ax = (ring[i - 1][0] - longitude) * longitudeScale;
    const ay = ring[i - 1][1] - latitude;
    const bx = (ring[i][0] - longitude) * longitudeScale;
    const by = ring[i][1] - latitude;
    const dx = bx - ax;
    const dy = by - ay;
    const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)));
    const x = ax + t * dx;
    const y = ay + t * dy;
    closest = Math.min(closest, x * x + y * y);
  }
  return closest;
}

const response = await fetch(regionalDistrictBoundarySource.data, {
  headers: { 'user-agent': 'parkdex-data-builder/1.0' },
});
if (!response.ok) throw new Error(`Regional district boundary source returned ${response.status}`);
const collection = await response.json();
if (collection.type !== 'FeatureCollection' || collection.features?.length !== 28) {
  throw new Error(`Expected 27 BC regional districts and Stikine, received ${collection.features?.length ?? 0}`);
}
const districts = collection.features.map((feature) => {
  const abbreviation = feature.properties?.ADMIN_AREA_ABBREVIATION;
  const region = districtCollectionRegion[abbreviation];
  if (!region) throw new Error(`No collection region for ${abbreviation}`);
  const polygons = polygonsFor(feature.geometry);
  return { abbreviation, region, polygons };
});
if (new Set(districts.map(({ abbreviation }) => abbreviation)).size !== 28) {
  throw new Error('Duplicate regional district abbreviation in GeoBC source');
}

export function classifyBcRegion(longitude, latitude) {
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
    throw new Error('BC region classifier requires finite coordinates');
  }
  const point = [longitude, latitude];
  for (const district of districts) {
    if (district.polygons.some((polygon) => polygonContains(point, polygon))) return district.region;
  }
  // Marine parks can sit beyond the legal district land polygon. The closest
  // district coastline places them in the same collection as the shore.
  let nearest = null;
  for (const district of districts) {
    const distance = Math.min(...district.polygons.map((polygon) => distanceToRing(point, polygon[0])));
    if (!nearest || distance < nearest.distance) nearest = { region: district.region, distance };
  }
  if (!nearest || nearest.distance > 4) {
    // The Northern Rockies Regional Municipality is outside the 27 district
    // polygons. Its northern/eastern BC location is in the Northeast group.
    if (latitude >= 57 && longitude >= -126.5) return 'Northeast';
    throw new Error(`Cannot assign BC collection region at ${longitude}, ${latitude}`);
  }
  return nearest.region;
}

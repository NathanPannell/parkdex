export const boundarySources = Object.freeze({
  bcParks: Object.freeze({
    name: 'BC Parks / DataBC — TANTALIS protected areas',
    page: 'https://catalogue.data.gov.bc.ca/dataset/parks-ecological-reserves-and-protected-areas',
    data: 'https://openmaps.gov.bc.ca/geo/pub/WHSE_TANTALIS.TA_PARK_ECORES_PA_SVW/ows?service=WFS&version=2.0.0&request=GetFeature&typeNames=pub:WHSE_TANTALIS.TA_PARK_ECORES_PA_SVW&outputFormat=json&srsName=EPSG:4326&bbox=48.2,-128.8,51.2,-123.0,urn:ogc:def:crs:EPSG::4326',
  }),
  crd: Object.freeze({
    name: 'Capital Regional District — Park GIS layer',
    page: 'https://mapservices.crd.bc.ca/arcgis/rest/services/Basemap/Basemap/MapServer/3',
    data: "https://mapservices.crd.bc.ca/arcgis/rest/services/Basemap/Basemap/MapServer/3/query?where=Type%3D%27Regional%20Park%27&outFields=*&returnGeometry=true&outSR=4326&f=geojson",
  }),
  cvrd: Object.freeze({
    name: 'Cowichan Valley Regional District — Parks GIS layer',
    page: 'https://maps.cvrd.ca/mapservices/rest/services/Parks/MapServer/2',
    data: "https://maps.cvrd.ca/mapservices/rest/services/Parks/MapServer/2/query?where=Park_Type%3D%27Regional%20Park%27&outFields=*&returnGeometry=true&outSR=4326&f=geojson",
  }),
  rdn: Object.freeze({
    name: 'Regional District of Nanaimo — Regional Parks spatial data',
    page: 'https://rdn.bc.ca/spatial-data-files',
    data: 'https://rdn.bc.ca/sites/default/files/RegionalParks_14.kmz',
  }),
  national: Object.freeze({
    name: 'Natural Resources Canada — Canada Lands Survey System',
    page: 'https://open.canada.ca/data/en/dataset/9e1507cd-f25c-4c64-995b-6563bf9d65bd',
    data: "https://proxyinternet.nrcan-rncan.gc.ca/arcgis/rest/services/CLSS-SATC/CLSS_Administrative_Boundaries/MapServer/1/query?where=adminAreaId%20IN%20(%27PRIM%27%2C%27GULF%27)&outFields=adminAreaId%2CadminAreaNameEng%2CNID&returnGeometry=true&outSR=4326&f=geojson",
  }),
  osm: Object.freeze({
    name: 'OpenStreetMap contributors',
    page: 'https://www.openstreetmap.org/copyright',
    lookup: 'https://nominatim.openstreetmap.org/lookup',
  }),
});

// These reviewed object identities are part of the source contract. Keeping them
// outside generated audit output makes accidental identity drift fail validation.
export const osmObjects = new Map([
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

const nationalSourceIds = new Map([
  ['national-gulf-islands-national-park-reserve', 'a8532b93849c20c344c7'],
  ['national-pacific-rim-national-park-reserve', '5bf78d80ba3611d892e2'],
]);

const crdSourceIds = new Map([
  ['regional-albert-head-lagoon-regional-park', '1689'],
  ['regional-ayum-creek-regional-park', '1955'],
  ['regional-bear-hill-regional-park', '1710'],
  ['regional-brooks-point-regional-park', '1612'],
  ['regional-coles-bay-regional-park', '1885'],
  ['regional-devonian-regional-park', '1819'],
  ['regional-east-point-regional-park', '1613'],
  ['regional-east-sooke-regional-park', '1694'],
  ['regional-elk-beaver-lake-regional-park', '1698'],
  ['regional-francis-king-regional-park', '1691'],
  ['regional-george-hill-regional-park', '1953'],
  ['regional-gonzales-hill-regional-park', '1619'],
  ['regional-horth-hill-regional-park', '1622'],
  ['regional-island-view-beach-regional-park', '1960'],
  ['regional-jordan-river-regional-park', '1962'],
  ['regional-kapoor-regional-park', '1630'],
  ['regional-lone-tree-hill-regional-park', '1631'],
  ['regional-matheson-lake-regional-park', '1818'],
  ['regional-matthews-point-regional-park', '1632'],
  ['regional-mill-farm-regional-park', '1872'],
  ['regional-mill-hill-regional-park', '1847'],
  ['regional-mount-parke-regional-park', '1641'],
  ['regional-mount-wells-regional-park', '1796'],
  ['regional-mount-work-regional-park', '1646'],
  ['regional-mountain-forest-regional-park', '1702'],
  ['regional-roche-cove-regional-park', '1802'],
  ['regional-sea-to-sea-regional-park', '1659'],
  ['regional-sooke-hills-wilderness-regional-park', '1668'],
  ['regional-sooke-potholes-regional-park', '1678'],
  ['regional-sooke-river-regional-park', '1800'],
  ['regional-st-john-point-regional-park', '1679'],
  ['regional-thetis-lake-regional-park', '1686'],
  ['regional-witty-s-lagoon-regional-park', '1696'],
  ['regional-wrigglesworth-lake-regional-park', '527'],
]);

export const expectedSourceCounts = Object.freeze({
  [boundarySources.bcParks.name]: 136,
  [boundarySources.crd.name]: 34,
  [boundarySources.cvrd.name]: 4,
  [boundarySources.national.name]: 2,
  [boundarySources.osm.name]: 26,
  [boundarySources.rdn.name]: 14,
});

export function expectedBoundarySource(place) {
  if (place.category === 'national') return { source: boundarySources.national, sourceId: nationalSourceIds.get(place.id) };
  if (place.category === 'provincial') return { source: boundarySources.bcParks, sourceId: place.sourceId == null ? null : String(place.sourceId) };
  if (place.category === 'island' || place.id === 'regional-bere-point-regional-park') {
    return { source: boundarySources.osm, sourceId: osmObjects.get(place.id) };
  }
  if (place.sourceName === boundarySources.crd.name) return { source: boundarySources.crd, sourceId: crdSourceIds.get(place.id) };
  if (place.sourceName === boundarySources.cvrd.name) return { source: boundarySources.cvrd, sourceId: place.sourceId == null ? null : String(place.sourceId) };
  if (place.sourceName === boundarySources.rdn.name) return { source: boundarySources.rdn, sourceId: `rdn-${place.id.slice('regional-'.length)}` };
  return null;
}

export function validateBoundarySource(place, properties) {
  const expected = expectedBoundarySource(place);
  if (!expected?.source || !expected.sourceId) throw new Error(`${place.id}: no reviewed boundary source contract`);
  if (properties.sourceName !== expected.source.name) throw new Error(`${place.id}: unexpected boundary source name`);
  if (properties.sourceUrl !== expected.source.page) throw new Error(`${place.id}: unexpected boundary source URL`);
  if (String(properties.sourceId) !== expected.sourceId) throw new Error(`${place.id}: unexpected boundary source object`);
}

export function countBoundarySources(features) {
  return Object.fromEntries(Object.keys(expectedSourceCounts).map((name) => [name, features.filter((feature) => feature.properties.sourceName === name).length]));
}

export function validateBoundarySourceCounts(features, auditCounts) {
  const actual = countBoundarySources(features);
  if (JSON.stringify(actual) !== JSON.stringify(expectedSourceCounts)) throw new Error('boundary source counts differ from reviewed contract');
  if (JSON.stringify(actual) !== JSON.stringify(auditCounts)) throw new Error('boundary audit source counts mismatch');
}

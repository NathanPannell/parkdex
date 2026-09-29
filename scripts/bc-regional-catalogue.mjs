import { fetchMetroVancouverParks, metroVancouverParkSource } from './metro-vancouver-parks.mjs';
import { fetchRdcoParks, rdcoParkSource } from './rdco-parks.mjs';
import { fetchFraserFortGeorgeParks, fraserFortGeorgeParksSource } from './fraser-fort-george-parks.mjs';
import { fetchWfsRegionalParkFeatures, groupRegionalParkFeatures, regionalGreenspacesSource } from './regional-greenspaces.mjs';

export const officialRegionalSources = Object.freeze({
  metro: { name: metroVancouverParkSource.name, page: metroVancouverParkSource.page },
  rdco: { name: rdcoParkSource.name, page: rdcoParkSource.page },
  rdffg: { name: fraserFortGeorgeParksSource.name, page: fraserFortGeorgeParksSource.page },
  greenspaces: { name: 'BC Local and Regional Greenspaces / DataBC', page: regionalGreenspacesSource.cataloguePage },
});

const localAuthorityDistricts = [
  'Capital', 'Cowichan Valley', 'Nanaimo',
  'Metro Vancouver', 'Central Okanagan', 'Fraser-Fort George',
];

// The WFS type flags are broader than an official named park inventory. These
// reviewed source identities are clearly facilities, tenures, trails, or
// insufficiently identified sites. Keep the reason with the stable source ID.
export const excludedGreenspaceIds = new Map([
  ['8803', 'civic address rather than a named park'],
  ['7174', 'Crown tenure, not a distinct park'],
  ['7160', 'Crown tenure, not a distinct park'],
  ['6960', 'Crown tenure, not a distinct park'],
  ['7026', 'community centre rather than a park'],
  ['325', 'historic hotel rather than a park'],
  ['7087', 'ranger station rather than a park'],
  ['4818', 'greenway rather than a park'],
  ['4887', 'greenway rather than a park'],
  ['8438', 'generic district label without a named park'],
  ['4831', 'person names without a verified park name'],
  ['7106', 'ambiguous bare name without a verified park identity'],
  ['7022', 'ambiguous bare name without a verified park identity'],
  ['315', 'ambiguous bare name without a verified park identity'],
]);

function canonicalFeature(feature, sourceKey) {
  const source = officialRegionalSources[sourceKey];
  const district = feature.properties?.regionalDistrict;
  const sourceName = sourceKey === 'greenspaces'
    ? `${district}${district === 'Northern Rockies Regional Municipality' || district === 'Stikine Region' ? '' : ' Regional District'} via BC Local and Regional Greenspaces`
    : source.name;
  const originalId = String(feature.id || feature.properties?.id || '');
  const sourceId = sourceKey === 'greenspaces'
    ? String(feature.properties?.sourceIds?.[0] || '')
    : String(feature.properties?.sourceId || '');
  if (!originalId || !sourceId || !feature.properties?.name) {
    throw new Error(`${source.name}: incomplete park identity`);
  }
  const suffix = sourceKey === 'metro' ? originalId.replace(/^metro-vancouver-/, '')
    : sourceKey === 'rdco' ? originalId.replace(/^regional-central-okanagan-/, '')
      : sourceKey === 'rdffg' ? originalId.replace(/^regional-fraser-fort-george-/, '')
        : originalId.replace(/^bc-regional-/, '');
  const idPrefix = sourceKey === 'metro' ? 'regional-metro-vancouver' : `regional-${sourceKey}`;
  const id = `${idPrefix}-${suffix}`;
  return {
    type: 'Feature',
    id,
    properties: {
      ...feature.properties,
      id,
      sourceId,
      sourceName,
      sourceUrl: source.page,
    },
    geometry: feature.geometry,
  };
}

export async function fetchOfficialRegionalParks() {
  const [metro, rdco, rdffg, wfs] = await Promise.all([
    fetchMetroVancouverParks(), fetchRdcoParks(), fetchFraserFortGeorgeParks(), fetchWfsRegionalParkFeatures(),
  ]);
  const greenspaces = groupRegionalParkFeatures(wfs.features, { localAuthorityDistricts });
  const excludedGreenspaces = [];
  const includedGreenspaces = greenspaces.groups.filter((feature) => {
    const sourceId = String(feature.properties.sourceIds?.[0] ?? '');
    const trailOnly = /\btrails?\b/i.test(feature.properties.name) && !/\bpark\b/i.test(feature.properties.name);
    const reason = excludedGreenspaceIds.get(sourceId) || (trailOnly ? 'trail rather than a park' : null);
    if (reason) excludedGreenspaces.push({ sourceId, name: feature.properties.name, district: feature.properties.regionalDistrict, reason });
    return !reason;
  });
  const features = [
    ...metro.features.map((feature) => canonicalFeature(feature, 'metro')),
    ...rdco.features.map((feature) => canonicalFeature(feature, 'rdco')),
    ...rdffg.features.map((feature) => canonicalFeature(feature, 'rdffg')),
    ...includedGreenspaces.map((feature) => canonicalFeature(feature, 'greenspaces')),
  ];
  const ids = features.map((feature) => feature.id);
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate regional park identity across official sources');
  return {
    features,
    counts: {
      metro: metro.features.length,
      rdco: rdco.features.length,
      rdffg: rdffg.features.length,
      greenspaces: includedGreenspaces.length,
      greenspacesSourceFeatures: wfs.features.length,
      greenspacesExcluded: greenspaces.excluded.length,
      greenspacesExcludedAfterGrouping: excludedGreenspaces.length,
    },
    excludedGreenspaces,
  };
}

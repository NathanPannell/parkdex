import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasBalancedNameDelimiters, provincialNameCorrections } from './place-name-corrections.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const places = JSON.parse(fs.readFileSync(path.join(root, 'data', 'places.json'), 'utf8'));
const audit = JSON.parse(fs.readFileSync(path.join(root, 'data', 'coverage-audit.json'), 'utf8'));
const visitorPages = JSON.parse(fs.readFileSync(path.join(root, 'frontend', 'lib', 'visitor-information.catalogue.json'), 'utf8'));
const publishedDescriptionSources = JSON.parse(fs.readFileSync(path.join(root, 'frontend', 'lib', 'place-description-sources.catalogue.json'), 'utf8'));
const descriptionFiles = ['place-descriptions.catalogue.json', 'nonprovincial-descriptions.catalogue.json'];
const descriptionEntries = new Map();
for (const filename of descriptionFiles) {
  const catalogue = JSON.parse(fs.readFileSync(path.join(root, 'data', filename), 'utf8'));
  if (!catalogue.entries || typeof catalogue.entries !== 'object' || Array.isArray(catalogue.entries)) {
    throw new Error(`${filename}: expected an entries object`);
  }
  for (const [id, entry] of Object.entries(catalogue.entries)) {
    if (descriptionEntries.has(id)) throw new Error(`duplicate description entry: ${id}`);
    if (!['summary', 'no-overview'].includes(entry.status)
        || typeof entry.description !== 'string' || entry.description.trim().length < 40
        || !URL.canParse(entry.sourceUrl) || !entry.sourceUrl.startsWith('https://')
        || !entry.sourceName || !entry.sourceTitle || !entry.sourceSection
        || !/^\d{4}-\d{2}-\d{2}$/.test(entry.reviewedAt ?? '')
        || (entry.status === 'no-overview' && !entry.description.startsWith('No visitor overview is available'))) {
      throw new Error(`${filename}: incomplete description or source provenance for ${id}`);
    }
    descriptionEntries.set(id, entry);
  }
}
const requiredFields = ['id', 'name', 'category', 'latitude', 'longitude', 'region', 'description', 'sourceUrl', 'sourceName'];
const categories = new Set(['national', 'provincial', 'regional', 'island']);
const ids = new Set();

for (const place of places) {
  for (const field of requiredFields) {
    if (place[field] === undefined || place[field] === '') throw new Error(`${place.id || place.name}: missing ${field}`);
  }
  if (ids.has(place.id)) throw new Error(`duplicate id: ${place.id}`);
  if (!hasBalancedNameDelimiters(place.name)) throw new Error(`${place.id}: unmatched display-name delimiter`);
  ids.add(place.id);
  if (!categories.has(place.category)) throw new Error(`${place.id}: invalid category`);
  if (!Number.isFinite(place.latitude) || !Number.isFinite(place.longitude)) throw new Error(`${place.id}: invalid coordinate`);
  if (place.latitude < 48.15 || place.latitude > 51.25 || place.longitude < -128.9 || place.longitude > -123) throw new Error(`${place.id}: coordinate outside catalogue extent`);
  if (!URL.canParse(place.sourceUrl) || !place.sourceUrl.startsWith('https://')) throw new Error(`${place.id}: sourceUrl must be HTTPS`);
  const description = descriptionEntries.get(place.id);
  if (!description) throw new Error(`${place.id}: missing visitor-facing description source`);
  if (place.description !== description.description) throw new Error(`${place.id}: built description does not match its source catalogue`);
}

if (descriptionEntries.size !== places.length) throw new Error('description source catalogues do not match the canonical place count');
const expectedDescriptionSources = Object.fromEntries([...descriptionEntries].sort(([a], [b]) => a.localeCompare(b)).map(([id, entry]) => [id, {
  status: entry.status,
  sourceName: entry.sourceName,
  sourceTitle: entry.sourceTitle,
  sourceUrl: entry.sourceUrl,
  sourceSection: entry.sourceSection,
  reviewedAt: entry.reviewedAt,
}]));
if (JSON.stringify(publishedDescriptionSources) !== JSON.stringify(expectedDescriptionSources)) {
  throw new Error('frontend description source catalogue is stale or does not match source provenance');
}
const provincialDescriptionGaps = new Set(['provincial-beaver-point-park', 'provincial-eves-park']);
const supplementalProvincialSources = new Map([
  ['provincial-arbutus-grove-park', {
    sourceName: 'BC Parks',
    sourceUrl: 'https://nrs.objectstore.gov.bc.ca/kuwyyf/arbutus_grove_zoningplan_89e9a73c51.pdf',
    sourceSection: 'Primary Role and Secondary Role',
  }],
  ['provincial-hwsalu-utsum-park', {
    sourceName: 'Government of British Columbia',
    sourceUrl: 'https://news.gov.bc.ca/releases/2021ENV0054-001907',
    sourceSection: 'Hwsalu-Utsum description',
  }],
  ['provincial-wood-mountain-ski-park', {
    sourceName: 'BC Geographical Names Office',
    sourceUrl: 'https://apps.gov.bc.ca/pub/bcgnws/names/23998.html',
    sourceSection: 'Description and history',
  }],
]);
for (const place of places.filter((item) => item.category === 'provincial')) {
  const description = descriptionEntries.get(place.id);
  if (provincialDescriptionGaps.has(place.id)) {
    if (description.status !== 'no-overview') throw new Error(`${place.id}: source gap must remain explicit`);
    if (description.sourceName !== 'BC Parks' || description.sourceUrl !== visitorPages[place.id]?.url) {
      throw new Error(`${place.id}: no-overview source provenance mismatch`);
    }
  } else {
    const supplemental = supplementalProvincialSources.get(place.id);
    const hasExpectedSource = supplemental
      ? description.sourceName === supplemental.sourceName && description.sourceUrl === supplemental.sourceUrl
        && description.sourceSection === supplemental.sourceSection
      : description.sourceName === 'BC Parks' && description.sourceUrl === visitorPages[place.id]?.url
        && description.sourceSection === 'Highlights in this park';
    if (description.status !== 'summary' || !hasExpectedSource) {
      throw new Error(`${place.id}: expected a paraphrased official overview with matching provenance`);
    }
  }
}
for (const [id] of supplementalProvincialSources) {
  if (!places.some((place) => place.id === id && place.category === 'provincial')) {
    throw new Error(`${id}: supplemental provincial source does not match a canonical park`);
  }
}

for (const [sourceId, correction] of provincialNameCorrections) {
  const place = places.find((item) => item.category === 'provincial' && item.sourceId === sourceId);
  const alias = correction.alias.replace(/^Also known as\s+/i, '').replace(/[.!?]+$/, '');
  if (!place || place.id !== correction.id || place.name !== correction.name || !place.description.includes(alias)) throw new Error(`Display correction or stable identity lost for provincial source ${sourceId}`);
}

const expected = [
  'national-pacific-rim-national-park-reserve', 'national-gulf-islands-national-park-reserve',
  'provincial-cape-scott-park', 'provincial-strathcona-park', 'provincial-elk-falls-park',
  'provincial-rathtrevor-beach-park', 'provincial-miracle-beach-park',
  'regional-kwaksistah-regional-park', 'regional-little-huson-cave-regional-park',
  'regional-mount-cain-alpine-park',
  'regional-sooke-river-regional-park',
];
for (const id of expected) if (!ids.has(id)) throw new Error(`coverage regression: ${id}`);

const reviewedRegionalPointSources = new Map([
  ['regional-kwaksistah-regional-park', 'W827164115'],
  ['regional-little-huson-cave-regional-park', 'W816998556'],
  ['regional-mount-cain-alpine-park', 'W579980733'],
]);
for (const [id, sourceId] of reviewedRegionalPointSources) {
  const place = places.find((item) => item.id === id);
  if (place?.sourceId !== sourceId || !place.sourceName.includes('OpenStreetMap contributors')) {
    throw new Error(`${id}: reviewed point-source provenance mismatch`);
  }
}

const excludedMainlandIds = [
  'provincial-alice-lake-park', 'provincial-garibaldi-park', 'provincial-shannon-falls-park',
  'provincial-stawamus-chief-park', 'provincial-tantalus-park',
];
for (const id of excludedMainlandIds) if (ids.has(id)) throw new Error(`mainland scope regression: ${id}`);

const excludedRegionalIds = [
  'regional-siddoo-regional-park',
  'regional-stocking-heart-lake-regional-park',
  'regional-morden-colliery-regional-trail',
  'regional-bute-island-regional-park',
];
for (const id of excludedRegionalIds) if (ids.has(id)) throw new Error(`ineligible regional feature regression: ${id}`);
for (const id of ['provincial-apodaca-park', 'provincial-buccaneer-bay-park']) {
  if (ids.has(id)) throw new Error(`out-of-scope Sunshine Coast feature regression: ${id}`);
}
if (places.some((place) => place.category === 'regional' && /\btrail\b/i.test(place.name))) {
  throw new Error('regional trail regression: trail emitted as a park');
}

const expectedRegions = new Map([
  ['island-flores-island', 'West Coast Islands'],
  ['island-meares-island', 'West Coast Islands'],
  ['island-vargas-island', 'West Coast Islands'],
  ['island-quadra-island', 'Discovery Islands'],
  ['island-malcolm-island', 'Northern Islands'],
  ['island-denman-island', 'Northern Gulf Islands'],
  ['island-gabriola-island', 'Gulf Islands'],
  ['provincial-arbutus-grove-park', 'Central Island'],
  ['provincial-hemer-park', 'Central Island'],
  ['provincial-morden-colliery-historic-park', 'Central Island'],
  ['provincial-petroglyph-park', 'Central Island'],
  ['provincial-rathtrevor-beach-park', 'Central Island'],
  ['provincial-roberts-memorial-park', 'Central Island'],
  ['provincial-sandwell-park', 'Gulf Islands'],
  ['provincial-burgoyne-bay-park', 'Gulf Islands'],
  ['provincial-mount-erskine-park', 'Gulf Islands'],
  ['provincial-mount-maxwell-park', 'Gulf Islands'],
  ['provincial-denman-island-park', 'Northern Gulf Islands'],
  ['provincial-fillongley-park', 'Northern Gulf Islands'],
  ['provincial-helliwell-park', 'Northern Gulf Islands'],
  ['provincial-tribune-bay-park', 'Northern Gulf Islands'],
  ['provincial-mount-geoffrey-escarpment-park', 'Northern Gulf Islands'],
  ['provincial-main-lake-park', 'Discovery Islands'],
  ['provincial-rebecca-spit-marine-park', 'Discovery Islands'],
  ['provincial-octopus-islands-marine-park', 'Discovery Islands'],
  ['provincial-read-island-park', 'Discovery Islands'],
  ['provincial-thurston-bay-marine-park', 'Discovery Islands'],
  ['provincial-surge-narrows-park', 'Discovery Islands'],
  ['provincial-mitlenatch-island-nature-park', 'Discovery Islands'],
  ['provincial-flores-island-park', 'West Coast Islands'],
  ['provincial-vargas-island-park', 'West Coast Islands'],
]);
for (const [id, region] of expectedRegions) {
  if (!places.some((place) => place.id === id && place.region === region)) throw new Error(`region regression: ${id} must be ${region}`);
}

const polygonSources = new Set([
  'BC Parks / DataBC — TANTALIS protected areas',
  'Capital Regional District — Park GIS layer',
  'Cowichan Valley Regional District — Parks GIS layer',
  'Regional District of Nanaimo — Regional Parks spatial data',
]);
const polygonPinCount = places.filter((place) => polygonSources.has(place.sourceName)).length;
if (audit.polygonPinsVerified !== polygonPinCount) throw new Error('polygon pin containment audit does not match catalogue');
if (!Array.isArray(audit.polygonInteriorFallbacks)
    || !audit.polygonInteriorFallbacks.some((entry) => entry.source === 'BC Parks' && entry.name === 'Cape Scott Park')) {
  throw new Error('polygon interior fallback audit is missing Cape Scott Park');
}
const cvrdExclusionIds = new Set((audit.excludedCvrdRegionalParks || []).map((entry) => entry.sourceId));
for (const sourceId of ['980473', '980187']) {
  if (!cvrdExclusionIds.has(sourceId)) throw new Error(`CVRD eligibility audit is missing source ${sourceId}`);
}

console.log(`Validated ${places.length} places and ${ids.size} unique IDs.`);

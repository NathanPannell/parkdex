/**
 * Add official BC Parks visitor pages for catalogue parks with a unique exact
 * name match in the published BC Parks GraphQL catalogue.
 *
 * Run from the repository root:
 *   node scripts/enrich-bcparks-visitor-pages.mjs
 *   node scripts/enrich-bcparks-visitor-pages.mjs --apply --verified-at 2026-09-23
 *
 * The first command reports coverage without writing. Existing links are never
 * replaced. Parks without an exact published match remain without a link.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const placesPath = path.join(root, 'data', 'places.json');
const cataloguePath = path.join(root, 'frontend', 'lib', 'visitor-information.catalogue.json');
const reportPath = path.join(root, 'data', 'visitor-information-coverage.json');
const API_URL = 'https://bcparks.api.gov.bc.ca/graphql';
const PAGE_SIZE = 500;
const apply = process.argv.includes('--apply');
const dateIndex = process.argv.indexOf('--verified-at');
const verifiedAt = dateIndex >= 0 ? process.argv[dateIndex + 1] : new Date().toISOString().slice(0, 10);

if (!/^\d{4}-\d{2}-\d{2}$/.test(verifiedAt) || Number.isNaN(Date.parse(`${verifiedAt}T00:00:00Z`))) {
  throw new Error('Pass --verified-at YYYY-MM-DD with a valid date');
}

function exactName(name) {
  return name.normalize('NFC').replace(/[\u2018\u2019]/g, "'").replace(/\s+/gu, ' ')
    .replace(/\s*([/-])\s*/gu, '$1').trim().toLocaleLowerCase('en-CA');
}

function officialPage(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname === 'bcparks.ca'
      && /^\/(?:[a-z0-9][a-z0-9-]*\/)+$/.test(parsed.pathname) && !parsed.search && !parsed.hash;
  } catch {
    return false;
  }
}

async function publishedParks() {
  const query = `query PublishedParks($page: Int!, $pageSize: Int!) {
    protectedAreas(pagination: { page: $page, pageSize: $pageSize }, sort: ["protectedAreaName:asc"]) {
      protectedAreaName url isDisplayed publishedAt
      parkNames { parkName }
      sites { siteName url isDisplayed publishedAt }
    }
  }`;
  const parks = [];
  for (let page = 1; ; page += 1) {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables: { page, pageSize: PAGE_SIZE } }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`BC Parks API returned ${response.status} on page ${page}`);
    const result = await response.json();
    if (result.errors?.length || !Array.isArray(result.data?.protectedAreas)) {
      throw new Error(`BC Parks API rejected page ${page}: ${JSON.stringify(result.errors ?? result)}`);
    }
    parks.push(...result.data.protectedAreas);
    if (result.data.protectedAreas.length < PAGE_SIZE) break;
  }
  if (parks.length < 500) throw new Error(`Unexpectedly small BC Parks catalogue: ${parks.length}`);
  return parks;
}

const places = JSON.parse(await fs.readFile(placesPath, 'utf8'));
const current = JSON.parse(await fs.readFile(cataloguePath, 'utf8'));
const parks = await publishedParks();
const byName = new Map();
function addCandidate(name, url, title) {
  if (!name || !officialPage(url)) return;
  const key = exactName(name);
  if (!byName.has(key)) byName.set(key, new Map());
  byName.get(key).set(url, { url, title });
}
for (const park of parks) {
  if (!park.isDisplayed || !park.publishedAt || !park.protectedAreaName || !officialPage(park.url)) continue;
  const names = new Set([park.protectedAreaName, ...(park.parkNames ?? []).map((name) => name.parkName)].filter(Boolean));
  for (const name of names) addCandidate(name, park.url, `${park.protectedAreaName} | BC Parks`);
  for (const site of park.sites ?? []) {
    if (!site.publishedAt || !site.siteName) continue;
    // Some official site records are unpublished as standalone visitor pages.
    // Their published parent park page is still an official destination.
    const siteUrl = site.isDisplayed && site.url?.startsWith(park.url) && officialPage(site.url) ? site.url : park.url;
    const title = siteUrl === park.url
      ? `${park.protectedAreaName} | BC Parks`
      : `${park.protectedAreaName}: ${site.siteName} | BC Parks`;
    for (const name of names) {
      addCandidate(`${name} - ${site.siteName}`, siteUrl, title);
    }
  }
}

const additions = {};
const unmatched = [];
const provincial = places.filter((place) => place.category === 'provincial');
for (const place of provincial) {
  if (Object.hasOwn(current, place.id)) continue;
  const candidates = [...(byName.get(exactName(place.name))?.values() ?? [])];
  if (candidates.length !== 1) {
    unmatched.push({ id: place.id, name: place.name, sourceId: place.sourceId ?? null,
      reason: candidates.length ? 'ambiguous_exact_name' : 'no_exact_published_match' });
    continue;
  }
  const park = candidates[0];
  additions[place.id] = {
    url: park.url,
    title: park.title,
    authority: 'BC Parks',
    verifiedAt,
    evidenceUrl: API_URL,
  };
}

const report = {
  source: API_URL,
  verifiedAt,
  apiRecords: parks.length,
  provincialPlaces: provincial.length,
  linkedProvincialPlaces: provincial.filter((place) => Object.hasOwn(current, place.id) || Object.hasOwn(additions, place.id)).length,
  unmatchedCount: unmatched.length,
  unmatched: unmatched.sort((a, b) => a.id.localeCompare(b.id)),
};

if (apply) {
  const combined = Object.fromEntries(Object.entries({ ...current, ...additions }).sort(([a], [b]) => a.localeCompare(b)));
  await fs.writeFile(cataloguePath, `${JSON.stringify(combined, null, 2)}\n`);
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}
process.stdout.write(`${JSON.stringify({ mode: apply ? 'applied' : 'dry-run', newLinks: Object.keys(additions).length, ...report, unmatched: undefined }, null, 2)}\n`);

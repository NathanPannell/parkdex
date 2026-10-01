#!/usr/bin/env node
// Save small, real copies of the content API responses that installed apps read.
// The contract test replays them through every supported app reader, so a server
// change that would break an older build fails in CI instead of on a phone.
//
//   node scripts/capture-content-contract-fixtures.mjs [https://staging.web.parkdex.app]
//
// Records are trimmed (a few parks per category, simplified boundary rings) but
// every field is copied exactly as the API sent it.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const origin = (process.argv[2] ?? "https://staging.web.parkdex.app").replace(/\/$/, "");
const output = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "lib", "content", "compat", "fixtures");
const PARKS_PER_CATEGORY = 2;
const MAX_RING_POINTS = 24;
const MAX_CHANGES = 25;

async function getJson(path) {
  const response = await fetch(`${origin}${path}`, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  return response.json();
}

// Keep the first polygon and a closed, evenly sampled outer ring. Readers check
// ring structure, not area, so this stays representative at a fraction of the size.
function simplifyFeature(feature) {
  const ring = feature.geometry.coordinates[0][0];
  const step = Math.max(1, Math.ceil((ring.length - 1) / (MAX_RING_POINTS - 1)));
  const sampled = ring.slice(0, -1).filter((_, index) => index % step === 0);
  if (sampled.length < 3) return feature;
  return { ...feature, geometry: { ...feature.geometry, coordinates: [[[...sampled, sampled[0]]]] } };
}

function pickParks(parks) {
  const picked = [];
  const byCategory = new Map();
  for (const park of parks) {
    const list = byCategory.get(park.category) ?? [];
    list.push(park);
    byCategory.set(park.category, list);
  }
  for (const list of byCategory.values()) {
    const withScene = list.filter((park) => park.scene !== null);
    const withoutScene = list.filter((park) => park.scene === null);
    picked.push(...[...withScene.slice(0, 1), ...withoutScene.slice(0, 1), ...withScene.slice(1)].slice(0, PARKS_PER_CATEGORY));
  }
  const order = new Map(parks.map((park, index) => [park.id, index]));
  return picked.sort((a, b) => order.get(a.id) - order.get(b.id));
}

function trimSnapshot(snapshot) {
  const parks = pickParks(snapshot.parks);
  const ids = new Set(parks.map((park) => park.id));
  const scenes = new Set(parks.flatMap((park) => park.scene ? [`art/badges/scenes/${park.scene}.webp`] : []));
  return {
    ...snapshot,
    parks,
    boundaries: { ...snapshot.boundaries, features: snapshot.boundaries.features.filter((feature) => ids.has(feature.properties.id)).map(simplifyFeature) },
    drive: { ...snapshot.drive, parks: Object.fromEntries(Object.entries(snapshot.drive.parks).filter(([id]) => ids.has(id))) },
    assets: snapshot.assets.filter((file) => scenes.has(file.path)),
  };
}

function trimChanges(changes) {
  return {
    ...changes,
    batches: changes.batches.map((batch) => ({
      ...batch,
      changes: batch.changes.slice(0, MAX_CHANGES).map((change) => change.entity === "boundary" && change.value ? { ...change, value: simplifyFeature(change.value) } : change),
    })),
  };
}

const snapshot = await getJson("/api/content/snapshot");
const head = snapshot.revision;
const latest = head > 0 ? await getJson(`/api/content/changes?after=${head - 1}&limit=1`) : null;
const channel = await getJson("/api/content/current");

await mkdir(output, { recursive: true });
const write = (name, value) => writeFile(join(output, name), `${JSON.stringify(value, null, 2)}\n`);
await write("snapshot.json", trimSnapshot(snapshot));
if (latest) await write("changes.json", trimChanges(latest));
await write("current.json", channel);
await write("source.json", { origin, revision: head, capturedAt: new Date().toISOString() });
console.log(`Saved content contract fixtures from ${origin} at revision ${head} to ${output}`);

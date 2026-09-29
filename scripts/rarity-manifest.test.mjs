import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const MANIFEST = new URL("../database/catalogue/victoria-rarities-20260928.json", import.meta.url);
const TRANSITION = new URL("../database/catalogue/victoria-rarity-downshift-20260928.json", import.meta.url);
const SEED = new URL("../database/seeds/victoria-100-20260927/victoria-100-seed-v1.json", import.meta.url);
const EXPECTED_COUNTS = { common: 89, uncommon: 10, rare: 1, legendary: 0 };
const SOURCE_COUNTS = { common: 59, uncommon: 30, rare: 10, legendary: 1 };
const SOOKE_POTHOLES_ID = "regional-sooke-potholes-regional-park";

test("rarity assignment covers the immutable 100-park seed exactly", async () => {
  const [manifest, seed] = await Promise.all([MANIFEST, SEED].map(async (url) => JSON.parse(await readFile(url, "utf8"))));
  assert.equal(manifest.schema, "parkdex.rarity-assignment/v1");
  assert.equal(manifest.environment, "staging");
  assert.equal(seed.schema, "parkdex.victoria-100-seed/v1");
  assert.equal(seed.parks.length, 100);
  assert.equal(manifest.parks.length, 100);

  const seedIds = seed.parks.map((park) => park.id);
  const assignedIds = manifest.parks.map((park) => park.id);
  assert.equal(new Set(seedIds).size, 100, "seed park IDs must be unique");
  assert.equal(new Set(assignedIds).size, 100, "rarity park IDs must be unique");
  assert.deepEqual(new Set(assignedIds), new Set(seedIds), "rarities must match the seed IDs exactly");
  assert.deepEqual(
    manifest.parks.map((park) => park.rank),
    Array.from({ length: 100 }, (_, index) => index + 1),
    "rarity ranks must cover 1 through 100 exactly",
  );
  assert.deepEqual(
    manifest.parks.map((park) => park.id),
    seedIds,
    "rarity ranks must retain the historical seed order",
  );

  const counts = { common: 0, uncommon: 0, rare: 0, legendary: 0 };
  for (const park of manifest.parks) {
    assert.ok(Object.hasOwn(counts, park.rarity), `unknown rarity for ${park.id}`);
    counts[park.rarity] += 1;
  }
  assert.deepEqual(counts, EXPECTED_COUNTS);
  assert.deepEqual(manifest.counts, EXPECTED_COUNTS);
  assert.deepEqual(manifest.parks.filter((park) => park.rarity === "legendary"), []);
  assert.equal(manifest.parks.find((park) => park.id === SOOKE_POTHOLES_ID)?.rarity, "rare");
  assert.equal(manifest.parks.find((park) => park.id === SOOKE_POTHOLES_ID)?.name, "Sooke Potholes Regional Park");
});

test("downshift records every changed rarity exactly once", async () => {
  const [manifest, transition] = await Promise.all([MANIFEST, TRANSITION].map(async (url) => JSON.parse(await readFile(url, "utf8"))));
  assert.equal(transition.schema, "parkdex.rarity-downshift/v1");
  assert.equal(transition.environment, "staging");
  assert.deepEqual(transition.source_counts, SOURCE_COUNTS);
  assert.deepEqual(transition.target_counts, EXPECTED_COUNTS);
  const step = { common: "common", uncommon: "common", rare: "uncommon", legendary: "rare" };
  const before = new Map(manifest.parks.map((park) => [park.id, park.rarity]));
  const changed = new Set();
  for (const change of transition.changes) {
    assert.deepEqual(Object.keys(change), ["id", "from", "to"]);
    assert.ok(!changed.has(change.id), `duplicate transition for ${change.id}`);
    assert.equal(step[change.from], change.to);
    assert.notEqual(change.from, change.to);
    assert.equal(before.get(change.id), change.to);
    before.set(change.id, change.from);
    changed.add(change.id);
  }
  assert.equal(changed.size, 41);
  const sourceCounts = { common: 0, uncommon: 0, rare: 0, legendary: 0 };
  for (const rarity of before.values()) sourceCounts[rarity] += 1;
  assert.deepEqual(sourceCounts, SOURCE_COUNTS);
  for (const park of manifest.parks) assert.equal(park.rarity, step[before.get(park.id)]);
});

test("rarity assignment declares the agreed unlock thresholds", async () => {
  const manifest = JSON.parse(await readFile(MANIFEST, "utf8"));
  assert.deepEqual(manifest.unlock_requirements, {
    common: { parks: 0 },
    uncommon: { parks: 2 },
    rare: { parks: 5 },
    legendary: { parks: 10 },
  });
});

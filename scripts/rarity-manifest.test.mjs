import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const MANIFEST = new URL("../database/catalogue/victoria-rarities-20260928.json", import.meta.url);
const SEED = new URL("../database/seeds/victoria-100-20260927/victoria-100-seed-v1.json", import.meta.url);
const EXPECTED_COUNTS = { common: 59, uncommon: 30, rare: 10, legendary: 1 };
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
  assert.deepEqual(
    manifest.parks.filter((park) => park.rarity === "legendary").map((park) => park.id),
    [SOOKE_POTHOLES_ID],
  );
  assert.equal(manifest.parks.find((park) => park.id === SOOKE_POTHOLES_ID)?.name, "Sooke Potholes Regional Park");
});

test("rarity assignment declares the agreed unlock thresholds", async () => {
  const manifest = JSON.parse(await readFile(MANIFEST, "utf8"));
  assert.deepEqual(manifest.unlock_requirements, {
    common: {},
    uncommon: { common: 4 },
    rare: { common: 10, uncommon: 3 },
    legendary: { common: 20, uncommon: 6, rare: 2 },
  });
});

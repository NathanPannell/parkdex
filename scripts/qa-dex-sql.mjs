import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { applyMigration, dbUrl, pool } from "./qa-postgres-adapter.mjs";
import { createNeonGameStore } from "../worker/game-store.ts";
import { createNeonProgressStore } from "../worker/accounts/progress-store.ts";

// My Dex (#174): the Dex list, photo display backup, and photo claims kept out of visit history.
const migration = (name) => fileURLToPath(new URL(`../database/migrations/${name}`, import.meta.url));
const suffix = randomUUID().replaceAll("-", "").slice(0, 6);
const game = createNeonGameStore(dbUrl);
const progress = createNeonProgressStore(dbUrl);
const log = (name) => process.stdout.write(`${name}: PASS\n`);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// 10:00 in Victoria (PDT), so whole-day offsets stay on distinct local days.
const T0 = Date.parse("2026-06-01T17:00:00.000Z");
const at = (offsetMs) => new Date(T0 + offsetMs).toISOString();
const park = (name) => `qa-dex-${suffix}-${name}`;
const snapshot = (parkId) => ({
  id: parkId,
  name: "QA Dex Park",
  short: "QA",
  category: "community",
  region: "QA",
  lat: 48.4,
  lng: -123.4,
  biome: "forest",
  shape: "circle",
  rarity: "common",
  seed: 1,
  blurb: "Synthetic QA park.",
  scene: null,
});

async function account(name, { handle = true } = {}) {
  const id = randomUUID();
  await pool.query("INSERT INTO kip_account.accounts (id, normalized_email, password_hash) VALUES ($1, $2, $3)", [
    id,
    `dex-${name}-${suffix}@example.test`,
    "qa-hash",
  ]);
  if (handle)
    await pool.query("INSERT INTO kip_game.players (account_id, handle, flag_seed, created_at) VALUES ($1, $2, kip_game.flag_seed($1), $3)", [
      id,
      `dx${suffix}_${name}`,
      at(-DAY),
    ]);
  return id;
}

async function visit(accountId, parkId, offsetMs) {
  const { rows } = await pool.query("SELECT kip_game.record_visit($1, $2, $3, $4) AS result", [randomUUID(), accountId, parkId, at(offsetMs)]);
  assert.equal(rows[0].result.status, "recorded");
}

async function claim(accountId, parkId, offsetMs) {
  const claimId = randomUUID();
  const payload = { claimId, parkId, claimedAt: at(offsetMs), parkSnapshot: snapshot(parkId), contentReleaseId: null };
  assert.equal((await progress.putClaim(accountId, payload, digest(JSON.stringify(payload)))).status, "created");
  return claimId;
}

async function count(sql, params) {
  return Number((await pool.query(sql, params)).rows[0].count);
}

try {
  await applyMigration(migration("accounts_001_init.sql"));
  await applyMigration(migration("progress_001_init.sql"));
  if (!(await pool.query("SELECT to_regclass('public.parks') AS name")).rows[0].name) {
    await applyMigration(fileURLToPath(new URL("../database/001_cloud_content.sql", import.meta.url)));
  }
  await applyMigration(migration("game_001_init.sql"));
  await applyMigration(migration("game_005_dex.sql"));
  await applyMigration(migration("game_005_dex.sql"));
  for (const name of ["old", "played", "photo", "hidden"]) {
    await pool.query(
      `
      INSERT INTO public.parks (id, name, short, category, region, lat, lng, biome, shape, rarity, scene, seed, blurb)
      VALUES ($1, $2, 'QA', 'community', 'QA', 48.4, -123.4, 'forest', 'circle', 'common', NULL, 1, 'Synthetic QA park.')
      ON CONFLICT (id) DO NOTHING`,
      [park(name), `QA ${name}`],
    );
  }
  log("game_005_dex replays cleanly");

  const player = await account("p");
  const other = await account("o");
  // An old claim from before the flag game, then visits, then photos taken on the visit days.
  const oldClaim = await claim(player, park("old"), -30 * DAY);
  await visit(player, park("played"), 0);
  await visit(player, park("played"), 2 * DAY);
  const photoSameDay = await claim(player, park("played"), 2 * DAY + HOUR);
  const secondPhotoSameDay = await claim(player, park("played"), 2 * DAY + 2 * HOUR);
  // A photo on a later day with no visit that day.
  const laterPhoto = await claim(player, park("played"), 5 * DAY);
  await visit(other, park("played"), DAY);

  // game_001 imports claims on every deploy. Photo claims taken after a visit stay out of history.
  await applyMigration(migration("game_001_init.sql"));
  const imported = await pool.query("SELECT park_id FROM kip_game.visits WHERE account_id = $1 AND source = 'claim_import' ORDER BY park_id", [player]);
  assert.deepEqual(
    imported.rows.map((row) => row.park_id),
    [park("old")],
  );
  assert.equal(await count("SELECT count(*) FROM kip_game.visits WHERE account_id = $1 AND park_id = $2", [player, park("played")]), 2);
  log("photo claims after a visit are not imported as visits; older claims still are");

  const dex = await game.dex(player, at(10 * DAY));
  assert.deepEqual(
    dex.map((row) => row.parkId),
    [park("old"), park("played")],
  );
  const [old, played] = dex;
  assert.deepEqual(old.days, ["2026-05-02"]);
  assert.equal(old.firstVisitAt, at(-30 * DAY));
  assert.equal(old.lastVisitAt, at(-30 * DAY));
  assert.deepEqual(played.days, ["2026-06-01", "2026-06-03", "2026-06-06"], "one entry per day: photos on a visit day do not add one");
  assert.equal(played.firstVisitAt, at(0));
  assert.equal(played.lastVisitAt, at(5 * DAY));
  assert.equal(played.hidden, false);
  assert.deepEqual(
    (await game.dex(player, at(DAY))).map((row) => [row.parkId, row.days.length]),
    [
      [park("old"), 1],
      [park("played"), 1],
    ],
    "nothing after now",
  );
  assert.deepEqual(
    (await game.dex(other, at(10 * DAY))).map((row) => row.parkId),
    [park("played")],
  );
  assert.deepEqual(await game.dex(await account("n", { handle: false }), at(0)), []);
  log("the Dex lists each park with distinct visit days from visits and claims");

  // content_005_park_visibility.sql needs the whole content schema; a stand-in table with the
  // columns the lookup reads is enough here, and is dropped again afterwards.
  const hiddenTableMissing = !(await pool.query("SELECT to_regclass('public.content_park_hidden') AS name")).rows[0].name;
  if (hiddenTableMissing) await pool.query("CREATE TABLE public.content_park_hidden (park_id text PRIMARY KEY, reason text NOT NULL, source text NOT NULL)");
  try {
    await visit(player, park("hidden"), 3 * DAY);
    await pool.query("INSERT INTO public.content_park_hidden (park_id, reason, source) VALUES ($1, 'QA', 'operator') ON CONFLICT DO NOTHING", [park("hidden")]);
    const withHidden = await game.dex(player, at(10 * DAY));
    assert.equal(withHidden.find((row) => row.parkId === park("hidden"))?.hidden, true);
    assert.equal(withHidden.find((row) => row.parkId === park("played"))?.hidden, false);
  } finally {
    await pool.query("DELETE FROM public.content_park_hidden WHERE park_id = $1", [park("hidden")]);
    if (hiddenTableMissing) await pool.query("DROP TABLE public.content_park_hidden");
  }
  log("hidden parks are marked");

  const crop = { x: 0.125, y: 0, width: 0.5625, height: 1 };
  assert.deepEqual(await progress.listClaimDisplays(player, 100), []);
  const saved = await progress.putClaimDisplay(player, photoSameDay, { crop, coverAt: at(3 * DAY), removed: false });
  assert.equal(saved.status, "saved");
  assert.deepEqual({ ...saved.display, updatedAt: undefined }, { claimId: photoSameDay, crop, coverAt: at(3 * DAY), removed: false, updatedAt: undefined });
  const replaced = await progress.putClaimDisplay(player, photoSameDay, { crop: null, coverAt: null, removed: true });
  assert.equal(replaced.status, "saved");
  assert.ok(Date.parse(replaced.display.updatedAt) >= Date.parse(saved.display.updatedAt));
  await progress.putClaimDisplay(player, secondPhotoSameDay, { crop, coverAt: null, removed: false });
  const listed = await progress.listClaimDisplays(player, 100);
  assert.deepEqual(listed.map((row) => row.claimId).sort(), [photoSameDay, secondPhotoSameDay].sort());
  assert.deepEqual(
    listed.find((row) => row.claimId === photoSameDay),
    replaced.display,
  );
  assert.deepEqual(listed.find((row) => row.claimId === secondPhotoSameDay)?.crop, crop);
  assert.equal((await progress.listClaimDisplays(player, 1)).length, 1);
  assert.deepEqual(await progress.listClaimDisplays(other, 100), []);
  log("display choices save whole, last write wins, and list per account");

  assert.equal((await progress.putClaimDisplay(other, laterPhoto, { crop: null, coverAt: null, removed: false })).status, "claim_missing");
  assert.equal((await progress.putClaimDisplay(player, randomUUID(), { crop: null, coverAt: null, removed: false })).status, "claim_missing");
  await assert.rejects(
    pool.query("INSERT INTO kip_account.claim_display (account_id, claim_id, crop) VALUES ($1, $2, $3)", [
      player,
      oldClaim,
      JSON.stringify({ x: 0.6, y: 0, width: 0.5, height: 1 }),
    ]),
    /claim_display_crop_check/,
  );
  await assert.rejects(
    pool.query("INSERT INTO kip_account.claim_display (account_id, claim_id, crop) VALUES ($1, $2, $3)", [
      player,
      oldClaim,
      JSON.stringify({ x: 0, y: 0, width: 0.5, height: 1, z: 1 }),
    ]),
    /claim_display_crop_check/,
  );
  log("display choices need the account's own claim and a crop inside the photo");

  await pool.query("UPDATE kip_account.accounts SET deletion_state = 'deleting' WHERE id = $1", [player]);
  assert.equal((await progress.putClaimDisplay(player, laterPhoto, { crop: null, coverAt: null, removed: false })).status, "unavailable");
  assert.deepEqual(await progress.listClaimDisplays(player, 100), []);
  await progress.deleteAccountProgress(player);
  assert.equal(await count("SELECT count(*) FROM kip_account.claim_display WHERE account_id = $1", [player]), 0);
  await pool.query("DELETE FROM kip_account.accounts WHERE id = ANY($1::uuid[])", [[player, other]]);
  log("a deleting account cannot write, and deleting its claims removes its display choices");
} finally {
  await pool.end();
}

import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";

// Crewmates become friends by handle (social_002_crewmates.sql) against real PostgreSQL: only
// players who were in the same crew, mutual, replay-safe, within the friend limit, and gone with
// account deletion. Runs the migrations it needs in inventory order in its own throwaway kip_qa_
// database, like qa-game-sql, because crews need the game's later migrations.
const shared = process.env.PGDATABASE;
assert.ok(shared?.startsWith("kip_qa_") || shared === "kip_accounts_qa", "SQL QA requires a dedicated kip_qa_ database");
const owned = `kip_qa_crewmates_${randomBytes(8).toString("hex")}`;
const admin = new pg.Client({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT),
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: shared,
});
await admin.connect();
await admin.query(`CREATE DATABASE "${owned}"`);
process.env.PGDATABASE = owned;
const { applyMigration, dbUrl, pool } = await import("./qa-postgres-adapter.mjs");
const { createNeonFriendsStore } = await import("../worker/friends-store.ts");

const root = new URL("../", import.meta.url);
const CREWMATES_MIGRATION = "database/migrations/social_002_crewmates.sql";
const MIGRATIONS = new Set([
  "database/migrations/accounts_001_init.sql",
  "database/migrations/progress_001_init.sql",
  "database/001_cloud_content.sql",
  "database/migrations/interactions_001_init.sql",
  "database/migrations/interactions_002_db_events.sql",
  "database/migrations/park_proposals_001_init.sql",
  "database/migrations/game_001_init.sql",
  "database/migrations/founders_001_init.sql",
  "database/migrations/game_002_points.sql",
  "database/migrations/social_001_friends.sql",
  "database/migrations/game_003_crews.sql",
  CREWMATES_MIGRATION,
]);
const suffix = randomUUID().replaceAll("-", "").slice(0, 6);
const store = createNeonFriendsStore(dbUrl);
const log = (name) => process.stdout.write(`${name}: PASS\n`);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
// 10:00 in Victoria (PDT).
const T0 = Date.parse("2026-06-01T17:00:00.000Z");
const at = (offsetMs) => new Date(T0 + offsetMs).toISOString();
const handle = (name) => `qc${suffix}_${name}`;

async function park(name) {
  const id = `qa-crewmates-${suffix}-${name}`;
  await pool.query(
    `
    INSERT INTO public.parks (id, name, short, category, region, lat, lng, biome, shape, rarity, scene, seed, blurb)
    VALUES ($1, $2, 'QA', 'community', 'QA', 48.4, -123.4, 'forest', 'circle', 'common', NULL, 1, 'Synthetic QA park.')`,
    [id, `QA ${name}`],
  );
  return id;
}

async function account(name, { withHandle = true } = {}) {
  const id = randomUUID();
  await pool.query("INSERT INTO kip_account.accounts (id, normalized_email, password_hash) VALUES ($1, $2, $3)", [
    id,
    `crewmates-${name}-${suffix}@example.test`,
    "qa-hash",
  ]);
  if (withHandle) await pool.query("INSERT INTO kip_game.players (account_id, handle, flag_seed) VALUES ($1, $2, kip_game.flag_seed($1))", [id, handle(name)]);
  return id;
}

async function visit(accountId, parkId, offsetMs) {
  const { rows } = await pool.query("SELECT kip_game.record_visit($1, $2, $3, $4) AS result", [randomUUID(), accountId, parkId, at(offsetMs)]);
  // A logged visit during someone's protected hour answers `protected`.
  assert.ok(["recorded", "protected"].includes(rows[0].result.status), rows[0].result.status);
  return rows[0].result.visit.outcome;
}

async function join(accountId, parkId, offsetMs) {
  const code = (
    await pool.query(
      "SELECT c.code FROM kip_game.crew_codes c JOIN kip_game.tenures t ON t.tenure_id = c.tenure_id WHERE t.park_id = $1 AND t.ended_at IS NULL",
      [parkId],
    )
  ).rows[0].code;
  const { rows } = await pool.query("SELECT kip_game.join_crew($1, $2, $3, $4) AS result", [accountId, code, randomUUID(), at(offsetMs)]);
  assert.equal(rows[0].result.status, "joined");
}

async function add(accountId, name, limit) {
  const { rows } =
    limit === undefined
      ? await pool.query("SELECT kip_social.add_crewmate($1, $2) AS result", [accountId, name])
      : await pool.query("SELECT kip_social.add_crewmate($1, $2, $3) AS result", [accountId, name, limit]);
  return rows[0].result;
}

const friendships = async (accountId) =>
  Number((await pool.query("SELECT count(*) FROM kip_social.friendships WHERE account_id = $1", [accountId])).rows[0].count);

try {
  const config = JSON.parse(readFileSync(new URL("deployment.json", root), "utf8"));
  const full = [
    config.migrationPath,
    ...config.contentSync.supportingMigrationPaths,
    ...config.optionalMigrationPaths,
    ...config.contentSync.migrationPaths,
    ...config.independentMigrationPaths,
  ];
  const inventory = full.filter((path) => MIGRATIONS.has(path));
  assert.equal(inventory.length, MIGRATIONS.size, "every migration this QA needs is in deployment.json");
  const position = (path) => inventory.indexOf(path);
  assert.ok(
    position(CREWMATES_MIGRATION) > position("database/migrations/social_001_friends.sql") &&
      position(CREWMATES_MIGRATION) > position("database/migrations/game_003_crews.sql"),
    "social_002 replays after the friends and crews it reads",
  );
  for (const path of inventory) await applyMigration(fileURLToPath(new URL(path, root)));
  await applyMigration(fileURLToPath(new URL(CREWMATES_MIGRATION, root)));
  log("the migration replays after friends and crews");

  const beach = await park("beach");
  const lead = await account("lead");
  const sam = await account("sam");
  const tom = await account("tom");
  const outsider = await account("outsider");
  const noHandle = await account("nohandle", { withHandle: false });
  assert.equal(await visit(lead, beach, 0), "planted");
  await join(sam, beach, 10 * MINUTE);
  await join(tom, beach, 20 * MINUTE);
  assert.equal(await visit(outsider, beach, 30 * MINUTE), "logged", "a logged visit during the hour is not a crew join");

  assert.deepEqual(await add(noHandle, handle("lead")), { status: "handle_required" });
  assert.deepEqual(await add(sam, handle("sam")), { status: "own_handle" });
  assert.deepEqual(await add(sam, handle("nobody")), { status: "not_crewmates" });
  assert.deepEqual(await add(outsider, handle("lead")), { status: "not_crewmates" }, "visiting the same park is not being in the crew");
  assert.deepEqual(await add(lead, handle("outsider")), { status: "not_crewmates" });
  assert.equal(await friendships(outsider), 0);
  log("only crewmates can be added by handle");

  const added = await add(sam, handle("lead").toUpperCase());
  assert.equal(added.status, "added");
  assert.deepEqual(added.friend, { handle: handle("lead"), flagSeed: (await pool.query("SELECT kip_game.flag_seed($1) AS seed", [lead])).rows[0].seed });
  assert.equal(await friendships(sam), 1);
  assert.equal(await friendships(lead), 1, "the friendship is mutual");
  assert.equal((await add(sam, handle("lead"))).status, "already_friends", "a second tap is safe");
  assert.equal((await add(lead, handle("sam"))).status, "already_friends", "adding back is already done");
  assert.equal((await store.addCrewmate(tom, handle("sam"), 200)).status, "added", "two members who joined can add each other");
  assert.equal(await friendships(sam), 2);
  log("a member adds the leader and another member, mutual and replay-safe");

  // After the hour an outsider takes the flag: the crew is over, but it was still a crew.
  assert.equal(await visit(outsider, beach, 2 * HOUR), "took");
  assert.equal((await add(tom, handle("lead"))).status, "added", "an ended crew still counts");
  // The taker's new flag has its own crew: the old crew's members are not in it.
  assert.deepEqual(await add(outsider, handle("tom")), { status: "not_crewmates" });
  // A holder whose flag was taken never shared a crew with the taker.
  const old = await park("old");
  const holder = await account("holder");
  const taker = await account("taker");
  assert.equal(await visit(holder, old, 0), "planted");
  assert.equal(await visit(taker, old, 2 * HOUR), "took");
  assert.deepEqual(await add(taker, handle("holder")), { status: "not_crewmates" });
  log("ended crews count, and taking a flag does not make crewmates");

  const field = await park("field");
  const host = await account("host");
  const mates = await Promise.all(["m1", "m2", "m3", "m4"].map((name) => account(name)));
  assert.equal(await visit(host, field, 0), "planted");
  for (const [index, mate] of mates.entries()) await join(mate, field, (index + 1) * MINUTE);
  assert.equal((await store.addCrewmate(mates[0], handle("host"), 1)).status, "added");
  assert.equal((await store.addCrewmate(mates[1], handle("host"), 1)).status, "too_many_friends", "the leader is at the limit");
  const raced = await Promise.all(mates.slice(1).map((mate) => add(mate, handle("host"), 3)));
  assert.equal(raced.filter((row) => row.status === "added").length, 2);
  assert.equal(raced.filter((row) => row.status === "too_many_friends").length, 1);
  assert.equal(await friendships(host), 3, "concurrent adds respect the limit");
  // add_friend shares the limit: the host's friend code is over it too.
  const hostCode = (await pool.query("SELECT kip_social.ensure_friend_code($1) AS code", [host])).rows[0].code;
  assert.deepEqual((await pool.query("SELECT kip_social.add_friend($1, $2, 3) AS result", [outsider, hostCode])).rows[0].result, {
    status: "too_many_friends",
  });
  log("the friend limit holds under concurrent crewmate adds and is shared with friend codes");

  await pool.query("UPDATE kip_account.accounts SET deletion_state = 'deleting' WHERE id = $1", [mates[3]]);
  assert.deepEqual(await add(mates[3], handle("m1")), { status: "account_unavailable" });
  assert.deepEqual(await add(mates[2], handle("m4")), { status: "not_crewmates" }, "a deleting account cannot be added");
  await pool.query("DELETE FROM kip_account.accounts WHERE id = $1", [lead]);
  assert.equal(await friendships(sam), 1, "deleting the leader ends their friendships, not the members' own");
  log("account deletion stops crewmate adds and cascades");
} finally {
  // pool.end() resolves before its connections close; the adapter ignores the server ending them
  // when the database is dropped WITH (FORCE) below.
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS "${owned}" WITH (FORCE)`);
  await admin.end();
}

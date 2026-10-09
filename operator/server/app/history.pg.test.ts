import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { createSqlOtaHistoryStore, type OtaHistoryStore, type OtaPublishInput } from "./history.ts";

// Runs the publish history SQL against app_config_003. Point OPERATOR_OTA_TEST_DATABASE_URL at a
// disposable loopback database named kip_qa_* (its own, separate from the other pg tests).
const DSN = process.env.OPERATOR_OTA_TEST_DATABASE_URL;
const root = fileURLToPath(new URL("../../../", import.meta.url));

let pool: import("pg").Pool;
let store: OtaHistoryStore;

const row = (overrides: Partial<OtaPublishInput> = {}): OtaPublishInput => ({
  channel: "staging", generation: 1, previousGeneration: 0, action: "publish", source: "script", sha256: "a".repeat(64), previousSha256: null,
  version: "1111111-aaaaaaaa", byteSize: 1000, minimumNativeBuild: 12, maximumNativeBuild: 12, sourceCommit: "1".repeat(40),
  outcome: "confirmed", note: "", publishedAt: "2026-10-01T00:00:00.000Z", ...overrides,
});

before(async () => {
  if (!DSN) return;
  const url = new URL(DSN);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || !url.pathname.slice(1).startsWith("kip_qa_")) throw new Error("The integration tests need a loopback database named kip_qa_*.");
  const pg = (await import("pg")).default;
  pool = new pg.Pool({ connectionString: DSN, max: 2 });
  pool.on("error", () => undefined);
  await pool.query("DROP SCHEMA IF EXISTS kip_app_config CASCADE");
  store = createSqlOtaHistoryStore(async (text, params) => (await pool.query(text, params)).rows);
});

after(async () => {
  await pool?.end();
});

test("the history reports itself missing until app_config_003 is applied, and the migration replays", { skip: !DSN }, async () => {
  assert.equal(await store.available(), false);
  await pool.query(await readFile(`${root}database/migrations/app_config_001_init.sql`, "utf8"));
  for (let run = 0; run < 2; run += 1) await pool.query(await readFile(`${root}database/migrations/app_config_003_ota_publishes.sql`, "utf8"));
  assert.equal(await store.available(), true);
});

test("records are idempotent per move, listed newest first, and summarise each bundle", { skip: !DSN }, async () => {
  const first = await store.record(row());
  assert.equal(first?.generation, 1);
  assert.equal(await store.record(row()), null, "a retried --record adds nothing");
  await store.record(row({ generation: 2, previousGeneration: 1, sha256: "b".repeat(64), previousSha256: "a".repeat(64), version: "2222222-bbbbbbbb", minimumNativeBuild: 13, maximumNativeBuild: 14 }));
  await store.record(row({ channel: "production", generation: 1, action: "promote", source: "dashboard", minimumNativeBuild: 13, maximumNativeBuild: 13, note: "Promoted" }));
  // A conflict row never vouches for a bundle.
  await store.record(row({ generation: 3, previousGeneration: 2, sha256: "c".repeat(64), version: "3333333-cccccccc", outcome: "conflict" }));

  const listed = await store.list(10);
  assert.deepEqual(listed.map((item) => [item.channel, item.generation]), [["staging", 3], ["production", 1], ["staging", 2], ["staging", 1]]);
  assert.equal(listed[1].note, "Promoted");
  assert.equal(listed[0].publishedAt, "2026-10-01T00:00:00.000Z");

  const bundles = Object.fromEntries((await store.bundles()).map((item) => [item.sha256, item]));
  assert.deepEqual(Object.keys(bundles).sort(), ["a".repeat(64), "b".repeat(64)]);
  assert.equal(bundles["a".repeat(64)].minimumNativeBuild, 13, "the highest minimum any publication used");
  assert.deepEqual(bundles["a".repeat(64)].channels.sort(), ["production", "staging"]);
  assert.equal(bundles["b".repeat(64)].maximumNativeBuild, 14);

  await assert.rejects(store.record(row({ generation: 4, sha256: "not-a-sha" })), /check/i);
  await assert.rejects(store.record(row({ generation: 4, minimumNativeBuild: 15, maximumNativeBuild: 14 })), /check/i);
});

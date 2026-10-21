import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createNeonInteractionStore } from "../worker/interactions.ts";
import { applyMigration, dbUrl, pool } from "./qa-postgres-adapter.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const ids = new Set();
const rateLimitHashes = new Set();
const store = createNeonInteractionStore(dbUrl);
const log = (name) => process.stdout.write(`${name}: PASS\n`);

function event(eventId = randomUUID(), entryPoint = "map") {
  return {
    eventId,
    installationId: randomUUID(),
    sessionId: randomUUID(),
    occurredAt: new Date().toISOString(),
    schemaVersion: 1,
    appVersion: "qa-1",
    appBuild: "postgres-adapter",
    contentReleaseId: "e".repeat(64),
    environment: "preview",
    parkId: "provincial-goldstream-park",
    type: "park_viewed",
    entryPoint,
  };
}

function hashedEvent(value) {
  return { event: value, payloadHash: digest(JSON.stringify(value)) };
}

try {
  await applyMigration(fileURLToPath(new URL("../database/migrations/interactions_001_init.sql", import.meta.url)));

  const replayEvent = event();
  ids.add(replayEvent.eventId);
  const stored = hashedEvent(replayEvent);
  const firstWrite = await store.saveBatch([stored]);
  assert.deepEqual(firstWrite, { inserted: 1, conflictingEventIds: [] });
  const identicalRetry = await store.saveBatch([stored]);
  assert.deepEqual(identicalRetry, { inserted: 0, conflictingEventIds: [] });
  const changedRetry = await store.saveBatch([hashedEvent({ ...replayEvent, entryPoint: "nearby" })]);
  assert.deepEqual(changedRetry, { inserted: 0, conflictingEventIds: [replayEvent.eventId] });
  log("event insertion, identical replay, changed-payload conflict");

  const concurrentEventId = randomUUID();
  ids.add(concurrentEventId);
  const conflictBase = event(concurrentEventId, "map");
  const competingPayloads = [hashedEvent(conflictBase), hashedEvent({ ...conflictBase, entryPoint: "collection" })];
  const racedWrites = await Promise.all(competingPayloads.map((item) => store.saveBatch([item])));
  assert.equal(racedWrites.filter((result) => result.inserted === 1 && result.conflictingEventIds.length === 0).length, 1);
  assert.equal(
    racedWrites.filter((result) => result.inserted === 0 && result.conflictingEventIds.length === 1 && result.conflictingEventIds[0] === concurrentEventId)
      .length,
    1,
  );
  const persistedRace = await pool.query("SELECT payload_hash FROM kip_analytics.events WHERE event_id = $1::uuid", [concurrentEventId]);
  assert.equal(persistedRace.rows.length, 1);
  assert.ok(competingPayloads.some((item) => item.payloadHash === persistedRace.rows[0].payload_hash));
  log("concurrent changed-payload event ID conflict serialization");

  const duplicateEventId = randomUUID();
  ids.add(duplicateEventId);
  const duplicatePayload = hashedEvent(event(duplicateEventId));
  const concurrentDuplicates = await Promise.all(Array.from({ length: 8 }, () => store.saveBatch([duplicatePayload])));
  assert.equal(
    concurrentDuplicates.reduce((total, result) => total + result.inserted, 0),
    1,
  );
  assert.ok(concurrentDuplicates.every((result) => result.conflictingEventIds.length === 0));
  log("concurrent identical event retries insert once");

  const rateSubjectHash = digest(randomBytes(32));
  rateLimitHashes.add(rateSubjectHash);
  await pool.query(
    `INSERT INTO kip_analytics.rate_limits (subject_hash, window_started_at, hit_count, expires_at)
    VALUES ($1, now(), 27, now() + interval '2 hours')`,
    [rateSubjectHash],
  );
  const boundaryResults = await Promise.all(Array.from({ length: 5 }, () => store.consumeRateLimit(rateSubjectHash)));
  assert.equal(boundaryResults.filter(Boolean).length, 3, "only hits 28 through 30 should be accepted");
  assert.equal(boundaryResults.filter((allowed) => !allowed).length, 2, "hits 31 and 32 should be rejected");
  const boundaryRow = await pool.query("SELECT hit_count FROM kip_analytics.rate_limits WHERE subject_hash = $1", [rateSubjectHash]);
  assert.equal(boundaryRow.rows[0].hit_count, 32);
  assert.equal(await store.consumeRateLimit(rateSubjectHash), false, "a later hit must stay over the cap");
  log("concurrent keyed rate-limit boundary at 30 requests per 15 minutes");
} finally {
  if (ids.size > 0) {
    await pool.query("DELETE FROM kip_analytics.events WHERE event_id = ANY($1::uuid[])", [[...ids]]).catch(() => undefined);
  }
  if (rateLimitHashes.size > 0) {
    await pool.query("DELETE FROM kip_analytics.rate_limits WHERE subject_hash = ANY($1::text[])", [[...rateLimitHashes]]).catch(() => undefined);
  }
  await pool.end();
}

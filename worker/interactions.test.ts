import assert from "node:assert/strict";
import { test } from "node:test";
import {
  handleInteractionRequest,
  handleRetentionRequest,
  INTERACTION_PURGE_BATCH_LIMIT,
  validateInteractionBatch,
  type InteractionEvent,
  type InteractionPurgeResult,
  type InteractionStore,
} from "./interactions.ts";

const API_ORIGIN = "https://kip.example.test";
const SECRET = "interaction-retention-key-is-long-enough-for-tests";
const NOW = Date.parse("2026-09-27T12:00:00.000Z");
const NINETY_DAYS = 90 * 24 * 60 * 60 * 1000;
const RELEASE_ID = "a".repeat(64);
const PARK_ID = "provincial-goldstream-park";

function event(id: number): Extract<InteractionEvent, { type: "park_viewed" }>;
function event(id: number, type: "park_viewed"): Extract<InteractionEvent, { type: "park_viewed" }>;
function event(id: number, type: "directions_opened"): Extract<InteractionEvent, { type: "directions_opened" }>;
function event(id: number, type: "park_claimed"): Extract<InteractionEvent, { type: "park_claimed" }>;
function event(id: number, type?: InteractionEvent["type"]): InteractionEvent {
  type ??= "park_viewed";
  const base = {
    eventId: `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
    installationId: "10000000-0000-4000-8000-000000000001",
    sessionId: "20000000-0000-4000-8000-000000000001",
    occurredAt: new Date(NOW).toISOString(),
    schemaVersion: 1 as const,
    appVersion: "0.1.0",
    appBuild: "abcdef1234567",
    contentReleaseId: RELEASE_ID,
    environment: "staging" as const,
    parkId: PARK_ID,
  };
  if (type === "directions_opened") return { ...base, type, entryPoint: "map", provider: "google_maps", travelMode: "driving" };
  if (type === "park_claimed") return { ...base, type, claimId: `30000000-0000-4000-8000-${String(id).padStart(12, "0")}`, claimStatus: "first" };
  return { ...base, type, entryPoint: "map" };
}

class MemoryInteractionStore implements InteractionStore {
  readonly events = new Map<string, { event: InteractionEvent; payloadHash: string }>();
  readonly rateKeys: string[] = [];
  rateAllowed = true;
  purgeRows: Array<{ receivedAt: number; id: number }> = [];
  lastPurgeLimit = 0;

  async consumeRateLimit(subjectHash: string): Promise<boolean> {
    this.rateKeys.push(subjectHash);
    return this.rateAllowed;
  }

  async saveBatch(items: Array<{ event: InteractionEvent; payloadHash: string }>) {
    const conflicts = items
      .filter((item) => {
        const prior = this.events.get(item.event.eventId);
        return prior && prior.payloadHash !== item.payloadHash;
      })
      .map((item) => item.event.eventId);
    if (conflicts.length > 0) return { inserted: 0, conflictingEventIds: conflicts };
    let inserted = 0;
    for (const item of items) {
      if (!this.events.has(item.event.eventId)) {
        this.events.set(item.event.eventId, item);
        inserted += 1;
      }
    }
    return { inserted, conflictingEventIds: [] };
  }

  async purgeExpired(cutoff: string, batchLimit: number): Promise<InteractionPurgeResult> {
    this.lastPurgeLimit = batchLimit;
    const boundary = Date.parse(cutoff);
    const expired = this.purgeRows.filter((row) => row.receivedAt < boundary).sort((left, right) => left.receivedAt - right.receivedAt || left.id - right.id);
    const removed = new Set(expired.slice(0, batchLimit).map((row) => row.id));
    this.purgeRows = this.purgeRows.filter((row) => !removed.has(row.id));
    return { deleted: removed.size, remainingExpired: this.purgeRows.filter((row) => row.receivedAt < boundary).length };
  }
}

function makeRequest(path: string, body?: unknown, options: { method?: string; ip?: string; authorization?: string } = {}): Request {
  const headers = new Headers();
  if (body !== undefined) headers.set("content-type", "application/json");
  if (options.ip) headers.set("cf-connecting-ip", options.ip);
  if (options.authorization) headers.set("authorization", options.authorization);
  return new Request(`${API_ORIGIN}${path}`, {
    method: options.method ?? "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

test("accepts only the three event types and their exact context fields", () => {
  const result = validateInteractionBatch({ events: [event(1), event(2, "directions_opened"), event(3, "park_claimed")] }, NOW);
  assert.equal(result.length, 3);
  assert.deepEqual(
    result.map((item) => item.type),
    ["park_viewed", "directions_opened", "park_claimed"],
  );

  const extraFields = ["accountId", "email", "ipAddress", "latitude", "photo", "message"];
  for (const field of extraFields) {
    const invalid = { ...event(4), [field]: "must not be accepted" };
    assert.throws(() => validateInteractionBatch({ events: [invalid] }, NOW), /shape/);
  }
  assert.throws(() => validateInteractionBatch({ events: [{ ...event(5), type: "clicked" }] }, NOW), /type/);
});

test("rejects malformed enums, unsupported schema, and timestamps outside retention and clock bounds", () => {
  assert.throws(() => validateInteractionBatch({ events: [{ ...event(10), entryPoint: "somewhere" }] }, NOW), /entryPoint/);
  assert.throws(() => validateInteractionBatch({ events: [{ ...event(11), schemaVersion: 2 }] }, NOW), /schema/);
  assert.throws(() => validateInteractionBatch({ events: [{ ...event(12), occurredAt: new Date(NOW + 6 * 60 * 1000).toISOString() }] }, NOW), /outside/);
  assert.throws(() => validateInteractionBatch({ events: [{ ...event(13), occurredAt: new Date(NOW - NINETY_DAYS - 1).toISOString() }] }, NOW), /outside/);
  assert.doesNotThrow(() => validateInteractionBatch({ events: [{ ...event(14), occurredAt: new Date(NOW - NINETY_DAYS).toISOString() }] }, NOW));
});

test("caps request batches and detects conflicting repeated IDs before writing", () => {
  const tooMany = Array.from({ length: 51 }, (_, index) => event(100 + index));
  assert.throws(() => validateInteractionBatch({ events: tooMany }, NOW), /1 to 50/);
  assert.throws(() => validateInteractionBatch({ events: [event(200), { ...event(200), entryPoint: "nearby" }] }, NOW), /different content/);
  const sameIdempotent = validateInteractionBatch({ events: [event(201), event(201)] }, NOW);
  assert.equal(sameIdempotent.length, 1);
});

test("POST accepts a new event, safely acknowledges a retry, and rejects changed content for the same ID", async () => {
  const store = new MemoryInteractionStore();
  const dependencies = { now: () => NOW, createStore: () => store };
  const request = (payload: InteractionEvent) => makeRequest("/api/interactions", { events: [payload] }, { ip: "203.0.113.5" });

  const created = await handleInteractionRequest(request(event(300)), { KIP_RETENTION_SECRET: SECRET }, dependencies);
  assert.equal(created?.status, 201);
  assert.deepEqual(await json(created!), { accepted: 1, inserted: 1, duplicates: 0 });

  const retried = await handleInteractionRequest(request(event(300)), { KIP_RETENTION_SECRET: SECRET }, dependencies);
  assert.equal(retried?.status, 200);
  assert.deepEqual(await json(retried!), { accepted: 1, inserted: 0, duplicates: 1 });

  const changed = await handleInteractionRequest(request({ ...event(300), entryPoint: "nearby" }), { KIP_RETENTION_SECRET: SECRET }, dependencies);
  assert.equal(changed?.status, 409);
  const conflict = await json(changed!);
  assert.deepEqual(conflict.conflictingEventIds, [event(300).eventId]);
  assert.equal(store.events.size, 1);
  assert.equal(store.rateKeys.length, 3);
  assert.notEqual(store.rateKeys[0], "203.0.113.5");
  assert.match(store.rateKeys[0], /^[0-9a-f]{64}$/);
  const stored = store.events.get(event(300).eventId)?.event as Record<string, unknown>;
  for (const forbidden of ["accountId", "email", "ipAddress", "latitude", "photo", "message"]) assert.equal(forbidden in stored, false);
});

test("throttles requests with a keyed subject digest outside event rows", async () => {
  const store = new MemoryInteractionStore();
  store.rateAllowed = false;
  const response = await handleInteractionRequest(
    makeRequest("/api/interactions", { events: [event(350)] }, { ip: "198.51.100.2" }),
    { KIP_RETENTION_SECRET: SECRET },
    { now: () => NOW, createStore: () => store },
  );
  assert.equal(response?.status, 429);
  assert.equal(store.events.size, 0);
  assert.notEqual(store.rateKeys[0], "198.51.100.2");
});

test("the protected purge deletes only events older than 90 days and reports remaining rows", async () => {
  const store = new MemoryInteractionStore();
  store.purgeRows = [
    { id: 1, receivedAt: NOW - NINETY_DAYS - 1 },
    { id: 2, receivedAt: NOW - NINETY_DAYS },
    { id: 3, receivedAt: NOW - NINETY_DAYS + 1 },
  ];
  const dependencies = { now: () => NOW, createStore: () => store };
  const denied = await handleRetentionRequest(
    makeRequest("/api/retention/interactions/purge", undefined, { authorization: "Bearer wrong-secret" }),
    { KIP_RETENTION_SECRET: SECRET },
    dependencies,
  );
  assert.equal(denied?.status, 401);
  assert.equal(store.purgeRows.length, 3);

  const purged = await handleRetentionRequest(
    makeRequest("/api/retention/interactions/purge", undefined, { authorization: `Bearer ${SECRET}` }),
    { KIP_RETENTION_SECRET: SECRET },
    dependencies,
  );
  assert.equal(purged?.status, 200);
  assert.deepEqual(await json(purged!), {
    deleted: 1,
    batchLimit: INTERACTION_PURGE_BATCH_LIMIT,
    remainingExpired: 0,
    cutoff: new Date(NOW - NINETY_DAYS).toISOString(),
  });
  assert.deepEqual(
    store.purgeRows.map((row) => row.id),
    [2, 3],
  );
  assert.equal(store.lastPurgeLimit, INTERACTION_PURGE_BATCH_LIMIT);
});

test("the purge cap leaves a visible expired-row count for a follow-up manual run", async () => {
  const store = new MemoryInteractionStore();
  store.purgeRows = Array.from({ length: INTERACTION_PURGE_BATCH_LIMIT + 1 }, (_, index) => ({
    id: index,
    receivedAt: NOW - NINETY_DAYS - 1,
  }));
  const response = await handleRetentionRequest(
    makeRequest("/api/retention/interactions/purge", undefined, { authorization: `Bearer ${SECRET}` }),
    { KIP_RETENTION_SECRET: SECRET },
    { now: () => NOW, createStore: () => store },
  );
  const body = await json(response!);
  assert.equal(body.deleted, INTERACTION_PURGE_BATCH_LIMIT);
  assert.equal(body.remainingExpired, 1);
  assert.equal(store.purgeRows.length, 1);
});

test("handlers return null for routes they do not own and reject unsupported methods", async () => {
  assert.equal(await handleInteractionRequest(new Request(`${API_ORIGIN}/api/other`), {}), null);
  assert.equal(await handleRetentionRequest(new Request(`${API_ORIGIN}/api/other`), {}), null);
  assert.equal((await handleInteractionRequest(new Request(`${API_ORIGIN}/api/interactions`), {}))?.status, 405);
  assert.equal((await handleRetentionRequest(new Request(`${API_ORIGIN}/api/retention/interactions/purge`), {}))?.status, 405);
});

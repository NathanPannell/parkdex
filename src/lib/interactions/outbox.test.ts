import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InteractionClient } from "./client";
import { InteractionOutbox, INTERACTION_BATCH_SIZE, MAX_OUTBOX_AGE_MS, MAX_OUTBOX_EVENTS } from "./outbox";
import type { InteractionEvent } from "./types";

const DATABASE = "kip-interactions";
const RELEASE_ID = "a".repeat(64);
const NOW = Date.parse("2026-09-27T12:00:00.000Z");

function event(id: number, occurredAt = new Date(NOW).toISOString()): InteractionEvent {
  return {
    eventId: `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
    installationId: "10000000-0000-4000-8000-000000000001",
    sessionId: "20000000-0000-4000-8000-000000000001",
    occurredAt,
    schemaVersion: 1,
    appVersion: "0.1.0",
    appBuild: "abcdef1234567",
    contentReleaseId: RELEASE_ID,
    environment: "staging",
    parkId: "provincial-goldstream-park",
    type: "park_viewed",
    entryPoint: "map",
  };
}

function deleteDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Interaction database is still open."));
  });
}

function successfulResponse(count: number): Response {
  return new Response(JSON.stringify({ accepted: count, inserted: count, duplicates: 0 }), {
    status: 201,
    headers: { "content-type": "application/json" },
  });
}

describe("InteractionOutbox", () => {
  let outbox: InteractionOutbox;

  beforeEach(async () => {
    await deleteDatabase();
    outbox = new InteractionOutbox();
  });

  afterEach(async () => {
    await deleteDatabase();
  });

  it("persists one random installation ID and returns bounded FIFO batches", async () => {
    const firstInstallationId = await outbox.getInstallationId();
    const secondInstallationId = await new InteractionOutbox().getInstallationId();
    expect(firstInstallationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(secondInstallationId).toBe(firstInstallationId);

    for (let index = 1; index <= MAX_OUTBOX_EVENTS + 1; index += 1) {
      await outbox.enqueue(event(index), NOW + index);
    }
    expect(await outbox.count()).toBe(MAX_OUTBOX_EVENTS);
    const batch = await outbox.nextBatch(NOW + MAX_OUTBOX_EVENTS + 1);
    expect(batch).toHaveLength(INTERACTION_BATCH_SIZE);
    expect(batch[0].event.eventId).toBe(event(2).eventId);
    expect(batch.at(-1)?.event.eventId).toBe(event(INTERACTION_BATCH_SIZE + 1).eventId);
  });

  it("expires queued events after 90 days while retaining the exact boundary until it is older", async () => {
    await outbox.enqueue(event(500), NOW);
    expect(await outbox.nextBatch(NOW + MAX_OUTBOX_AGE_MS)).toHaveLength(1);
    expect(await outbox.nextBatch(NOW + MAX_OUTBOX_AGE_MS + 1)).toHaveLength(0);
    expect(await outbox.count()).toBe(0);
  });
});

describe("InteractionClient", () => {
  beforeEach(async () => { await deleteDatabase(); });
  afterEach(async () => { await deleteDatabase(); });

  it("returns after durable queueing and reuses the same event ID after a failed send", async () => {
    const outbox = new InteractionOutbox();
    const attempts: InteractionEvent[][] = [];
    let resolveFirst!: (response: Response) => void;
    const fetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { events: InteractionEvent[] };
      attempts.push(body.events);
      if (attempts.length === 1) return await new Promise<Response>((resolve) => { resolveFirst = resolve; });
      return successfulResponse(body.events.length);
    };
    const client = new InteractionClient({
      outbox,
      fetcher,
      now: () => NOW,
      apiBaseUrl: "https://kip.example.test",
      appVersion: "0.1.0",
      appBuild: "abcdef1234567",
      environment: "staging",
      lifecycleHooks: false,
    });

    const queued = client.recordParkViewed({ parkId: "provincial-goldstream-park", entryPoint: "map", contentReleaseId: RELEASE_ID });
    await queued;
    expect(await outbox.count()).toBe(1);
    const activeFlush = client.flush(true);
    for (let pass = 0; pass < 20 && attempts.length === 0; pass += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(attempts).toHaveLength(1);
    const queuedId = (await outbox.nextBatch(NOW))[0].event.eventId;
    expect(queuedId).toMatch(/^[0-9a-f-]{36}$/);

    resolveFirst(new Response(JSON.stringify({ error: { code: "service_unavailable" } }), { status: 503 }));
    await activeFlush;
    expect(await outbox.count()).toBe(1);

    const captured = [...attempts[0]];
    await client.flush(true);
    expect(attempts).toHaveLength(2);
    expect(attempts[1][0].eventId).toBe(captured[0].eventId);
    expect(attempts[1][0].eventId).toBe(queuedId);
    expect(await outbox.count()).toBe(0);
  });

  it("adds only allowlisted shared and event-specific context for each explicit event", async () => {
    const outbox = new InteractionOutbox();
    let captured: InteractionEvent[] = [];
    const client = new InteractionClient({
      outbox,
      fetcher: async (_input, init) => {
        captured = (JSON.parse(String(init?.body)) as { events: InteractionEvent[] }).events;
        return new Response("unavailable", { status: 503 });
      },
      now: () => NOW,
      apiBaseUrl: "https://kip.example.test",
      appVersion: "0.1.0",
      appBuild: "abcdef1234567",
      environment: "staging",
      lifecycleHooks: false,
      automaticDelivery: false,
    });
    await client.recordParkViewed({ parkId: "provincial-goldstream-park", entryPoint: "collection", contentReleaseId: RELEASE_ID });
    await client.recordDirectionsOpened({
      parkId: "provincial-goldstream-park", entryPoint: "map", provider: "google_maps", travelMode: "driving", contentReleaseId: RELEASE_ID,
    });
    await client.recordParkClaimed({
      parkId: "provincial-goldstream-park", claimId: "30000000-0000-4000-8000-000000000001", claimStatus: "first", contentReleaseId: RELEASE_ID,
    });
    await client.flush(true);

    const events = await outbox.nextBatch(NOW);
    expect(events.map(({ event: item }) => item.type)).toEqual(["park_viewed", "directions_opened", "park_claimed"]);
    const all = events.map(({ event: item }) => item);
    expect(new Set(all.map((item) => item.installationId)).size).toBe(1);
    expect(new Set(all.map((item) => item.sessionId)).size).toBe(1);
    expect(captured.map((item) => item.type)).toEqual(["park_viewed", "directions_opened", "park_claimed"]);
    for (const item of all) {
      expect(item).not.toHaveProperty("accountId");
      expect(item).not.toHaveProperty("email");
      expect(item).not.toHaveProperty("ipAddress");
      expect(item).not.toHaveProperty("latitude");
      expect(item).not.toHaveProperty("photo");
      expect(item).not.toHaveProperty("message");
    }
    expect(await outbox.count()).toBe(3);
  });
});

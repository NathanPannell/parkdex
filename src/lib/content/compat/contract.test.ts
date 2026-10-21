import { describe, expect, it } from "vitest";
import { createChangesHandler, createSnapshotHandler } from "../../../../worker/content_sync";
import * as currentReader from "../manifest";
import * as readerV1 from "./reader-v1";
import changesFixture from "./fixtures/changes.json";
import currentFixture from "./fixtures/current.json";
import snapshotFixture from "./fixtures/snapshot.json";

// Every reader that a supported app build still runs. When a build line is
// retired, remove its reader here and delete its frozen file.
const READERS = [
  { name: "this build", reader: currentReader },
  { name: "installed builds up to 2026-09-30 (strict v1)", reader: readerV1 },
] as const;

type Snapshot = typeof snapshotFixture;
type Park = Snapshot["parks"][number];

function response() {
  let body = "";
  return {
    statusCode: 0,
    get body() {
      return body;
    },
    setHeader() {},
    end(value?: string) {
      body = value ?? "";
    },
  };
}

const request = (query: Record<string, string> = {}) => ({ method: "GET", query, headers: {} });

// A batch touching every entity kind, built from real rows so the server's own
// output validator decides the exact shape that goes to phones.
function everyEntityBatch(snapshot: Snapshot, revision: number) {
  const park = snapshot.parks.find((entry) => entry.scene !== null) as Park;
  const boundary = snapshot.boundaries.features.find((feature) => feature.properties.id === park.id);
  const asset = snapshot.assets.find((file) => file.path === `art/badges/scenes/${park.scene}.webp`);
  const other = snapshot.parks.find((entry) => entry.id !== park.id && entry.scene === null) as Park;
  return {
    revision,
    changes: [
      { entity: "park", op: "upsert", id: park.id, value: { ...park, name: `${park.name} (renamed)` } },
      { entity: "boundary", op: "upsert", id: park.id, value: boundary },
      { entity: "drive", op: "upsert", id: park.id, value: (snapshot.drive.parks as Record<string, unknown>)[park.id] },
      { entity: "asset", op: "upsert", id: asset!.path, value: asset },
      { entity: "hubs", op: "upsert", id: "default", value: snapshot.drive.hubs },
      { entity: "map", op: "upsert", id: "default", value: snapshot.map },
      { entity: "park", op: "delete", id: other.id },
      { entity: "boundary", op: "delete", id: other.id },
      { entity: "drive", op: "delete", id: other.id },
    ],
  };
}

async function serverSnapshot(snapshot: Snapshot): Promise<unknown> {
  const res = response();
  const repository = { snapshot: async () => snapshot, changes: async () => ({}), scene: async () => null };
  await createSnapshotHandler({ repository })(request(), res);
  expect(res.statusCode).toBe(200);
  return JSON.parse(res.body);
}

async function serverChanges(snapshot: Snapshot): Promise<unknown> {
  const res = response();
  const after = snapshot.revision;
  const batch = everyEntityBatch(snapshot, after + 1);
  const repository = {
    snapshot: async () => snapshot,
    changes: async () => ({ headRevision: after + 1, retentionFloor: 0, hasMore: false, batches: [batch] }),
    scene: async () => null,
  };
  await createChangesHandler({ repository })(request({ after: String(after), limit: "50" }), res);
  expect(res.statusCode).toBe(200);
  return JSON.parse(res.body);
}

describe.each(READERS)("content API contract for $name", ({ reader }) => {
  it("reads the saved real snapshot", () => {
    const state = reader.parseContentSnapshot(snapshotFixture);
    expect(state.parks.map((park) => park.id)).toEqual(snapshotFixture.parks.map((park) => park.id));
  });

  it("reads the saved real change batch", () => {
    const parsed = reader.parseContentChanges(changesFixture, changesFixture.fromRevision);
    expect(parsed.batches.length).toBe(changesFixture.batches.length);
  });

  it("reads the saved real content channel", () => {
    const channel = reader.parseContentChannel(currentFixture, currentFixture.environment as "staging" | "main");
    expect(channel.releaseId).toBe(currentFixture.releaseId);
  });

  it("reads the snapshot the current server code produces", async () => {
    const state = reader.parseContentSnapshot(await serverSnapshot(snapshotFixture));
    expect(state.parks).toHaveLength(snapshotFixture.parks.length);
  });

  it("reads and applies a change batch of every entity kind from the current server code", async () => {
    const state = reader.parseContentSnapshot(snapshotFixture);
    const changes = reader.parseContentChanges(await serverChanges(snapshotFixture), snapshotFixture.revision);
    const next = reader.applyContentChangeBatch(state, changes.batches[0]!);
    expect(next.revision).toBe(snapshotFixture.revision + 1);
    expect(next.parks).toHaveLength(snapshotFixture.parks.length - 1);
    expect(next.parks.some((park) => park.name.endsWith("(renamed)"))).toBe(true);
  });
});

import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArchivedScene, ContentChangeBatch, ContentEnvironment, ContentFile, ContentSyncState } from "./contracts";
import type { Park } from "../parks";

const nativeHarness = vi.hoisted(() => ({
  connection: null as unknown,
  closeConnection: vi.fn(),
  files: new Map<string, string>(),
  directories: new Set<string>(),
  filesystem: {
    mkdir: vi.fn(),
    readdir: vi.fn(),
    stat: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    deleteFile: vi.fn(),
    rename: vi.fn(),
  },
}));

vi.mock("@capacitor-community/sqlite", () => ({
  CapacitorSQLite: {},
  SQLiteConnection: class {
    createConnection() {
      return nativeHarness.connection;
    }
    closeConnection() {
      return nativeHarness.closeConnection();
    }
  },
}));

vi.mock("@capacitor/filesystem", () => ({
  Directory: { Data: "DATA" },
  Filesystem: nativeHarness.filesystem,
}));

import { NativeContentStore } from "./store.native";

type SqlValue = string | number | null;
type SqlSetStatement = { statement?: string; values?: SqlValue[] };

/** Minimal Capacitor SQLite adapter backed by real synchronous SQLite statements. */
class InMemoryCapacitorSqlite {
  constructor(private readonly database: DatabaseSync) {}

  async open() {}

  async execute(statement: string) {
    this.database.exec(statement);
    return { changes: { changes: 0 } };
  }

  async query(statement: string, values: SqlValue[] = []) {
    return { values: this.database.prepare(statement).all(...values) };
  }

  async run(statement: string, values: SqlValue[] = []) {
    const result = this.database.prepare(statement).run(...values);
    return { changes: { changes: Number(result.changes) } };
  }

  async executeSet(statements: SqlSetStatement[], transaction = true) {
    if (transaction) this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const { statement, values = [] } of statements) {
        if (statement) this.database.prepare(statement).run(...values);
      }
      if (transaction) this.database.exec("COMMIT");
      return { changes: { changes: 0 } };
    } catch (error) {
      if (transaction) this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async beginTransaction() {
    this.database.exec("BEGIN");
  }

  async commitTransaction() {
    this.database.exec("COMMIT");
  }

  async rollbackTransaction() {
    this.database.exec("ROLLBACK");
  }
}

const ENVIRONMENT: ContentEnvironment = "staging";
const SOURCE = "native-test-source-a";
const PARK_ID = "native-sync-test-park";
const HUBS = [{ name: "Victoria", lng: -123.3656, lat: 48.4284 }];

function park(scene: string | null, blurb = "A native SQLite fixture park."): Park {
  return {
    id: PARK_ID,
    name: "Native Sync Fixture Park",
    short: "Native Fixture",
    category: "regional",
    region: "Victoria",
    lat: 48.4,
    lng: -123.3,
    biome: "forest",
    shape: "circle",
    rarity: "common",
    scene,
    seed: 42,
    blurb,
  };
}

function boundary(id = PARK_ID): ContentSyncState["boundaries"]["features"][number] {
  const west = -123.31;
  const south = 48.39;
  return {
    type: "Feature",
    properties: { id, biome: "forest" },
    geometry: {
      type: "MultiPolygon",
      coordinates: [[[[west, south], [west + 0.01, south], [west + 0.01, south + 0.01], [west, south]]]],
    },
  };
}

function sceneFile(scene: string, hashChar: string, releaseId = "a".repeat(64)): ContentFile {
  const path = `art/badges/scenes/${scene}.webp`;
  const key = `releases/${releaseId}/${path}`;
  return {
    path,
    key,
    url: `https://kip-assets.parkdex.app/${key}`,
    sha256: hashChar.repeat(64),
    byte_size: 12,
    content_type: "image/webp",
  };
}

function syncState(revision: number, scene: string | null, sourceId = SOURCE): ContentSyncState {
  return {
    revision,
    sourceId,
    parks: scene ? [park(scene)] : [],
    boundaries: { type: "FeatureCollection", features: scene ? [boundary()] : [] },
    drive: { hubs: HUBS, parks: scene ? { [PARK_ID]: { drive: [[12, 8]], walkM: 250 } } : {} },
    assets: scene ? [sceneFile(scene, "b")] : [],
    map: null,
  };
}

function emptyState(revision: number, sourceId = SOURCE): ContentSyncState {
  return {
    revision,
    sourceId,
    parks: [],
    boundaries: { type: "FeatureCollection", features: [] },
    drive: { hubs: HUBS, parks: {} },
    assets: [],
    map: null,
  };
}

function archivedScene(releaseId: string, scene: string, sha256 = "c".repeat(64), byteSize = 12): ArchivedScene {
  const path = `art/badges/scenes/${scene}.webp`;
  const key = `releases/${releaseId}/${path}`;
  return {
    releaseId,
    scene,
    file: {
      path,
      key,
      url: `https://kip-assets.parkdex.app/${key}`,
      sha256,
      byte_size: byteSize,
      content_type: "image/webp",
    },
  };
}

function arrayBuffer(value: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(value);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

async function hash(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("NativeContentStore sync persistence with SQLite", () => {
  let database: DatabaseSync;
  let store: NativeContentStore;

  beforeEach(async () => {
    vi.resetAllMocks();
    database = new DatabaseSync(":memory:");
    nativeHarness.connection = new InMemoryCapacitorSqlite(database);
    nativeHarness.files.clear();
    nativeHarness.directories.clear();
    nativeHarness.closeConnection.mockResolvedValue(undefined);
    nativeHarness.filesystem.mkdir.mockImplementation(async ({ path }: { path: string }) => {
      nativeHarness.directories.add(path);
      return {};
    });
    nativeHarness.filesystem.readdir.mockResolvedValue({ files: [] });
    nativeHarness.filesystem.stat.mockImplementation(async ({ path }: { path: string }) => {
      const data = nativeHarness.files.get(path);
      if (data === undefined) throw { code: "OS-PLUG-FILE-0008", message: "File does not exist" };
      return { size: atob(data).length };
    });
    nativeHarness.filesystem.readFile.mockImplementation(async ({ path }: { path: string }) => {
      const data = nativeHarness.files.get(path);
      if (data === undefined) throw { code: "OS-PLUG-FILE-0008", message: "File does not exist" };
      return { data };
    });
    nativeHarness.filesystem.writeFile.mockImplementation(async ({ path, data }: { path: string; data: string }) => {
      nativeHarness.files.set(path, data);
      return {};
    });
    nativeHarness.filesystem.deleteFile.mockImplementation(async ({ path }: { path: string }) => {
      nativeHarness.files.delete(path);
      return {};
    });
    nativeHarness.filesystem.rename.mockImplementation(async ({ from, to }: { from: string; to: string }) => {
      const data = nativeHarness.files.get(from);
      if (data === undefined) throw { code: "OS-PLUG-FILE-0008", message: "File does not exist" };
      nativeHarness.files.delete(from);
      nativeHarness.files.set(to, data);
      return {};
    });
    store = new NativeContentStore();
    await store.initialize();
  });

  afterEach(async () => {
    await store.close();
    database.close();
    nativeHarness.connection = null;
  });

  it("commits a multi-entity SQL batch with its cursor and restores it through a new store", async () => {
    await store.replaceSyncState(ENVIRONMENT, null, emptyState(10), SOURCE, null);
    const newPark = park("native-scene", "Updated by one native revision.");
    const file = sceneFile("native-scene", "d");
    const map = {
      version: "map-v1",
      manifestUrl: "https://kip-assets.parkdex.app/map/manifest.json",
      manifestSha256: "e".repeat(64),
    };
    const batch: ContentChangeBatch = {
      revision: 11,
      changes: [
        { entity: "park", op: "upsert", id: PARK_ID, value: newPark },
        { entity: "boundary", op: "upsert", id: PARK_ID, value: boundary() },
        { entity: "drive", op: "upsert", id: PARK_ID, value: { drive: [[12, 8]], walkM: 250 } },
        { entity: "asset", op: "upsert", id: file.path, value: file },
        { entity: "map", op: "upsert", id: "default", value: map },
      ],
    };

    await store.applySyncBatch(ENVIRONMENT, 10, batch, SOURCE);
    await expect(store.getSyncCursor(ENVIRONMENT)).resolves.toEqual({ revision: 11, sourceId: SOURCE, readerVersion: 2 });
    await expect(store.getSyncState(ENVIRONMENT)).resolves.toMatchObject({
      revision: 11,
      sourceId: SOURCE,
      parks: [newPark],
      boundaries: { features: [boundary()] },
      drive: { parks: { [PARK_ID]: { drive: [[12, 8]], walkM: 250 } } },
      assets: [file],
      map,
    });
    await expect(store.getCachedMapPointer(ENVIRONMENT)).resolves.toEqual(map);

    await store.close();
    store = new NativeContentStore();
    await store.initialize();
    await expect(store.getSyncState(ENVIRONMENT)).resolves.toMatchObject({
      revision: 11,
      sourceId: SOURCE,
      parks: [newPark],
      assets: [file],
    });
  });

  it("rolls back earlier row writes and cursor changes when a later SQL row violates a constraint", async () => {
    const previous = syncState(20, "old-scene");
    await store.replaceSyncState(ENVIRONMENT, null, previous, SOURCE, null);
    const before = await store.getSyncState(ENVIRONMENT);
    database.exec(`
      CREATE TRIGGER reject_sync_row BEFORE INSERT ON content_sync_rows
      WHEN NEW.row_id = 'force-rollback'
      BEGIN SELECT RAISE(ABORT, 'injected SQLite row failure'); END;
    `);
    const batch: ContentChangeBatch = {
      revision: 21,
      changes: [
        { entity: "park", op: "upsert", id: PARK_ID, value: park("new-scene", "This must roll back.") },
        { entity: "boundary", op: "upsert", id: "force-rollback", value: boundary("force-rollback") },
      ],
    };

    await expect(store.applySyncBatch(ENVIRONMENT, 20, batch, SOURCE)).rejects.toThrow(/injected SQLite row failure/);

    await expect(store.getSyncState(ENVIRONMENT)).resolves.toEqual(before);
    await expect(store.getSyncCursor(ENVIRONMENT)).resolves.toEqual({ revision: 20, sourceId: SOURCE, readerVersion: 2 });
  });

  it("rejects stale revision and source compare-and-swap attempts without changing rows", async () => {
    const previous = syncState(7, "saved-scene");
    await store.replaceSyncState(ENVIRONMENT, null, previous, SOURCE, null);
    const before = await store.getSyncState(ENVIRONMENT);
    const batch: ContentChangeBatch = {
      revision: 9,
      changes: [{ entity: "park", op: "upsert", id: PARK_ID, value: park("uncommitted-scene") }],
    };

    await expect(store.applySyncBatch(ENVIRONMENT, 7, batch, SOURCE)).rejects.toThrow();
    await expect(store.applySyncBatch(ENVIRONMENT, 7, { ...batch, revision: 8 }, "other-source")).rejects.toThrow();
    await expect(store.replaceSyncState(ENVIRONMENT, 7, syncState(8, "uncommitted-scene", "other-source"), "other-source", "stale-source", true)).rejects.toThrow();

    await expect(store.getSyncState(ENVIRONMENT)).resolves.toEqual(before);
    await expect(store.getSyncCursor(ENVIRONMENT)).resolves.toEqual({ revision: 7, sourceId: SOURCE, readerVersion: 2 });
  });

  it("repairs legacy content columns in place and only resets a malformed cursor", async () => {
    const previous = syncState(8, "legacy-scene");
    await store.replaceSyncState(ENVIRONMENT, null, previous, SOURCE, null);
    await store.retainParks([{ park: park("retired-park", "Retired Park") }]);
    const bytes = arrayBuffer("legacy archived badge");
    const digest = await hash(bytes);
    const archived = archivedScene("a".repeat(64), "legacy-scene", digest, bytes.byteLength);
    await store.putFile(digest, bytes);
    await store.retainArchivedScene(archived);
    await store.close();

    database.exec(`
      DROP INDEX content_sync_rows_order;
      ALTER TABLE content_sync_rows DROP COLUMN position;
      ALTER TABLE content_sync_cursors RENAME COLUMN source_id TO source;
      ALTER TABLE content_retained_parks DROP COLUMN scene_file_json;
      ALTER TABLE content_sync_cursors DROP COLUMN reader_version;
      DROP TABLE content_local_schema;
    `);
    store = new NativeContentStore();
    await store.initialize();

    await expect(store.getSyncCursor(ENVIRONMENT)).resolves.toEqual({ revision: 8, sourceId: SOURCE, readerVersion: 1 });
    await expect(store.getSyncState(ENVIRONMENT)).resolves.toMatchObject({ revision: 8, sourceId: SOURCE, parks: previous.parks });
    expect(database.prepare("SELECT version FROM content_local_schema WHERE singleton = 'schema'").get()).toEqual({ version: 2 });
    await expect(store.getRetainedParks()).resolves.toEqual([{ park: park("retired-park", "Retired Park") }]);
    await expect(store.getArchivedScene(archived.releaseId, archived.scene)).resolves.toEqual(archived);
    await expect(store.hasFile(digest, bytes.byteLength)).resolves.toBe(true);

    database.prepare("UPDATE content_sync_cursors SET revision = ? WHERE environment = ?").run("malformed", ENVIRONMENT);
    await expect(store.getSyncCursor(ENVIRONMENT)).resolves.toBeNull();
    await expect(store.getSyncState(ENVIRONMENT)).resolves.toBeNull();
    await store.replaceSyncState(ENVIRONMENT, null, emptyState(9, "recovered-source"), "recovered-source", null, true);
    await expect(store.getSyncCursor(ENVIRONMENT)).resolves.toEqual({ revision: 9, sourceId: "recovered-source", readerVersion: 2 });

    database.prepare("UPDATE content_sync_cursors SET revision = ?, source_id = ? WHERE environment = ?")
      .run(10, "newer-source", ENVIRONMENT);
    await expect(store.replaceSyncState(ENVIRONMENT, null, emptyState(11, "stale-source"), "stale-source", null, true)).rejects.toThrow();
    await expect(store.getSyncCursor(ENVIRONMENT)).resolves.toEqual({ revision: 10, sourceId: "newer-source", readerVersion: 2 });
    await expect(store.getArchivedScene(archived.releaseId, archived.scene)).resolves.toEqual(archived);
    await expect(store.hasFile(digest, bytes.byteLength)).resolves.toBe(true);
  });

  it("keeps an empty catalogue distinguishable from an uninitialized store after recreation", async () => {
    await store.replaceSyncState(ENVIRONMENT, null, emptyState(0), SOURCE, null);
    await store.close();
    store = new NativeContentStore();
    await store.initialize();

    await expect(store.getSyncState(ENVIRONMENT)).resolves.toEqual({
      revision: 0,
      sourceId: SOURCE,
      parks: [],
      boundaries: { type: "FeatureCollection", features: [] },
      drive: { hubs: HUBS, parks: {} },
      assets: [],
      map: null,
    });
  });

  it("writes archive rows in the accounts release format with file JSON only", async () => {
    const archived = archivedScene("e".repeat(64), "release-format-scene");
    await store.retainArchivedScene(archived);

    const row = database.prepare(
      "SELECT release_id, scene, file_json FROM content_archived_scenes WHERE release_id = ? AND scene = ?",
    ).get(archived.releaseId, archived.scene) as { release_id: string; scene: string; file_json: string } | undefined;
    expect(row).toEqual({ release_id: archived.releaseId, scene: archived.scene, file_json: JSON.stringify(archived.file) });
    await expect(store.getArchivedScene(archived.releaseId, archived.scene)).resolves.toEqual(archived);
  });

  it("resets to a new source and empty catalogue without deleting archived earned art", async () => {
    const previous = syncState(30, "earned-scene");
    await store.replaceSyncState(ENVIRONMENT, null, previous, SOURCE, null);
    const bytes = arrayBuffer("native archived badge bytes");
    const digest = await hash(bytes);
    const archived = archivedScene("f".repeat(64), "earned-scene", digest, bytes.byteLength);
    await store.putFile(digest, bytes);
    // Seed the exact row format written by the accounts staging release.
    database.prepare("INSERT INTO content_archived_scenes(release_id, scene, file_json) VALUES(?, ?, ?)")
      .run(archived.releaseId, archived.scene, JSON.stringify(archived.file));

    await store.replaceSyncState(ENVIRONMENT, 30, emptyState(0, "native-test-source-b"), "native-test-source-b", SOURCE, true);
    await store.close();
    store = new NativeContentStore();
    await store.initialize();

    await expect(store.getSyncState(ENVIRONMENT)).resolves.toEqual({
      revision: 0,
      sourceId: "native-test-source-b",
      parks: [],
      boundaries: { type: "FeatureCollection", features: [] },
      drive: { hubs: HUBS, parks: {} },
      assets: [],
      map: null,
    });
    await expect(store.getArchivedScene(archived.releaseId, archived.scene)).resolves.toEqual(archived);
    await expect(store.listArchivedScenes()).resolves.toEqual([archived]);
    await expect(store.hasFile(digest, bytes.byteLength)).resolves.toBe(true);
    await expect(store.deleteFile(digest)).rejects.toThrow(/active or retained content/);
  });
});

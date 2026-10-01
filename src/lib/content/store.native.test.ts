import { beforeEach, describe, expect, it, vi } from "vitest";

const nativeMocks = vi.hoisted(() => ({
  db: {
    open: vi.fn(),
    execute: vi.fn(),
    query: vi.fn(),
    run: vi.fn(),
    executeSet: vi.fn(),
  },
  createConnection: vi.fn(),
  closeConnection: vi.fn(),
  mkdir: vi.fn(),
  readdir: vi.fn(),
  stat: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  deleteFile: vi.fn(),
  rename: vi.fn(),
  directories: new Set<string>(),
  files: new Map<string, string>(),
  tableColumns: new Map<string, string[]>(),
}));

vi.mock("@capacitor-community/sqlite", () => ({
  CapacitorSQLite: {},
  SQLiteConnection: class {
    createConnection(...args: unknown[]) {
      return nativeMocks.createConnection(...args);
    }
    closeConnection(...args: unknown[]) {
      return nativeMocks.closeConnection(...args);
    }
  },
}));

vi.mock("@capacitor/filesystem", () => ({
  Directory: { Data: "DATA" },
  Filesystem: {
    mkdir: nativeMocks.mkdir,
    readdir: nativeMocks.readdir,
    stat: nativeMocks.stat,
    readFile: nativeMocks.readFile,
    writeFile: nativeMocks.writeFile,
    deleteFile: nativeMocks.deleteFile,
    rename: nativeMocks.rename,
  },
}));

import type { ArchivedScene, RetainedPark, StoredRelease } from "./contracts";
import { NativeContentStore } from "./store.native";

const HASH = "b".repeat(64);

async function hash(bytes: ArrayBuffer) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function release(files: StoredRelease["manifest"]["files"]): StoredRelease {
  return {
    id: "release",
    channel: {
      schema: "parkdex.content-channel/v1",
      environment: "staging",
      generation: 1,
      releaseId: "release",
      manifestUrl: "https://kip-assets.parkdex.app/manifest.json",
      manifestSha256: "0".repeat(64),
      minimumReaderVersion: 1,
    },
    manifest: {
      version: "1",
      sourceCommit: "test",
      cdnOrigin: "https://kip-assets.parkdex.app",
      files,
      parkIds: [],
      boundaryIds: [],
      mapManifest: { size: 0, chunkBytes: 1, count: 0 },
    },
    readiness: "candidate",
    healthy: false,
  };
}

function park(id: string, name: string): RetainedPark["park"] {
  return {
    id,
    name,
    short: name,
    category: "regional",
    region: "Victoria",
    lat: 48.4,
    lng: -123.3,
    biome: "coast",
    shape: "circle",
    rarity: "common",
    seed: 7,
    blurb: "A retained test park.",
    scene: null,
  };
}

const sceneFile = {
  path: "art/badges/scenes/earned.webp",
  key: "scene-earned",
  url: "https://kip-assets.parkdex.app/earned.webp",
  sha256: HASH,
  byte_size: 10,
  content_type: "image/webp",
};

describe("NativeContentStore deletion guard", () => {
  let activeRelease = release([sceneFile]);
  let retainedRows: { park_json: string; scene_file_json: string | null }[] = [];
  let archivedRows: { release_id: string; scene: string; file_json: string }[] = [];

  beforeEach(() => {
    vi.resetAllMocks();
    nativeMocks.directories.clear();
    nativeMocks.directories.add("");
    nativeMocks.files.clear();
    activeRelease = release([sceneFile]);
    retainedRows = [];
    archivedRows = [];
    nativeMocks.tableColumns.clear();
    nativeMocks.tableColumns.set("content_retained_parks", ["park_id", "park_json", "scene_file_json"]);
    nativeMocks.tableColumns.set("content_sync_rows", ["environment", "entity", "row_id", "position", "value_json"]);
    nativeMocks.tableColumns.set("content_sync_cursors", ["environment", "revision", "source_id"]);
    nativeMocks.createConnection.mockResolvedValue(nativeMocks.db);
    nativeMocks.db.open.mockResolvedValue(undefined);
    nativeMocks.db.execute.mockResolvedValue({});
    nativeMocks.db.run.mockImplementation(async (statement: string, values?: unknown[]) => {
      if (statement.includes("INSERT OR REPLACE INTO content_archived_scenes")) {
        const [release_id, scene, file_json] = values as [string, string, string];
        archivedRows = archivedRows.filter((row) => row.release_id !== release_id || row.scene !== scene);
        archivedRows.push({ release_id, scene, file_json });
      }
      return { changes: { changes: 1 } };
    });
    nativeMocks.db.query.mockImplementation(async (statement: string, values?: unknown[]) => {
      if (statement.startsWith("PRAGMA table_info(")) {
        const table = /^PRAGMA table_info\(([^)]+)\)$/.exec(statement)?.[1] ?? "";
        return { values: (nativeMocks.tableColumns.get(table) ?? []).map((name) => ({ name })) };
      }
      if (statement.includes("FROM content_archived_scenes")) {
        if (statement.includes("WHERE release_id = ? AND scene = ?")) {
          const [releaseId, scene] = values as [string, string];
          return { values: archivedRows.filter((row) => row.release_id === releaseId && row.scene === scene) };
        }
        return { values: [...archivedRows].sort((left, right) => left.release_id.localeCompare(right.release_id) || left.scene.localeCompare(right.scene)) };
      }
      if (statement.includes("SELECT release_id")) return { values: [{ release_id: "release" }] };
      if (statement.includes("content_releases")) {
        if (statement.includes("ORDER BY")) return { values: [{ id: activeRelease.id, release_json: JSON.stringify(activeRelease) }] };
        return { values: [{ id: activeRelease.id, release_json: JSON.stringify(activeRelease) }] };
      }
      if (statement.includes("SELECT park_json")) return { values: retainedRows };
      return { values: [] };
    });
    nativeMocks.db.executeSet.mockResolvedValue({});
    nativeMocks.closeConnection.mockResolvedValue(undefined);
    nativeMocks.mkdir.mockResolvedValue(undefined);
    nativeMocks.readdir.mockResolvedValue({ files: [] });
    nativeMocks.stat.mockResolvedValue({ size: 0 });
    nativeMocks.readFile.mockResolvedValue({ data: "" });
    nativeMocks.writeFile.mockResolvedValue({});
    nativeMocks.deleteFile.mockResolvedValue(undefined);
    nativeMocks.rename.mockResolvedValue(undefined);
  });

  it("refuses to delete a blob used by the active release", async () => {
    const store = new NativeContentStore();
    await store.initialize();

    await expect(store.deleteFile(HASH)).rejects.toThrow(/active or retained content/);
    expect(nativeMocks.deleteFile).not.toHaveBeenCalled();
    expect(nativeMocks.db.run).not.toHaveBeenCalled();
    await store.close();
  });

  it("deletes a detailed map chunk the active release lists only as optional coverage", async () => {
    activeRelease = release([{ ...sceneFile, path: "map/island/0123.bin", content_type: "application/octet-stream" }]);
    const store = new NativeContentStore();
    await store.initialize();

    await expect(store.deleteFile(HASH)).rejects.toThrow(/active or retained content/);
    await store.deleteFile(HASH, { optionalMapChunk: true });
    expect(nativeMocks.deleteFile).toHaveBeenCalledOnce();
    expect(nativeMocks.db.run).toHaveBeenCalledWith("DELETE FROM content_files WHERE hash = ?", [HASH]);
    await store.close();
  });

  it("refuses to delete a retained earned-park scene after its release is retired", async () => {
    activeRelease = release([]);
    retainedRows = [{
      park_json: JSON.stringify(park("earned-park", "Earned Park")),
      scene_file_json: JSON.stringify(sceneFile),
    }];
    const store = new NativeContentStore();
    await store.initialize();

    await expect(store.deleteFile(HASH)).rejects.toThrow(/active or retained content/);
    expect(nativeMocks.deleteFile).not.toHaveBeenCalled();
    expect(nativeMocks.db.run).not.toHaveBeenCalled();
    await store.close();
  });

  it("pins archived scenes separately by release and blocks their blobs from collection", async () => {
    activeRelease = release([]);
    const makeArchived = (releaseId: string, digest: string): ArchivedScene => ({
      releaseId,
      scene: "coast-a",
      file: {
        path: "art/badges/scenes/coast-a.webp",
        key: `releases/${releaseId}/art/badges/scenes/coast-a.webp`,
        url: `https://kip-assets.parkdex.app/releases/${releaseId}/art/badges/scenes/coast-a.webp`,
        sha256: digest,
        byte_size: 10,
        content_type: "image/webp",
      },
    });
    const first = makeArchived("a".repeat(64), "c".repeat(64));
    const second = makeArchived("b".repeat(64), "d".repeat(64));
    const store = new NativeContentStore();
    await store.initialize();

    await store.retainArchivedScene(first);
    await store.retainArchivedScene(second);
    await expect(store.deleteFile(first.file.sha256)).rejects.toThrow(/active or retained content/);
    expect(await store.getArchivedScene(first.releaseId, first.scene)).toEqual(first);
    expect(await store.listArchivedScenes()).toEqual([first, second]);
    await store.close();
  });

  it("uses the native filesystem partial-read offset and length", async () => {
    nativeMocks.readFile.mockResolvedValue({ data: btoa("rld") });
    const store = new NativeContentStore();
    await store.initialize();

    const result = await store.readFile(HASH, 4, 3);

    expect(new TextDecoder().decode(result)).toBe("rld");
    expect(nativeMocks.readFile).toHaveBeenCalledWith({
      path: `parkdex-content-v1/blobs/${HASH.slice(0, 2)}/${HASH}.blob`,
      directory: "DATA",
      offset: 4,
      length: 3,
    });
    await store.close();
  });

  it("trusts recorded files at their recorded size without rereading them", async () => {
    const other = "c".repeat(64);
    const query = nativeMocks.db.query.getMockImplementation()!;
    nativeMocks.db.query.mockImplementation(async (statement: string, values?: unknown[]) => {
      if (statement === "SELECT hash, byte_size FROM content_files") return { values: [{ hash: HASH, byte_size: 12 }, { hash: other, byte_size: 99 }] };
      return query(statement, values);
    });
    nativeMocks.stat.mockResolvedValue({ size: 12 });
    nativeMocks.readFile.mockResolvedValue({ data: btoa("not the hash") });
    const store = new NativeContentStore();
    await store.initialize();

    expect(await store.hasFile(HASH, 12)).toBe(true);
    expect(nativeMocks.readFile).not.toHaveBeenCalled();
    // A size mismatch with the record falls back to a full hash check, which fails here.
    nativeMocks.stat.mockResolvedValue({ size: 99 });
    expect(await store.hasFile(HASH, 99)).toBe(false);
    expect(nativeMocks.readFile).toHaveBeenCalledOnce();
    await store.close();
  });

  it("migrates known older content columns without clearing content files", async () => {
    nativeMocks.tableColumns.set("content_retained_parks", ["park_id", "park_json"]);
    nativeMocks.tableColumns.set("content_sync_rows", ["environment", "entity", "row_id", "value_json"]);
    nativeMocks.tableColumns.set("content_sync_cursors", ["environment", "revision", "source"]);
    const blob = "parkdex-content-v1/blobs/aa/map.blob";
    nativeMocks.files.set(blob, btoa("map tile"));
    const store = new NativeContentStore();

    await store.initialize();

    expect(nativeMocks.db.execute).toHaveBeenCalledWith("ALTER TABLE content_retained_parks ADD COLUMN scene_file_json TEXT NULL");
    expect(nativeMocks.db.execute).toHaveBeenCalledWith("ALTER TABLE content_sync_rows ADD COLUMN position INTEGER NOT NULL DEFAULT 0");
    expect(nativeMocks.db.execute).toHaveBeenCalledWith("ALTER TABLE content_sync_cursors ADD COLUMN source_id TEXT NOT NULL DEFAULT ''");
    expect(nativeMocks.db.execute).toHaveBeenCalledWith("UPDATE content_sync_cursors SET source_id = source WHERE source IS NOT NULL AND (source_id IS NULL OR source_id = '')");
    expect(nativeMocks.files.has(blob)).toBe(true);
    expect(nativeMocks.deleteFile).not.toHaveBeenCalled();
    await store.close();
  });

  it("skips unreadable optional release and retained descriptors without deleting their stored rows", async () => {
    retainedRows = [
      { park_json: "{broken", scene_file_json: JSON.stringify(sceneFile) },
      { park_json: JSON.stringify(park("retained", "Retained Park")), scene_file_json: null },
    ];
    nativeMocks.db.query.mockImplementation(async (statement: string, values?: unknown[]) => {
      if (statement.startsWith("PRAGMA table_info(")) {
        const table = /^PRAGMA table_info\(([^)]+)\)$/.exec(statement)?.[1] ?? "";
        return { values: (nativeMocks.tableColumns.get(table) ?? []).map((name) => ({ name })) };
      }
      if (statement.includes("content_releases")) {
        const releaseRows = [
        { id: "release", release_json: JSON.stringify(activeRelease) },
        { id: "broken", release_json: "{broken" },
        ];
        return { values: statement.includes("WHERE id = ?") ? releaseRows.filter((row) => row.id === values?.[0]) : releaseRows };
      }
      if (statement.includes("SELECT park_json")) return { values: retainedRows };
      return { values: [] };
    });
    const store = new NativeContentStore();
    await store.initialize();

    expect(await store.listReleases()).toEqual([activeRelease]);
    expect(await store.getRelease("broken")).toBeUndefined();
    expect(await store.getRetainedParks()).toEqual([{ park: park("retained", "Retained Park") }]);
    expect(retainedRows).toHaveLength(2);
    await store.close();
  });

  it("creates shared blob parents safely during concurrent first writes", async () => {
    nativeMocks.mkdir.mockImplementation(async ({ path }: { path: string; recursive?: boolean }) => {
      await Promise.resolve();
      const normalized = path.replace(/\/+$/, "");
      const separator = normalized.lastIndexOf("/");
      const parent = separator < 0 ? "" : normalized.slice(0, separator);
      if (!nativeMocks.directories.has(parent)) {
        throw { code: "OS-PLUG-FILE-0011", message: "Missing parent directory" };
      }
      if (nativeMocks.directories.has(normalized) || nativeMocks.files.has(normalized)) {
        throw { code: "OS-PLUG-FILE-0010", message: "Directory already exists" };
      }
      nativeMocks.directories.add(normalized);
    });
    nativeMocks.readdir.mockImplementation(async ({ path }: { path: string }) => {
      if (!nativeMocks.directories.has(path)) {
        throw { code: "OS-PLUG-FILE-0008", message: "Directory does not exist" };
      }
      const prefix = path ? `${path}/` : "";
      const children = new Map<string, { name: string; type: "file" | "directory"; size: number; uri: string }>();
      for (const directory of nativeMocks.directories) {
        if (directory === path || !directory.startsWith(prefix)) continue;
        const remainder = directory.slice(prefix.length);
        if (!remainder || remainder.includes("/")) continue;
        children.set(remainder, { name: remainder, type: "directory", size: 0, uri: directory });
      }
      for (const [filePath, data] of nativeMocks.files) {
        if (!filePath.startsWith(prefix)) continue;
        const remainder = filePath.slice(prefix.length);
        if (!remainder || remainder.includes("/")) continue;
        children.set(remainder, { name: remainder, type: "file", size: atob(data).length, uri: filePath });
      }
      return { files: [...children.values()] };
    });
    nativeMocks.stat.mockImplementation(async ({ path }: { path: string }) => {
      const data = nativeMocks.files.get(path);
      if (data !== undefined) return { size: atob(data).length };
      if (nativeMocks.directories.has(path)) return { size: 0 };
      throw { code: "OS-PLUG-FILE-0008", message: "File does not exist" };
    });
    nativeMocks.writeFile.mockImplementation(async ({ path, data }: { path: string; data: string }) => {
      nativeMocks.files.set(path, data);
      return {};
    });
    nativeMocks.readFile.mockImplementation(async ({ path }: { path: string }) => {
      const data = nativeMocks.files.get(path);
      if (data === undefined) throw { code: "OS-PLUG-FILE-0008", message: "File does not exist" };
      return { data };
    });
    nativeMocks.rename.mockImplementation(async ({ from, to }: { from: string; to: string }) => {
      const data = nativeMocks.files.get(from);
      if (data === undefined) throw { code: "OS-PLUG-FILE-0008", message: "File does not exist" };
      nativeMocks.files.delete(from);
      nativeMocks.files.set(to, data);
    });
    nativeMocks.deleteFile.mockImplementation(async ({ path }: { path: string }) => {
      nativeMocks.files.delete(path);
    });

    const store = new NativeContentStore();
    await store.initialize();
    const items = await Promise.all(["one", "two", "three", "four"].map(async (value) => {
      const encoded = new TextEncoder().encode(value);
      const bytes = encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength);
      const digest = await hash(bytes);
      await store.putFile(digest, bytes);
      return { digest, size: bytes.byteLength };
    }));

    expect(await store.listFiles()).toHaveLength(items.length);
    expect(await Promise.all(items.map(({ digest, size }) => store.hasFile(digest, size)))).toEqual([true, true, true, true]);
    expect(nativeMocks.directories.has("parkdex-content-v1/blobs")).toBe(true);
    expect(nativeMocks.mkdir.mock.calls.every(([options]) => options.recursive === false)).toBe(true);
    await store.close();
  });
});

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

import type { StoredRelease } from "./contracts";
import { NativeContentStore } from "./store.native";

const HASH = "b".repeat(64);

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
  let retainedRows: { park_json: string; scene_file_json: string }[] = [];

  beforeEach(() => {
    vi.resetAllMocks();
    activeRelease = release([sceneFile]);
    retainedRows = [];
    nativeMocks.createConnection.mockResolvedValue(nativeMocks.db);
    nativeMocks.db.open.mockResolvedValue(undefined);
    nativeMocks.db.execute.mockResolvedValue({});
    nativeMocks.db.run.mockResolvedValue({ changes: { changes: 1 } });
    nativeMocks.db.query.mockImplementation(async (statement: string) => {
      if (statement.includes("SELECT release_id")) return { values: [{ release_id: "release" }] };
      if (statement.includes("SELECT release_json")) return { values: [{ release_json: JSON.stringify(activeRelease) }] };
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

  it("refuses to delete a retained earned-park scene after its release is retired", async () => {
    activeRelease = release([]);
    retainedRows = [{
      park_json: JSON.stringify({ id: "earned-park" }),
      scene_file_json: JSON.stringify(sceneFile),
    }];
    const store = new NativeContentStore();
    await store.initialize();

    await expect(store.deleteFile(HASH)).rejects.toThrow(/active or retained content/);
    expect(nativeMocks.deleteFile).not.toHaveBeenCalled();
    expect(nativeMocks.db.run).not.toHaveBeenCalled();
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
});

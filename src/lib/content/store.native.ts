import { CapacitorSQLite, SQLiteConnection, type SQLiteDBConnection } from "@capacitor-community/sqlite";
import { Directory, Filesystem } from "@capacitor/filesystem";
import type { ArchivedScene, ContentChangeBatch, ContentEnvironment, ContentFile, ContentMapInventory, ContentMapPointer, ContentStore, ContentSyncCursor, ContentSyncState, RetainedPark, StoredRelease } from "./contracts";
import { assertArchivedSceneDescriptor, assertArchivedSceneIdentity } from "./archived-art";

const DATABASE = "parkdex_content";
const ROOT = "parkdex-content-v1";
const BLOBS = `${ROOT}/blobs`;
const TEMP = `${ROOT}/tmp`;
const ACTIVE_POINTER = "1";

function assertHash(hash: string): string {
  if (!/^[a-f\d]{64}$/i.test(hash)) throw new Error("Invalid content SHA-256 hash");
  return hash.toLowerCase();
}

function assertSize(size: number) {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error("Invalid content byte size");
}

function assertRange(offset = 0, length?: number) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid content read offset");
  if (length !== undefined && (!Number.isSafeInteger(length) || length < 0)) {
    throw new Error("Invalid content read length");
  }
  if (length !== undefined && !Number.isSafeInteger(offset + length)) {
    throw new Error("Invalid content read range");
  }
}

function assertRelease(release: StoredRelease) {
  if (!release || typeof release.id !== "string" || release.id.length === 0) {
    throw new Error("Invalid content release");
  }
}

function assertRetainedPark(retained: RetainedPark) {
  if (!retained?.park || typeof retained.park.id !== "string" || retained.park.id.length === 0) {
    throw new Error("Invalid retained park");
  }
  if (retained.sceneFile) assertHash(retained.sceneFile.sha256);
}

async function sha256(bytes: ArrayBuffer): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("SHA-256 is unavailable on this device");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

function fromBase64(encoded: string): ArrayBuffer {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.toLowerCase();
  if (error && typeof error === "object") {
    const details = error as { code?: unknown; message?: unknown };
    const code = typeof details.code === "string" ? details.code : "";
    const message = typeof details.message === "string" ? details.message : "";
    return `${code} ${message}`.toLowerCase();
  }
  return String(error).toLowerCase();
}

function isMissingFile(error: unknown): boolean {
  const message = errorMessage(error);
  return message.includes("os-plug-file-0008") || message.includes("does not exist") || message.includes("not found") || message.includes("no such file");
}

function isExistingDirectory(error: unknown): boolean {
  const message = errorMessage(error);
  return message.includes("os-plug-file-0010") || message.includes("already exists") || message.includes("cannot be overwritten");
}

function blobPath(hash: string) {
  return `${BLOBS}/${hash.slice(0, 2)}/${hash}.blob`;
}

function newToken() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function mimeType(mime: string): string {
  if (typeof mime !== "string" || mime.length > 128 || /[\r\n]/.test(mime)) {
    throw new Error("Invalid content MIME type");
  }
  return mime;
}

/** Native metadata is held in its own SQLite database and blobs in a private app-data folder. */
export class NativeContentStore implements ContentStore {
  private sqlite: SQLiteConnection | null = null;
  private connection: SQLiteDBConnection | null = null;
  private initializing: Promise<void> | null = null;
  private readonly objectUrls = new Map<string, string>();
  private readonly writeLocks = new Map<string, Promise<void>>();
  private readonly knownDirectories = new Set<string>();
  private directoryQueue: Promise<void> = Promise.resolve();
  private mutationQueue: Promise<void> = Promise.resolve();

  initialize(): Promise<void> {
    if (!this.initializing) {
      this.initializing = this.initializeInner().catch((error) => {
        this.initializing = null;
        throw error;
      });
    }
    return this.initializing;
  }

  async getActiveId(): Promise<string | null> {
    const rows = await this.db().query("SELECT release_id FROM content_active WHERE singleton = ?", [ACTIVE_POINTER]);
    const value = rows.values?.[0]?.release_id;
    return typeof value === "string" ? value : null;
  }

  async getRelease(id: string): Promise<StoredRelease | undefined> {
    const rows = await this.db().query("SELECT release_json FROM content_releases WHERE id = ?", [id]);
    const json = rows.values?.[0]?.release_json;
    return typeof json === "string" ? JSON.parse(json) as StoredRelease : undefined;
  }

  async listReleases(): Promise<StoredRelease[]> {
    const rows = await this.db().query("SELECT release_json FROM content_releases ORDER BY id");
    return (rows.values ?? []).map((row) => JSON.parse(String(row.release_json)) as StoredRelease);
  }

  async putRelease(release: StoredRelease): Promise<void> {
    assertRelease(release);
    await this.exclusive(async () => {
      await this.db().run(
        "INSERT OR REPLACE INTO content_releases(id, release_json) VALUES(?, ?)",
        [release.id, JSON.stringify(release)],
      );
    });
  }

  async activateRelease(id: string, expectedActiveId: string | null): Promise<void> {
    await this.exclusive(async () => {
      const result = await this.db().run(
        "UPDATE content_active SET release_id = ? WHERE singleton = ? AND release_id IS ? AND EXISTS (SELECT 1 FROM content_releases WHERE id = ?)",
        [id, ACTIVE_POINTER, expectedActiveId, id],
      );
      if ((result.changes?.changes ?? 0) > 0) return;

      const [active, release] = await Promise.all([this.getActiveId(), this.getRelease(id)]);
      if (active === id && expectedActiveId === id && release) return;
      if (!release) throw new Error(`Cannot activate missing content release: ${id}`);
      throw new Error(`Active content changed: expected ${String(expectedActiveId)}, found ${String(active)}`);
    });
  }

  async deleteRelease(id: string): Promise<void> {
    await this.exclusive(async () => {
      const result = await this.db().run(
        "DELETE FROM content_releases WHERE id = ? AND NOT EXISTS (SELECT 1 FROM content_active WHERE singleton = ? AND release_id = ?)",
        [id, ACTIVE_POINTER, id],
      );
      if ((result.changes?.changes ?? 0) > 0 || !(await this.getRelease(id))) return;
      if ((await this.getActiveId()) === id) throw new Error(`Cannot delete active content release: ${id}`);
    });
  }

  async hasFile(hash: string, expectedSize: number): Promise<boolean> {
    const key = assertHash(hash);
    assertSize(expectedSize);
    let stat;
    try {
      stat = await Filesystem.stat({ path: blobPath(key), directory: Directory.Data });
    } catch (error) {
      if (isMissingFile(error)) return false;
      throw error;
    }
    if (stat.size !== expectedSize) return false;
    const bytes = await this.readNativeFile(blobPath(key));
    if (bytes.byteLength !== expectedSize || (await sha256(bytes)) !== key) return false;
    await this.recordFile(key, expectedSize);
    return true;
  }

  async putFile(hash: string, bytes: ArrayBuffer): Promise<void> {
    const key = assertHash(hash);
    if (!(bytes instanceof ArrayBuffer)) throw new Error("Content file must be an ArrayBuffer");
    if ((await sha256(bytes)) !== key) throw new Error("Content file SHA-256 does not match its address");
    await this.withFileLock(key, () => this.writeNativeFile(key, bytes));
  }

  async readFile(hash: string, offset = 0, length?: number): Promise<ArrayBuffer> {
    const key = assertHash(hash);
    assertRange(offset, length);
    if (length === 0) return new ArrayBuffer(0);
    const path = blobPath(key);
    const options: { path: string; directory: Directory; offset?: number; length?: number } = {
      path,
      directory: Directory.Data,
    };
    if (offset > 0) options.offset = offset;
    if (length !== undefined) options.length = length;
    const result = await Filesystem.readFile(options);
    if (typeof result.data !== "string") throw new Error("Native content file did not return binary data");
    return fromBase64(result.data);
  }

  async fileUrl(hash: string, mime: string): Promise<string> {
    const key = assertHash(hash);
    const type = mimeType(mime);
    const cacheKey = `${key}\n${type}`;
    const existing = this.objectUrls.get(cacheKey);
    if (existing) return existing;
    const stat = await Filesystem.stat({ path: blobPath(key), directory: Directory.Data });
    const bytes = await this.readNativeFile(blobPath(key));
    if (bytes.byteLength !== stat.size || (await sha256(bytes)) !== key) {
      throw new Error(`Content file failed SHA-256 verification: ${key}`);
    }
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    this.objectUrls.set(cacheKey, url);
    return url;
  }

  async listFiles(): Promise<{ hash: string; size: number }[]> {
    const output: { hash: string; size: number }[] = [];
    let roots;
    try {
      roots = await Filesystem.readdir({ path: BLOBS, directory: Directory.Data });
    } catch (error) {
      if (isMissingFile(error)) return output;
      throw error;
    }
    for (const child of roots.files) {
      if (child.type !== "directory" || !/^[a-f\d]{2}$/.test(child.name)) continue;
      const folder = `${BLOBS}/${child.name}`;
      let files;
      try {
        files = await Filesystem.readdir({ path: folder, directory: Directory.Data });
      } catch (error) {
        if (isMissingFile(error)) continue;
        throw error;
      }
      for (const entry of files.files) {
        const match = /^([a-f\d]{64})\.blob$/.exec(entry.name);
        if (entry.type !== "file" || !match || match[1].slice(0, 2) !== child.name) continue;
        output.push({ hash: match[1], size: entry.size });
      }
    }
    return output.sort((a, b) => a.hash.localeCompare(b.hash));
  }

  async deleteFile(hash: string): Promise<void> {
    const key = assertHash(hash);
    await this.withFileLock(key, () => this.exclusive(async () => {
      const activeId = await this.getActiveId();
      const active = activeId ? await this.getRelease(activeId) : undefined;
      const activeReferencesFile = active?.manifest.files.some((file) => file.sha256.toLowerCase() === key) ?? false;
      const retainedReferencesFile = (await this.getRetainedParks()).some((park) => park.sceneFile?.sha256.toLowerCase() === key);
      const syncState = (await this.db().query("SELECT value_json FROM content_sync_rows WHERE entity = 'asset'", [])).values ?? [];
      const syncReferencesFile = syncState.some((row) => {
        const file = JSON.parse(String(row.value_json)) as { sha256?: unknown };
        return file.sha256 === key;
      });
      const archivedFiles = (await this.db().query("SELECT file_json FROM content_archived_scenes", [])).values ?? [];
      const archivedReferencesFile = archivedFiles.some((row) => {
        const file = JSON.parse(String(row.file_json)) as ContentFile;
        return file.sha256 === key;
      });
      const pointers = (await this.db().query("SELECT pointer_json FROM content_cached_maps", [])).values ?? [];
      const currentMapVersions = new Set(pointers.map((row) => (JSON.parse(String(row.pointer_json)) as ContentMapPointer).version));
      const currentMapRows = (await this.db().query("SELECT value_json FROM content_sync_rows WHERE entity = 'map'", [])).values ?? [];
      for (const row of currentMapRows) currentMapVersions.add((JSON.parse(String(row.value_json)) as ContentMapPointer).version);
      const inventories = (await this.db().query("SELECT version, inventory_json FROM content_map_inventories", [])).values ?? [];
      const mapReferencesFile = inventories.some((row) => {
        if (!currentMapVersions.has(String(row.version))) return false;
        const inventory = JSON.parse(String(row.inventory_json)) as ContentMapInventory;
        return inventory.files.some((file) => file.sha256 === key);
      });
      if (activeReferencesFile || retainedReferencesFile || syncReferencesFile || archivedReferencesFile || mapReferencesFile) {
        throw new Error(`Cannot delete content file referenced by active or retained content: ${key}`);
      }
      const path = blobPath(key);
      try {
        await Filesystem.deleteFile({ path, directory: Directory.Data });
      } catch (error) {
        if (!isMissingFile(error)) throw error;
      }
      await this.db().run("DELETE FROM content_files WHERE hash = ?", [key]);
      this.revokeHashUrls(key);
    }));
  }

  async getRetainedParks(): Promise<RetainedPark[]> {
    const rows = await this.db().query("SELECT park_json, scene_file_json FROM content_retained_parks ORDER BY park_id");
    return (rows.values ?? []).map((row) => ({
      park: JSON.parse(String(row.park_json)) as RetainedPark["park"],
      ...(typeof row.scene_file_json === "string" ? { sceneFile: JSON.parse(row.scene_file_json) as RetainedPark["sceneFile"] } : {}),
    }));
  }

  async retainParks(parks: RetainedPark[]): Promise<void> {
    const unique = new Map<string, RetainedPark>();
    for (const retained of parks) {
      assertRetainedPark(retained);
      unique.set(retained.park.id, retained);
    }
    if (unique.size === 0) return;
    await this.exclusive(async () => {
      const db = this.db();
      await db.executeSet(
        [...unique].map(([parkId, retained]) => ({
          statement: "INSERT OR REPLACE INTO content_retained_parks(park_id, park_json, scene_file_json) VALUES(?, ?, COALESCE(?, (SELECT scene_file_json FROM content_retained_parks WHERE park_id = ?)))",
          values: [parkId, JSON.stringify(retained.park), retained.sceneFile ? JSON.stringify(retained.sceneFile) : null, parkId],
        })),
        true,
      );
    });
  }

  async clearActiveRelease(expectedActiveId: string): Promise<void> {
    await this.exclusive(async () => {
      const result = await this.db().run(
        "UPDATE content_active SET release_id = NULL WHERE singleton = ? AND release_id = ?",
        [ACTIVE_POINTER, expectedActiveId],
      );
      if ((result.changes?.changes ?? 0) !== 1 && (await this.getActiveId()) !== null) {
        throw new Error("Active content changed before its legacy pointer could be cleared");
      }
    });
  }

  async getArchivedScene(releaseId: string, scene: string): Promise<ArchivedScene | undefined> {
    assertArchivedSceneIdentity(releaseId, scene);
    const rows = await this.db().query(
      "SELECT release_id, scene, file_json FROM content_archived_scenes WHERE release_id = ? AND scene = ?",
      [releaseId, scene],
    );
    const row = rows.values?.[0];
    if (!row) return undefined;
    if (row.release_id !== releaseId || row.scene !== scene || typeof row.file_json !== "string") {
      throw new Error("Archived scene storage row does not match its key");
    }
    const descriptor: ArchivedScene = {
      releaseId,
      scene,
      file: JSON.parse(row.file_json) as ArchivedScene["file"],
    };
    assertArchivedSceneDescriptor(descriptor);
    return descriptor;
  }

  async retainArchivedScene(scene: ArchivedScene): Promise<void> {
    assertArchivedSceneDescriptor(scene);
    const descriptor: ArchivedScene = { releaseId: scene.releaseId, scene: scene.scene, file: { ...scene.file } };
    const fileJson = JSON.stringify(descriptor.file);
    await this.exclusive(async () => {
      await this.db().run(
        "INSERT OR REPLACE INTO content_archived_scenes(release_id, scene, file_json) VALUES(?, ?, ?)",
        [descriptor.releaseId, descriptor.scene, fileJson],
      );
    });
  }

  async listArchivedScenes(): Promise<ArchivedScene[]> {
    const rows = await this.db().query(
      "SELECT release_id, scene, file_json FROM content_archived_scenes ORDER BY release_id, scene",
    );
    return (rows.values ?? []).map((row) => {
      if (typeof row.release_id !== "string" || typeof row.scene !== "string" || typeof row.file_json !== "string") {
        throw new Error("Archived scene storage row is invalid");
      }
      const descriptor: ArchivedScene = {
        releaseId: row.release_id,
        scene: row.scene,
        file: JSON.parse(row.file_json) as ArchivedScene["file"],
      };
      assertArchivedSceneDescriptor(descriptor);
      return descriptor;
    });
  }

  async getSyncState(environment: ContentEnvironment): Promise<ContentSyncState | null> {
    return this.exclusive(async () => {
      const db = this.db();
      await db.beginTransaction();
      try {
        const rows = await db.query("SELECT entity, row_id, value_json FROM content_sync_rows WHERE environment = ? ORDER BY entity, position, row_id", [environment]);
        const cursorRows = await db.query("SELECT revision, source_id FROM content_sync_cursors WHERE environment = ?", [environment]);
        const rawCursor = cursorRows.values?.[0]?.revision;
        const rawSource = cursorRows.values?.[0]?.source_id;
        if (typeof rawCursor !== "number" || !Number.isSafeInteger(rawCursor)) {
          await db.commitTransaction();
          return null;
        }
        const parsed = (rows.values ?? []).map((row) => ({
          entity: String(row.entity),
          id: String(row.row_id),
          value: JSON.parse(String(row.value_json)) as unknown,
        }));
        const parks = parsed.filter((row) => row.entity === "park").map((row) => row.value as ContentSyncState["parks"][number]);
        const boundaries = parsed.filter((row) => row.entity === "boundary").map((row) => row.value as ContentSyncState["boundaries"]["features"][number]);
        const drives = Object.fromEntries(parsed.filter((row) => row.entity === "drive").map((row) => [row.id, row.value as ContentSyncState["drive"]["parks"][string]]));
        const hubs = parsed.find((row) => row.entity === "hubs")?.value as ContentSyncState["drive"]["hubs"] | undefined;
        if (!hubs) {
          await db.commitTransaction();
          return null;
        }
        const state: ContentSyncState = {
          revision: rawCursor,
          sourceId: typeof rawSource === "string" ? rawSource : "",
          parks,
          boundaries: { type: "FeatureCollection", features: boundaries },
          drive: { hubs, parks: drives },
          assets: parsed.filter((row) => row.entity === "asset").map((row) => row.value as ContentSyncState["assets"][number]),
          map: parsed.find((row) => row.entity === "map")?.value as ContentSyncState["map"] ?? null,
        };
        await db.commitTransaction();
        return state;
      } catch (error) {
        await db.rollbackTransaction().catch(() => {});
        throw error;
      }
    });
  }

  async getSyncCursor(environment: ContentEnvironment): Promise<ContentSyncCursor | null> {
    const rows = await this.db().query("SELECT revision, source_id FROM content_sync_cursors WHERE environment = ?", [environment]);
    const row = rows.values?.[0];
    if (typeof row?.revision !== "number" || !Number.isSafeInteger(row.revision) || typeof row.source_id !== "string") return null;
    return { revision: row.revision, sourceId: row.source_id };
  }

  async replaceSyncState(environment: ContentEnvironment, expectedRevision: number | null, state: ContentSyncState, sourceId: string, expectedSourceId: string | null, resetCursor = false): Promise<void> {
    if (!resetCursor && expectedRevision !== null && state.revision < expectedRevision) throw new Error("Content snapshot cannot move the sync cursor backwards");
    await this.exclusive(async () => {
      const rows: Array<{ entity: string; id: string; value: unknown; position: number }> = [];
      state.parks.forEach((value, position) => rows.push({ entity: "park", id: value.id, value, position }));
      state.boundaries.features.forEach((value, position) => rows.push({ entity: "boundary", id: value.properties.id, value, position }));
      Object.entries(state.drive.parks).forEach(([id, value], position) => rows.push({ entity: "drive", id, value, position }));
      state.assets.forEach((value, position) => rows.push({ entity: "asset", id: value.path, value, position }));
      rows.push({ entity: "hubs", id: "default", value: state.drive.hubs, position: 0 });
      if (state.map) rows.push({ entity: "map", id: "default", value: state.map, position: 0 });
      const statements = [
        { statement: "INSERT INTO content_sync_guard(ok) SELECT CASE WHEN (? IS NULL AND NOT EXISTS (SELECT 1 FROM content_sync_cursors WHERE environment = ?)) OR EXISTS (SELECT 1 FROM content_sync_cursors WHERE environment = ? AND revision = ? AND source_id IS ?) THEN 1 ELSE 0 END", values: [expectedRevision, environment, environment, expectedRevision, expectedSourceId] },
        { statement: "DELETE FROM content_sync_guard", values: [] },
        { statement: "DELETE FROM content_sync_rows WHERE environment = ?", values: [environment] },
        ...rows.map((row) => ({
          statement: "INSERT OR REPLACE INTO content_sync_rows(environment, entity, row_id, position, value_json) VALUES(?, ?, ?, ?, ?)",
          values: [environment, row.entity, row.id, row.position, JSON.stringify(row.value)],
        })),
        ...(state.map ? [{ statement: "INSERT OR REPLACE INTO content_cached_maps(environment, pointer_json) VALUES(?, ?)", values: [environment, JSON.stringify(state.map)] }] : []),
        { statement: "INSERT OR REPLACE INTO content_sync_cursors(environment, revision, source_id) VALUES(?, ?, ?)", values: [environment, state.revision, sourceId] },
      ];
      await this.db().executeSet(statements, true);
    });
  }

  async applySyncBatch(environment: ContentEnvironment, expectedRevision: number, batch: ContentChangeBatch, sourceId: string): Promise<void> {
    await this.exclusive(async () => {
      if (batch.revision !== expectedRevision + 1) {
        throw new Error("Content sync cursor changed before the batch could be committed");
      }
      const statements: Array<{ statement: string; values: (string | number | null)[] }> = [
        { statement: "INSERT INTO content_sync_guard(ok) SELECT CASE WHEN EXISTS (SELECT 1 FROM content_sync_cursors WHERE environment = ? AND revision = ? AND source_id = ?) THEN 1 ELSE 0 END", values: [environment, expectedRevision, sourceId] },
        { statement: "DELETE FROM content_sync_guard", values: [] },
        ...batch.changes.flatMap((change) => {
        if (change.entity === "map" && change.op === "upsert" && change.value === null) return [{
          statement: "DELETE FROM content_sync_rows WHERE environment = ? AND entity = ? AND row_id = ?",
          values: [environment, change.entity, change.id],
        }];
        if (change.op === "delete") return [{
          statement: "DELETE FROM content_sync_rows WHERE environment = ? AND entity = ? AND row_id = ?",
          values: [environment, change.entity, change.id],
        }];
        const mutation = [{
          statement: "INSERT OR REPLACE INTO content_sync_rows(environment, entity, row_id, position, value_json) VALUES(?, ?, ?, COALESCE((SELECT position FROM content_sync_rows WHERE environment = ? AND entity = ? AND row_id = ?), (SELECT COALESCE(MAX(position), -1) + 1 FROM content_sync_rows WHERE environment = ? AND entity = ?)), ?)",
          values: [environment, change.entity, change.id, environment, change.entity, change.id, environment, change.entity, JSON.stringify(change.value)],
        }];
        if (change.entity === "map" && change.value) mutation.push({
          statement: "INSERT OR REPLACE INTO content_cached_maps(environment, pointer_json) VALUES(?, ?)",
          values: [environment, JSON.stringify(change.value)],
        });
        return mutation;
        }),
      ];
      statements.push({
        statement: "UPDATE content_sync_cursors SET revision = ? WHERE environment = ? AND revision = ? AND source_id = ?",
        values: [batch.revision, environment, expectedRevision, sourceId],
      });
      await this.db().executeSet(statements, true);
      const confirmed = await this.db().query("SELECT revision, source_id FROM content_sync_cursors WHERE environment = ?", [environment]);
      if (confirmed.values?.[0]?.revision !== batch.revision || confirmed.values?.[0]?.source_id !== sourceId) throw new Error("Content sync cursor was not advanced with its batch");
    });
  }

  async advanceSyncRevision(environment: ContentEnvironment, expectedRevision: number, revision: number, sourceId: string): Promise<void> {
    await this.exclusive(async () => {
      if (revision < expectedRevision) throw new Error("Content sync cursor cannot move backwards");
      await this.db().executeSet([
        { statement: "INSERT INTO content_sync_guard(ok) SELECT CASE WHEN EXISTS (SELECT 1 FROM content_sync_cursors WHERE environment = ? AND revision = ? AND source_id = ?) THEN 1 ELSE 0 END", values: [environment, expectedRevision, sourceId] },
        { statement: "DELETE FROM content_sync_guard", values: [] },
        { statement: "UPDATE content_sync_cursors SET revision = ? WHERE environment = ? AND revision = ? AND source_id = ?", values: [revision, environment, expectedRevision, sourceId] },
      ], true);
    });
  }

  async getMapInventory(version: string): Promise<ContentMapInventory | null> {
    const rows = await this.db().query("SELECT inventory_json FROM content_map_inventories WHERE version = ?", [version]);
    const value = rows.values?.[0]?.inventory_json;
    return typeof value === "string" ? JSON.parse(value) as ContentMapInventory : null;
  }

  async putMapInventory(inventory: ContentMapInventory): Promise<void> {
    await this.exclusive(async () => {
      await this.db().run(
        "INSERT OR REPLACE INTO content_map_inventories(version, inventory_json) VALUES(?, ?)",
        [inventory.version, JSON.stringify(inventory)],
      );
    });
  }

  async pruneMapInventories(keepVersions: readonly string[]): Promise<void> {
    await this.exclusive(async () => {
      const rows = (await this.db().query("SELECT version FROM content_map_inventories", [])).values ?? [];
      const keep = new Set(keepVersions);
      const stale = rows.map((row) => String(row.version)).filter((version) => !keep.has(version));
      if (stale.length) await this.db().executeSet(stale.map((version) => ({
        statement: "DELETE FROM content_map_inventories WHERE version = ?",
        values: [version],
      })), true);
    });
  }

  async getCachedMapPointer(environment: ContentEnvironment): Promise<ContentMapPointer | null> {
    const rows = await this.db().query("SELECT pointer_json FROM content_cached_maps WHERE environment = ?", [environment]);
    const value = rows.values?.[0]?.pointer_json;
    return typeof value === "string" ? JSON.parse(value) as ContentMapPointer : null;
  }

  async close(): Promise<void> {
    for (const url of this.objectUrls.values()) URL.revokeObjectURL(url);
    this.objectUrls.clear();
    if (this.sqlite && this.connection) {
      await this.sqlite.closeConnection(DATABASE, false);
      this.sqlite = null;
      this.connection = null;
      this.initializing = null;
    }
  }

  private async initializeInner() {
    const sqlite = new SQLiteConnection(CapacitorSQLite);
    const connection = await sqlite.createConnection(DATABASE, false, "no-encryption", 1, false);
    this.sqlite = sqlite;
    this.connection = connection;
    try {
      await connection.open();
      await connection.execute(`
        CREATE TABLE IF NOT EXISTS content_releases (
          id TEXT PRIMARY KEY NOT NULL,
          release_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS content_active (
          singleton TEXT PRIMARY KEY NOT NULL,
          release_id TEXT NULL
        );
        CREATE TABLE IF NOT EXISTS content_files (
          hash TEXT PRIMARY KEY NOT NULL,
          byte_size INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS content_retained_parks (
          park_id TEXT PRIMARY KEY NOT NULL,
          park_json TEXT NOT NULL,
          scene_file_json TEXT NULL
        );
        CREATE TABLE IF NOT EXISTS content_archived_scenes (
          release_id TEXT NOT NULL,
          scene TEXT NOT NULL,
          file_json TEXT NOT NULL,
          PRIMARY KEY(release_id, scene)
        );
        CREATE TABLE IF NOT EXISTS content_sync_rows (
          environment TEXT NOT NULL,
          entity TEXT NOT NULL,
          row_id TEXT NOT NULL,
          position INTEGER NOT NULL,
          value_json TEXT NOT NULL,
          PRIMARY KEY(environment, entity, row_id)
        );
        CREATE INDEX IF NOT EXISTS content_sync_rows_order ON content_sync_rows(environment, entity, position, row_id);
        CREATE TABLE IF NOT EXISTS content_sync_cursors (
          environment TEXT PRIMARY KEY NOT NULL,
          revision INTEGER NOT NULL,
          source_id TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS content_map_inventories (
          version TEXT PRIMARY KEY NOT NULL,
          inventory_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS content_cached_maps (
          environment TEXT PRIMARY KEY NOT NULL,
          pointer_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS content_sync_guard (
          ok INTEGER NOT NULL CHECK(ok = 1)
        );
        INSERT OR IGNORE INTO content_active(singleton, release_id) VALUES('${ACTIVE_POINTER}', NULL);
      `);
      const cursorColumns = await connection.query("PRAGMA table_info(content_sync_cursors)");
      if (!(cursorColumns.values ?? []).some((column) => column.name === "source_id")) {
        await connection.execute("ALTER TABLE content_sync_cursors ADD COLUMN source_id TEXT NOT NULL DEFAULT ''");
      }
      await this.ensureDirectory(TEMP);
      await this.removeInterruptedWrites();
    } catch (error) {
      await sqlite.closeConnection(DATABASE, false).catch(() => {});
      this.sqlite = null;
      this.connection = null;
      throw error;
    }
  }

  private db(): SQLiteDBConnection {
    if (!this.connection) throw new Error("Content store is not initialized");
    return this.connection;
  }

  private async recordFile(hash: string, size: number) {
    await this.db().run(
      "INSERT OR REPLACE INTO content_files(hash, byte_size) VALUES(?, ?)",
      [hash, size],
    );
  }

  private async writeNativeFile(hash: string, bytes: ArrayBuffer) {
    const finalPath = blobPath(hash);
    const temporaryPath = `${TEMP}/${hash}.${newToken()}.part`;
    await this.ensureDirectory(`${BLOBS}/${hash.slice(0, 2)}`);
    try {
      await Filesystem.writeFile({
        path: temporaryPath,
        data: toBase64(new Uint8Array(bytes)),
        directory: Directory.Data,
      });
      const temporaryBytes = await this.readNativeFile(temporaryPath);
      if (temporaryBytes.byteLength !== bytes.byteLength || (await sha256(temporaryBytes)) !== hash) {
        throw new Error("Temporary content file failed SHA-256 verification");
      }

      if (await this.fileExists(finalPath)) {
        const existing = await this.readNativeFile(finalPath);
        if (existing.byteLength === bytes.byteLength && (await sha256(existing)) === hash) {
          await Filesystem.deleteFile({ path: temporaryPath, directory: Directory.Data });
          await this.recordFile(hash, bytes.byteLength);
          return;
        }
        await Filesystem.deleteFile({ path: finalPath, directory: Directory.Data });
      }

      await Filesystem.rename({
        from: temporaryPath,
        to: finalPath,
        directory: Directory.Data,
        toDirectory: Directory.Data,
      });
      const installed = await this.readNativeFile(finalPath);
      if (installed.byteLength !== bytes.byteLength || (await sha256(installed)) !== hash) {
        await Filesystem.deleteFile({ path: finalPath, directory: Directory.Data }).catch(() => {});
        throw new Error("Installed content file failed SHA-256 verification");
      }
      await this.recordFile(hash, bytes.byteLength);
      this.revokeHashUrls(hash);
    } catch (error) {
      await Filesystem.deleteFile({ path: temporaryPath, directory: Directory.Data }).catch(() => {});
      throw error;
    }
  }

  private async readNativeFile(path: string): Promise<ArrayBuffer> {
    const result = await Filesystem.readFile({ path, directory: Directory.Data });
    if (typeof result.data !== "string") throw new Error("Native content file did not return binary data");
    return fromBase64(result.data);
  }

  private async fileExists(path: string): Promise<boolean> {
    try {
      await Filesystem.stat({ path, directory: Directory.Data });
      return true;
    } catch (error) {
      if (isMissingFile(error)) return false;
      throw error;
    }
  }

  private async ensureDirectory(path: string) {
    const previous = this.directoryQueue;
    let release!: () => void;
    this.directoryQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => {});
    try {
      let current = "";
      for (const segment of path.split("/").filter(Boolean)) {
        current = current ? `${current}/${segment}` : segment;
        if (this.knownDirectories.has(current)) continue;
        try {
          await Filesystem.mkdir({ path: current, directory: Directory.Data, recursive: false });
        } catch (error) {
          if (!isExistingDirectory(error)) throw error;
          // The plugin reports an existing path as an error. Confirm it is a directory,
          // since silently accepting a file at this path would only defer the failure.
          await Filesystem.readdir({ path: current, directory: Directory.Data });
        }
        this.knownDirectories.add(current);
      }
    } finally {
      release();
    }
  }

  private async removeInterruptedWrites() {
    let result;
    try {
      result = await Filesystem.readdir({ path: TEMP, directory: Directory.Data });
    } catch (error) {
      if (isMissingFile(error)) return;
      throw error;
    }
    for (const file of result.files) {
      if (file.type === "file" && /^[a-f\d]{64}\.[a-z\d-]+\.part$/i.test(file.name)) {
        await Filesystem.deleteFile({ path: `${TEMP}/${file.name}`, directory: Directory.Data });
      }
    }
  }

  private revokeHashUrls(hash: string) {
    for (const [key, url] of this.objectUrls) {
      if (key.startsWith(`${hash}\n`)) {
        URL.revokeObjectURL(url);
        this.objectUrls.delete(key);
      }
    }
  }

  private async withFileLock(hash: string, operation: () => Promise<void>) {
    const previous = this.writeLocks.get(hash) ?? Promise.resolve();
    const writing = previous.catch(() => {}).then(operation);
    this.writeLocks.set(hash, writing);
    try {
      await writing;
    } finally {
      if (this.writeLocks.get(hash) === writing) this.writeLocks.delete(hash);
    }
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationQueue;
    let release!: () => void;
    this.mutationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

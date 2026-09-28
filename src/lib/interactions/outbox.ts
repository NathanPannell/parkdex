import type { InteractionEvent } from "./types";

const DATABASE_NAME = "kip-interactions";
const DATABASE_VERSION = 1;
const META_STORE = "meta";
const OUTBOX_STORE = "outbox";
export const MAX_OUTBOX_EVENTS = 500;
export const MAX_OUTBOX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
export const INTERACTION_BATCH_SIZE = 50;
const INSTALLATION_KEY = "installationId";

export type QueuedInteraction = { event: InteractionEvent; queuedAt: number; order: number };

function makeUuid(): string {
  if (typeof crypto === "undefined" || typeof crypto.getRandomValues !== "function") {
    throw new Error("Secure random IDs are unavailable.");
  }
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID().toLowerCase();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function requestError(error: DOMException | null | undefined, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}

export class InteractionOutbox {
  constructor(private readonly factory: IDBFactory | undefined = typeof indexedDB === "undefined" ? undefined : indexedDB) {}

  private openDatabase(): Promise<IDBDatabase> {
    if (!this.factory) return Promise.reject(new Error("Interaction storage is unavailable."));
    return new Promise((resolve, reject) => {
      const request = this.factory!.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(META_STORE)) database.createObjectStore(META_STORE);
        if (!database.objectStoreNames.contains(OUTBOX_STORE)) {
          const outbox = database.createObjectStore(OUTBOX_STORE, { keyPath: "event.eventId" });
          outbox.createIndex("queuedAt", "queuedAt", { unique: false });
        }
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
      request.onerror = () => reject(requestError(request.error, "Interaction storage could not be opened."));
      request.onblocked = () => reject(new Error("Interaction storage is busy."));
    });
  }

  async getInstallationId(): Promise<string> {
    const database = await this.openDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction(META_STORE, "readwrite");
        const store = transaction.objectStore(META_STORE);
        const request = store.get(INSTALLATION_KEY);
        let installationId = "";
        request.onsuccess = () => {
          const saved = request.result;
          if (typeof saved === "string" && UUID_PATTERN.test(saved)) {
            installationId = saved.toLowerCase();
          } else {
            installationId = makeUuid();
            store.put(installationId, INSTALLATION_KEY);
          }
        };
        request.onerror = () => transaction.abort();
        transaction.oncomplete = () => resolve(installationId);
        transaction.onerror = () => reject(requestError(transaction.error, "Installation identity could not be saved."));
        transaction.onabort = () => reject(requestError(transaction.error, "Installation identity could not be saved."));
      });
    } finally {
      database.close();
    }
  }

  async enqueue(event: InteractionEvent, now = Date.now()): Promise<void> {
    const database = await this.openDatabase();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(OUTBOX_STORE, "readwrite");
        const store = transaction.objectStore(OUTBOX_STORE);
        const request = store.getAll();
        request.onsuccess = () => {
          const cutoff = now - MAX_OUTBOX_AGE_MS;
          const retained = (request.result as QueuedInteraction[])
            .filter((item) => Number.isFinite(item.queuedAt) && item.queuedAt >= cutoff)
            .sort((left, right) => left.queuedAt - right.queuedAt || left.order - right.order || left.event.eventId.localeCompare(right.event.eventId));
          for (const item of request.result as QueuedInteraction[]) {
            if (!Number.isFinite(item.queuedAt) || item.queuedAt < cutoff) store.delete(item.event.eventId);
          }
          const order = retained.reduce((max, item) => Math.max(max, Number.isFinite(item.order) ? item.order : 0), 0) + 1;
          store.add({ event, queuedAt: now, order } satisfies QueuedInteraction);
          retained.push({ event, queuedAt: now, order });
          while (retained.length > MAX_OUTBOX_EVENTS) {
            const dropped = retained.shift();
            if (dropped) store.delete(dropped.event.eventId);
          }
        };
        request.onerror = () => transaction.abort();
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(requestError(transaction.error, "Interaction could not be saved."));
        transaction.onabort = () => reject(requestError(transaction.error, "Interaction could not be saved."));
      });
    } finally {
      database.close();
    }
  }

  async nextBatch(now = Date.now()): Promise<QueuedInteraction[]> {
    const database = await this.openDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction(OUTBOX_STORE, "readwrite");
        const store = transaction.objectStore(OUTBOX_STORE);
        const request = store.getAll();
        let batch: QueuedInteraction[] = [];
        request.onsuccess = () => {
          const all = request.result as QueuedInteraction[];
          const cutoff = now - MAX_OUTBOX_AGE_MS;
          const retained = all.filter((item) => Number.isFinite(item.queuedAt) && item.queuedAt >= cutoff);
          for (const item of all) {
            if (!Number.isFinite(item.queuedAt) || item.queuedAt < cutoff) store.delete(item.event.eventId);
          }
          batch = retained.sort((left, right) => left.queuedAt - right.queuedAt || left.order - right.order || left.event.eventId.localeCompare(right.event.eventId))
            .slice(0, INTERACTION_BATCH_SIZE);
        };
        request.onerror = () => transaction.abort();
        transaction.oncomplete = () => resolve(batch);
        transaction.onerror = () => reject(requestError(transaction.error, "Pending interactions could not be read."));
        transaction.onabort = () => reject(requestError(transaction.error, "Pending interactions could not be read."));
      });
    } finally {
      database.close();
    }
  }

  async remove(eventIds: readonly string[]): Promise<void> {
    if (eventIds.length === 0) return;
    const database = await this.openDatabase();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(OUTBOX_STORE, "readwrite");
        const store = transaction.objectStore(OUTBOX_STORE);
        for (const eventId of eventIds) store.delete(eventId);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(requestError(transaction.error, "Pending interactions could not be updated."));
        transaction.onabort = () => reject(requestError(transaction.error, "Pending interactions could not be updated."));
      });
    } finally {
      database.close();
    }
  }

  async count(now = Date.now()): Promise<number> {
    const database = await this.openDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction(OUTBOX_STORE, "readonly");
        const request = transaction.objectStore(OUTBOX_STORE).count();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(requestError(request.error, "Pending interactions could not be counted."));
        transaction.onabort = () => reject(requestError(transaction.error, "Pending interactions could not be counted."));
      });
    } finally {
      database.close();
    }
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

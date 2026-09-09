import { describe, expect, it } from "vitest";
import type { KeyValueStore } from "./platform-storage";

import { IdentityEpoch, accountPendingKey, readStored, removeStored, toggledSet, writeRawStored, writeStored } from "./field-journal-state";

function memoryStorage(): KeyValueStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: async (key) => values.get(key) ?? null,
    removeItem: async (key) => { values.delete(key); },
    setItem: async (key, value) => { values.set(key, value); },
  };
}

describe("field journal state helpers", () => {
  it("guards responses from an earlier identity", () => {
    const epoch = new IdentityEpoch();
    const guestRequest = epoch.capture();
    epoch.advance();
    expect(epoch.isCurrent(guestRequest)).toBe(false);
    expect(epoch.isCurrent(epoch.capture())).toBe(true);
  });

  it("isolates persisted account outboxes by account and progress kind", () => {
    expect(accountPendingKey("one", "visits")).not.toBe(accountPendingKey("two", "visits"));
    expect(accountPendingKey("one", "visits")).not.toBe(accountPendingKey("one", "trails"));
  });

  it("performs item-level optimistic toggles without mutating an older snapshot", () => {
    const before = new Set(["one", "two"]);
    const { next, enabled } = toggledSet(before, "one");
    expect(enabled).toBe(false);
    expect([...before]).toEqual(["one", "two"]);
    expect([...next]).toEqual(["two"]);
  });

  it("contains unavailable or corrupt platform storage", async () => {
    const storage = memoryStorage();
    expect(await writeStored(storage, "progress", { ids: ["park"] })).toBe(true);
    expect(await readStored(storage, "progress", { ids: [] })).toEqual({ ids: ["park"] });
    storage.values.set("broken", "{");
    expect(await readStored(storage, "broken", [])).toEqual([]);
    expect(await removeStored(storage, "progress")).toBe(true);
    expect(await readStored(storage, "progress", null)).toBeNull();
    expect(await writeRawStored(storage, "token", "opaque-token")).toBe(true);
    expect(await storage.getItem("token")).toBe("opaque-token");
    expect(await readStored(storage, "token", "")).toBe("opaque-token");

    const unavailable = {
      async getItem() { throw new Error("blocked"); },
      async setItem() { throw new Error("blocked"); },
      async removeItem() { throw new Error("blocked"); },
    };
    expect(await readStored(unavailable, "x", ["safe"])).toEqual(["safe"]);
    expect(await writeStored(unavailable, "x", [])).toBe(false);
    expect(await removeStored(unavailable, "x")).toBe(false);
  });
});

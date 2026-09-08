import { describe, expect, it } from "vitest";

import { IdentityEpoch, accountPendingKey, readStored, removeStored, toggledSet, writeRawStored, writeStored } from "./field-journal-state";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
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

  it("contains unavailable or corrupt browser storage", () => {
    const storage = memoryStorage();
    expect(writeStored(storage, "progress", { ids: ["park"] })).toBe(true);
    expect(readStored(storage, "progress", { ids: [] })).toEqual({ ids: ["park"] });
    storage.setItem("broken", "{");
    expect(readStored(storage, "broken", [])).toEqual([]);
    expect(removeStored(storage, "progress")).toBe(true);
    expect(readStored(storage, "progress", null)).toBeNull();
    expect(writeRawStored(storage, "token", "opaque-token")).toBe(true);
    expect(storage.getItem("token")).toBe("opaque-token");
    expect(readStored(storage, "token", "")).toBe("opaque-token");

    const unavailable = {
      getItem() { throw new Error("blocked"); },
      setItem() { throw new Error("blocked"); },
      removeItem() { throw new Error("blocked"); },
    };
    expect(readStored(unavailable, "x", ["safe"])).toEqual(["safe"]);
    expect(writeStored(unavailable, "x", [])).toBe(false);
    expect(removeStored(unavailable, "x")).toBe(false);
  });
});

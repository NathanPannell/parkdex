import { describe, expect, it } from "vitest";

import {
  GUEST_MIGRATION_KEYS,
  GUEST_MIGRATION_MAX_BYTES,
  GUEST_MIGRATION_ORIGIN_PAIRS,
  GUEST_MIGRATION_TRANSFER_TYPE,
  guestMigrationPairForAppOrigin,
  receiveGuestMigrationMessage,
} from "./guest-migration";

function makeStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    values,
  };
}

const opener = {};
const sourceOrigin = "https://parkdex.app";
const appOrigin = "https://web.parkdex.app";

function transfer(values: Record<string, string>) {
  return { type: GUEST_MIGRATION_TRANSFER_TYPE, version: 1, values };
}

function receive(payload: unknown, storage = makeStorage(), options: { origin?: string; source?: unknown } = {}) {
  return receiveGuestMigrationMessage({
    origin: options.origin ?? sourceOrigin,
    source: options.source ?? opener,
    expectedOrigin: sourceOrigin,
    expectedSource: opener,
    payload,
    storage,
  });
}

describe("guest progress migration receiver", () => {
  it("pairs the production and staging app origins with their exact legacy origins", () => {
    expect(GUEST_MIGRATION_ORIGIN_PAIRS).toEqual([
      { sourceOrigin: "https://parkdex.app", targetOrigin: "https://web.parkdex.app" },
      { sourceOrigin: "https://staging.parkdex.app", targetOrigin: "https://staging.web.parkdex.app" },
    ]);
    expect(guestMigrationPairForAppOrigin(appOrigin)?.sourceOrigin).toBe(sourceOrigin);
    expect(guestMigrationPairForAppOrigin("https://web.evil.example")).toBeNull();
  });

  it("imports only allowlisted guest state after matching both the exact origin and opener", () => {
    const storage = makeStorage();
    const payload = transfer({
      "every-park:collection-key:v1": "guest-key",
      "every-park:visited:v1": '["park-one"]',
      "every-park:visit-timestamps:v1": '{"park-one":"2026-09-01T12:00:00Z"}',
      "every-park:visit-metadata:v1": '{"park-one":{"visitedAt":"2026-09-01T12:00:00Z"}}',
      "every-park:trails:v1": '["trail-one"]',
      "every-park:pending:v1": "{}",
      "every-park:trail-pending:v1": "{}",
      "every-park:guest-revision:v1": "4",
    });

    const result = receive(payload, storage);

    expect(result).toMatchObject({ status: "imported" });
    expect(result.keys).toHaveLength(8);
    for (const [key, value] of Object.entries(payload.values)) {
      expect(storage.getItem(key)).toBe(value);
    }
  });

  it("ignores messages from another origin or another window", () => {
    const storage = makeStorage();
    const payload = transfer({ "every-park:collection-key:v1": "guest-key" });

    expect(receive(payload, storage, { origin: "https://evil.example" }).status).toBe("ignored");
    expect(receive(payload, storage, { source: {} }).status).toBe("ignored");
    expect(storage.getItem("every-park:collection-key:v1")).toBeNull();
  });

  it("reuses a freshly initialized destination identity when its persisted guest shell is empty", () => {
    const storage = makeStorage({
      "every-park:collection-key:v1": "d".repeat(43),
      "every-park:visited:v1": "[]",
      "every-park:visit-timestamps:v1": "{}",
      "every-park:visit-metadata:v1": "{}",
      "every-park:trails:v1": "[]",
      "every-park:pending:v1": "{}",
      "every-park:trail-pending:v1": "{}",
    });

    const result = receive(transfer({
      "every-park:collection-key:v1": "s".repeat(43),
      "every-park:visited:v1": '["old-park"]',
    }), storage);

    expect(result.status).toBe("imported");
    expect(storage.getItem("every-park:collection-key:v1")).toBe("s".repeat(43));
    expect(storage.getItem("every-park:visited:v1")).toBe('["old-park"]');
  });

  it("rejects account credentials, unknown keys, malformed versions, and oversized messages", () => {
    expect(receive(transfer({ "every-park:account-token:v1": "secret" })).status).toBe("invalid");
    expect(receive(transfer({ "every-park:collection-key:v1": "key", unexpected: "value" })).status).toBe("invalid");
    expect(receive({ ...transfer({ "every-park:collection-key:v1": "key" }), version: 2 }).status).toBe("invalid");

    const tooLarge = "x".repeat(GUEST_MIGRATION_MAX_BYTES);
    expect(receive(transfer({ "every-park:visit-metadata:v1": tooLarge })).status).toBe("oversized");
    expect(GUEST_MIGRATION_KEYS).not.toContain("every-park:account-token:v1" as never);
  });

  it("preserves existing destination guest state and reports a conflict", () => {
    const storage = makeStorage({ "every-park:visited:v1": '["new-park"]' });

    const result = receive(transfer({ "every-park:collection-key:v1": "old-key" }), storage);

    expect(result.status).toBe("conflict");
    expect(storage.getItem("every-park:visited:v1")).toBe('["new-park"]');
    expect(storage.getItem("every-park:collection-key:v1")).toBeNull();
  });

  it("keeps a destination identity if its revision proves prior guest use even after progress was undone", () => {
    const storage = makeStorage({
      "every-park:collection-key:v1": "d".repeat(43),
      "every-park:visited:v1": "[]",
      "every-park:trails:v1": "[]",
      "every-park:guest-revision:v1": "2",
    });

    const result = receive(transfer({ "every-park:collection-key:v1": "s".repeat(43) }), storage);

    expect(result.status).toBe("conflict");
    expect(storage.getItem("every-park:collection-key:v1")).toBe("d".repeat(43));
  });

  it("treats malformed destination snapshots as conflicts instead of assuming they are empty", () => {
    const storage = makeStorage({
      "every-park:collection-key:v1": "d".repeat(43),
      "every-park:visited:v1": "not-json",
    });

    const result = receive(transfer({ "every-park:collection-key:v1": "s".repeat(43) }), storage);

    expect(result.status).toBe("conflict");
    expect(storage.getItem("every-park:collection-key:v1")).toBe("d".repeat(43));
  });

  it("rolls back partial writes when the browser storage write cannot be verified", () => {
    const storage = makeStorage();
    let writes = 0;
    const failing = {
      ...storage,
      setItem(key: string, value: string) {
        writes += 1;
        if (writes === 2) throw new Error("quota exceeded");
        storage.setItem(key, value);
      },
    };

    const result = receive(transfer({
      "every-park:collection-key:v1": "old-key",
      "every-park:visited:v1": '["park"]',
    }), failing);

    expect(result.status).toBe("storage-error");
    expect(storage.getItem("every-park:collection-key:v1")).toBeNull();
    expect(storage.getItem("every-park:visited:v1")).toBeNull();
  });
});

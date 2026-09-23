import { describe, expect, it, vi } from "vitest";

import {
  GUEST_MIGRATION_KEYS,
  GUEST_MIGRATION_MAX_BYTES,
  GUEST_MIGRATION_ORIGIN_PAIRS,
  GUEST_MIGRATION_TRANSFER_TYPE,
  fetchRemoteGuestProgress,
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

function receive(payload: unknown, storage = makeStorage(), options: { origin?: string; source?: unknown; checkRemoteProgress?: (key: string) => Promise<boolean> } = {}) {
  return receiveGuestMigrationMessage({
    origin: options.origin ?? sourceOrigin,
    source: options.source ?? opener,
    expectedOrigin: sourceOrigin,
    expectedSource: opener,
    payload,
    storage,
    checkRemoteProgress: options.checkRemoteProgress,
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

  it("imports only allowlisted guest state after matching both the exact origin and opener", async () => {
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

    const result = await receive(payload, storage);

    expect(result).toMatchObject({ status: "imported" });
    expect(result.keys).toHaveLength(8);
    for (const [key, value] of Object.entries(payload.values)) {
      expect(storage.getItem(key)).toBe(value);
    }
  });

  it("ignores messages from another origin or another window", async () => {
    const storage = makeStorage();
    const payload = transfer({ "every-park:collection-key:v1": "guest-key" });

    expect((await receive(payload, storage, { origin: "https://evil.example" })).status).toBe("ignored");
    expect((await receive(payload, storage, { source: {} })).status).toBe("ignored");
    expect(storage.getItem("every-park:collection-key:v1")).toBeNull();
  });

  it("reuses a freshly initialized destination identity when its local and remote guest state are empty", async () => {
    const storage = makeStorage({
      "every-park:collection-key:v1": "d".repeat(43),
      "every-park:visited:v1": "[]",
      "every-park:visit-timestamps:v1": "{}",
      "every-park:visit-metadata:v1": "{}",
      "every-park:trails:v1": "[]",
      "every-park:pending:v1": "{}",
      "every-park:trail-pending:v1": "{}",
    });

    const checkRemoteProgress = vi.fn(async () => false);
    const result = await receive(transfer({
      "every-park:collection-key:v1": "s".repeat(43),
      "every-park:visited:v1": '["old-park"]',
    }), storage, { checkRemoteProgress });

    expect(result.status).toBe("imported");
    expect(checkRemoteProgress).toHaveBeenCalledWith("d".repeat(43));
    expect(storage.getItem("every-park:collection-key:v1")).toBe("s".repeat(43));
    expect(storage.getItem("every-park:visited:v1")).toBe('["old-park"]');
  });

  it("preserves an empty local shell when the destination collection key has remote progress", async () => {
    const storage = makeStorage({
      "every-park:collection-key:v1": "d".repeat(43),
      "every-park:visited:v1": "[]",
      "every-park:visit-timestamps:v1": "{}",
      "every-park:visit-metadata:v1": "{}",
      "every-park:trails:v1": "[]",
      "every-park:pending:v1": "{}",
      "every-park:trail-pending:v1": "{}",
    });
    const checkRemoteProgress = vi.fn(async () => true);

    const result = await receive(transfer({
      "every-park:collection-key:v1": "s".repeat(43),
      "every-park:visited:v1": '["old-park"]',
    }), storage, { checkRemoteProgress });

    expect(result.status).toBe("conflict");
    expect(checkRemoteProgress).toHaveBeenCalledWith("d".repeat(43));
    expect(storage.getItem("every-park:collection-key:v1")).toBe("d".repeat(43));
    expect(storage.getItem("every-park:visited:v1")).toBe("[]");
  });

  it("fails closed and preserves the destination key when remote progress cannot be checked", async () => {
    const storage = makeStorage({ "every-park:collection-key:v1": "d".repeat(43) });
    const checkRemoteProgress = vi.fn(async () => { throw new Error("API unavailable"); });

    const result = await receive(transfer({ "every-park:collection-key:v1": "s".repeat(43) }), storage, { checkRemoteProgress });

    expect(result.status).toBe("conflict");
    expect(checkRemoteProgress).toHaveBeenCalledWith("d".repeat(43));
    expect(storage.getItem("every-park:collection-key:v1")).toBe("d".repeat(43));
  });

  it("rechecks local state after the remote probe before replacing the key", async () => {
    const storage = makeStorage({ "every-park:collection-key:v1": "d".repeat(43) });
    const checkRemoteProgress = vi.fn(async () => {
      storage.setItem("every-park:visited:v1", '["new-park"]');
      return false;
    });

    const result = await receive(transfer({ "every-park:collection-key:v1": "s".repeat(43) }), storage, { checkRemoteProgress });

    expect(result.status).toBe("conflict");
    expect(storage.getItem("every-park:collection-key:v1")).toBe("d".repeat(43));
    expect(storage.getItem("every-park:visited:v1")).toBe('["new-park"]');
  });

  it("checks the destination API with the existing collection key and reports remote visits or trails", async () => {
    const key = "d".repeat(43);
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(new URL(String(input)).href).toBe("https://api-production.example/api/guest/progress-state");
      expect(init?.method).toBe("GET");
      expect(new Headers(init?.headers).get("X-Collection-Key")).toBe(key);
      expect(init?.cache).toBe("no-store");
      expect(init?.credentials).toBe("omit");
      return new Response(JSON.stringify({ hasProgress: true }));
    });

    await expect(fetchRemoteGuestProgress("https://api-production.example", appOrigin, key, fetcher)).resolves.toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("uses the static app's same-origin API route and rejects unavailable or malformed API responses", async () => {
    const key = "d".repeat(43);
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      expect(new URL(String(input)).href).toBe("https://web.parkdex.app/api/guest/progress-state");
      return new Response(JSON.stringify({ hasProgress: false }));
    });

    await expect(fetchRemoteGuestProgress(".", appOrigin, key, fetcher)).resolves.toBe(false);
    await expect(fetchRemoteGuestProgress("", appOrigin, key, fetcher)).rejects.toThrow(/not configured/);
    await expect(fetchRemoteGuestProgress("https://api-production.example", appOrigin, key, async () => new Response("offline", { status: 503 }))).rejects.toThrow(/could not confirm/);
    await expect(fetchRemoteGuestProgress("https://api-production.example", appOrigin, key, async () => new Response("{}"))).rejects.toThrow(/invalid guest progress response/);
  });

  it("rejects account credentials, unknown keys, malformed versions, and oversized messages", async () => {
    expect((await receive(transfer({ "every-park:account-token:v1": "secret" }))).status).toBe("invalid");
    expect((await receive(transfer({ "every-park:collection-key:v1": "key", unexpected: "value" }))).status).toBe("invalid");
    expect((await receive({ ...transfer({ "every-park:collection-key:v1": "key" }), version: 2 })).status).toBe("invalid");

    const tooLarge = "x".repeat(GUEST_MIGRATION_MAX_BYTES);
    expect((await receive(transfer({ "every-park:visit-metadata:v1": tooLarge }))).status).toBe("oversized");
    expect(GUEST_MIGRATION_KEYS).not.toContain("every-park:account-token:v1" as never);
  });

  it("preserves existing destination guest state and reports a conflict", async () => {
    const storage = makeStorage({ "every-park:visited:v1": '["new-park"]' });

    const result = await receive(transfer({ "every-park:collection-key:v1": "old-key" }), storage);

    expect(result.status).toBe("conflict");
    expect(storage.getItem("every-park:visited:v1")).toBe('["new-park"]');
    expect(storage.getItem("every-park:collection-key:v1")).toBeNull();
  });

  it("keeps a destination identity if its revision proves prior guest use even after progress was undone", async () => {
    const storage = makeStorage({
      "every-park:collection-key:v1": "d".repeat(43),
      "every-park:visited:v1": "[]",
      "every-park:trails:v1": "[]",
      "every-park:guest-revision:v1": "2",
    });

    const result = await receive(transfer({ "every-park:collection-key:v1": "s".repeat(43) }), storage);

    expect(result.status).toBe("conflict");
    expect(storage.getItem("every-park:collection-key:v1")).toBe("d".repeat(43));
  });

  it("treats malformed destination snapshots as conflicts instead of assuming they are empty", async () => {
    const storage = makeStorage({
      "every-park:collection-key:v1": "d".repeat(43),
      "every-park:visited:v1": "not-json",
    });

    const result = await receive(transfer({ "every-park:collection-key:v1": "s".repeat(43) }), storage);

    expect(result.status).toBe("conflict");
    expect(storage.getItem("every-park:collection-key:v1")).toBe("d".repeat(43));
  });

  it("rolls back partial writes when the browser storage write cannot be verified", async () => {
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

    const result = await receive(transfer({
      "every-park:collection-key:v1": "old-key",
      "every-park:visited:v1": '["park"]',
    }), failing);

    expect(result.status).toBe("storage-error");
    expect(storage.getItem("every-park:collection-key:v1")).toBeNull();
    expect(storage.getItem("every-park:visited:v1")).toBeNull();
  });
});

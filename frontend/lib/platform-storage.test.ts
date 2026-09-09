// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getPlatformStorage,
  registerNativePlatformStorage,
  resetPlatformStorageForTests,
  type KeyValueStore,
} from "./platform-storage";

function memoryStore(initial: Record<string, string> = {}): KeyValueStore & { values: Map<string, string> } {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: vi.fn(async (key) => values.get(key) ?? null),
    setItem: vi.fn(async (key, value) => { values.set(key, value); }),
    removeItem: vi.fn(async (key) => { values.delete(key); }),
  };
}

function setNative(native: boolean) {
  Object.defineProperty(globalThis, "Capacitor", {
    configurable: true,
    value: { isNativePlatform: () => native },
  });
}

afterEach(() => {
  resetPlatformStorageForTests();
  window.localStorage.clear();
  window.sessionStorage.clear();
  Reflect.deleteProperty(globalThis, "Capacitor");
});

describe("platform storage", () => {
  it("preserves browser localStorage keys and raw values", async () => {
    const storage = await getPlatformStorage();
    await storage.setItem("every-park:visited:v1", '["park"]');

    expect(window.localStorage.getItem("every-park:visited:v1")).toBe('["park"]');
    expect(await storage.getItem("every-park:visited:v1")).toBe('["park"]');
    await storage.setItem("parkdex:google-code-verifier:v1", "verifier");
    expect(window.sessionStorage.getItem("parkdex:google-code-verifier:v1")).toBe("verifier");
    expect(window.localStorage.getItem("parkdex:google-code-verifier:v1")).toBeNull();
    await storage.removeItem("every-park:visited:v1");
    expect(window.localStorage.getItem("every-park:visited:v1")).toBeNull();
  });

  it("fails closed when native storage was not registered", async () => {
    setNative(true);
    window.localStorage.setItem("every-park:account-token:v1", "raw-token");

    await expect(getPlatformStorage()).rejects.toThrow("not registered");
    expect(window.localStorage.getItem("every-park:account-token:v1")).toBe("raw-token");
  });

  it("allows native initialization to retry after a failure", async () => {
    setNative(true);
    const credentials = memoryStore();
    const journal = memoryStore();
    let attempts = 0;
    registerNativePlatformStorage(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("storage unavailable");
      return { credentials, journal };
    });

    await expect(getPlatformStorage()).rejects.toThrow("storage unavailable");
    await expect(getPlatformStorage()).resolves.toBeDefined();
    expect(attempts).toBe(2);
  });

  it("migrates credentials before journal data and removes verified legacy values", async () => {
    setNative(true);
    const credentials = memoryStore();
    const journal = memoryStore();
    const order: string[] = [];
    vi.mocked(credentials.setItem).mockImplementation(async (key, value) => { order.push(`credential:${key}`); credentials.values.set(key, value); });
    vi.mocked(journal.setItem).mockImplementation(async (key, value) => { order.push(`journal:${key}`); journal.values.set(key, value); });
    window.localStorage.setItem("every-park:account-token:v1", "raw-token");
    window.localStorage.setItem("every-park:collection-key:v1", "guest-key");
    window.sessionStorage.setItem("parkdex:google-code-verifier:v1", "pkce-verifier");
    window.localStorage.setItem("every-park:visited:v1", '["park"]');
    window.localStorage.setItem("unrelated", "keep");
    registerNativePlatformStorage(async () => ({ credentials, journal }));

    const storage = await getPlatformStorage();

    expect(order).toEqual([
      "credential:every-park:account-token:v1",
      "credential:every-park:collection-key:v1",
      "credential:parkdex:google-code-verifier:v1",
      "journal:every-park:visited:v1",
    ]);
    expect(await storage.getItem("every-park:account-token:v1")).toBe("raw-token");
    expect(await storage.getItem("parkdex:google-code-verifier:v1")).toBe("pkce-verifier");
    expect(await storage.getItem("every-park:visited:v1")).toBe('["park"]');
    expect(window.localStorage.getItem("every-park:account-token:v1")).toBeNull();
    expect(window.localStorage.getItem("every-park:visited:v1")).toBeNull();
    expect(window.sessionStorage.getItem("parkdex:google-code-verifier:v1")).toBeNull();
    expect(window.localStorage.getItem("unrelated")).toBe("keep");
  });

  it("keeps a legacy credential when secure migration cannot be verified", async () => {
    setNative(true);
    const credentials = memoryStore();
    const journal = memoryStore();
    vi.mocked(credentials.getItem).mockResolvedValue(null);
    window.localStorage.setItem("every-park:account-token:v1", "raw-token");
    registerNativePlatformStorage(async () => ({ credentials, journal }));

    await expect(getPlatformStorage()).rejects.toThrow("Could not verify");
    expect(window.localStorage.getItem("every-park:account-token:v1")).toBe("raw-token");
  });

  it("does not overwrite a newer native value during repeated migration", async () => {
    setNative(true);
    const credentials = memoryStore({ "every-park:account-token:v1": "native-token" });
    const journal = memoryStore();
    window.localStorage.setItem("every-park:account-token:v1", "legacy-token");
    registerNativePlatformStorage(async () => ({ credentials, journal }));

    const storage = await getPlatformStorage();

    expect(await storage.getItem("every-park:account-token:v1")).toBe("native-token");
    expect(credentials.setItem).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("every-park:account-token:v1")).toBeNull();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { ALWAYS_TRACKS, rememberWebLocation, tracksLocation, WEB_CAN_TRACK, webLocationAllowed } from "./liveLocation";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

describe("live location", () => {
  it("keeps the demo spot in dev builds, which have demo tools", () => {
    // Vitest runs as a dev build: no field mode, no native shell, demo tools on.
    expect(ALWAYS_TRACKS).toBe(false);
    expect(WEB_CAN_TRACK).toBe(false);
    expect(tracksLocation(true)).toBe(false);
  });

  it("remembers and forgets the player's choice", () => {
    const storage = memoryStorage();
    rememberWebLocation(true, storage);
    expect(storage.getItem("parkdex-web-location-v1")).toBe("1");
    // Dev builds never track, so the stored choice reads as off here.
    expect(webLocationAllowed(storage)).toBe(false);
    rememberWebLocation(false, storage);
    expect(storage.getItem("parkdex-web-location-v1")).toBeNull();
  });
});

describe("live location in the hosted web app", () => {
  afterEach(() => {
    vi.doUnmock("./demo");
    vi.doUnmock("./native");
  });

  it("follows the player only after they allow location", async () => {
    vi.resetModules();
    vi.doMock("./demo", () => ({ DEMO_TOOLS: false }));
    vi.doMock("./native", () => ({ FIELD: false, isNative: false }));
    const hosted = await import("./liveLocation");
    expect(hosted.WEB_CAN_TRACK).toBe(true);
    expect(hosted.tracksLocation(false)).toBe(false);
    expect(hosted.tracksLocation(true)).toBe(true);
    const storage = memoryStorage();
    hosted.rememberWebLocation(true, storage);
    expect(hosted.webLocationAllowed(storage)).toBe(true);
  });
});

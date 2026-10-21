import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearLocalHandle, saveLocalHandle } from "../game/localHandle";
import { nativeSessionNeedsRenewal } from "./AuthProvider";
import { allowGuestStart, startGuestForLocalHandle } from "./guestStart";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
    clear: () => values.clear(),
    key: () => null,
    length: 0,
  } as Storage;
}

describe("starting a guest account for the onboarding handle", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", memoryStorage());
    allowGuestStart();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens one guest account when a handle is waiting and nobody is signed in", async () => {
    saveLocalHandle("fern_walker");
    const startGuest = vi.fn(async () => ({}));
    const auth = { phase: "guest", config: {}, startGuest };
    const work = startGuestForLocalHandle(auth);
    expect(startGuestForLocalHandle(auth)).toBeNull();
    await work;
    expect(startGuest).toHaveBeenCalledTimes(1);
  });

  it("waits without a handle, while signed in, or before the account service answers", () => {
    const startGuest = vi.fn(async () => ({}));
    expect(startGuestForLocalHandle({ phase: "guest", config: {}, startGuest })).toBeNull();
    saveLocalHandle("fern_walker");
    expect(startGuestForLocalHandle({ phase: "authenticated", config: {}, startGuest })).toBeNull();
    expect(startGuestForLocalHandle({ phase: "guest", config: null, startGuest })).toBeNull();
    expect(startGuest).not.toHaveBeenCalled();
    clearLocalHandle();
  });

  it("tries once per launch, and again only after onboarding saves a new handle", async () => {
    saveLocalHandle("fern_walker");
    const startGuest = vi.fn(async () => {
      throw new Error("rate limited");
    });
    const auth = { phase: "guest", config: {}, startGuest };
    await startGuestForLocalHandle(auth);
    expect(startGuestForLocalHandle(auth)).toBeNull();
    allowGuestStart();
    expect(startGuestForLocalHandle(auth)).not.toBeNull();
    expect(startGuest).toHaveBeenCalledTimes(2);
  });
});

describe("when the phone renews its session", () => {
  const day = 24 * 60 * 60 * 1000;

  it("renews an account in its last week, and catches up an upgraded guest's long expiry", () => {
    expect(nativeSessionNeedsRenewal(20 * day, false)).toBe(false);
    expect(nativeSessionNeedsRenewal(6 * day, false)).toBe(true);
    expect(nativeSessionNeedsRenewal(300 * day, false)).toBe(true);
  });

  it("renews a guest once its year-long session is a month old", () => {
    expect(nativeSessionNeedsRenewal(360 * day, true)).toBe(false);
    expect(nativeSessionNeedsRenewal(330 * day, true)).toBe(true);
  });
});

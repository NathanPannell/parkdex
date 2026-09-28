import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  native: false,
  connectivity: { connected: true, wifi: false },
  listener: null as ((connectivity: { connected: boolean; wifi: boolean }) => void) | null,
  getConnectivity: vi.fn(async () => mocks.connectivity),
  subscribe: vi.fn((listener: (connectivity: { connected: boolean; wifi: boolean }) => void) => {
    mocks.listener = listener;
    return vi.fn();
  }),
}));

vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => mocks.native } }));
vi.mock("../content/transport", () => ({
  getContentConnectivity: mocks.getConnectivity,
  subscribeContentConnectivity: mocks.subscribe,
}));

import {
  getAccountBackupConnectivity,
  isAccountBackupAvailable,
  mapAccountBackupConnectivity,
  subscribeAccountBackupConnectivity,
} from "./accountBackupConnectivity";

describe("account backup connectivity policy", () => {
  beforeEach(() => {
    mocks.native = false;
    mocks.connectivity = { connected: true, wifi: false };
    mocks.listener = null;
    mocks.getConnectivity.mockImplementation(async () => mocks.connectivity);
    mocks.subscribe.mockClear();
  });

  it("allows browser backups on any connected network, including unknown or cellular type", async () => {
    expect(mapAccountBackupConnectivity({ connected: true, wifi: false }, false)).toEqual({ connected: true, allowed: true });
    await expect(getAccountBackupConnectivity()).resolves.toEqual({ connected: true, allowed: true });
    await expect(isAccountBackupAvailable()).resolves.toBe(true);
  });

  it("blocks browser backups while offline", async () => {
    mocks.connectivity = { connected: false, wifi: false };
    await expect(getAccountBackupConnectivity()).resolves.toEqual({ connected: false, allowed: false });
    await expect(isAccountBackupAvailable()).resolves.toBe(false);
  });

  it("requires confirmed Wi-Fi on native platforms and reports the connected-but-paused state", async () => {
    mocks.native = true;
    expect(mapAccountBackupConnectivity({ connected: true, wifi: true })).toEqual({ connected: true, allowed: true });
    expect(mapAccountBackupConnectivity({ connected: true, wifi: false })).toEqual({ connected: true, allowed: false });
    await expect(isAccountBackupAvailable({ connected: true, wifi: false })).resolves.toBe(false);
  });

  it("notifies subscribers with the mapped native availability", () => {
    mocks.native = true;
    const listener = vi.fn();
    const unsubscribe = subscribeAccountBackupConnectivity(listener);

    mocks.listener?.({ connected: true, wifi: false });

    expect(listener).toHaveBeenCalledWith({ connected: true, allowed: false });
    unsubscribe();
  });

  it("fails closed if connectivity cannot be read", async () => {
    mocks.getConnectivity.mockRejectedValueOnce(new Error("network status unavailable"));
    await expect(isAccountBackupAvailable()).resolves.toBe(false);
  });
});

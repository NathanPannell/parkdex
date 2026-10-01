import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connectivity: { connected: true, wifi: false },
  listener: null as ((connectivity: { connected: boolean; wifi: boolean }) => void) | null,
  getConnectivity: vi.fn(async () => mocks.connectivity),
  subscribe: vi.fn((listener: (connectivity: { connected: boolean; wifi: boolean }) => void) => {
    mocks.listener = listener;
    return vi.fn();
  }),
}));

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
    mocks.connectivity = { connected: true, wifi: false };
    mocks.listener = null;
    mocks.getConnectivity.mockImplementation(async () => mocks.connectivity);
    mocks.subscribe.mockClear();
  });

  it("allows backup on any connected network regardless of the Wi-Fi marker", async () => {
    expect(mapAccountBackupConnectivity({ connected: true, wifi: false })).toEqual({ connected: true, allowed: true });
    expect(mapAccountBackupConnectivity({ connected: true, wifi: true })).toEqual({ connected: true, allowed: true });
    await expect(getAccountBackupConnectivity()).resolves.toEqual({ connected: true, allowed: true });
    await expect(isAccountBackupAvailable()).resolves.toBe(true);
  });

  it("blocks backup while offline", async () => {
    mocks.connectivity = { connected: false, wifi: false };
    await expect(getAccountBackupConnectivity()).resolves.toEqual({ connected: false, allowed: false });
    await expect(isAccountBackupAvailable()).resolves.toBe(false);
  });

  it("notifies subscribers with the mapped connected availability", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeAccountBackupConnectivity(listener);

    mocks.listener?.({ connected: true, wifi: false });

    expect(listener).toHaveBeenCalledWith({ connected: true, allowed: true });
    unsubscribe();
  });

  it("fails closed if connectivity cannot be read", async () => {
    mocks.getConnectivity.mockRejectedValueOnce(new Error("network status unavailable"));
    await expect(isAccountBackupAvailable()).resolves.toBe(false);
  });
});

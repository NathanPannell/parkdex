// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getNativeCapabilities,
  LocationCapabilityError,
  registerNativeCapabilities,
  type NativeCapabilities,
} from "./native-capabilities";

function provider(latitude: number): NativeCapabilities {
  return {
    getCurrentLocation: vi.fn(async () => ({
      latitude,
      longitude: -123,
      accuracyMeters: 10,
      capturedAtEpochMs: 1,
    })),
    getPhoto: vi.fn(async () => null),
  };
}

afterEach(() => {
  Reflect.deleteProperty(navigator, "geolocation");
});

describe("native capability facade", () => {
  it("does not let an older cleanup unregister a newer provider", () => {
    const first = provider(1);
    const second = provider(2);
    const unregisterFirst = registerNativeCapabilities(first);
    const unregisterSecond = registerNativeCapabilities(second);

    unregisterFirst();
    expect(getNativeCapabilities()).toBe(second);
    unregisterSecond();
    expect(getNativeCapabilities()).not.toBe(first);
    expect(getNativeCapabilities()).not.toBe(second);
  });

  it("maps browser coordinates and request options into the shared shape", async () => {
    const getCurrentPosition = vi.fn((
      success: PositionCallback,
      error?: PositionErrorCallback | null,
      options?: PositionOptions,
    ) => {
      void error;
      void options;
      success({
      coords: { latitude: 48, longitude: -123, accuracy: 7 },
      timestamp: 1234,
      } as GeolocationPosition);
    });
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: { getCurrentPosition },
    });

    await expect(getNativeCapabilities().getCurrentLocation({
      highAccuracy: true,
      timeoutMs: 12_000,
      maxAgeMs: 60_000,
    })).resolves.toEqual({
      latitude: 48,
      longitude: -123,
      accuracyMeters: 7,
      capturedAtEpochMs: 1234,
    });
    expect(getCurrentPosition).toHaveBeenCalledWith(expect.any(Function), expect.any(Function), {
      enableHighAccuracy: true,
      timeout: 12_000,
      maximumAge: 60_000,
    });
  });

  it("returns a typed unavailable error when browser location is absent", async () => {
    await expect(getNativeCapabilities().getCurrentLocation({
      highAccuracy: true,
      timeoutMs: 1,
      maxAgeMs: 0,
    })).rejects.toBeInstanceOf(LocationCapabilityError);
  });
});

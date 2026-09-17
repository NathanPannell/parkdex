// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "./account";
import type { ClaimRecommendation } from "./claims-client";
import { LocationCapabilityError, NATIVE_APP_STATE_EVENT, publishNativeAppState, registerNativeCapabilities, type LocationSample } from "./native-capabilities";
import { useLiveClaimRecommendation, useLiveLocation } from "./use-live-location";

const sample = (capturedAtEpochMs = Date.now(), accuracyMeters = 7): LocationSample => ({
  latitude: 49.0918726,
  longitude: -123.0600868,
  accuracyMeters,
  capturedAtEpochMs,
});

let restore: () => void = () => undefined;

afterEach(() => {
  cleanup();
  restore();
  publishNativeAppState(true);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useLiveLocation", () => {
  it("publishes foreground watch fixes and stops the provider on cleanup", () => {
    let publish: ((next: LocationSample) => void) | undefined;
    const stop = vi.fn();
    const watchLocation = vi.fn((_options, onLocation: (next: LocationSample) => void) => {
      publish = onLocation;
      return stop;
    });
    restore = registerNativeCapabilities({
      getCurrentLocation: vi.fn(),
      getPhoto: vi.fn(),
      watchLocation,
    });

    const { result, unmount } = renderHook(() => useLiveLocation(true));
    expect(watchLocation).toHaveBeenCalledTimes(1);
    act(() => publish?.(sample()));
    expect(result.current.location).toEqual(sample(result.current.location?.capturedAtEpochMs));
    expect(result.current.status).toBe("ready");
    unmount();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("withdraws a stale fix after provider failure or disable", async () => {
    let publish: ((next: LocationSample) => void) | undefined;
    let fail: ((reason: LocationCapabilityError) => void) | undefined;
    const stop = vi.fn();
    restore = registerNativeCapabilities({
      getCurrentLocation: vi.fn(),
      getPhoto: vi.fn(),
      watchLocation: vi.fn((_options, onLocation, onError) => {
        publish = onLocation;
        fail = onError;
        return stop;
      }),
    });
    const { result, rerender } = renderHook(({ enabled }) => useLiveLocation(enabled), { initialProps: { enabled: true } });
    act(() => publish?.(sample()));
    expect(result.current.location).not.toBeNull();
    act(() => fail?.(new LocationCapabilityError("unavailable", "GPS unavailable")));
    expect(result.current.location).toBeNull();
    expect(result.current.status).toBe("unavailable");

    act(() => publish?.(sample()));
    rerender({ enabled: false });
    await waitFor(() => expect(result.current.location).toBeNull());
    expect(result.current.status).toBe("idle");
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("stops on a native app pause and restarts on resume", async () => {
    const stops: Array<ReturnType<typeof vi.fn>> = [];
    const watchLocation = vi.fn(() => {
      const stop = vi.fn();
      stops.push(stop);
      return stop;
    });
    restore = registerNativeCapabilities({ getCurrentLocation: vi.fn(), getPhoto: vi.fn(), watchLocation });
    renderHook(() => useLiveLocation(true));
    expect(watchLocation).toHaveBeenCalledTimes(1);
    act(() => window.dispatchEvent(new CustomEvent(NATIVE_APP_STATE_EVENT, { detail: { isActive: false } })));
    await waitFor(() => expect(stops[0]).toHaveBeenCalledTimes(1));
    act(() => window.dispatchEvent(new CustomEvent(NATIVE_APP_STATE_EVENT, { detail: { isActive: true } })));
    await waitFor(() => expect(watchLocation).toHaveBeenCalledTimes(2));
  });

  it("does not start a watch until native startup is confirmed active", async () => {
    const watchLocation = vi.fn(() => vi.fn());
    restore = registerNativeCapabilities({ getCurrentLocation: vi.fn(), getPhoto: vi.fn(), watchLocation });
    publishNativeAppState(false);
    const { result } = renderHook(() => useLiveLocation(true));
    expect(watchLocation).not.toHaveBeenCalled();
    await waitFor(() => expect(result.current.status).toBe("starting"));
    act(() => publishNativeAppState(true));
    await waitFor(() => expect(watchLocation).toHaveBeenCalledTimes(1));
  });

  it("restarts an already-enabled foreground watch when the user retries", async () => {
    const stops: Array<ReturnType<typeof vi.fn>> = [];
    const watchLocation = vi.fn(() => {
      const stop = vi.fn();
      stops.push(stop);
      return stop;
    });
    restore = registerNativeCapabilities({ getCurrentLocation: vi.fn(), getPhoto: vi.fn(), watchLocation });
    const { rerender } = renderHook(({ retry }) => useLiveLocation(true, retry), { initialProps: { retry: 0 } });
    expect(watchLocation).toHaveBeenCalledTimes(1);

    rerender({ retry: 1 });

    await waitFor(() => expect(stops[0]).toHaveBeenCalledTimes(1));
    expect(watchLocation).toHaveBeenCalledTimes(2);
  });
});

describe("useLiveClaimRecommendation", () => {
  it("checks immediately and never calls the server more often than every 30 seconds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-16T12:00:00Z"));
    const recommendation = {
      status: "recommended" as const,
      recommendationToken: "signed",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      candidate: { placeId: "regional-bell-park", matchKind: "exact" as const, distanceMeters: 0 },
    };
    const recommend = vi.fn().mockResolvedValue(recommendation);
    const { result, rerender } = renderHook(
      ({ location }) => useLiveClaimRecommendation({ enabled: true, sessionKey: "account-1", location, recommend }),
      { initialProps: { location: sample() } },
    );
    await act(async () => { await Promise.resolve(); });
    expect(recommend).toHaveBeenCalledTimes(1);
    expect(result.current.recommendation).toEqual(recommendation);

    vi.setSystemTime(new Date("2026-09-16T12:00:10Z"));
    rerender({ location: sample() });
    await act(async () => { await Promise.resolve(); });
    expect(recommend).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date("2026-09-16T12:00:31Z"));
    rerender({ location: sample() });
    await act(async () => { await Promise.resolve(); });
    expect(recommend).toHaveBeenCalledTimes(2);
  });

  it("withdraws an eligible banner as soon as the latest fix is too inaccurate", async () => {
    const recommendation = {
      status: "recommended" as const,
      recommendationToken: "signed",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      candidate: { placeId: "regional-bell-park", matchKind: "exact" as const, distanceMeters: 0 },
    };
    const recommend = vi.fn().mockResolvedValue(recommendation);
    const { result, rerender } = renderHook(
      ({ location }) => useLiveClaimRecommendation({ enabled: true, sessionKey: "account-1", location, recommend }),
      { initialProps: { location: sample() } },
    );
    await waitFor(() => expect(result.current.recommendation).toEqual(recommendation));
    rerender({ location: sample(Date.now(), 80) });
    await waitFor(() => expect(result.current.recommendation).toBeNull());
    expect(recommend).toHaveBeenCalledTimes(1);
  });

  it("withdraws an eligible banner when the location watch loses its fix", async () => {
    const recommendation = {
      status: "recommended" as const,
      recommendationToken: "signed",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      candidate: { placeId: "regional-bell-park", matchKind: "exact" as const, distanceMeters: 0 },
    };
    const recommend = vi.fn().mockResolvedValue(recommendation);
    const { result, rerender } = renderHook(
      ({ location }) => useLiveClaimRecommendation({ enabled: true, sessionKey: "account-1", location, recommend }),
      { initialProps: { location: sample() as LocationSample | null } },
    );
    await waitFor(() => expect(result.current.recommendation).toEqual(recommendation));
    rerender({ location: null });
    await waitFor(() => expect(result.current.recommendation).toBeNull());
  });

  it("starts a new request after an invalidated request even when the old request is unresolved", async () => {
    const first = Promise.withResolvers<ClaimRecommendation>();
    const secondRecommendation = {
      status: "recommended" as const,
      recommendationToken: "second",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      candidate: { placeId: "regional-bell-park", matchKind: "exact" as const, distanceMeters: 0 },
    };
    const recommend = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(secondRecommendation);
    const { result, rerender } = renderHook(
      ({ location }) => useLiveClaimRecommendation({ enabled: true, sessionKey: "account-1", location, recommend }),
      { initialProps: { location: sample() } },
    );
    await waitFor(() => expect(recommend).toHaveBeenCalledTimes(1));
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    act(() => window.dispatchEvent(new Event("offline")));
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    rerender({ location: sample(Date.now() + 1) });
    await waitFor(() => expect(recommend).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.recommendation).toEqual(secondRecommendation));
    first.resolve({ status: "none" });
    await act(async () => { await first.promise; });
    expect(result.current.recommendation).toEqual(secondRecommendation);
  });

  it("does not apply a late rate limit response to a new account session", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-16T12:00:00Z"));
    const first = Promise.withResolvers<ClaimRecommendation>();
    const recommend = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue({ status: "none" });
    const { rerender } = renderHook(
      ({ sessionKey, location }) => useLiveClaimRecommendation({ enabled: true, sessionKey, location, recommend }),
      { initialProps: { sessionKey: "account-a", location: sample() } },
    );
    await act(async () => { await Promise.resolve(); });
    expect(recommend).toHaveBeenCalledTimes(1);

    rerender({ sessionKey: "account-b", location: sample(Date.now() + 1) });
    await act(async () => { await Promise.resolve(); });
    expect(recommend).toHaveBeenCalledTimes(2);
    await act(async () => {
      first.reject(new ApiError("Too many requests", 429));
      await first.promise.catch(() => undefined);
    });

    vi.setSystemTime(new Date("2026-09-16T12:00:31Z"));
    rerender({ sessionKey: "account-b", location: sample() });
    await act(async () => { await Promise.resolve(); });
    expect(recommend).toHaveBeenCalledTimes(3);
  });
});

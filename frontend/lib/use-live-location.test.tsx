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

  it("preserves the last good fix after a transient provider failure, then clears it when disabled", async () => {
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
    const { result, rerender } = renderHook(({ enabled, retry }) => useLiveLocation(enabled, retry), { initialProps: { enabled: true, retry: 0 } });
    act(() => publish?.(sample()));
    expect(result.current.location).not.toBeNull();
    act(() => fail?.(new LocationCapabilityError("unavailable", "GPS unavailable")));
    expect(result.current.location).not.toBeNull();
    expect(result.current.status).toBe("ready");
    expect(result.current.error).toBe("GPS unavailable");

    rerender({ enabled: true, retry: 1 });
    await waitFor(() => expect(stop).toHaveBeenCalledTimes(1));

    act(() => publish?.(sample()));
    rerender({ enabled: false, retry: 1 });
    await waitFor(() => expect(result.current.location).toBeNull());
    expect(result.current.status).toBe("idle");
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it("clears a prior fix and remains terminally denied when permission is revoked", () => {
    vi.useFakeTimers();
    let publish: ((next: LocationSample) => void) | undefined;
    let fail: ((reason: LocationCapabilityError) => void) | undefined;
    const stop = vi.fn();
    const watchLocation = vi.fn((_options, onLocation, onError) => {
      publish = onLocation;
      fail = onError;
      return stop;
    });
    restore = registerNativeCapabilities({ getCurrentLocation: vi.fn(), getPhoto: vi.fn(), watchLocation });
    const { result } = renderHook(() => useLiveLocation(true));

    act(() => publish?.(sample()));
    act(() => fail?.(new LocationCapabilityError("unavailable", "Provider interrupted")));
    act(() => fail?.(new LocationCapabilityError("permission-denied", "Location permission was denied.")));

    expect(result.current.location).toBeNull();
    expect(result.current.claimLocationFresh).toBe(false);
    expect(result.current.status).toBe("denied");
    expect(stop).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(60_000));
    expect(result.current.status).toBe("denied");
    expect(watchLocation).toHaveBeenCalledTimes(1);
  });

  it("invalidates a delayed precise result when location is disabled", async () => {
    let resolvePrecise: ((sample: LocationSample) => void) | undefined;
    const getCurrentLocation = vi.fn(() => new Promise<LocationSample>((resolve) => { resolvePrecise = resolve; }));
    restore = registerNativeCapabilities({ getCurrentLocation, getPhoto: vi.fn(), watchLocation: vi.fn(() => vi.fn()) });
    const { result, rerender } = renderHook(({ enabled }) => useLiveLocation(enabled), { initialProps: { enabled: true } });
    let request!: Promise<LocationSample>;
    act(() => { request = result.current.requestPreciseLocation(); });

    rerender({ enabled: false });
    act(() => resolvePrecise?.(sample()));

    await expect(request).rejects.toMatchObject({ code: "unavailable" });
    await act(async () => { await Promise.resolve(); });
    expect(result.current.location).toBeNull();
    expect(result.current.status).toBe("idle");
  });

  it("invalidates a delayed precise result across an account generation change", async () => {
    let resolvePrecise: ((sample: LocationSample) => void) | undefined;
    const getCurrentLocation = vi.fn(() => new Promise<LocationSample>((resolve) => { resolvePrecise = resolve; }));
    const watchLocation = vi.fn(() => vi.fn());
    restore = registerNativeCapabilities({ getCurrentLocation, getPhoto: vi.fn(), watchLocation });
    const { result, rerender } = renderHook(({ account }) => useLiveLocation(true, 0, account), { initialProps: { account: "account:a" } });
    let request!: Promise<LocationSample>;
    act(() => { request = result.current.requestPreciseLocation(); });

    rerender({ account: "account:b" });
    act(() => resolvePrecise?.(sample()));

    await expect(request).rejects.toMatchObject({ code: "unavailable" });
    expect(result.current.location).toBeNull();
    expect(watchLocation).toHaveBeenCalledTimes(1);
  });

  it("resumes coarse map updates after a precision downgrade without unlocking claims or requesting permission again", async () => {
    vi.useFakeTimers();
    const precise = sample(Date.now(), 8);
    const getCurrentLocation = vi.fn().mockResolvedValue(precise);
    const callbacks: Array<{ publish: (sample: LocationSample) => void; fail?: (reason: LocationCapabilityError) => void; stop: ReturnType<typeof vi.fn> }> = [];
    const watchLocation = vi.fn((_options, publish: (sample: LocationSample) => void, fail?: (reason: LocationCapabilityError) => void) => {
      const stop = vi.fn();
      callbacks.push({ publish, fail, stop });
      return stop;
    });
    restore = registerNativeCapabilities({ getCurrentLocation, getPhoto: vi.fn(), watchLocation });
    const { result } = renderHook(() => useLiveLocation(true));

    await act(async () => { await result.current.requestPreciseLocation(); });
    expect(watchLocation).toHaveBeenCalledTimes(2);
    act(() => callbacks[1].publish(precise));
    expect(result.current.claimLocationFresh).toBe(true);

    act(() => callbacks[1].fail?.(new LocationCapabilityError(
      "precise-required",
      "Precise location is required to claim a park. Turn on precise location for Parkdex in Android settings, then try again.",
    )));

    expect(result.current.location).toEqual(precise);
    expect(result.current.claimLocationFresh).toBe(false);
    expect(result.current.preciseLocationRequired).toBe(true);
    expect(callbacks[1].stop).toHaveBeenCalledTimes(1);
    expect(watchLocation).toHaveBeenCalledTimes(3);
    expect(watchLocation.mock.calls[2][0]).toEqual(expect.objectContaining({ requirePrecise: undefined }));

    const firstCoarse = { ...precise, latitude: precise.latitude + 0.01, accuracyMeters: 800, capturedAtEpochMs: Date.now() };
    act(() => callbacks[2].publish(firstCoarse));
    expect(result.current.location).toEqual(firstCoarse);
    expect(result.current.claimLocationFresh).toBe(false);
    act(() => vi.advanceTimersByTime(5_000));
    const movedCoarse = { ...firstCoarse, latitude: firstCoarse.latitude + 0.001, capturedAtEpochMs: Date.now() };
    act(() => callbacks[2].publish(movedCoarse));
    expect(result.current.location).toEqual(movedCoarse);
    expect(result.current.claimLocationFresh).toBe(false);

    act(() => vi.advanceTimersByTime(60_000));
    expect(watchLocation).toHaveBeenCalledTimes(3);
    expect(getCurrentLocation).toHaveBeenCalledTimes(1);
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

  it("does not spin indefinitely when native startup never becomes active", () => {
    vi.useFakeTimers();
    const watchLocation = vi.fn(() => vi.fn());
    restore = registerNativeCapabilities({ getCurrentLocation: vi.fn(), getPhoto: vi.fn(), watchLocation });
    publishNativeAppState(false);
    const { result } = renderHook(() => useLiveLocation(true));

    act(() => vi.advanceTimersByTime(15_000));

    expect(result.current.status).toBe("unavailable");
    expect(result.current.error).toBe("Location tracking did not become active in time.");
    expect(watchLocation).not.toHaveBeenCalled();
  });

  it("does not restart an already-warming watch when Locate Me is tapped", async () => {
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

    await act(async () => { await Promise.resolve(); });
    expect(stops[0]).not.toHaveBeenCalled();
    expect(watchLocation).toHaveBeenCalledTimes(1);
  });

  it("leaves starting after 15 seconds and restarts only after a failed attempt is retried", async () => {
    vi.useFakeTimers();
    const stops: Array<ReturnType<typeof vi.fn>> = [];
    const watchLocation = vi.fn(() => {
      const stop = vi.fn();
      stops.push(stop);
      return stop;
    });
    restore = registerNativeCapabilities({ getCurrentLocation: vi.fn(), getPhoto: vi.fn(), watchLocation });
    const { result, rerender } = renderHook(({ retry }) => useLiveLocation(true, retry), { initialProps: { retry: 0 } });

    expect(result.current.status).toBe("starting");
    act(() => vi.advanceTimersByTime(14_999));
    expect(result.current.status).toBe("starting");
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.status).toBe("unavailable");
    expect(result.current.error).toBe("Could not get your location in time.");

    rerender({ retry: 1 });
    await act(async () => { await Promise.resolve(); });
    expect(stops[0]).toHaveBeenCalledTimes(1);
    expect(watchLocation).toHaveBeenCalledTimes(2);
  });

  it("automatically re-registers the provider after a transient failure without an app restart", async () => {
    vi.useFakeTimers();
    const callbacks: Array<{ publish: (next: LocationSample) => void; fail?: (reason: LocationCapabilityError) => void }> = [];
    const stops: Array<ReturnType<typeof vi.fn>> = [];
    const watchLocation = vi.fn((_options, publish: (next: LocationSample) => void, fail?: (reason: LocationCapabilityError) => void) => {
      callbacks.push({ publish, fail });
      const stop = vi.fn();
      stops.push(stop);
      return stop;
    });
    restore = registerNativeCapabilities({ getCurrentLocation: vi.fn(), getPhoto: vi.fn(), watchLocation });
    const { result } = renderHook(() => useLiveLocation(true));

    act(() => callbacks[0].fail?.(new LocationCapabilityError("unavailable", "Provider disabled")));
    expect(result.current.status).toBe("unavailable");
    act(() => vi.advanceTimersByTime(1_999));
    expect(watchLocation).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(1));
    expect(stops[0]).toHaveBeenCalledTimes(1);
    expect(watchLocation).toHaveBeenCalledTimes(2);

    act(() => callbacks[1].publish(sample()));
    expect(result.current.status).toBe("ready");
    expect(result.current.location).not.toBeNull();
  });

  it("schedules another recovery when a watch fails again after a fresh fix", () => {
    vi.useFakeTimers();
    const callbacks: Array<{ publish: (next: LocationSample) => void; fail?: (reason: LocationCapabilityError) => void }> = [];
    const watchLocation = vi.fn((_options, publish: (next: LocationSample) => void, fail?: (reason: LocationCapabilityError) => void) => {
      callbacks.push({ publish, fail });
      return vi.fn();
    });
    restore = registerNativeCapabilities({ getCurrentLocation: vi.fn(), getPhoto: vi.fn(), watchLocation });
    renderHook(() => useLiveLocation(true));

    act(() => callbacks[0].fail?.(new LocationCapabilityError("unavailable", "First failure")));
    act(() => callbacks[0].publish(sample()));
    act(() => callbacks[0].fail?.(new LocationCapabilityError("unavailable", "Second failure")));
    act(() => vi.advanceTimersByTime(2_000));

    expect(watchLocation).toHaveBeenCalledTimes(2);
  });

  it("keeps a retained pin provisional until a resumed watch produces a fresh fix", async () => {
    vi.useFakeTimers();
    const publishers: Array<(next: LocationSample) => void> = [];
    const stops: Array<ReturnType<typeof vi.fn>> = [];
    const watchLocation = vi.fn((_options, publish: (next: LocationSample) => void) => {
      publishers.push(publish);
      const stop = vi.fn();
      stops.push(stop);
      return stop;
    });
    restore = registerNativeCapabilities({ getCurrentLocation: vi.fn(), getPhoto: vi.fn(), watchLocation });
    const { result, rerender } = renderHook(({ retry }) => useLiveLocation(true, retry), { initialProps: { retry: 0 } });
    act(() => publishers[0](sample()));

    act(() => window.dispatchEvent(new CustomEvent(NATIVE_APP_STATE_EVENT, { detail: { isActive: false } })));
    act(() => window.dispatchEvent(new CustomEvent(NATIVE_APP_STATE_EVENT, { detail: { isActive: true } })));
    expect(watchLocation).toHaveBeenCalledTimes(2);
    act(() => vi.advanceTimersByTime(15_000));

    expect(result.current.location).not.toBeNull();
    expect(result.current.status).toBe("ready");
    expect(result.current.error).toBe("Could not get your location in time.");

    rerender({ retry: 1 });
    await act(async () => { await Promise.resolve(); });
    expect(stops[1]).toHaveBeenCalledTimes(1);
    expect(watchLocation).toHaveBeenCalledTimes(3);
  });

  it("shows a stale cached pin without letting it satisfy the first-fix watchdog", async () => {
    vi.useFakeTimers();
    let publish: ((next: LocationSample) => void) | undefined;
    const watchLocation = vi.fn((_options, onLocation: (next: LocationSample) => void) => {
      publish = onLocation;
      return vi.fn();
    });
    restore = registerNativeCapabilities({ getCurrentLocation: vi.fn(), getPhoto: vi.fn(), watchLocation });
    const { result, rerender } = renderHook(({ retry }) => useLiveLocation(true, retry), { initialProps: { retry: 0 } });
    act(() => publish?.(sample(Date.now() - 5 * 60_000)));
    expect(result.current.location).not.toBeNull();
    expect(result.current.status).toBe("ready");

    act(() => vi.advanceTimersByTime(15_000));
    expect(result.current.location).not.toBeNull();
    expect(result.current.error).toBe("Could not get your location in time.");

    rerender({ retry: 1 });
    await act(async () => { await Promise.resolve(); });
    expect(watchLocation).toHaveBeenCalledTimes(2);
  });

  it("never recommends a retained fix across pause, replacement-watch watchdog, or provider failure", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-16T12:00:00Z"));
    const callbacks: Array<{ publish: (next: LocationSample) => void; fail?: (reason: LocationCapabilityError) => void }> = [];
    const watchLocation = vi.fn((_options, publish: (next: LocationSample) => void, fail?: (reason: LocationCapabilityError) => void) => {
      callbacks.push({ publish, fail });
      return vi.fn();
    });
    const recommend = vi.fn().mockResolvedValue({ status: "no_candidate" as const });
    restore = registerNativeCapabilities({ getCurrentLocation: vi.fn(), getPhoto: vi.fn(), watchLocation });
    const { result } = renderHook(() => {
      const live = useLiveLocation(true);
      const claim = useLiveClaimRecommendation({
        enabled: true,
        sessionKey: "account-1",
        location: live.claimLocationFresh ? live.location : null,
        recommend,
      });
      return { ...live, claim };
    });

    act(() => callbacks[0].publish(sample()));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.claimLocationFresh).toBe(true);
    expect(recommend).toHaveBeenCalledTimes(1);

    act(() => window.dispatchEvent(new CustomEvent(NATIVE_APP_STATE_EVENT, { detail: { isActive: false } })));
    expect(result.current.location).not.toBeNull();
    expect(result.current.claimLocationFresh).toBe(false);
    act(() => vi.advanceTimersByTime(31_000));
    await act(async () => { await Promise.resolve(); });
    expect(recommend).toHaveBeenCalledTimes(1);

    act(() => window.dispatchEvent(new CustomEvent(NATIVE_APP_STATE_EVENT, { detail: { isActive: true } })));
    expect(watchLocation).toHaveBeenCalledTimes(2);
    expect(result.current.claimLocationFresh).toBe(false);
    act(() => vi.advanceTimersByTime(17_000));
    expect(watchLocation).toHaveBeenCalledTimes(3);
    expect(result.current.claimLocationFresh).toBe(false);
    expect(recommend).toHaveBeenCalledTimes(1);

    act(() => callbacks[2].publish(sample()));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.claimLocationFresh).toBe(true);
    expect(recommend).toHaveBeenCalledTimes(2);

    act(() => callbacks[2].fail?.(new LocationCapabilityError("unavailable", "Provider interrupted")));
    expect(result.current.location).not.toBeNull();
    expect(result.current.claimLocationFresh).toBe(false);
    act(() => vi.advanceTimersByTime(60_000));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.claimLocationFresh).toBe(false);
    expect(recommend).toHaveBeenCalledTimes(2);
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

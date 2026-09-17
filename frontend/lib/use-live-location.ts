"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { currentNativeAppState, FOREGROUND_LOCATION_WATCH_OPTIONS, getNativeCapabilities, LocationCapabilityError, NATIVE_APP_STATE_EVENT, watchCurrentLocation, type LocationSample } from "./native-capabilities";
import type { ClaimRecommendation } from "./claims-client";
import { ApiError } from "./account";
import { fieldDiagnostics, type FieldDiagnosticTrace } from "./field-diagnostics";

export type LiveLocationStatus = "idle" | "starting" | "ready" | "denied" | "unavailable";

const RECOMMENDATION_REFRESH_MS = 30_000;
const MAX_SAMPLE_AGE_MS = 20_000;
const MAX_RECOMMENDATION_ACCURACY_METERS = 50;
const FIRST_FIX_WATCHDOG_MS = 15_000;
const LOCATION_RETRY_BASE_MS = 2_000;
const LOCATION_RETRY_MAX_MS = 30_000;
const PRECISE_LOCATION_REQUEST_OPTIONS = {
  highAccuracy: true,
  timeoutMs: 15_000,
  maxAgeMs: 0,
  requirePrecise: true,
} as const;

function statusFor(error: unknown): LiveLocationStatus {
  return error instanceof LocationCapabilityError && error.code === "permission-denied" ? "denied" : "unavailable";
}

/** Keep the foreground map location moving at native-provider cadence, with a browser-safe polling fallback. */
export function useLiveLocation(enabled = true, restartKey = 0, generationKey: string | number = "default") {
  const [location, setLocation] = useState<LocationSample | null>(null);
  const [claimLocationFresh, setClaimLocationFresh] = useState(false);
  const [preciseLocationRequired, setPreciseLocationRequired] = useState(false);
  const [status, setStatus] = useState<LiveLocationStatus>(enabled ? "starting" : "idle");
  const [error, setError] = useState("");
  const [recoveryAttempt, setRecoveryAttempt] = useState(0);
  const generationRef = useRef(0);
  const locationRef = useRef<LocationSample | null>(null);
  const statusRef = useRef<LiveLocationStatus>(enabled ? "starting" : "idle");
  const attemptFailedRef = useRef(false);
  const preciseWatchRef = useRef(false);
  const preciseLocationRequiredRef = useRef(false);
  const preciseRequestEpochRef = useRef(0);
  const previousGenerationKeyRef = useRef(generationKey);
  const previousRestartKeyRef = useRef(restartKey);
  const diagnosticRef = useRef<FieldDiagnosticTrace | null>(null);
  const providerAttemptRef = useRef(0);
  const consecutiveFailureRef = useRef(0);
  const [documentVisible, setDocumentVisible] = useState(() => typeof document === "undefined" || document.visibilityState !== "hidden");
  const [nativeActive, setNativeActive] = useState(currentNativeAppState);
  const foreground = documentVisible && nativeActive;

  useEffect(() => {
    let subscribed = true;
    const updateVisibility = () => {
      const visible = document.visibilityState !== "hidden";
      if (!visible) setClaimLocationFresh(false);
      setDocumentVisible(visible);
    };
    const updateNativeState = (event: Event) => {
      const active = (event as CustomEvent<{ isActive?: boolean }>).detail?.isActive !== false;
      if (!active) setClaimLocationFresh(false);
      setNativeActive(active);
    };
    document.addEventListener("visibilitychange", updateVisibility);
    window.addEventListener(NATIVE_APP_STATE_EVENT, updateNativeState);
    // Runtime startup may publish between this hook's render and subscription.
    // Re-read both stores after subscribing so that single resume is not lost.
    queueMicrotask(() => {
      if (!subscribed) return;
      updateVisibility();
      const active = currentNativeAppState();
      if (!active) setClaimLocationFresh(false);
      setNativeActive(active);
    });
    return () => {
      subscribed = false;
      document.removeEventListener("visibilitychange", updateVisibility);
      window.removeEventListener(NATIVE_APP_STATE_EVENT, updateNativeState);
    };
  }, []);

  const accept = useCallback((next: LocationSample) => {
    if (![next.latitude, next.longitude, next.accuracyMeters, next.capturedAtEpochMs].every(Number.isFinite)) return;
    locationRef.current = next;
    statusRef.current = "ready";
    setLocation(next);
    setClaimLocationFresh(!preciseLocationRequiredRef.current && Math.max(0, Date.now() - next.capturedAtEpochMs) <= MAX_SAMPLE_AGE_MS);
    setStatus("ready");
    setError("");
  }, []);

  const requestPreciseLocation = useCallback(async () => {
    const generation = generationRef.current;
    const requestEpoch = ++preciseRequestEpochRef.current;
    const sample = await getNativeCapabilities().getCurrentLocation(PRECISE_LOCATION_REQUEST_OPTIONS);
    if (generationRef.current !== generation || preciseRequestEpochRef.current !== requestEpoch || !enabled || !foreground) {
      throw new LocationCapabilityError("unavailable", "The location request was cancelled because your Parkdex session changed.");
    }
    // Invalidate the previous watch before publishing the precise sample. Its
    // late approximate callbacks must not replace a claim-capable fix.
    generationRef.current += 1;
    preciseWatchRef.current = true;
    preciseLocationRequiredRef.current = false;
    setPreciseLocationRequired(false);
    accept(sample);
    setClaimLocationFresh(false);
    setRecoveryAttempt((current) => current + 1);
    return sample;
  }, [accept, enabled, foreground]);

  useEffect(() => {
    if (previousRestartKeyRef.current === restartKey) return;
    previousRestartKeyRef.current = restartKey;
    // Locate Me may be tapped while the automatic Android watch is still
    // warming. Preserve that attempt; only replace a watch that has actually
    // failed or exceeded the bounded first-fix watchdog.
    if (enabled && foreground && attemptFailedRef.current) {
      setClaimLocationFresh(false);
      setRecoveryAttempt((current) => current + 1);
    }
  }, [enabled, foreground, restartKey]);

  useEffect(() => {
    if (previousGenerationKeyRef.current === generationKey) return;
    previousGenerationKeyRef.current = generationKey;
    preciseRequestEpochRef.current += 1;
    preciseWatchRef.current = false;
    preciseLocationRequiredRef.current = false;
    setPreciseLocationRequired(false);
  }, [generationKey]);

  useEffect(() => {
    const generation = ++generationRef.current;
    preciseRequestEpochRef.current += 1;
    if (!enabled) {
      diagnosticRef.current?.dismiss();
      diagnosticRef.current = null;
      providerAttemptRef.current = 0;
      consecutiveFailureRef.current = 0;
      attemptFailedRef.current = false;
      preciseWatchRef.current = false;
      preciseLocationRequiredRef.current = false;
      queueMicrotask(() => {
        if (generationRef.current !== generation) return;
        locationRef.current = null;
        statusRef.current = "idle";
        setLocation(null);
        setClaimLocationFresh(false);
        setPreciseLocationRequired(false);
        setStatus("idle");
        setError("");
      });
      return;
    }
    if (!foreground || !currentNativeAppState() || document.visibilityState === "hidden") {
      queueMicrotask(() => {
        if (generationRef.current !== generation) return;
        const nextStatus = locationRef.current ? "ready" : "starting";
        statusRef.current = nextStatus;
        setStatus(nextStatus);
        setError("");
      });
      if (locationRef.current) return;
      const inactiveWatchdog = setTimeout(() => {
        if (generationRef.current !== generation) return;
        const trace = diagnosticRef.current ?? fieldDiagnostics.begin({
          key: "location:foreground",
          flow: "location",
          title: "Finding your location",
          stage: "watch-start",
          summary: "Waiting for the app to become active",
          facts: [{ kind: "app-state", value: "inactive" }],
        });
        diagnosticRef.current = trace;
        attemptFailedRef.current = true;
        trace.warn("watch-start", {
          summary: "The location listener could not start while the app was inactive",
          facts: [{ kind: "provider-wait-ms", value: FIRST_FIX_WATCHDOG_MS }, { kind: "result", value: "timed-out" }],
        });
        statusRef.current = "unavailable";
        setStatus("unavailable");
        setError("Location tracking did not become active in time.");
      }, FIRST_FIX_WATCHDOG_MS);
      return () => clearTimeout(inactiveWatchdog);
    }
    const attempt = ++providerAttemptRef.current;
    const attemptStartedAt = Date.now();
    let attemptHasFix = false;
    attemptFailedRef.current = false;
    const trace = diagnosticRef.current ?? fieldDiagnostics.begin({
      key: "location:foreground",
      flow: "location",
      title: "Finding your location",
      stage: "watch-start",
      summary: "Starting the foreground GPS listener",
      facts: [{ kind: "attempt", value: attempt }, { kind: "app-state", value: "active" }, { kind: "visibility", value: "visible" }],
    });
    diagnosticRef.current = trace;
    if (attempt > 1) {
      trace.stage("watch-start", {
        summary: "Restarting the GPS listener",
        facts: [{ kind: "attempt", value: attempt }, { kind: "retry-attempt", value: consecutiveFailureRef.current }],
      });
    }
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let firstFixTimer: ReturnType<typeof setTimeout> | undefined;
    let providerStop: () => void = () => undefined;
    let stopRequested = false;
    const stop = () => {
      if (stopRequested) return;
      stopRequested = true;
      providerStop();
    };
    let terminalFailure = false;
    const fail = (reason: unknown) => {
      if (generationRef.current !== generation) return;
      attemptFailedRef.current = true;
      setClaimLocationFresh(false);
      const failureStatus = statusFor(reason);
      const precisionDowngrade = reason instanceof LocationCapabilityError && reason.code === "precise-required";
      if (failureStatus === "denied" || precisionDowngrade) {
        terminalFailure = true;
        if (firstFixTimer !== undefined) {
          clearTimeout(firstFixTimer);
          firstFixTimer = undefined;
        }
        if (retryTimer !== undefined) {
          clearTimeout(retryTimer);
          retryTimer = undefined;
        }
        stop();
        if (failureStatus === "denied") {
          locationRef.current = null;
          setLocation(null);
          preciseLocationRequiredRef.current = false;
        } else {
          // Keep the last pin as a visual hint, but it is no longer valid for
          // a claim until the user explicitly restores precise access.
          preciseWatchRef.current = false;
          preciseLocationRequiredRef.current = true;
          attemptFailedRef.current = false;
        }
        const terminalStatus = failureStatus === "denied" ? "denied" : locationRef.current ? "ready" : "unavailable";
        statusRef.current = terminalStatus;
        setClaimLocationFresh(false);
        setPreciseLocationRequired(precisionDowngrade);
        setStatus(terminalStatus);
        setError(reason instanceof Error ? reason.message : "Location permission is not available.");
        trace.fail("permission", {
          summary: precisionDowngrade ? "Precise location access needs your attention" : "Location permission is not available",
          facts: [{ kind: "permission", value: precisionDowngrade ? "approximate" : "denied" }, { kind: "result", value: "rejected" }],
        });
        if (precisionDowngrade) {
          // Resume non-prompting coarse updates for map and Nearby. Claim
          // freshness stays locked until the explicit precise-location action.
          setRecoveryAttempt((current) => current + 1);
        }
        return;
      }
      const nextStatus = locationRef.current ? "ready" : failureStatus;
      statusRef.current = nextStatus;
      setStatus(nextStatus);
      setError(reason instanceof Error ? reason.message : "Your location is unavailable right now.");
      if (retryTimer !== undefined) return;
      consecutiveFailureRef.current += 1;
      const retryDelay = Math.min(
        LOCATION_RETRY_MAX_MS,
        LOCATION_RETRY_BASE_MS * (2 ** Math.min(4, consecutiveFailureRef.current - 1)),
      );
      trace.warn(attemptHasFix ? "watch-start" : "first-fix", {
        summary: `The location provider stopped. Retrying in ${Math.round(retryDelay / 1_000)} seconds`,
        facts: [
          { kind: "attempt", value: attempt },
          { kind: "elapsed-ms", value: Date.now() - attemptStartedAt },
          { kind: "retry-attempt", value: consecutiveFailureRef.current },
          { kind: "result", value: reason instanceof LocationCapabilityError && reason.code === "timeout" ? "timed-out" : "failed" },
        ],
      });
      retryTimer = setTimeout(() => {
        if (generationRef.current === generation && enabled && foreground) {
          setRecoveryAttempt((current) => current + 1);
        }
      }, retryDelay);
    };
    queueMicrotask(() => {
      if (generationRef.current === generation && !terminalFailure) {
        const nextStatus = locationRef.current ? "ready" : "starting";
        statusRef.current = nextStatus;
        setStatus(nextStatus);
        setError("");
      }
    });

    providerStop = watchCurrentLocation({ ...FOREGROUND_LOCATION_WATCH_OPTIONS, requirePrecise: preciseWatchRef.current || undefined }, (sample) => {
      if (generationRef.current !== generation) return;
      if (preciseWatchRef.current && sample.accuracyMeters > MAX_RECOMMENDATION_ACCURACY_METERS) return;
      const sampleAgeMs = Math.max(0, Date.now() - sample.capturedAtEpochMs);
      const freshForAttempt = sampleAgeMs <= MAX_SAMPLE_AGE_MS;
      if (freshForAttempt && firstFixTimer !== undefined) {
        clearTimeout(firstFixTimer);
        firstFixTimer = undefined;
      }
      if (freshForAttempt && retryTimer !== undefined) {
        clearTimeout(retryTimer);
        retryTimer = undefined;
      }
      if (freshForAttempt && !attemptHasFix) {
        attemptHasFix = true;
        attemptFailedRef.current = false;
        consecutiveFailureRef.current = 0;
        trace.succeed("first-fix", {
          summary: "Location pin is ready",
          facts: [
            { kind: "attempt", value: attempt },
            { kind: "elapsed-ms", value: Date.now() - attemptStartedAt },
            { kind: "accuracy-meters", value: sample.accuracyMeters },
            { kind: "sample-age-ms", value: sampleAgeMs },
            { kind: "result", value: "ready" },
          ],
        });
      }
      accept(sample);
    }, fail);
    if (stopRequested) providerStop();
    // A retained or cached pin is provisional. Every new foreground watch must
    // still prove it can produce a fresh fix before the watchdog expires.
    if (!attemptHasFix && !terminalFailure) {
      firstFixTimer = setTimeout(() => {
        fail(new LocationCapabilityError("timeout", "Could not get your location in time."));
      }, FIRST_FIX_WATCHDOG_MS);
    }
    return () => {
      if (firstFixTimer !== undefined) clearTimeout(firstFixTimer);
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      stop();
    };
  }, [accept, enabled, foreground, recoveryAttempt]);

  return { location, status, error, claimLocationFresh, preciseLocationRequired, requestPreciseLocation };
}

type RecommendationState = {
  recommendation: ClaimRecommendation | null;
  checking: boolean;
  error: string;
};

export function useLiveClaimRecommendation({
  enabled,
  sessionKey,
  location,
  recommend,
}: {
  enabled: boolean;
  sessionKey: string;
  location: LocationSample | null;
  recommend?: (input: { location: LocationSample }) => Promise<ClaimRecommendation>;
}) {
  const [state, setState] = useState<RecommendationState>({ recommendation: null, checking: false, error: "" });
  const requestRef = useRef({ at: 0, sequence: 0 });
  const cooldownUntilRef = useRef(0);
  const inFlightRef = useRef<Promise<ClaimRecommendation | null> | null>(null);
  const latestLocationRef = useRef(location);
  const recommendationRef = useRef(state.recommendation);
  latestLocationRef.current = location;
  recommendationRef.current = state.recommendation;

  const refresh = useCallback(async (): Promise<ClaimRecommendation | null> => {
    const sample = latestLocationRef.current;
    if (!enabled || !recommend || !sample) return null;
    const now = Date.now();
    if (now < cooldownUntilRef.current) return null;
    if (now - sample.capturedAtEpochMs > MAX_SAMPLE_AGE_MS || sample.accuracyMeters > MAX_RECOMMENDATION_ACCURACY_METERS) {
      setState((current) => current.recommendation === null ? current : { recommendation: null, checking: false, error: "" });
      return null;
    }
    const previous = requestRef.current;
    const elapsed = now - previous.at;
    if (inFlightRef.current) return inFlightRef.current;
    if (elapsed < RECOMMENDATION_REFRESH_MS) return recommendationRef.current;

    const sequence = previous.sequence + 1;
    requestRef.current = { at: now, sequence };
    setState((current) => ({ ...current, checking: true, error: "" }));
    let request: Promise<ClaimRecommendation | null> | null = null;
    request = (async () => { try {
      const recommendation = await recommend({ location: sample });
      if (requestRef.current.sequence === sequence) setState({ recommendation, checking: false, error: "" });
      return recommendation;
    } catch (reason) {
      if (requestRef.current.sequence === sequence) {
        if (reason instanceof ApiError && reason.status === 429) cooldownUntilRef.current = Date.now() + 15 * 60_000;
        setState((current) => ({ ...current, checking: false, error: reason instanceof Error ? reason.message : "Could not check nearby park boundaries." }));
      }
      return null;
    } finally {
      if (request && inFlightRef.current === request) inFlightRef.current = null;
    } })();
    inFlightRef.current = request;
    return request;
  }, [enabled, recommend]);

  useEffect(() => {
    cooldownUntilRef.current = 0;
    requestRef.current = { at: 0, sequence: requestRef.current.sequence + 1 };
    inFlightRef.current = null;
    queueMicrotask(() => setState({ recommendation: null, checking: false, error: "" }));
  }, [sessionKey]);

  useEffect(() => {
    if (!enabled || !location) {
      requestRef.current = { at: 0, sequence: requestRef.current.sequence + 1 };
      inFlightRef.current = null;
      queueMicrotask(() => setState({ recommendation: null, checking: false, error: "" }));
      return;
    }
    void refresh();
  }, [enabled, location, refresh]);

  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => void refresh(), RECOMMENDATION_REFRESH_MS + 250);
    return () => window.clearInterval(timer);
  }, [enabled, refresh]);

  useEffect(() => {
    if (state.recommendation?.status !== "recommended") return;
    const expiresIn = Date.parse(state.recommendation.expiresAt) - Date.now();
    const timer = window.setTimeout(() => setState({ recommendation: null, checking: false, error: "" }), Math.max(0, expiresIn));
    return () => window.clearTimeout(timer);
  }, [state.recommendation]);

  useEffect(() => {
    const clear = () => {
      if (document.visibilityState === "hidden" || !navigator.onLine) {
        requestRef.current = { at: 0, sequence: requestRef.current.sequence + 1 };
        inFlightRef.current = null;
        setState({ recommendation: null, checking: false, error: "" });
      }
    };
    document.addEventListener("visibilitychange", clear);
    window.addEventListener("offline", clear);
    return () => {
      document.removeEventListener("visibilitychange", clear);
      window.removeEventListener("offline", clear);
    };
  }, []);

  const clear = useCallback(() => {
    requestRef.current = { at: 0, sequence: requestRef.current.sequence + 1 };
    inFlightRef.current = null;
    setState({ recommendation: null, checking: false, error: "" });
  }, []);

  return { ...state, refresh, clear };
}

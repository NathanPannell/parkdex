"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { currentNativeAppState, FOREGROUND_LOCATION_WATCH_OPTIONS, LocationCapabilityError, NATIVE_APP_STATE_EVENT, watchCurrentLocation, type LocationSample } from "./native-capabilities";
import type { ClaimRecommendation } from "./claims-client";
import { ApiError } from "./account";

export type LiveLocationStatus = "idle" | "starting" | "ready" | "denied" | "unavailable";

const RECOMMENDATION_REFRESH_MS = 30_000;
const MAX_SAMPLE_AGE_MS = 20_000;
const MAX_RECOMMENDATION_ACCURACY_METERS = 50;

function statusFor(error: unknown): LiveLocationStatus {
  return error instanceof LocationCapabilityError && error.code === "permission-denied" ? "denied" : "unavailable";
}

/** Keep the foreground map location moving at native-provider cadence, with a browser-safe polling fallback. */
export function useLiveLocation(enabled = true) {
  const [location, setLocation] = useState<LocationSample | null>(null);
  const [status, setStatus] = useState<LiveLocationStatus>(enabled ? "starting" : "idle");
  const [error, setError] = useState("");
  const generationRef = useRef(0);
  const [documentVisible, setDocumentVisible] = useState(() => typeof document === "undefined" || document.visibilityState !== "hidden");
  const [nativeActive, setNativeActive] = useState(currentNativeAppState);
  const foreground = documentVisible && nativeActive;

  useEffect(() => {
    const updateVisibility = () => setDocumentVisible(document.visibilityState !== "hidden");
    const updateNativeState = (event: Event) => setNativeActive((event as CustomEvent<{ isActive?: boolean }>).detail?.isActive !== false);
    document.addEventListener("visibilitychange", updateVisibility);
    window.addEventListener(NATIVE_APP_STATE_EVENT, updateNativeState);
    return () => {
      document.removeEventListener("visibilitychange", updateVisibility);
      window.removeEventListener(NATIVE_APP_STATE_EVENT, updateNativeState);
    };
  }, []);

  const accept = useCallback((next: LocationSample) => {
    if (![next.latitude, next.longitude, next.accuracyMeters, next.capturedAtEpochMs].every(Number.isFinite)) return;
    setLocation(next);
    setStatus("ready");
    setError("");
  }, []);

  useEffect(() => {
    const generation = ++generationRef.current;
    if (!enabled || !foreground) {
      queueMicrotask(() => {
        if (generationRef.current !== generation) return;
        setLocation(null);
        setStatus("idle");
        setError("");
      });
      return;
    }
    const fail = (reason: unknown) => {
      if (generationRef.current !== generation) return;
      setLocation(null);
      setStatus(statusFor(reason));
      setError(reason instanceof Error ? reason.message : "Your location is unavailable right now.");
    };
    queueMicrotask(() => {
      if (generationRef.current === generation) {
        setStatus("starting");
        setError("");
      }
    });

    return watchCurrentLocation(FOREGROUND_LOCATION_WATCH_OPTIONS, (sample) => {
      if (generationRef.current === generation) accept(sample);
    }, fail);
  }, [accept, enabled, foreground]);

  return { location, status, error };
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

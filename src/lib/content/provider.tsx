import { App as CapacitorApp } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { createContentRuntime } from "./runtime";
import { createContentStore } from "./store";
import { contentFetch, getContentApiOrigin, subscribeContentConnectivity } from "./transport";
import type { ContentEnvironment, ContentRuntime, ContentStatus } from "./contracts";
import { useStore } from "../store";
import { useAuth } from "../accounts/AuthProvider";
import { isUsableGpsAccuracy } from "../geo";

const EMPTY_STATUS: ContentStatus = {
  phase: "starting",
  snapshot: null,
  downloadedBytes: 0,
  totalBytes: 0,
  activeDownloads: 0,
  fullMapReady: false,
  mapDetailReady: false,
  waitingForWifi: false,
  syncStage: "idle",
  error: null,
};

const NO_SUBSCRIBE = () => () => {};
const ContentContext = createContext<ContentRuntime | null>(null);

function contentEnvironment(): ContentEnvironment {
  const value = import.meta.env.VITE_CONTENT_ENV;
  // Keep the existing data-environment label; the API source ID also binds the cache to its host.
  return value === "main" ? "main" : "staging";
}

function initialConnectivity() {
  const connected = typeof navigator === "undefined" ? true : navigator.onLine;
  return {
    connected,
    wifi: false,
    contentDownloadAllowed: !Capacitor.isNativePlatform() && connected,
  };
}

export function ContentProvider({ children }: { children: ReactNode }) {
  const { state } = useStore();
  const auth = useAuth();
  const activeOwnerKey = auth.phase === "guest"
    ? "guest"
    : (auth.phase === "authenticated" || auth.phase === "offline-account") && auth.ownerAccountId
      ? `account:${auth.ownerAccountId.toLowerCase()}`
      : null;
  const claimsReady = state.progressReady && state.progressOwnerKey === activeOwnerKey;
  const claimsRef = useRef(state.claims);
  const claimsReadyRef = useRef(claimsReady);
  claimsRef.current = state.claims;
  claimsReadyRef.current = claimsReady;

  const runtimeRef = useRef<ContentRuntime | null>(null);
  if (!runtimeRef.current) {
    const store = createContentStore();
    runtimeRef.current = createContentRuntime({
      store,
      apiUrl: getContentApiOrigin(),
      environment: contentEnvironment(),
      claimedParkIds: () => claimsReadyRef.current ? Object.keys(claimsRef.current) : [],
      connectivity: initialConnectivity(),
      fetch: contentFetch,
    });
  }
  const runtime = runtimeRef.current;
  const stopTimer = useRef<number | undefined>(undefined);

  useLayoutEffect(() => {
    runtime.refreshClaimedParks();
  }, [runtime, state.progressReady, state.progressOwnerKey, state.claimRevision, auth.phase, auth.ownerAccountId]);

  useEffect(() => {
    if (stopTimer.current !== undefined) window.clearTimeout(stopTimer.current);
    let live = true;
    const stopConnectivity = subscribeContentConnectivity((connectivity) => runtime.setConnectivity(connectivity));
    let appListener: { remove: () => Promise<void> } | undefined;
    const setForeground = (foreground: boolean) => runtime.setForeground(foreground);
    const onVisibility = () => setForeground(document.visibilityState !== "hidden");

    onVisibility();
    document.addEventListener("visibilitychange", onVisibility);
    if (Capacitor.isNativePlatform()) {
      void CapacitorApp.addListener("appStateChange", ({ isActive }) => setForeground(isActive)).then((listener) => {
        if (live) appListener = listener;
        else void listener.remove();
      }).catch(() => {});
    }

    // Runtime owns storage initialization and shutdown, including URL revocation.
    void runtime.start().catch(() => {});
    return () => {
      live = false;
      document.removeEventListener("visibilitychange", onVisibility);
      stopConnectivity();
      void appListener?.remove();
      runtime.setForeground(false);
      // React StrictMode replays effects during development. Give the next setup
      // a turn to reclaim this runtime before releasing its storage.
      stopTimer.current = window.setTimeout(() => void runtime.stop(), 0);
    };
  }, [runtime]);

  useEffect(() => {
    const accuracy = state.accuracy;
    const usableGpsFix = isUsableGpsAccuracy(accuracy) && state.locationError !== "denied";
    runtime.setLocation(usableGpsFix ? state.user : null);
  }, [runtime, state.user, state.accuracy, state.locationError]);

  useEffect(() => {
    runtime.setBusy(state.screen === "camera" || state.screen === "claim" || state.screen === "share");
  }, [runtime, state.screen]);

  return <ContentContext.Provider value={runtime}>{children}</ContentContext.Provider>;
}

export function useContentRuntime() {
  const runtime = useContext(ContentContext);
  if (!runtime) throw new Error("useContentRuntime outside ContentProvider");
  return runtime;
}

export function useContentStatus(): ContentStatus {
  const runtime = useContentRuntime();
  return useSyncExternalStore((listener) => runtime.subscribe(listener), () => runtime.getStatus(), () => runtime.getStatus());
}

export function useMapDetailReady(): boolean {
  const runtime = useContentRuntime();
  return useSyncExternalStore(
    (listener) => runtime.subscribe(listener),
    () => runtime.getStatus().mapDetailReady,
    () => runtime.getStatus().mapDetailReady,
  );
}

// Select the snapshot inside the store read: status is replaced on every download
// progress tick, and returning it would re-render every catalogue reader each time.
export function useContent() {
  const runtime = useContentRuntime();
  return useSyncExternalStore((listener) => runtime.subscribe(listener), () => runtime.getStatus().snapshot, () => runtime.getStatus().snapshot);
}

// Presentation helpers such as Badge can still render in storybook-style isolated tests.
export function useOptionalContent() {
  const runtime = useContext(ContentContext);
  return useSyncExternalStore(
    (listener) => (runtime ? runtime.subscribe(listener) : NO_SUBSCRIBE()),
    () => (runtime?.getStatus() ?? EMPTY_STATUS).snapshot,
    () => (runtime?.getStatus() ?? EMPTY_STATUS).snapshot,
  );
}

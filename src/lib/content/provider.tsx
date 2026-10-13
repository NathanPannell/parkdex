import { App as CapacitorApp } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { contentChannelOverride } from "../contentChannel";
import { createContentRuntime } from "./runtime";
import { createContentStore } from "./store";
import { localCacheMarker } from "./leanCache";
import { readAllowMobileMapData, subscribeAllowMobileMapData } from "../downloadPreferences";
import { contentFetch, getContentApiOrigin, subscribeContentConnectivity } from "./transport";
import { BUILD_MAP_POINTER, OFFLINE_DOWNLOADS, type ContentEnvironment, type ContentRuntime, type ContentStatus } from "./contracts";
import { useStore } from "../store";
import { useAuth } from "../accounts/AuthProvider";
import { isUsableGpsAccuracy } from "../geo";
import { SHOW_BADGE_ART } from "../parks";

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
  const override = contentChannelOverride();
  if (override) return override;
  const value = import.meta.env.VITE_CONTENT_ENV;
  // Keep the existing data-environment label; the API source ID also binds the cache to its host.
  return value === "main" ? "main" : "staging";
}

function initialConnectivity() {
  const connected = typeof navigator === "undefined" ? true : navigator.onLine;
  return {
    connected,
    wifi: false,
    contentDownloadAllowed: connected,
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
      badgeArt: SHOW_BADGE_ART,
      connectivity: initialConnectivity(),
      fetch: contentFetch,
      mapPointer: BUILD_MAP_POINTER,
      appBuild: typeof __APP_BUILD__ === "undefined" ? "unknown" : __APP_BUILD__,
      cacheMarker: localCacheMarker(),
    });
  }
  const runtime = runtimeRef.current;
  const stopTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    // The switch only governs offline downloads (#199). Map detail around the player and park
    // content use any connection either way.
    runtime.setAllowMobileMapData?.(OFFLINE_DOWNLOADS && readAllowMobileMapData());
    return subscribeAllowMobileMapData((allowed) => runtime.setAllowMobileMapData?.(OFFLINE_DOWNLOADS && allowed));
  }, [runtime]);

  useLayoutEffect(() => {
    runtime.refreshClaimedParks();
  }, [runtime, state.progressReady, state.progressOwnerKey, state.claimRevision, auth.phase, auth.ownerAccountId]);

  useEffect(() => {
    if (stopTimer.current !== undefined) window.clearTimeout(stopTimer.current);
    let live = true;
    const stopConnectivity = subscribeContentConnectivity((connectivity) => runtime.setConnectivity(connectivity));
    const appListeners: { remove: () => Promise<void> }[] = [];
    const setForeground = (foreground: boolean) => runtime.setForeground(foreground);
    const onVisibility = () => setForeground(document.visibilityState !== "hidden");

    onVisibility();
    document.addEventListener("visibilitychange", onVisibility);
    if (Capacitor.isNativePlatform()) {
      const keep = (listener: { remove: () => Promise<void> }) => {
        if (live) appListeners.push(listener);
        else void listener.remove();
      };
      void CapacitorApp.addListener("appStateChange", ({ isActive }) => setForeground(isActive)).then(keep).catch(() => {});
      // A permission dialog pauses the Activity without stopping it, so no appStateChange follows.
      void CapacitorApp.addListener("resume", () => runtime.resumeAfterPause?.()).then(keep).catch(() => {});
    }

    // Runtime owns storage initialization and shutdown, including URL revocation.
    void runtime.start().catch(() => {});
    return () => {
      live = false;
      document.removeEventListener("visibilitychange", onVisibility);
      stopConnectivity();
      for (const listener of appListeners.splice(0)) void listener.remove();
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
    runtime.setBusy(state.screen === "camera");
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

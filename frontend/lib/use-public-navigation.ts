"use client";

import { useCallback, useEffect, useMemo, useSyncExternalStore, type SetStateAction } from "react";
import { hasAccountCallback, navigationUrl, readNavigation, type PublicNavigation } from "./navigation";

const navigationEvent = "parkdex:navigation";
function subscribe(onChange: () => void) {
  window.addEventListener("popstate", onChange);
  window.addEventListener(navigationEvent, onChange);
  return () => { window.removeEventListener("popstate", onChange); window.removeEventListener(navigationEvent, onChange); };
}
const getSnapshot = () => window.location.href;
const getServerSnapshot = () => "/";

export function usePublicNavigation() {
  const href = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const state = useMemo(() => readNavigation(href), [href]);
  useEffect(() => {
    const url = new URL(href, window.location.origin);
    if (url.pathname !== "/" || hasAccountCallback(url) ||
      !["view", "place", "mapQuery", "query"].some((key) => url.searchParams.has(key))) return;
    const next = navigationUrl(href, readNavigation(href));
    if (next === `${url.pathname}${url.search}${url.hash}`) return;
    window.history.replaceState(window.history.state, "", next);
    window.dispatchEvent(new Event(navigationEvent));
  }, [href]);
  const update = useCallback((patch: Partial<PublicNavigation>, history: "push" | "replace" = "replace") => {
    // AccountView consumes its one-use credentials before ordinary navigation can write history.
    if (hasAccountCallback(new URL(window.location.href))) return;
    const next = navigationUrl(window.location.href, { ...readNavigation(window.location.href), ...patch });
    const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (next === current) return;
    const currentState = window.history.state;
    const depth = Number.isSafeInteger(currentState?.parkdexRouteDepth) ? Math.max(0, currentState.parkdexRouteDepth) : 0;
    const nextState = history === "push" ? { ...currentState, parkdexRouteDepth: depth + 1 } : currentState;
    window.history[history === "push" ? "pushState" : "replaceState"](nextState, "", next);
    window.dispatchEvent(new Event(navigationEvent));
  }, []);
  const set = <K extends keyof PublicNavigation>(key: K, value: SetStateAction<PublicNavigation[K]>) => {
    const current = readNavigation(window.location.href)[key];
    update({ [key]: typeof value === "function" ? (value as (previous: PublicNavigation[K]) => PublicNavigation[K])(current) : value });
  };
  return { state, update, set };
}

export function notifyNavigationChange() { window.dispatchEvent(new Event(navigationEvent)); }

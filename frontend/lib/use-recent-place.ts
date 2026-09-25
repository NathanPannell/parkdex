"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import type { CachedPlaceBundle } from "./place-cache";
import { getRecentPlaceCache } from "./place-cache";
import type { Place } from "./places";

export type RecentPlaceSelection = {
  selectedId: string | null;
  status: "idle" | "loading" | "ready" | "error";
  bundle: CachedPlaceBundle | null;
  place: Place | null;
  photo: Blob | null;
  photoUrl: string | null;
  error: string | null;
  warning: string | null;
};

type ObjectUrlSnapshot = { photo: Blob | null; url: string | null };

const EMPTY_SELECTION: RecentPlaceSelection = {
  selectedId: null,
  status: "idle",
  bundle: null,
  place: null,
  photo: null,
  photoUrl: null,
  error: null,
  warning: null,
};

function selectionForBundle(selectedId: string, bundle: CachedPlaceBundle): RecentPlaceSelection {
  return {
    selectedId,
    status: "ready",
    bundle,
    place: bundle.place,
    photo: bundle.photo,
    photoUrl: null,
    error: null,
    warning: bundle.image && !bundle.photo
      ? "The full-resolution photo is not saved for offline use yet. Connect to retry."
      : null,
  };
}

function selectionForError(selectedId: string, error: unknown): RecentPlaceSelection {
  return {
    selectedId,
    status: "error",
    bundle: null,
    place: null,
    photo: null,
    photoUrl: null,
    error: error instanceof Error ? error.message : "Place details are unavailable while offline.",
    warning: null,
  };
}

function usePhotoObjectUrl(photo: Blob | null) {
  const current = useRef<ObjectUrlSnapshot>({ photo: null, url: null });
  const subscribe = useCallback((onChange: () => void) => {
    if (!photo || typeof URL.createObjectURL !== "function") {
      current.current = { photo, url: null };
      return () => undefined;
    }
    let url: string;
    try {
      url = URL.createObjectURL(photo);
    } catch {
      current.current = { photo, url: null };
      return () => undefined;
    }
    current.current = { photo, url };
    onChange();
    return () => {
      URL.revokeObjectURL(url);
      if (current.current.url === url) current.current = { photo: null, url: null };
    };
  }, [photo]);
  const getSnapshot = useCallback(() => current.current.photo === photo ? current.current.url : null, [photo]);
  return useSyncExternalStore(subscribe, getSnapshot, () => null);
}

/** Hydrates local detail immediately, then refreshes it while the selected detail view is open. */
export function useRecentPlace({ selectedId, apiBaseUrl }: { selectedId: string | null; apiBaseUrl: string }) {
  const [selection, setSelection] = useState<RecentPlaceSelection>(EMPTY_SELECTION);
  const photoUrl = usePhotoObjectUrl(selection.selectedId === selectedId ? selection.photo : null);

  useEffect(() => {
    if (!selectedId) return;

    let active = true;
    let cacheReadFinished = false;
    let refreshFailed = false;
    let activeRefreshes = 0;
    let refreshGeneration = 0;
    let latestBundle: CachedPlaceBundle | null = null;

    let cache: ReturnType<typeof getRecentPlaceCache>;
    try {
      cache = getRecentPlaceCache();
    } catch (error) {
      void Promise.resolve().then(() => {
        if (active) setSelection(selectionForError(selectedId, error));
      });
      return () => { active = false; };
    }

    const needsRetry = () => refreshFailed || Boolean(latestBundle?.image && !latestBundle.photo);
    const publishBundle = (bundle: CachedPlaceBundle) => {
      latestBundle = bundle;
      setSelection(selectionForBundle(selectedId, bundle));
    };

    const refresh = async () => {
      const currentGeneration = ++refreshGeneration;
      activeRefreshes += 1;
      try {
        const bundle = await cache.view(selectedId, apiBaseUrl);
        if (currentGeneration === refreshGeneration) refreshFailed = false;
        if (active && currentGeneration === refreshGeneration) publishBundle(bundle);
      } catch (error) {
        if (currentGeneration === refreshGeneration) refreshFailed = true;
        if (active && currentGeneration === refreshGeneration && cacheReadFinished && !latestBundle) {
          setSelection(selectionForError(selectedId, error));
        }
      } finally {
        activeRefreshes = Math.max(0, activeRefreshes - 1);
      }
    };

    const handleOnline = () => {
      // Restart a hung initial request if reconnect happens before any local bundle exists.
      if (needsRetry() || (!latestBundle && activeRefreshes > 0)) {
        void refresh();
      }
    };

    if (typeof window !== "undefined") window.addEventListener("online", handleOnline);

    void cache.get(selectedId).then((bundle) => {
      cacheReadFinished = true;
      if (!active) return;
      if (bundle && !latestBundle) publishBundle(bundle);
      else if (!bundle && refreshFailed && !latestBundle) setSelection(selectionForError(selectedId, new Error("Place details are unavailable while offline.")));
    }).catch((error: unknown) => {
      cacheReadFinished = true;
      if (active && refreshFailed && !latestBundle) setSelection(selectionForError(selectedId, error));
    });

    // view() updates recency because opening the detail view is an actual view.
    void refresh();

    return () => {
      active = false;
      if (typeof window !== "undefined") window.removeEventListener("online", handleOnline);
    };
  }, [apiBaseUrl, selectedId]);

  if (!selectedId) return EMPTY_SELECTION;
  if (selection.selectedId !== selectedId) {
    return {
      selectedId,
      status: "loading" as const,
      bundle: null,
      place: null,
      photo: null,
      photoUrl: null,
      error: null,
      warning: null,
    };
  }
  return {
    ...selection,
    photoUrl,
  };
}

"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import type { CachedPlaceBundle } from "./place-cache";
import { getRecentPlaceCache } from "./place-cache";
import type { PlaceImageRecord } from "./place-images";
import { getPlaceImages } from "./place-images";
import type { Place } from "./places";

export type RecentPlaceSelection = {
  selectedId: string | null;
  status: "idle" | "loading" | "ready" | "error";
  bundle: CachedPlaceBundle | null;
  place: Place | null;
  images: readonly PlaceImageRecord[];
  photo: Blob | null;
  photoUrl: string | null;
  photoUrls: readonly (string | null)[];
  error: string | null;
  warning: string | null;
};

type ObjectUrlSnapshot = { photos: readonly (Blob | null)[]; urls: readonly (string | null)[] };

const EMPTY_SELECTION: RecentPlaceSelection = {
  selectedId: null,
  status: "idle",
  bundle: null,
  place: null,
  images: [],
  photo: null,
  photoUrl: null,
  photoUrls: [],
  error: null,
  warning: null,
};

function selectionForBundle(selectedId: string, bundle: CachedPlaceBundle): RecentPlaceSelection {
  const galleryPhotos = bundle.galleryPhotos ?? [];
  const images = bundle.image ? [bundle.image, ...galleryPhotos.map((entry) => entry.image)] : [];
  const expectedImageCount = getPlaceImages(selectedId).length;
  const missingPhoto = Boolean((bundle.image && !bundle.photo)
    || galleryPhotos.some((entry) => !entry.photo)
    || expectedImageCount > images.length);
  return {
    selectedId,
    status: "ready",
    bundle,
    place: bundle.place,
    images,
    photo: bundle.photo,
    photoUrl: null,
    photoUrls: [],
    error: null,
    warning: missingPhoto
      ? "The full photo gallery is not fully saved for offline use yet. Connect to retry."
      : null,
  };
}

function selectionForError(selectedId: string, error: unknown): RecentPlaceSelection {
  return {
    selectedId,
    status: "error",
    bundle: null,
    place: null,
    images: [],
    photo: null,
    photoUrl: null,
    photoUrls: [],
    error: error instanceof Error ? error.message : "Place details are unavailable while offline.",
    warning: null,
  };
}

function usePhotoObjectUrls(photos: readonly (Blob | null)[]) {
  const emptyUrls = useMemo(() => photos.map(() => null), [photos]);
  const current = useRef<ObjectUrlSnapshot>({ photos: [], urls: [] });
  const subscribe = useCallback((onChange: () => void) => {
    const urls = photos.map((photo) => {
      if (!photo || typeof URL.createObjectURL !== "function") return null;
      try {
        return URL.createObjectURL(photo);
      } catch {
        return null;
      }
    });
    current.current = { photos, urls };
    onChange();
    return () => {
      urls.forEach((url) => {
        if (url) URL.revokeObjectURL(url);
      });
      if (current.current.photos === photos) current.current = { photos: [], urls: [] };
    };
  }, [photos]);
  const getSnapshot = useCallback(() => current.current.photos === photos ? current.current.urls : emptyUrls, [photos, emptyUrls]);
  const getServerSnapshot = useCallback(() => emptyUrls, [emptyUrls]);
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Hydrates local detail immediately, then refreshes it while the selected detail view is open. */
export function useRecentPlace({ selectedId, apiBaseUrl }: { selectedId: string | null; apiBaseUrl: string }) {
  const [selection, setSelection] = useState<RecentPlaceSelection>(EMPTY_SELECTION);
  const currentBundle = selection.selectedId === selectedId ? selection.bundle : null;
  const photos = useMemo(() => currentBundle
    ? [currentBundle.photo, ...(currentBundle.galleryPhotos ?? []).map((entry) => entry.photo)]
    : [], [currentBundle]);
  const photoUrls = usePhotoObjectUrls(photos);

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

    const needsRetry = () => refreshFailed || Boolean(latestBundle && selectionForBundle(selectedId, latestBundle).warning);
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
      images: [],
      photo: null,
      photoUrl: null,
      photoUrls: [],
      error: null,
      warning: null,
    };
  }
  return {
    ...selection,
    photoUrl: photoUrls[0] ?? null,
    photoUrls,
  };
}

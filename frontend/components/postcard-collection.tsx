"use client";

import { ChevronLeft, ChevronRight, RotateCcw, RotateCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { Visit } from "@/lib/account";
import type { Place } from "@/lib/places";
import { VisitPostcard } from "@/components/visit-postcard";

export const POSTCARD_BATCH_SIZE = 12;

export type VisitState = Record<string, Visit>;
export type PostcardVisitState = VisitState | readonly Visit[];

export type PostcardCollectionProps = {
  places: Place[];
  visits: PostcardVisitState;
  loadPhoto: (placeId: string) => Promise<Blob>;
  removePhoto?: (placeId: string) => Promise<void>;
  ownerKey?: string;
  onOpenPlace?: (placeId: string) => void;
};

export type PostcardEntry = {
  place: Place;
  visit: Visit;
};

function visitMap(visits: PostcardVisitState): Map<string, Visit> {
  if (Array.isArray(visits)) {
    const result = new Map<string, Visit>();
    for (const visit of visits) {
      const previous = result.get(visit.placeId);
      if (!previous || visitTime(visit.visitedAt) > visitTime(previous.visitedAt)) result.set(visit.placeId, visit);
    }
    return result;
  }
  const result = new Map<string, Visit>();
  for (const visit of Object.values(visits)) {
    const previous = result.get(visit.placeId);
    if (!previous || visitTime(visit.visitedAt) > visitTime(previous.visitedAt)) result.set(visit.placeId, visit);
  }
  return result;
}

function visitTime(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Return one claimed postcard per place, ordered newest first. */
export function sortPostcardEntries(places: readonly Place[], visits: PostcardVisitState): PostcardEntry[] {
  const byPlace = visitMap(visits);
  const uniquePlaces = new Map<string, Place>();
  for (const place of places) uniquePlaces.set(place.id, place);
  return [...uniquePlaces.values()]
    .map((place) => ({ place, visit: byPlace.get(place.id) }))
    .filter((entry): entry is PostcardEntry => Boolean(entry.visit?.claim))
    .sort((a, b) => {
      const dateOrder = visitTime(b.visit.visitedAt) - visitTime(a.visit.visitedAt);
      return dateOrder || a.place.name.localeCompare(b.place.name) || a.place.id.localeCompare(b.place.id);
    });
}

function entryKey(entries: readonly PostcardEntry[]): string {
  return entries.map(({ place, visit }) => `${place.id}:${visit.visitedAt}:${visit.claim?.hasPhoto ? "photo" : "outline"}`).join("|");
}

const POSTCARD_ROTATIONS = [-2.4, 1.6, -1.2, 2.1, -1.8, 0.8] as const;

type PostcardRotation = {
  x: number;
  y: number;
  pinned?: boolean;
};

const POSTCARD_TOUCH_ROTATION = { x: -4, y: 6 } as const;

function usePrefersReducedMotion(): boolean {
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(mediaQuery.matches);
    update();
    mediaQuery.addEventListener?.("change", update);
    return () => mediaQuery.removeEventListener?.("change", update);
  }, []);

  return reducedMotion;
}

function clampRotation(value: number): number {
  return Math.max(-8, Math.min(8, value));
}

function PostcardShelfCard({
  entry,
  index,
  loadPhoto,
  removePhoto,
  ownerKey,
  onOpenPlace,
  expanded,
  reducedMotion,
  isRotationPinned,
  onRotationChange,
  onRotationReset,
  onRotationToggle,
}: {
  entry: PostcardEntry;
  index: number;
  loadPhoto: (placeId: string) => Promise<Blob>;
  removePhoto?: (placeId: string) => Promise<void>;
  ownerKey: string;
  onOpenPlace?: (placeId: string) => void;
  expanded: boolean;
  reducedMotion: boolean;
  isRotationPinned: boolean;
  onRotationChange: (placeId: string, rotation: PostcardRotation) => void;
  onRotationReset: (placeId: string) => void;
  onRotationToggle: (placeId: string) => void;
}) {
  const { place, visit } = entry;
  const baseRotation = POSTCARD_ROTATIONS[index % POSTCARD_ROTATIONS.length];

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    // The shelf owns horizontal touch movement. Mouse tilt adds depth without
    // competing with a swipe or with the postcard's open action.
    if (event.pointerType !== "mouse" || reducedMotion) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const horizontal = (event.clientX - bounds.left) / bounds.width - 0.5;
    const vertical = (event.clientY - bounds.top) / bounds.height - 0.5;
    onRotationChange(place.id, { x: clampRotation(vertical * -12), y: clampRotation(horizontal * 12) });
  };

  const handleRotationKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if ((event.key === "Enter" || event.key === " ") && !event.repeat) {
      event.preventDefault();
      onRotationToggle(place.id);
    }
  };

  const style = {
    "--postcard-base-rotation": `${baseRotation}deg`,
  } as CSSProperties;

  return <div
    className="postcard-shelf__card"
    style={style}
    data-postcard-index={index}
    onPointerMove={handlePointerMove}
    onPointerLeave={() => onRotationReset(place.id)}
    onPointerCancel={() => onRotationReset(place.id)}
  >
    <VisitPostcard
      place={place}
      visit={visit}
      loadPhoto={loadPhoto}
      removePhoto={removePhoto}
      ownerKey={ownerKey}
      compact={expanded || index > 0}
      expandable
      loadWhenVisible
      onOpenPlace={onOpenPlace ? () => onOpenPlace(place.id) : undefined}
    />
    <div className="postcard-shelf__card-actions">
      <button
        className="postcard-shelf__rotate"
        type="button"
        aria-label={isRotationPinned ? `Reset ${place.name} postcard rotation` : `Rotate ${place.name} postcard`}
        aria-pressed={isRotationPinned}
        disabled={reducedMotion}
        title={reducedMotion ? "Rotation is disabled when reduced motion is on" : undefined}
        onClick={() => onRotationToggle(place.id)}
        onKeyDown={handleRotationKeyDown}
      >
        {isRotationPinned ? <RotateCcw size={16} aria-hidden="true" /> : <RotateCw size={16} aria-hidden="true" />}
        <span>{isRotationPinned ? "Reset rotation" : "Rotate postcard"}</span>
      </button>
    </div>
  </div>;
}

export function PostcardCollection({ places, visits, loadPhoto, removePhoto, ownerKey = "current", onOpenPlace }: PostcardCollectionProps) {
  const entries = useMemo(() => sortPostcardEntries(places, visits), [places, visits]);
  const key = entryKey(entries);
  const [pagination, setPagination] = useState<{ key: string; count: number }>({ key, count: POSTCARD_BATCH_SIZE });
  const [expanded, setExpanded] = useState(false);
  const [rotation, setRotation] = useState<Record<string, PostcardRotation>>({});
  const [scrollState, setScrollState] = useState({ previous: false, next: false });
  const trackRef = useRef<HTMLDivElement>(null);
  const prefersReducedMotion = usePrefersReducedMotion();
  const visibleCount = pagination.key === key ? Math.min(pagination.count, entries.length) : Math.min(POSTCARD_BATCH_SIZE, entries.length);
  const visibleEntries = entries.slice(0, visibleCount);
  const hasMore = visibleCount < entries.length;

  const updateScrollState = useCallback(() => {
    const track = trackRef.current;
    if (!track || expanded) {
      setScrollState({ previous: false, next: false });
      return;
    }
    setScrollState({
      previous: track.scrollLeft > 4,
      next: track.scrollLeft + track.clientWidth < track.scrollWidth - 4,
    });
  }, [expanded]);

  useEffect(() => {
    if (expanded) return;
    const track = trackRef.current;
    if (!track) return;
    updateScrollState();
    track.addEventListener("scroll", updateScrollState, { passive: true });
    const resizeObserver = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(updateScrollState);
    resizeObserver?.observe(track);
    return () => {
      track.removeEventListener("scroll", updateScrollState);
      resizeObserver?.disconnect();
    };
  }, [expanded, updateScrollState, visibleEntries.length]);

  const scrollShelf = useCallback((direction: -1 | 1) => {
    const track = trackRef.current;
    if (!track || typeof track.scrollBy !== "function") return;
    track.scrollBy({ left: direction * Math.max(220, track.clientWidth * 0.82), behavior: prefersReducedMotion ? "auto" : "smooth" });
  }, [prefersReducedMotion]);

  const handleShelfKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (expanded) return;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      scrollShelf(-1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      scrollShelf(1);
    } else if (event.key === "Home") {
      event.preventDefault();
      const track = trackRef.current;
      if (track && typeof track.scrollTo === "function") track.scrollTo({ left: 0, behavior: prefersReducedMotion ? "auto" : "smooth" });
    } else if (event.key === "End") {
      event.preventDefault();
      const track = trackRef.current;
      if (track && typeof track.scrollTo === "function") track.scrollTo({ left: track.scrollWidth, behavior: prefersReducedMotion ? "auto" : "smooth" });
    }
  };

  const handleRotationChange = useCallback((placeId: string, nextRotation: PostcardRotation) => {
    setRotation((current) => ({ ...current, [placeId]: { ...nextRotation, pinned: current[placeId]?.pinned } }));
  }, []);

  const handleRotationReset = useCallback((placeId: string) => {
    setRotation((current) => {
      const existing = current[placeId];
      if (!existing) return current;
      return {
        ...current,
        [placeId]: existing.pinned ? { ...POSTCARD_TOUCH_ROTATION, pinned: true } : { x: 0, y: 0 },
      };
    });
  }, []);

  const handleRotationToggle = useCallback((placeId: string) => {
    setRotation((current) => {
      if (current[placeId]?.pinned) return { ...current, [placeId]: { x: 0, y: 0 } };
      return { ...current, [placeId]: { ...POSTCARD_TOUCH_ROTATION, pinned: true } };
    });
  }, []);

  const loadMore = () => setPagination((current) => {
    const currentCount = current.key === key ? current.count : POSTCARD_BATCH_SIZE;
    return { key, count: currentCount + POSTCARD_BATCH_SIZE };
  });

  return <section className="impression-collection postcard-shelf" aria-label="Visit postcards">
    <header className="impression-collection-heading">
      <div>
        <h2>Postcards</h2>
        <p>Private to your account.</p>
      </div>
      <span className="impression-collection-count" aria-label={`${entries.length} postcards`}>{entries.length}</span>
    </header>
    {!entries.length ? <div className="postcard-shelf__empty">
      <strong>Log a visit</strong>
      <p>Confirm a visit while you’re there to start your postcards.</p>
    </div> : <>
      {!expanded && <p className="postcard-shelf__browse-hint">Swipe to browse</p>}
      <div className={`postcard-shelf__viewport ${expanded ? "postcard-shelf__viewport--expanded" : ""}`}>
        {!expanded && visibleEntries.length > 1 && <div className="postcard-shelf__arrows" aria-label="Browse postcard shelf">
          <button type="button" onClick={() => scrollShelf(-1)} disabled={!scrollState.previous} aria-label="Show previous postcards"><ChevronLeft size={18} aria-hidden="true" /></button>
          <button type="button" onClick={() => scrollShelf(1)} disabled={!scrollState.next} aria-label="Show next postcards"><ChevronRight size={18} aria-hidden="true" /></button>
        </div>}
        <div
          ref={trackRef}
          className={`postcard-shelf__track ${expanded ? "postcard-shelf__track--expanded" : ""}`}
          role={expanded ? "list" : "group"}
          aria-label={expanded ? "All postcards" : "Swipe through your postcards"}
          tabIndex={0}
          onKeyDown={handleShelfKeyDown}
          onScroll={updateScrollState}
        >
          {visibleEntries.map((entry, index) => {
            const cardRotation = rotation[entry.place.id];
            const style = {
              "--postcard-rotation-x": `${cardRotation?.x ?? 0}deg`,
              "--postcard-rotation-y": `${cardRotation?.y ?? 0}deg`,
            } as CSSProperties;
            return <div key={entry.place.id} style={style} className="postcard-shelf__rotation-state" role={expanded ? "listitem" : undefined}>
              <PostcardShelfCard
                entry={entry}
                index={index}
                loadPhoto={loadPhoto}
                removePhoto={removePhoto}
                ownerKey={ownerKey}
                onOpenPlace={onOpenPlace}
                expanded={expanded}
                reducedMotion={prefersReducedMotion}
                isRotationPinned={Boolean(cardRotation?.pinned)}
                onRotationChange={handleRotationChange}
                onRotationReset={handleRotationReset}
                onRotationToggle={handleRotationToggle}
              />
            </div>;
          })}
        </div>
      </div>
      <div className="postcard-shelf__footer">
        <button className="postcard-shelf__toggle" type="button" onClick={() => setExpanded((current) => !current)} aria-expanded={expanded}>
          {expanded ? "Back to shelf" : "View all postcards"}
        </button>
        {hasMore && <button className="impression-collection-load-more" type="button" onClick={loadMore}>Load more postcards</button>}
      </div>
    </>}
  </section>;
}

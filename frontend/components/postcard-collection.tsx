"use client";

import { useMemo, useState } from "react";
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

export function PostcardCollection({ places, visits, loadPhoto, removePhoto, ownerKey = "current", onOpenPlace }: PostcardCollectionProps) {
  const entries = useMemo(() => sortPostcardEntries(places, visits), [places, visits]);
  const key = entryKey(entries);
  const [pagination, setPagination] = useState<{ key: string; count: number }>({ key, count: POSTCARD_BATCH_SIZE });
  const visibleCount = pagination.key === key ? Math.min(pagination.count, entries.length) : Math.min(POSTCARD_BATCH_SIZE, entries.length);
  const visibleEntries = entries.slice(0, visibleCount);
  const hasMore = visibleCount < entries.length;

  const loadMore = () => setPagination((current) => {
    const currentCount = current.key === key ? current.count : POSTCARD_BATCH_SIZE;
    return { key, count: currentCount + POSTCARD_BATCH_SIZE };
  });

  return <section className="impression-collection" aria-label="Visit postcards">
    <header className="impression-collection-heading">
      <div>
        <p className="impression-eyebrow">Your postcards</p>
        <h2><span style={{ display: "block" }}>Little escapes.</span><span style={{ display: "block" }}>Yours to keep.</span></h2>
        <p>Private to your account.</p>
      </div>
      <span className="impression-collection-count" aria-label={`${entries.length} postcards`}>{entries.length}</span>
    </header>
    {!entries.length ? <p className="impression-collection-empty">Your first boundary claim will become a postcard here.</p> : <>
      <div className="impression-collection-latest">
        <p className="impression-collection-label">Latest visit</p>
        {visibleEntries[0] && <VisitPostcard
          place={visibleEntries[0].place}
          visit={visibleEntries[0].visit}
          loadPhoto={loadPhoto}
          removePhoto={removePhoto}
          ownerKey={ownerKey}
          expandable
          loadWhenVisible
          onOpenPlace={onOpenPlace ? () => onOpenPlace(visibleEntries[0].place.id) : undefined}
        />}
      </div>
      {visibleEntries.length > 1 && <div className="impression-collection-grid" aria-label="Earlier visits">
        {visibleEntries.slice(1).map(({ place, visit }) => <VisitPostcard
          key={place.id}
          place={place}
          visit={visit}
          loadPhoto={loadPhoto}
          removePhoto={removePhoto}
          ownerKey={ownerKey}
          compact
          expandable
          loadWhenVisible
          onOpenPlace={onOpenPlace ? () => onOpenPlace(place.id) : undefined}
        />)}
      </div>}
      {hasMore && <button className="impression-collection-load-more" type="button" onClick={loadMore}>Load more postcards</button>}
    </>}
  </section>;
}

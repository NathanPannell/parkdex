"use client";
/* eslint-disable @next/next/no-img-element -- private object URLs cannot use next/image */

import type { Place } from "@/lib/places";
import { ParkSeal } from "@/components/park-seal";

export type PostcardPhotoState = "empty" | "loading" | "failed";

export type PostcardPrintProps = {
  place: Place;
  photoUrl?: string;
  visitedAt?: string;
  sealed?: boolean;
  compact?: boolean;
  photoState?: PostcardPhotoState;
  photoAlt?: string;
  className?: string;
};

export function formatPostcardDate(value?: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return null;
  return new Intl.DateTimeFormat("en-CA", { day: "2-digit", month: "short", year: "numeric" }).format(date).toUpperCase();
}

function photoCopy(photoUrl: string | undefined, photoState: PostcardPhotoState): string {
  if (photoUrl) return "";
  if (photoState === "loading") return "Loading private photo…";
  if (photoState === "failed") return "Photo unavailable";
  return "Visit recorded";
}

export function PostcardPrint({
  place,
  photoUrl,
  visitedAt,
  sealed = false,
  compact = false,
  photoState = "empty",
  photoAlt,
  className = "",
}: PostcardPrintProps) {
  const date = formatPostcardDate(visitedAt);
  const classes = [
    "impression-print",
    sealed ? "impression-print--sealed" : "",
    compact ? "impression-print--compact" : "",
    className,
  ].filter(Boolean).join(" ");

  return <div className={classes} data-place-id={place.id} data-sealed={sealed ? "true" : "false"}>
    <div className="impression-print-shadow" aria-hidden="true" />
    <div className="impression-print-paper">
      <div className={`impression-print-photo ${photoUrl ? "impression-print-photo--captured" : "impression-print-photo--outline"}`}>
        {photoUrl ? <img src={photoUrl} alt={photoAlt ?? `Private visit photo from ${place.name}`} /> : <div className="impression-print-placeholder" data-photo-state={photoState}>
          <ParkSeal place={place} visitedAt={visitedAt} compact={compact} />
          <span>{photoCopy(photoUrl, photoState)}</span>
        </div>}
      </div>
      <div className="impression-print-caption">
        <h3>{place.name}</h3>
        {date && <time dateTime={visitedAt}>{date}</time>}
      </div>
      {sealed && <ParkSeal place={place} visitedAt={visitedAt} sealed compact={compact} className="impression-print-seal" />}
    </div>
  </div>;
}

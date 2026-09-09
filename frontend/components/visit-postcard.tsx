"use client";

import { Camera, ImageOff, Trash2 } from "lucide-react";
import { useEffect, useState, type CSSProperties } from "react";
import type { Visit } from "@/lib/account";
import type { Place } from "@/lib/places";

type Props = {
  place: Place;
  visit: Visit;
  loadPhoto: (placeId: string) => Promise<Blob>;
  removePhoto?: (placeId: string) => Promise<void>;
  onOpenPlace?: () => void;
  ownerKey?: string;
};

const dateTime = (value: string) => new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
const coordinates = (visit: Visit) => visit.claim ? `${visit.claim.coordinates.latitude.toFixed(5)}, ${visit.claim.coordinates.longitude.toFixed(5)}` : "Legacy field note";

export function VisitPostcard({ place, visit, loadPhoto, removePhoto, onOpenPlace, ownerKey = "current" }: Props) {
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [photoError, setPhotoError] = useState(false);
  const [removing, setRemoving] = useState(false);
  const hasPhoto = visit.claim?.hasPhoto === true;

  useEffect(() => {
    let active = true;
    let url: string | null = null;
    setPhotoUrl(null); setPhotoError(false);
    if (hasPhoto) void loadPhoto(place.id).then((blob) => {
      if (!active) return;
      url = URL.createObjectURL(blob); setPhotoUrl(url);
    }).catch(() => { if (active) setPhotoError(true); });
    return () => { active = false; if (url) URL.revokeObjectURL(url); };
  }, [hasPhoto, loadPhoto, ownerKey, place.id]);

  async function remove() {
    if (!removePhoto) return;
    setRemoving(true); setPhotoError(false);
    try { await removePhoto(place.id); } catch { setPhotoError(true); } finally { setRemoving(false); }
  }

  return <article className="visit-postcard" tabIndex={0} style={{ "--postcard-tilt": `${((place.id.length % 5) - 2) * .35}deg` } as CSSProperties}>
    <button className="postcard-face" type="button" onClick={onOpenPlace} disabled={!onOpenPlace} aria-label={onOpenPlace ? `Open ${place.name} visit` : undefined}>
      <span className="postcard-photo">
        {photoUrl ? <img src={photoUrl} alt={`Private visit photo from ${place.name}`} /> : <span className="postcard-photo-empty">{photoError ? <ImageOff size={28} /> : <Camera size={28} />}<small>{hasPhoto ? photoError ? "Photo unavailable" : "Loading private photo…" : "Visit recorded"}</small></span>}
      </span>
      <span className="postcard-script">{place.name}</span>
      <time dateTime={visit.visitedAt}>{dateTime(visit.visitedAt)}</time>
      <span className="postcard-coordinates">{coordinates(visit)}</span>
    </button>
    {hasPhoto && removePhoto && <button className="postcard-remove" type="button" onClick={() => void remove()} disabled={removing} aria-label={`Remove photo from ${place.name}`}><Trash2 size={15} />{removing ? "Removing…" : "Remove photo"}</button>}
    {photoError && <p role="alert">The private photo could not be loaded. Try again when you’re online.</p>}
  </article>;
}

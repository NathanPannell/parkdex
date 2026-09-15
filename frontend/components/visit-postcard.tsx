"use client";
/* eslint-disable @next/next/no-img-element -- authenticated photos use temporary object URLs */

import { Camera, ImageOff, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
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
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [photoState, setPhotoState] = useState<{ key: string; url?: string; failed?: boolean }>({ key: "" });
  const [removedLocally, setRemovedLocally] = useState(false);
  const [confirmRemoval, setConfirmRemoval] = useState(false);
  const [removeError, setRemoveError] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [keyboardTilt, setKeyboardTilt] = useState({ x: 0, y: 0 });
  const hasPhoto = visit.claim?.hasPhoto === true && !removedLocally;
  const photoKey = `${ownerKey}:${place.id}:${hasPhoto}:${loadAttempt}`;
  const currentPhoto = photoState.key === photoKey ? photoState : { key: photoKey };

  useEffect(() => {
    let active = true;
    let url: string | null = null;
    if (hasPhoto) void loadPhoto(place.id).then((blob) => {
      if (!active) return;
      url = URL.createObjectURL(blob); setPhotoState({ key: photoKey, url });
    }).catch(() => { if (active) setPhotoState({ key: photoKey, failed: true }); });
    return () => { active = false; if (url) URL.revokeObjectURL(url); };
  }, [hasPhoto, loadPhoto, photoKey, place.id]);

  async function remove() {
    if (!removePhoto) return;
    setRemoving(true); setRemoveError(false);
    try {
      await removePhoto(place.id);
      setRemovedLocally(true);
      setConfirmRemoval(false);
    } catch {
      setRemoveError(true);
    } finally { setRemoving(false); }
  }

  function tiltWithKeyboard(event: KeyboardEvent<HTMLElement>) {
    const movement: Record<string, { x: number; y: number }> = {
      ArrowUp: { x: -2, y: 0 }, ArrowDown: { x: 2, y: 0 }, ArrowLeft: { x: 0, y: -2 }, ArrowRight: { x: 0, y: 2 },
    };
    if (event.key === "Escape") { setKeyboardTilt({ x: 0, y: 0 }); return; }
    const delta = movement[event.key];
    if (!delta) return;
    event.preventDefault();
    setKeyboardTilt((current) => ({ x: Math.max(-6, Math.min(6, current.x + delta.x)), y: Math.max(-6, Math.min(6, current.y + delta.y)) }));
  }

  function followPointer(event: PointerEvent<HTMLElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const horizontal = (event.clientX - bounds.left) / bounds.width;
    const vertical = (event.clientY - bounds.top) / bounds.height;
    event.currentTarget.style.setProperty("--postcard-x", `${(vertical - .5) * -8}deg`);
    event.currentTarget.style.setProperty("--postcard-y", `${(horizontal - .5) * 10}deg`);
    event.currentTarget.style.setProperty("--postcard-shine-x", `${horizontal * 100}%`);
    event.currentTarget.style.setProperty("--postcard-shine-y", `${vertical * 100}%`);
  }

  const style = {
    "--postcard-tilt": `${((place.id.length % 5) - 2) * .35}deg`,
    "--postcard-x": `${keyboardTilt.x}deg`,
    "--postcard-y": `${keyboardTilt.y}deg`,
    "--postcard-shine-x": `${50 + keyboardTilt.y * 4}%`,
    "--postcard-shine-y": `${50 + keyboardTilt.x * 4}%`,
  } as CSSProperties;

  return <article className="visit-postcard" tabIndex={0} aria-label={`Inspect postcard from ${place.name}. Use arrow keys to tilt it.`} onKeyDown={tiltWithKeyboard} onPointerMove={followPointer} onPointerLeave={(event) => { event.currentTarget.style.setProperty("--postcard-x", `${keyboardTilt.x}deg`); event.currentTarget.style.setProperty("--postcard-y", `${keyboardTilt.y}deg`); }} style={style}>
    <span className="postcard-gloss" aria-hidden="true" />
    <button className="postcard-face" type="button" onClick={onOpenPlace} disabled={!onOpenPlace} aria-label={onOpenPlace ? `Open ${place.name} visit` : undefined}>
      <span className="postcard-photo">
        {currentPhoto.url ? <img src={currentPhoto.url} alt={`Private visit photo from ${place.name}`} /> : <span className="postcard-photo-empty">{currentPhoto.failed ? <ImageOff size={28} /> : <Camera size={28} />}<small>{hasPhoto ? currentPhoto.failed ? "Photo unavailable" : "Loading private photo…" : "Visit recorded"}</small></span>}
      </span>
      <span className="postcard-script">{place.name}</span>
      <time dateTime={visit.visitedAt}>{dateTime(visit.visitedAt)}</time>
      <span className="postcard-coordinates">{coordinates(visit)}</span>
    </button>
    {currentPhoto.failed && <div className="postcard-recovery"><p role="alert">The private photo could not be loaded.</p><button type="button" onClick={() => setLoadAttempt((attempt) => attempt + 1)}><RefreshCw size={15} />Retry private photo</button></div>}
    {hasPhoto && removePhoto && !confirmRemoval && <button className="postcard-remove" type="button" onClick={() => { setConfirmRemoval(true); setRemoveError(false); }} aria-label={`Remove photo from ${place.name}`}><Trash2 size={15} />Remove photo</button>}
    {hasPhoto && removePhoto && confirmRemoval && <div className="postcard-remove-confirm" role="group" aria-label={`Confirm removal of photo from ${place.name}`}><strong>Remove this private photo?</strong><span><button type="button" onClick={() => void remove()} disabled={removing}>{removing ? "Removing…" : "Remove photo"}</button><button type="button" onClick={() => { setConfirmRemoval(false); setRemoveError(false); }} disabled={removing}>Keep photo</button></span></div>}
    {removeError && <p role="alert">The photo could not be removed. Check your connection and try again.</p>}
  </article>;
}

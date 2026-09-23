"use client";

import { RefreshCw, Trash2 } from "lucide-react";
import { createPortal } from "react-dom";
import { useEffect, useRef, useState, type RefObject } from "react";
import type { Visit } from "@/lib/account";
import { addNativeBackConsumer } from "@/lib/native-back";
import { getNativeCapabilities } from "@/lib/native-capabilities";
import { isDurablePhotoOwner } from "@/lib/photo-retry";
import type { Place } from "@/lib/places";
import { PostcardPrint, type PostcardPhotoState } from "@/components/postcard-print";

export type VisitPostcardProps = {
  place: Place;
  visit: Visit;
  loadPhoto: (placeId: string) => Promise<Blob>;
  removePhoto?: (placeId: string) => Promise<void>;
  onOpenPlace?: () => void;
  ownerKey?: string;
  compact?: boolean;
  expandable?: boolean;
  loadWhenVisible?: boolean;
  className?: string;
};

type PhotoState = {
  key: string;
  status: PostcardPhotoState;
  url?: string;
};

type InteractionState = {
  scopeKey: string;
  loadAttempt: number;
  deviceCopyCheckAttempt: number;
  removedLocally: boolean;
  confirmRemoval: boolean;
  removeError: boolean;
  removing: boolean;
  deviceCopyConfirmRemoval: boolean;
  deviceCopyRemoveError: boolean;
  deviceCopyRemoving: boolean;
  expanded: boolean;
};

type DeviceCopyStatus = "checking" | "present" | "absent" | "failed";

type DeviceCopyState = {
  key: string;
  status: DeviceCopyStatus;
};

function initialInteraction(scopeKey: string): InteractionState {
  return {
    scopeKey,
    loadAttempt: 0,
    deviceCopyCheckAttempt: 0,
    removedLocally: false,
    confirmRemoval: false,
    removeError: false,
    removing: false,
    deviceCopyConfirmRemoval: false,
    deviceCopyRemoveError: false,
    deviceCopyRemoving: false,
    expanded: false,
  };
}

function useVisibleWhenRequested(ref: RefObject<HTMLElement | null>, requested: boolean): boolean {
  const hasIntersectionObserver = typeof IntersectionObserver !== "undefined";
  const [observed, setObserved] = useState(false);
  const visible = !requested || !hasIntersectionObserver || observed;

  useEffect(() => {
    if (!requested || !hasIntersectionObserver) return;
    const node = ref.current;
    if (!node) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setObserved(true);
        observer.disconnect();
      }
    }, { rootMargin: "180px 0px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasIntersectionObserver, ref, requested]);

  return visible;
}

function safeObjectUrl(blob: Blob): string {
  if (typeof URL.createObjectURL !== "function") throw new Error("Temporary photo URLs are unavailable");
  return URL.createObjectURL(blob);
}

export function VisitPostcard({
  place,
  visit,
  loadPhoto,
  removePhoto,
  onOpenPlace,
  ownerKey = "current",
  compact = false,
  expandable = false,
  loadWhenVisible = false,
  className = "",
}: VisitPostcardProps) {
  const cardRef = useRef<HTMLElement>(null);
  const visible = useVisibleWhenRequested(cardRef, loadWhenVisible);
  const scopeKey = `${ownerKey}\u0000${place.id}`;
  const [interaction, setInteraction] = useState<InteractionState>(() => initialInteraction(scopeKey));
  const [photoState, setPhotoState] = useState<PhotoState>({ key: "", status: "empty" });
  const [deviceCopyState, setDeviceCopyState] = useState<DeviceCopyState>({ key: "", status: "absent" });
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const scopedInteraction = interaction.scopeKey === scopeKey ? interaction : initialInteraction(scopeKey);
  const updateInteraction = (patch: Partial<Omit<InteractionState, "scopeKey">>) => {
    setInteraction((current) => ({ ...(current.scopeKey === scopeKey ? current : initialInteraction(scopeKey)), ...patch, scopeKey }));
  };
  const hasPhoto = visit.claim?.hasPhoto === true && !scopedInteraction.removedLocally;
  const requestKey = `${scopeKey}\u0000${visit.visitedAt}\u0000${hasPhoto ? "photo" : "empty"}\u0000${scopedInteraction.loadAttempt}`;
  const shouldLoadPhoto = hasPhoto && visible;
  const currentPhoto = photoState.key === requestKey ? photoState : { key: requestKey, status: hasPhoto ? "loading" : "empty" } as PhotoState;
  const deviceCopyStore = isDurablePhotoOwner(ownerKey) ? getNativeCapabilities().photoRetry : undefined;
  const deviceCopyKey = `${scopeKey}\u0000${visit.visitedAt}\u0000${visit.claim ? "claim" : "none"}\u0000${visit.claim?.hasPhoto ? "photo" : "outline"}\u0000${scopedInteraction.deviceCopyCheckAttempt}`;
  const canCheckDeviceCopy = Boolean(visit.claim && deviceCopyStore);
  const shouldCheckDeviceCopy = canCheckDeviceCopy && visible;
  const currentDeviceCopy = deviceCopyState.key === deviceCopyKey
    ? deviceCopyState
    : { key: deviceCopyKey, status: canCheckDeviceCopy ? "checking" : "absent" as const };

  useEffect(() => {
    if (!scopedInteraction.expanded) return;
    const close = () => setInteraction((current) => current.scopeKey === scopeKey ? { ...current, expanded: false } : current);
    const removeNativeBack = addNativeBackConsumer(close);
    const previous = document.activeElement as HTMLElement | null;
    closeButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])")].filter((element) => !element.hasAttribute("disabled"));
      if (!focusable.length) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      removeNativeBack();
      previous?.focus();
    };
  }, [scopeKey, scopedInteraction.expanded]);

  useEffect(() => {
    if (!hasPhoto || !shouldLoadPhoto) return;
    let active = true;
    let objectUrl: string | null = null;

    void loadPhoto(place.id).then((blob) => {
      const nextUrl = safeObjectUrl(blob);
      if (!active) {
        URL.revokeObjectURL(nextUrl);
        return;
      }
      objectUrl = nextUrl;
      setPhotoState({ key: requestKey, status: "empty", url: nextUrl });
    }).catch(() => {
      if (active) setPhotoState({ key: requestKey, status: "failed" });
    });

    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [hasPhoto, loadPhoto, place.id, requestKey, shouldLoadPhoto]);

  useEffect(() => {
    if (!shouldCheckDeviceCopy || !deviceCopyStore) return;
    const owner = ownerKey;
    const placeId = place.id;
    const checkKey = deviceCopyKey;
    let active = true;
    void deviceCopyStore.load(owner, placeId).then((photo) => {
      if (!active) return;
      setDeviceCopyState({ key: checkKey, status: photo ? "present" : "absent" });
    }).catch(() => {
      if (active) setDeviceCopyState({ key: checkKey, status: "failed" });
    });
    return () => { active = false; };
  }, [deviceCopyKey, deviceCopyStore, ownerKey, place.id, shouldCheckDeviceCopy]);

  async function remove() {
    if (!removePhoto) return;
    const removalScope = scopeKey;
    setInteraction((current) => current.scopeKey === removalScope ? { ...current, removing: true, removeError: false } : current);
    try {
      await removePhoto(place.id);
      setInteraction((current) => current.scopeKey === removalScope ? { ...current, removedLocally: true, confirmRemoval: false, removing: false } : current);
    } catch {
      setInteraction((current) => current.scopeKey === removalScope ? { ...current, removeError: true, removing: false } : current);
    }
  }

  async function removeDeviceCopy() {
    if (!deviceCopyStore || !isDurablePhotoOwner(ownerKey)) return;
    const removalScope = scopeKey;
    const removalKey = deviceCopyKey;
    const owner = ownerKey;
    const placeId = place.id;
    setInteraction((current) => current.scopeKey === removalScope
      ? { ...current, deviceCopyRemoving: true, deviceCopyRemoveError: false }
      : current);
    try {
      await deviceCopyStore.remove(owner, placeId);
      setDeviceCopyState((current) => current.key === removalKey ? { key: removalKey, status: "absent" } : current);
      setInteraction((current) => current.scopeKey === removalScope
        ? { ...current, deviceCopyConfirmRemoval: false, deviceCopyRemoving: false, deviceCopyRemoveError: false }
        : current);
    } catch {
      setInteraction((current) => current.scopeKey === removalScope
        ? { ...current, deviceCopyRemoving: false, deviceCopyRemoveError: true }
        : current);
    }
  }

  const classes = [
    "impression-postcard",
    compact ? "impression-postcard--compact" : "",
    expandable ? "impression-postcard--expandable" : "",
    className,
  ].filter(Boolean).join(" ");

  const openPostcard = () => {
    if (compact || expandable) updateInteraction({ expanded: true });
    else onOpenPlace?.();
  };
  const canOpen = compact || expandable || Boolean(onOpenPlace);
  // Expandable collection cards keep the grid quiet. Their controls live only
  // in the body portal so a confirmation cannot appear twice.
  const showPhotoActions = !compact && !expandable;
  const deviceCopyPresent = currentDeviceCopy.status === "present";
  const deviceCopyCheckFailed = currentDeviceCopy.status === "failed";

  const openLabel = compact || expandable
    ? `View ${place.name} postcard`
    : onOpenPlace
      ? `Open ${place.name} visit`
      : `Inspect postcard from ${place.name}`;

  return <article ref={cardRef} className={classes} data-place-id={place.id} aria-label={`Postcard from ${place.name}`}>
    <button className="impression-postcard-open" type="button" onClick={openPostcard} disabled={!canOpen} aria-label={openLabel}>
      <PostcardPrint
        place={place}
        visitedAt={visit.visitedAt}
        photoUrl={currentPhoto.url}
        photoState={currentPhoto.status}
        sealed={Boolean(visit.claim)}
        compact={compact}
      />
    </button>
    {!expandable && deviceCopyPresent && <div className="impression-postcard-device-copy" role="region" aria-label={`Saved device photo copy for ${place.name}`}>
      <p>A photo copy is still saved on this device.</p>
      {!scopedInteraction.deviceCopyConfirmRemoval && <button type="button" onClick={() => updateInteraction({ deviceCopyConfirmRemoval: true, deviceCopyRemoveError: false })}>Remove device copy</button>}
      {scopedInteraction.deviceCopyConfirmRemoval && <div className="impression-postcard-device-copy-confirm" role="group" aria-label={`Confirm removal of device photo copy from ${place.name}`}>
        <strong>Remove this device copy?</strong>
        <p>This may be an unfinished replacement. Removing it discards only the local copy; your saved server photo stays unchanged.</p>
        <button type="button" onClick={() => void removeDeviceCopy()} disabled={scopedInteraction.deviceCopyRemoving}>{scopedInteraction.deviceCopyRemoving ? "Removing…" : "Remove device copy"}</button>
        <button type="button" onClick={() => updateInteraction({ deviceCopyConfirmRemoval: false, deviceCopyRemoveError: false })} disabled={scopedInteraction.deviceCopyRemoving}>Keep device copy</button>
      </div>}
      {scopedInteraction.deviceCopyRemoveError && <p className="impression-postcard-error" role="alert">The device photo copy could not be removed. Try again when storage is available.</p>}
    </div>}
    {!expandable && deviceCopyCheckFailed && <div className="impression-postcard-device-copy impression-postcard-device-copy--failed" role="alert">
      <p>Parkdex could not check for a saved device photo copy.</p>
      <button type="button" onClick={() => updateInteraction({ deviceCopyCheckAttempt: scopedInteraction.deviceCopyCheckAttempt + 1, deviceCopyRemoveError: false })}>Retry device copy check</button>
    </div>}
    {expandable && deviceCopyPresent && <span className="impression-postcard-device-copy-indicator" aria-label="A photo copy is still saved on this device">Device copy saved</span>}
    {expandable && deviceCopyCheckFailed && <span className="impression-postcard-device-copy-indicator impression-postcard-device-copy-indicator--failed" aria-label="The device photo copy check failed">Device copy check needs attention</span>}
    {currentPhoto.status === "failed" && !compact && !expandable && <div className="impression-postcard-recovery">
      <p role="alert">The private photo could not be loaded.</p>
      <button type="button" onClick={() => updateInteraction({ loadAttempt: scopedInteraction.loadAttempt + 1 })}><RefreshCw size={15} />Retry private photo</button>
    </div>}
    {showPhotoActions && hasPhoto && removePhoto && !scopedInteraction.confirmRemoval && <button className="impression-postcard-remove" type="button" onClick={() => updateInteraction({ confirmRemoval: true, removeError: false })} aria-label={`Remove photo from ${place.name}`}><Trash2 size={15} />Remove photo</button>}
    {showPhotoActions && hasPhoto && removePhoto && scopedInteraction.confirmRemoval && <div className="impression-postcard-remove-confirm" role="group" aria-label={`Confirm removal of photo from ${place.name}`}>
      <strong>Remove this private photo?</strong>
      <span>
        <button type="button" onClick={() => void remove()} disabled={scopedInteraction.removing}>{scopedInteraction.removing ? "Removing…" : "Remove photo"}</button>
        <button type="button" onClick={() => updateInteraction({ confirmRemoval: false, removeError: false })} disabled={scopedInteraction.removing}>Keep photo</button>
      </span>
    </div>}
    {showPhotoActions && scopedInteraction.removeError && <p className="impression-postcard-error" role="alert">The photo could not be removed. Check your connection and try again.</p>}
    {scopedInteraction.expanded && typeof document !== "undefined" && createPortal(<div className="impression-postcard-dialog" role="dialog" aria-modal="true" aria-label={`Private postcard from ${place.name}`} onClick={() => updateInteraction({ expanded: false })}>
      <section ref={dialogRef} className="impression-postcard-dialog-card" onClick={(event) => event.stopPropagation()}>
        <header className="impression-postcard-dialog-heading">
          <strong>{place.name}</strong>
          <button ref={closeButtonRef} type="button" onClick={() => updateInteraction({ expanded: false })} aria-label="Close postcard">×</button>
        </header>
        <PostcardPrint place={place} visitedAt={visit.visitedAt} photoUrl={currentPhoto.url} photoState={currentPhoto.status} sealed={Boolean(visit.claim)} />
        {deviceCopyPresent && <div className="impression-postcard-device-copy" role="region" aria-label={`Saved device photo copy for ${place.name}`}>
          <p>A photo copy is still saved on this device.</p>
          {!scopedInteraction.deviceCopyConfirmRemoval && <button type="button" onClick={() => updateInteraction({ deviceCopyConfirmRemoval: true, deviceCopyRemoveError: false })}>Remove device copy</button>}
          {scopedInteraction.deviceCopyConfirmRemoval && <div className="impression-postcard-device-copy-confirm" role="group" aria-label={`Confirm removal of device photo copy from ${place.name}`}>
            <strong>Remove this device copy?</strong>
            <p>This may be an unfinished replacement. Removing it discards only the local copy; your saved server photo stays unchanged.</p>
            <button type="button" onClick={() => void removeDeviceCopy()} disabled={scopedInteraction.deviceCopyRemoving}>{scopedInteraction.deviceCopyRemoving ? "Removing…" : "Remove device copy"}</button>
            <button type="button" onClick={() => updateInteraction({ deviceCopyConfirmRemoval: false, deviceCopyRemoveError: false })} disabled={scopedInteraction.deviceCopyRemoving}>Keep device copy</button>
          </div>}
          {scopedInteraction.deviceCopyRemoveError && <p className="impression-postcard-error" role="alert">The device photo copy could not be removed. Try again when storage is available.</p>}
        </div>}
        {deviceCopyCheckFailed && <div className="impression-postcard-device-copy impression-postcard-device-copy--failed" role="alert">
          <p>Parkdex could not check for a saved device photo copy.</p>
          <button type="button" onClick={() => updateInteraction({ deviceCopyCheckAttempt: scopedInteraction.deviceCopyCheckAttempt + 1, deviceCopyRemoveError: false })}>Retry device copy check</button>
        </div>}
        {currentPhoto.status === "failed" && <div className="impression-postcard-recovery">
          <p role="alert">The private photo could not be loaded.</p>
          <button type="button" onClick={() => updateInteraction({ loadAttempt: scopedInteraction.loadAttempt + 1 })}><RefreshCw size={15} />Retry private photo</button>
        </div>}
        <div className="impression-postcard-dialog-actions">
          {onOpenPlace && <button type="button" onClick={onOpenPlace}>Open place</button>}
          {hasPhoto && removePhoto && !scopedInteraction.confirmRemoval && <button type="button" onClick={() => updateInteraction({ confirmRemoval: true, removeError: false })}><Trash2 size={15} />Remove photo</button>}
          {hasPhoto && removePhoto && scopedInteraction.confirmRemoval && <div className="impression-postcard-dialog-confirm" role="group" aria-label={`Confirm removal of photo from ${place.name}`}>
            <strong>Remove this private photo?</strong>
            <button type="button" onClick={() => void remove()} disabled={scopedInteraction.removing}>{scopedInteraction.removing ? "Removing…" : "Remove photo"}</button>
            <button type="button" onClick={() => updateInteraction({ confirmRemoval: false, removeError: false })} disabled={scopedInteraction.removing}>Keep photo</button>
          </div>}
        </div>
        {scopedInteraction.removeError && <p className="impression-postcard-error" role="alert">The photo could not be removed. Check your connection and try again.</p>}
      </section>
    </div>, document.body)}
  </article>;
}

"use client";

/* eslint-disable @next/next/no-img-element -- camera previews and private retry photos use temporary object URLs. */

import { Camera, Check, Image as ImageIcon, LockKeyhole, MapPin, RefreshCw, X } from "lucide-react";
import { useEffect, useRef } from "react";

import { ParkSeal } from "@/components/park-seal";
import { PostcardPrint } from "@/components/postcard-print";
import { addNativeBackConsumer } from "@/lib/native-back";
import { getPlaceImage } from "@/lib/place-images";
import { useArrivalClaimFlow, type ArrivalClaimFlowProps } from "@/lib/use-arrival-claim-flow";
import type { ClaimWorkflowStage } from "@/lib/claim-workflow";

const STAGE_LABELS: Record<ClaimWorkflowStage, string> = {
  camera: "Opening camera…",
  processing: "Preparing photo…",
  saving: "Saving retry copy…",
  location: "Confirming location…",
  recommendation: "Checking park boundary…",
  claim: "Saving visit…",
  reconciliation: "Checking saved visit…",
  upload: "Uploading photo…",
  cleanup: "Finalizing postcard…",
};

export function ClaimFlowBanner(props: ArrivalClaimFlowProps) {
  const { place, recommendation, busy, arrivalPhotoUrl } = props;
  const flow = useArrivalClaimFlow(props);
  const {
    flowScreen, working, workStage, message, retry, noPhotoRetry, reviewPhoto,
    successPhotoUrl, successConfirmation, hydrationStatus, dismissFlow,
    retryHydration, claimWithCamera, claimWithoutPhoto, retryFlow, discardRetry,
    retakePhoto, saveReviewedPhoto, openAccount, isWorking,
  } = flow;
  const dialogRef = useRef<HTMLElement>(null);
  const dismissFlowRef = useRef(dismissFlow);
  const placeImage = getPlaceImage(place.id);

  useEffect(() => { dismissFlowRef.current = dismissFlow; });
  useEffect(() => addNativeBackConsumer(() => {
    if (!isWorking()) dismissFlowRef.current();
  }), [isWorking]);
  useEffect(() => {
    const node = dialogRef.current;
    if (!node) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = () => [...node.querySelectorAll<HTMLElement>("button:not([disabled]), a[href]")];
    (node.querySelector<HTMLElement>("[data-impression-initial-focus]") ?? focusable()[0])?.focus();
    function keydown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (!isWorking()) { event.preventDefault(); dismissFlowRef.current(); }
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener("keydown", keydown);
    return () => { document.removeEventListener("keydown", keydown); previous?.focus(); };
  }, [flowScreen, hydrationStatus, isWorking]);

  const workingLabel = workStage ? STAGE_LABELS[workStage] : "Finishing…";
  const reviewUrl = reviewPhoto?.previewUrl;
  const success = successConfirmation;
  const uploadConfirmation = success ?? (retry?.stage === "upload" || retry?.stage === "cleanup" ? retry.confirmation : null);
  const arrivalIsInside = recommendation.candidate.matchKind === "exact";
  const pendingSync = Boolean(successConfirmation?.pendingSync || (retry?.stage === "upload" && retry.confirmation.pendingSync));
  const heroPhotoUrl = arrivalPhotoUrl ?? placeImage?.detail.src ?? null;
  const dialogTitle = flowScreen === "success" ? "You were here." : flowScreen === "review" ? "Keep this one?" : flowScreen === "upload" ? pendingSync ? "Saved on this device." : "A moment in the making." : retry || noPhotoRetry ? "Finish your postcard" : `Hello, ${place.name}.`;
  const closeButton = <button className="impression-icon-button impression-close" type="button" onClick={() => flow.closeToMap()} disabled={working} aria-label="Close sealed impression" data-impression-initial-focus><X size={19} /></button>;
  const pendingSyncCopy = "Saved on this device. Syncs when online.";
  const retryControl = !working && retry && <div className="impression-recovery" role="alert">
    <p>{message || (retry.stage === "upload" ? retry.confirmation.pendingSync ? pendingSyncCopy : "Your visit is saved, but the photo still needs to upload." : retry.stage === "cleanup" ? "Your postcard is saved, but the private retry copy still needs cleanup." : "Your saved photo is ready to finish the visit.")}</p>
    <div className="impression-recovery-actions">
      <button className="impression-primary" type="button" onClick={() => void retryFlow()} disabled={working || busy}>{working ? workingLabel : retry.stage === "upload" ? retry.confirmation.pendingSync ? "Retry sync" : "Retry photo" : retry.stage === "cleanup" ? "Retry private photo cleanup" : "Retry saved visit"}</button>
      {retry.stage !== "cleanup" && <button className="impression-secondary" type="button" onClick={() => void discardRetry()} disabled={working}>{retry.stage === "upload" ? "Keep visit without photo" : "Discard saved photo"}</button>}
    </div>
  </div>;
  const noPhotoRetryControl = noPhotoRetry && !retry && <div className="impression-recovery" role="status"><p>{message || "Your visit could not be saved yet."}</p>{!successConfirmation?.pendingSync && <button className="impression-primary" type="button" onClick={() => void retryFlow()} disabled={working || busy}>{working ? workingLabel : "Retry saved visit"}</button>}</div>;

  return <aside ref={dialogRef} className={`impression-flow impression-flow--${flowScreen}`} role="dialog" aria-modal="true" aria-labelledby="impression-flow-title" aria-live="polite">
    {flowScreen === "arrival" && <section className="impression-arrival">
      <div className="impression-arrival-art" aria-hidden={heroPhotoUrl ? undefined : "true"}>{heroPhotoUrl ? <img src={heroPhotoUrl} alt={placeImage?.alt ?? `${place.name} park photo`} /> : <div className="impression-arrival-placeholder"><MapPin size={44} /><span>Place boundary</span></div>}{placeImage && <small className="impression-arrival-credit">Photo <a href={placeImage.sourceUrl} target="_blank" rel="noreferrer">{placeImage.creator}</a> · <a href={placeImage.originalUrl} target="_blank" rel="noreferrer">Original</a> · <a href={placeImage.licenseUrl} target="_blank" rel="noreferrer">{placeImage.license}</a><span className="impression-arrival-credit-changes">Changes: {placeImage.changes}</span></small>}</div>
      <header className="impression-header"><span className="impression-brand"><MapPin size={18} /> Parkdex</span>{closeButton}</header>
      <div className="impression-sheet">
        {hydrationStatus === "ready" && !retry && !noPhotoRetry && <ParkSeal place={place} className="impression-arrival-seal" />}
        <span className="impression-eyebrow">{hydrationStatus === "loading" ? "Checking saved photos" : retry || noPhotoRetry ? "Your next postcard" : arrivalIsInside ? "Inside the park" : "Near the boundary"}</span>
        <h1 id="impression-flow-title">{dialogTitle}</h1>
        {!retry && !noPhotoRetry && <p>{message || (hydrationStatus === "loading" ? "Making sure an earlier photo is not overwritten." : arrivalIsInside ? "Your location is inside the published boundary." : `About ${Math.round(recommendation.candidate.distanceMeters)} m from the park boundary.`)}</p>}
        {hydrationStatus === "loading" && <button className="impression-primary" type="button" disabled><RefreshCw className="impression-spin" size={18} />Checking saved photos…</button>}
        {hydrationStatus === "failed" && <button className="impression-primary" type="button" onClick={retryHydration}><RefreshCw size={18} />Retry saved photo check</button>}
        {hydrationStatus === "ready" && !retry && !noPhotoRetry && <>
          <button className="impression-primary" type="button" onClick={() => void claimWithCamera()} disabled={working || busy}><Camera size={18} />{working ? workingLabel : "Log visit + photo"}</button>
          <button className="impression-secondary" type="button" onClick={() => void claimWithoutPhoto()} disabled={working || busy}>Log without photo</button>
        </>}
        {retryControl}
        {noPhotoRetryControl}
        {hydrationStatus === "ready" && !working && <button className="impression-text-button" type="button" onClick={dismissFlow}>Not now</button>}
      </div>
    </section>}

    {flowScreen === "review" && <section className="impression-review">
      <header className="impression-header">{closeButton}<span className="impression-photo-tag">Your view</span></header>
      <div className="impression-review-photo">{reviewUrl ? <img src={reviewUrl} alt={`Your selected visit photo preview for ${place.name}`} /> : <div className="impression-photo-missing"><ImageIcon size={34} /><span>Photo preview unavailable</span></div>}</div>
      <div className="impression-review-copy"><div><h1 id="impression-flow-title">Keep this one?</h1><p>{place.name}</p></div><button className="impression-icon-button" type="button" onClick={() => void retakePhoto()} disabled={working || busy} aria-label="Retake photo"><Camera size={19} /></button></div>
      <div className="impression-actions"><div className="impression-privacy"><LockKeyhole size={14} /> Just for you</div><button className="impression-primary" type="button" onClick={() => void saveReviewedPhoto()} disabled={working || busy}>{working ? workingLabel : <><Check size={18} />Save my visit</>}</button>{message && <p className="impression-state" role="alert">{message}</p>}</div>
    </section>}

    {flowScreen === "upload" && <section className="impression-upload">
      <header className="impression-header">{closeButton}<span className="impression-eyebrow">{workStage === "upload" ? "Sending your photo" : "Saving your visit"}</span></header>
      <div className="impression-upload-heading"><h1 id="impression-flow-title">{pendingSync ? "Saved on this device." : <>A moment<br />in the making.</>}</h1><p>{pendingSync ? "Syncs when online." : (workStage === "upload" || workStage === "cleanup" || retry?.stage === "upload") ? "Your visit is saved." : "Saving your visit."}</p></div>
      {pendingSync ? <p className="impression-upload-status" role="status">{pendingSyncCopy}</p> : <div className="impression-print-stage"><PostcardPrint place={place} photoUrl={reviewUrl ?? successPhotoUrl ?? undefined} visitedAt={uploadConfirmation?.visitedAt} /></div>}
      {!pendingSync && (retryControl || <div className="impression-upload-status" role="status"><RefreshCw className="impression-spin" size={18} /><span>{workingLabel}<small>We’ll keep a copy if it needs a retry.</small></span></div>)}
      <div className="impression-actions"><button className="impression-text-button" type="button" onClick={() => flow.closeToMap()} disabled={working}>Back to map</button></div>
    </section>}

    {flowScreen === "success" && <section className="impression-success">
      <header className="impression-header"><span className="impression-brand"><MapPin size={18} /> Parkdex</span>{closeButton}</header>
      <div className="impression-success-heading"><h1 id="impression-flow-title">You were here.</h1><p>Now it’s one of your places.</p></div>
      <div className="impression-print-stage"><PostcardPrint place={place} photoUrl={successPhotoUrl ?? undefined} visitedAt={success?.visitedAt} sealed compact={false} /></div>
      <p className="impression-success-caption">{success?.claim.hasPhoto ? "Visit and photo saved." : "Visit saved. Add a photo another time."}</p>
      {retryControl}
      <div className="impression-actions"><button className="impression-primary" type="button" onClick={() => flow.closeToMap()}><MapPin size={18} />Back to map</button><button className="impression-text-button" type="button" onClick={() => { if (!working) { dismissFlow(); openAccount(); } }}>See my collection</button></div>
    </section>}
  </aside>;
}

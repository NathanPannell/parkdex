"use client";

/* eslint-disable @next/next/no-img-element -- native camera previews use temporary object URLs */

import { Camera, Check, LocateFixed, RefreshCw, X } from "lucide-react";
import type { Visit } from "@/lib/account";
import type { ClaimWorkflowConfirmation, ClaimCreationInput } from "@/lib/claim-workflow";
import type { ClaimRecommendation } from "@/lib/claims-client";
import type { LocationSample } from "@/lib/native-capabilities";
import type { Place } from "@/lib/places";
import { usePlaceClaimFlow } from "@/lib/use-place-claim-flow";
import { VisitPostcard } from "./visit-postcard";

type Props = {
  place: Place;
  visit?: Visit;
  busy: boolean;
  /** Claims are account-owned; the parent passes true only for an authenticated session. */
  authenticated?: boolean;
  recommendClaim: (input: { location: LocationSample }) => Promise<ClaimRecommendation>;
  createClaim: (input: ClaimCreationInput) => Promise<ClaimWorkflowConfirmation>;
  reconcileClaim?: (placeId: string) => Promise<ClaimWorkflowConfirmation | null>;
  uploadPhoto: (placeId: string, file: File) => Promise<void>;
  loadPhoto: (placeId: string) => Promise<Blob>;
  removePhoto: (placeId: string) => Promise<void>;
  onClaimed?: (confirmation: ClaimWorkflowConfirmation) => void;
  ownerKey?: string;
  placeNameForId?: (placeId: string) => string | undefined;
  onOpenPlace?: (placeId: string) => void;
};

export function ClaimVisitPanel(props: Props) {
  const { place, visit, busy, authenticated = false, loadPhoto, removePhoto, ownerKey, onOpenPlace } = props;
  const flow = usePlaceClaimFlow(props);
  const claimExists = Boolean(visit?.claim);

  const retryControl = flow.uploadRetry && <div className="claim-photo-recovery" role="status">
    <p>{flow.message || (flow.uploadRetry.pendingSync ? "Saved on this device. Syncs when online." : "Your visit is saved, but the photo still needs to upload.")}</p>
    <button className="claim-refresh" type="button" onClick={() => void flow.retryPhoto()} disabled={flow.working || busy}>
      <RefreshCw size={16} />{flow.working ? flow.uploadRetry.pendingSync ? "Checking sync…" : "Uploading photo…" : flow.uploadRetry.pendingSync ? "Retry sync" : "Retry photo upload"}
    </button>
      {!flow.uploadRetry.pendingSync && <button type="button" onClick={() => void flow.discardPhoto()} disabled={flow.working || busy}><X size={16} />Keep visit without photo</button>}
  </div>;
  const cleanupControl = flow.cleanupPending && <div className="claim-photo-recovery" role="status">
    <p>This visit already has a photo, but its local retry copy could not be removed yet.</p>
    <button className="claim-refresh" type="button" onClick={() => void flow.retryCleanup()} disabled={flow.working || busy}>
      <RefreshCw size={16} />Retry private photo cleanup
    </button>
  </div>;
  const photoLoadControl = flow.photoLoadFailed && <div className="claim-photo-recovery" role="status">
    <p>{claimExists ? "A saved photo could not be loaded. Retry recovery before uploading it." : "A saved photo could not be loaded. Retry recovery before choosing another photo or logging the visit."}</p>
    <button className="claim-refresh" type="button" onClick={flow.retryPhotoRecovery} disabled={flow.working || busy}><RefreshCw size={16} />Retry saved photo recovery</button>
  </div>;
  const unresolvedControl = flow.unresolvedClaim && !claimExists && <div className="claim-photo-recovery" role="status">
    <p>{flow.message || "Parkdex could not confirm whether your visit saved. Reconnect before retrying."}</p>
    <button className="claim-refresh" type="button" onClick={() => void flow.retryUnresolvedClaim()} disabled={flow.working || busy}>
      <RefreshCw size={16} />{flow.working ? "Checking saved visit…" : "Retry saved visit"}
    </button>
  </div>;

  if (!authenticated) return <><section className="claim-owner-gate" aria-label="Account visits"><strong>Saved visits belong to your account.</strong><p>Sign in to confirm a visit or add a private photo to this field note.</p></section>{cleanupControl}{photoLoadControl}</>;
  if (visit?.claim) return <section className="claimed-visit"><VisitPostcard place={place} visit={visit} loadPhoto={loadPhoto} removePhoto={removePhoto} ownerKey={ownerKey} onOpenPlace={onOpenPlace ? () => onOpenPlace(place.id) : undefined} />{retryControl}{cleanupControl}{photoLoadControl}</section>;
  if (visit) return <><p className="legacy-visit-note"><Check size={16} />Visited {new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeStyle: "short" }).format(new Date(visit.visitedAt))}. This legacy visit remains in your journal.</p>{unresolvedControl}{cleanupControl}{photoLoadControl}</>;

  return <section className="claim-visit" aria-label={`Log visit at ${place.name}`}>
    {!flow.pendingSync && <>
    <div className="claim-photo-prompt">
      {flow.photoPreview ? <><img src={flow.photoPreview} alt="Photo ready to attach after you log this visit" /><div><strong>{flow.photoConfirmed ? `Photo ready for ${place.name}` : `Use this photo for ${place.name}?`}</strong><p>{flow.photoConfirmed ? "It will upload after this visit is saved." : "Confirm the visit before this recovered or new photo can be attached."}</p><span className="claim-photo-actions">{!flow.photoConfirmed && <button type="button" onClick={flow.confirmPhoto}><Check size={16} />Use photo</button>}{!flow.uploadRetry?.pendingSync && <button type="button" onClick={() => void flow.discardPhoto()} disabled={flow.working || busy}><X size={16} />Discard</button>}</span></div></> : <button type="button" onClick={() => void flow.capturePhoto()} disabled={flow.working || busy || flow.photoLoadPending || flow.photoLoadFailed}><Camera size={18} />Take an optional visit photo</button>}
    </div>
    {!flow.candidateMatches && <button className="claim-locate" type="button" onClick={() => void flow.locate()} disabled={flow.working || busy}><LocateFixed size={19} />{flow.working ? "Checking your boundary…" : "Confirm this visit"}</button>}
    {flow.candidateMatches && <div className="claim-recommendation"><strong>You’re here. Log this visit?</strong><p>{flow.recommendation?.status === "recommended" && flow.recommendation.candidate.matchKind === "exact" ? "Your location is inside the published boundary." : `You’re ${Math.round(flow.recommendation?.status === "recommended" ? flow.recommendation.candidate.distanceMeters : 0)} m from this boundary.`}</p><button type="button" onClick={() => void flow.claim()} disabled={flow.working || busy || flow.expired || Boolean(flow.pendingPhoto && !flow.photoConfirmed)}><Check size={19} />{flow.working ? "Saving visit…" : "Log this visit"}</button>{flow.pendingPhoto && !flow.photoConfirmed && <small>Use or discard the photo before logging the visit.</small>}{flow.expired && <button type="button" className="claim-refresh" onClick={() => void flow.locate()} disabled={flow.working || busy}><RefreshCw size={16} />Refresh location</button>}</div>}
    {flow.otherCandidate && <div className="claim-other-candidate" role="status"><p>Your location matches <strong>{flow.otherCandidateName}</strong>.</p>{onOpenPlace && <button type="button" onClick={() => onOpenPlace(flow.otherCandidate!.placeId)}>Open {flow.otherCandidateName}</button>}</div>}
    {flow.recommendationText && <p className="claim-state" role="status">{flow.recommendationText}</p>}
    </>}
    {flow.message && !flow.uploadRetry && !flow.unresolvedClaim && <p className="claim-state" role="status">{flow.message}</p>}
    {unresolvedControl}{retryControl}{cleanupControl}{photoLoadControl}
    {!flow.pendingSync && flow.sample && <small className="claim-sample">Location accuracy ±{Math.round(flow.sample.accuracyMeters)} m</small>}
  </section>;
}

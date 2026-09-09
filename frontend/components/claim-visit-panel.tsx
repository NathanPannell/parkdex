"use client";

import { Camera, Check, LocateFixed, RefreshCw, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ApiError, Visit } from "@/lib/account";
import type { ClaimConfirmation, ClaimRecommendation } from "@/lib/claims-client";
import { getNativeCapabilities, LocationCapabilityError, type LocationSample, type PhotoAsset } from "@/lib/native-capabilities";
import type { Place } from "@/lib/places";
import { VisitPostcard } from "./visit-postcard";

type Props = {
  place: Place;
  visit?: Visit;
  busy: boolean;
  recommendClaim: (input: { location: LocationSample } | { testFixtureId: string }) => Promise<ClaimRecommendation>;
  createClaim: (input: { recommendationToken: string; expectedPlaceId: string }) => Promise<ClaimConfirmation>;
  uploadPhoto: (placeId: string, file: File) => Promise<void>;
  loadPhoto: (placeId: string) => Promise<Blob>;
  removePhoto: (placeId: string) => Promise<void>;
  onClaimed?: (confirmation: ClaimConfirmation) => void;
  ownerKey?: string;
};

const TEST_FIXTURES = [{ id: "inside-goldstream", label: "Inside Goldstream" }, { id: "inside-saltspring", label: "Inside Salt Spring" }];
const claimMessage = (error: unknown) => {
  const code = (error as ApiError)?.code;
  if (error instanceof LocationCapabilityError) return error.code === "permission-denied" ? "Location permission is off. Allow it for Parkdex, then try again." : error.code === "timeout" ? "Your location took too long. Move into open sky and try again." : "Your location is unavailable. Check location services and try again.";
  if (code === "location_accuracy_too_low") return "Your location is too broad to confirm this boundary. Move into open sky and try again.";
  if (code === "location_stale") return "That location sample is too old. Refresh your location to continue.";
  if (code === "claim_recommendation_expired") return "This recommendation expired. Refresh your location and confirm the park again.";
  if (code === "claim_recommendation_not_found") return "That recommendation is no longer available. Refresh your location to make a new claim.";
  if (code === "claim_recommendation_candidate_mismatch") return "Your location now matches a different park. Refresh and confirm the new recommendation.";
  return error instanceof Error ? error.message : "Parkdex could not confirm this claim. Try again.";
};

export function ClaimVisitPanel({ place, visit, busy, recommendClaim, createClaim, uploadPhoto, loadPhoto, removePhoto, onClaimed, ownerKey }: Props) {
  const [working, setWorking] = useState(false), [message, setMessage] = useState(""), [recommendation, setRecommendation] = useState<ClaimRecommendation | null>(null);
  const [sample, setSample] = useState<LocationSample | null>(null), [pendingPhoto, setPendingPhoto] = useState<PhotoAsset | null>(null), [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [photoConfirmed, setPhotoConfirmed] = useState(false);
  const [uploadRetry, setUploadRetry] = useState<File | null>(null);
  const testMode = process.env.NEXT_PUBLIC_CLAIM_TEST_MODE === "true";
  const candidateMatches = recommendation?.status === "recommended" && recommendation.candidate.placeId === place.id;
  const expired = recommendation?.status === "recommended" && Date.now() >= new Date(recommendation.expiresAt).valueOf();
  const recommendationText = useMemo(() => recommendation?.status === "none" ? "No eligible park boundary matches this location." : recommendation?.status === "recommended" && !candidateMatches ? "Your location matches another park. Open that park to claim it." : "", [candidateMatches, recommendation]);

  useEffect(() => () => { if (photoPreview) URL.revokeObjectURL(photoPreview); }, [photoPreview]);

  async function capturePhoto() {
    setMessage("");
    try {
      const photo = await getNativeCapabilities().getPhoto();
      if (!photo) return;
      if (photoPreview) URL.revokeObjectURL(photoPreview);
      setPendingPhoto(photo); setPhotoConfirmed(false); setPhotoPreview(URL.createObjectURL(photo.file));
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not open the camera."); }
  }

  async function locate(input?: { testFixtureId: string }) {
    setWorking(true); setMessage(""); setRecommendation(null);
    try {
      const location = input ? null : await getNativeCapabilities().getCurrentLocation({ highAccuracy: true, timeoutMs: 12000, maxAgeMs: 0 });
      if (location) setSample(location);
      const result = await recommendClaim(input ?? { location: location! });
      setRecommendation(result);
    } catch (error) { setMessage(claimMessage(error)); } finally { setWorking(false); }
  }

  async function claim() {
    if (recommendation?.status !== "recommended" || !candidateMatches) return;
    if (expired) { setMessage("This recommendation expired. Refresh your location and confirm the park again."); return; }
    setWorking(true); setMessage("");
    try {
      const confirmation = await createClaim({ recommendationToken: recommendation.recommendationToken, expectedPlaceId: place.id });
      onClaimed?.(confirmation);
      if (pendingPhoto && photoConfirmed) {
        try { await uploadPhoto(place.id, pendingPhoto.file); setPendingPhoto(null); setPhotoPreview(null); }
        catch { setUploadRetry(pendingPhoto.file); setMessage("Your visit is saved, but the photo did not upload. Try the photo again when you’re online."); }
      }
      setRecommendation(null);
    } catch (error) { setMessage(claimMessage(error)); } finally { setWorking(false); }
  }

  async function retryPhoto() {
    if (!uploadRetry) return;
    setWorking(true); setMessage("");
    try { await uploadPhoto(place.id, uploadRetry); setUploadRetry(null); setPendingPhoto(null); setPhotoPreview(null); }
    catch { setMessage("The photo still could not upload. Your visit remains saved; try again later."); }
    finally { setWorking(false); }
  }

  if (visit?.claim) return <VisitPostcard place={place} visit={visit} loadPhoto={loadPhoto} removePhoto={removePhoto} ownerKey={ownerKey} />;
  if (visit) return <p className="legacy-visit-note"><Check size={16} />Visited {new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeStyle: "short" }).format(new Date(visit.visitedAt))}. This legacy visit remains in your journal.</p>;

  return <section className="claim-visit" aria-label={`Claim ${place.name}`}>
    <div className="claim-photo-prompt">
      {photoPreview ? <><img src={photoPreview} alt="Photo ready to attach after you claim this park" /><div><strong>{photoConfirmed ? `Photo ready for ${place.name}` : `Use this photo for ${place.name}?`}</strong><p>{photoConfirmed ? "It will upload after the boundary claim succeeds." : "Confirm the park before this recovered or new photo can be attached."}</p><span className="claim-photo-actions">{!photoConfirmed && <button type="button" onClick={() => setPhotoConfirmed(true)}><Check size={16} />Use photo</button>}<button type="button" onClick={() => { if (photoPreview) URL.revokeObjectURL(photoPreview); setPhotoPreview(null); setPendingPhoto(null); setPhotoConfirmed(false); }}><X size={16} />Discard</button></span></div></> : <button type="button" onClick={() => void capturePhoto()} disabled={working || busy}><Camera size={18} />Take an optional visit photo</button>}
    </div>
    {!candidateMatches && <button className="claim-locate" type="button" onClick={() => void locate()} disabled={working || busy}><LocateFixed size={19} />{working ? "Checking your boundary…" : "Check if I can claim a park"}</button>}
    {candidateMatches && <div className="claim-recommendation"><strong>You’re here, claim this park now</strong><p>{recommendation.candidate.matchKind === "exact" ? "Your location is inside the published boundary." : `You’re ${Math.round(recommendation.candidate.distanceMeters)} m from this boundary.`}</p><button type="button" onClick={() => void claim()} disabled={working || busy || expired || Boolean(pendingPhoto && !photoConfirmed)}><Check size={19} />{working ? "Claiming…" : "Claim this park"}</button>{pendingPhoto && !photoConfirmed && <small>Use or discard the photo before claiming.</small>}{expired && <button type="button" className="claim-refresh" onClick={() => void locate()}><RefreshCw size={16} />Refresh location</button>}</div>}
    {recommendationText && <p className="claim-state" role="status">{recommendationText}</p>}
    {message && <p className="claim-state claim-error" role="alert">{message}</p>}
    {uploadRetry && <button className="claim-refresh" type="button" onClick={() => void retryPhoto()} disabled={working}><RefreshCw size={16} />Retry photo upload</button>}
    {testMode && <label className="claim-fixture">Test location<select defaultValue="" onChange={(event) => { if (event.target.value) void locate({ testFixtureId: event.target.value }); }}><option value="" disabled>Choose fixture</option>{TEST_FIXTURES.map((fixture) => <option key={fixture.id} value={fixture.id}>{fixture.label}</option>)}</select></label>}
    {sample && <small className="claim-sample">Location accuracy ±{Math.round(sample.accuracyMeters)} m</small>}
  </section>;
}

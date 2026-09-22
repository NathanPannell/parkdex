"use client";

import { ArrowLeft, ArrowRight, BookmarkPlus, Camera, Check, Compass, Layers, List, Map as MapIcon, MapPin, Trees } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ParkSeal } from "@/components/park-seal";
import { PlaceImage } from "@/components/place-image";
import { PostcardPrint } from "@/components/postcard-print";
import { addNativeBackConsumer } from "@/lib/native-back";
import type { Place } from "@/lib/places";

export type FieldGuideOnboardingCompletion = "finished" | "skipped";

export type FieldGuideOnboardingProps = {
  /** A catalogue place supplies the onboarding art with real Parkdex data and imagery. */
  place?: Place;
  /** A private visit photo can be shown in the postcard preview when the parent has one. */
  postcardPhotoSrc?: string;
  /** Optional visit date for the postcard preview. */
  postcardVisitedAt?: string;
  /** Useful for restoring a deep link or replaying the welcome flow at a chosen page. */
  initialStep?: number;
  onComplete?: (reason: FieldGuideOnboardingCompletion) => void;
};

type StepId = "field-guide" | "collections" | "my-dex";

type OnboardingStep = {
  id: StepId;
  title: string;
  body: string;
  accent: "lime" | "ocean" | "sun";
};

const STEPS: readonly OnboardingStep[] = [
  {
    id: "field-guide",
    title: "Find your next park.",
    body: "Explore the Field Guide in a map or list. Search Vancouver Island parks and islands, then open a place to learn more.",
    accent: "lime",
  },
  {
    id: "collections",
    title: "Keep good possibilities close.",
    body: "Sign in to save parks to Collections for later plans, day loops, and the places you want within easy reach.",
    accent: "ocean",
  },
  {
    id: "my-dex",
    title: "Bring a visit home as a postcard.",
    body: "A confirmed on-location visit with a photo can become a sealed cream postcard in My Dex.",
    accent: "sun",
  },
];

function clampStep(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(STEPS.length - 1, Math.max(0, Math.trunc(value ?? 0)));
}

export function FieldGuideOnboarding({
  place,
  postcardPhotoSrc,
  postcardVisitedAt,
  initialStep = 0,
  onComplete,
}: FieldGuideOnboardingProps) {
  const [stepIndex, setStepIndex] = useState(() => clampStep(initialStep));
  const [visible, setVisible] = useState(true);
  const panelRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId().replace(/:/g, "");
  const descriptionId = `${titleId}-description`;
  const currentStep = STEPS[stepIndex];
  const lastStep = stepIndex === STEPS.length - 1;

  const complete = useCallback((reason: FieldGuideOnboardingCompletion) => {
    setVisible(false);
    previousFocusRef.current?.focus();
    onComplete?.(reason);
  }, [onComplete]);

  useEffect(() => {
    if (!visible) return;

    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const focusable = () => [...(panelRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
    ) ?? [])];
    const focusFirst = () => focusable()[0]?.focus();
    const frame = window.requestAnimationFrame(focusFirst);

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        complete("skipped");
        return;
      }
      if (event.key !== "Tab") return;

      const items = focusable();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [complete, visible]);

  useEffect(() => {
    if (!visible) return;
    return addNativeBackConsumer(() => complete("skipped"));
  }, [complete, visible]);

  const visual = useMemo(() => {
    if (currentStep.id === "field-guide") return <FieldGuideVisual place={place} />;
    if (currentStep.id === "collections") return <CollectionsVisual />;
    return <MyDexVisual place={place} photoUrl={postcardPhotoSrc} visitedAt={postcardVisitedAt} />;
  }, [currentStep.id, place, postcardPhotoSrc, postcardVisitedAt]);

  if (!visible) return null;

  const nextLabel = lastStep ? "Start exploring" : "Continue";

  return (
    <div className="field-guide-onboarding" role="presentation">
      <div
        ref={panelRef}
        className={`field-guide-onboarding__panel field-guide-onboarding__panel--${currentStep.id}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <div
          className={`field-guide-onboarding__visual field-guide-onboarding__visual--${currentStep.accent}`}
          key={currentStep.id}
          aria-hidden="true"
        >
          {visual}
        </div>

        <div className="field-guide-onboarding__copy">
          <div className="field-guide-onboarding__topline">
            <span className="field-guide-onboarding__brand"><Trees size={17} strokeWidth={2.6} />Parkdex</span>
            <span className="field-guide-onboarding__step-count">{stepIndex + 1} of {STEPS.length}</span>
          </div>
          <div className="field-guide-onboarding__progress" aria-label={`Onboarding step ${stepIndex + 1} of ${STEPS.length}`}>
            {STEPS.map((item, index) => <span key={item.id} className={index === stepIndex ? "is-current" : index < stepIndex ? "is-complete" : ""} />)}
          </div>
          <h1 id={titleId}>{currentStep.title}</h1>
          <p id={descriptionId}>{currentStep.body}</p>

          <div className="field-guide-onboarding__actions">
            {stepIndex > 0 ? (
              <button className="field-guide-onboarding__back" type="button" onClick={() => setStepIndex((current) => Math.max(0, current - 1))}>
                <ArrowLeft size={16} aria-hidden="true" />
                Back
              </button>
            ) : <span className="field-guide-onboarding__back-spacer" aria-hidden="true" />}
            <button className="field-guide-onboarding__primary" type="button" onClick={() => lastStep ? complete("finished") : setStepIndex((current) => Math.min(STEPS.length - 1, current + 1))}>
              {nextLabel}
              <ArrowRight size={17} aria-hidden="true" />
            </button>
            <button className="field-guide-onboarding__skip" type="button" onClick={() => complete("skipped")}>Skip</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function FieldGuideVisual({ place }: { place?: Place }) {
  return (
    <div className="field-guide-onboarding__browse" aria-label="Field Guide map and list preview">
      <div className="field-guide-onboarding__map-preview">
        {place && <ParkSeal place={place} className="field-guide-onboarding__map-seal" />}
        <span className="field-guide-onboarding__map-label"><MapIcon size={12} /> Map</span>
      </div>
      <div className="field-guide-onboarding__list-preview">
        <span className="field-guide-onboarding__list-label"><List size={12} /> List</span>
        <div className="field-guide-onboarding__place-preview">
          {place ? <PlaceImage place={place} variant="thumbnail" sizes="68px" preload /> : <span className="field-guide-onboarding__place-fallback"><Trees size={22} /></span>}
          <span>
            <small>{place?.region ?? "Vancouver Island"}</small>
            <strong>{place?.name ?? "A park to find"}</strong>
          </span>
        </div>
        <span className="field-guide-onboarding__browse-chip"><Compass size={12} /> Explore</span>
      </div>
    </div>
  );
}

function CollectionsVisual() {
  return (
    <div className="field-guide-onboarding__collections-preview" aria-label="Collections preview">
      <div className="field-guide-onboarding__collection-heading"><Layers size={18} /><span>Collections</span><BookmarkPlus size={17} /></div>
      <div className="field-guide-onboarding__collection-row field-guide-onboarding__collection-row--lime"><span><MapPin size={17} /></span><strong>Wishlist</strong><small>Save for later</small><ArrowRight size={15} /></div>
      <div className="field-guide-onboarding__collection-row field-guide-onboarding__collection-row--paper"><span><Trees size={17} /></span><strong>Coast days</strong><small>Build a day loop</small><ArrowRight size={15} /></div>
      <div className="field-guide-onboarding__collection-row field-guide-onboarding__collection-row--sun"><span><Check size={17} /></span><strong>Worth the ferry</strong><small>Places to remember</small><ArrowRight size={15} /></div>
    </div>
  );
}

function MyDexVisual({ place, photoUrl, visitedAt }: { place?: Place; photoUrl?: string; visitedAt?: string }) {
  return (
    <div className="field-guide-onboarding__my-dex-preview" aria-label="My Dex sealed postcard preview">
      <div className="field-guide-onboarding__postcard-stack" aria-hidden="true"><span /><span /></div>
      {place ? (
        <PostcardPrint place={place} photoUrl={photoUrl} visitedAt={visitedAt} sealed className="field-guide-onboarding__postcard" />
      ) : (
        <div className="field-guide-onboarding__postcard-fallback" role="img" aria-label="Sealed cream postcard preview">
          <span className="field-guide-onboarding__postcard-fallback-label">MY DEX</span>
          <span className="field-guide-onboarding__postcard-fallback-art"><ParkSeal place={placeholderPlace} sealed compact /></span>
          <strong>Your visit, pressed into memory.</strong>
        </div>
      )}
      <span className="field-guide-onboarding__camera-note"><Camera size={15} /> Photo + visit</span>
    </div>
  );
}

const placeholderPlace: Place = {
  id: "onboarding-preview",
  name: "Your next park",
  category: "provincial",
  latitude: 49,
  longitude: -124,
  region: "Vancouver Island",
  description: "",
  sourceUrl: "https://parkdex.app/",
  sourceName: "Parkdex",
};

export const fieldGuideOnboardingStepCount = STEPS.length;

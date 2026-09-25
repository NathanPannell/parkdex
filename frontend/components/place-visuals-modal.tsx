"use client";

/* eslint-disable @next/next/no-img-element -- the base URL can be a separately hosted public CDN. */

import { LoaderCircle, X } from "lucide-react";
import { createPortal } from "react-dom";
import { Fragment, lazy, Suspense, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { addNativeBackConsumer } from "@/lib/native-back";
import { placeVisualAssetUrls, type PlaceVisualEntry } from "@/lib/place-visuals";

const TerrainViewer = lazy(() => import("./place-visuals-3d"));

type PlaceVisualTab = "satellite" | "relief" | "model";

const tabLabels: Record<PlaceVisualTab, string> = {
  satellite: "Satellite",
  relief: "Relief",
  model: "3D",
};

type PlaceVisualsModalProps = {
  placeName: string;
  entry: PlaceVisualEntry;
  baseUrl: string;
  onClose: () => void;
};

function useModalFocus(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const node = ref.current;
    const focusable = () => [...(node?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href]') ?? [])];
    focusable()[0]?.focus();
    const removeNativeBack = addNativeBackConsumer(() => closeRef.current());
    function keydown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", keydown);
    return () => {
      removeNativeBack();
      document.removeEventListener("keydown", keydown);
      document.body.style.overflow = previousOverflow;
      previous?.focus();
    };
  }, []);
  return ref;
}

function SourceAttribution({ source }: { source: string }) {
  const parts = source.split(/(https?:\/\/[^\s]+)/gi);
  return <>{parts.map((part, index) => {
    if (!/^https?:\/\//i.test(part)) return part;
    const urlText = part.replace(/[.,;:!?)}\]]+$/, "");
    const trailingText = part.slice(urlText.length);
    try {
      const url = new URL(urlText);
      if (url.protocol !== "https:" && url.protocol !== "http:") return part;
      return <Fragment key={index}><a href={url.href} target="_blank" rel="noopener noreferrer">{urlText}</a>{trailingText}</Fragment>;
    } catch {
      return part;
    }
  })}</>;
}

export function PlaceVisualsModal({ placeName, entry, baseUrl, onClose }: PlaceVisualsModalProps) {
  const [tab, setTab] = useState<PlaceVisualTab>("satellite");
  const [imageState, setImageState] = useState<"loading" | "loaded" | "failed">("loading");
  const dialogRef = useModalFocus(onClose);
  const urls = useMemo(() => placeVisualAssetUrls(entry, baseUrl), [entry, baseUrl]);
  const imageUrl = tab === "satellite" ? urls.satellite : urls.relief;

  function selectTab(nextTab: PlaceVisualTab) {
    setTab(nextTab);
    if (nextTab !== "model") setImageState("loading");
  }

  function handleTabKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const current = ["satellite", "relief", "model"] as const;
    const index = current.indexOf(tab);
    const nextIndex = event.key === "ArrowRight" ? (index + 1) % current.length
      : event.key === "ArrowLeft" ? (index - 1 + current.length) % current.length
        : event.key === "Home" ? 0
          : event.key === "End" ? current.length - 1 : -1;
    if (nextIndex < 0) return;
    event.preventDefault();
    const nextTab = current[nextIndex];
    selectTab(nextTab);
    dialogRef.current?.querySelector<HTMLButtonElement>(`#place-visual-tab-${nextTab}`)?.focus();
  }

  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="place-visuals-backdrop" onClick={onClose}>
      <section
        ref={dialogRef}
        className="place-visuals-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="place-visuals-eyebrow place-visuals-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="place-visuals-header">
          <div>
            <span id="place-visuals-eyebrow" className="place-visuals-eyebrow">Map views</span>
            <h2 id="place-visuals-title">{placeName}</h2>
          </div>
          <button className="place-visuals-close" type="button" aria-label="Close map views" onClick={onClose}><X size={21} /></button>
        </header>

        <div className="place-visuals-tabs" role="tablist" aria-label={`${placeName} map views`} onKeyDown={handleTabKeyDown}>
          {(Object.keys(tabLabels) as PlaceVisualTab[]).map((value) => (
            <button
              key={value}
              id={`place-visual-tab-${value}`}
              type="button"
              role="tab"
              aria-selected={tab === value}
              aria-controls="place-visual-panel"
              tabIndex={tab === value ? 0 : -1}
              onClick={() => selectTab(value)}
            >{tabLabels[value]}</button>
          ))}
        </div>

        <div id="place-visual-panel" className="place-visuals-panel" role="tabpanel" aria-labelledby={`place-visual-tab-${tab}`} tabIndex={0}>
          {entry.renderMode === "point-centered-boundary-free" && (
            <p className="place-visuals-render-note" role="note">
              This view covers an 8 km square centered on an independently sourced park point. It does not depict a park boundary.
            </p>
          )}
          {tab === "model" ? (
            <Suspense fallback={<p className="place-visuals-status" role="status"><LoaderCircle size={18} className="place-visuals-spin" />Loading 3D viewer…</p>}>
              <TerrainViewer key={entry.placeId} src={urls.model} label={`${placeName} 3D terrain`} />
            </Suspense>
          ) : (
            <figure className="place-visuals-image-wrap">
              {imageState === "loading" && <p className="place-visuals-image-status" role="status"><LoaderCircle size={18} className="place-visuals-spin" />Loading {tabLabels[tab].toLocaleLowerCase()} view…</p>}
              {imageState === "failed" ? (
                <div className="place-visuals-unavailable" role="status">
                  <p>{tabLabels[tab]} imagery is unavailable right now.</p>
                  <button type="button" onClick={() => setImageState("loading")}>Retry image</button>
                </div>
              ) : (
                <img
                  key={imageUrl}
                  className={`place-visuals-image ${imageState === "loaded" ? "is-loaded" : ""}`}
                  src={imageUrl}
                  alt={`${tabLabels[tab]} view of ${placeName}`}
                  onLoad={() => setImageState("loaded")}
                  onError={() => setImageState("failed")}
                />
              )}
            </figure>
          )}
        </div>

        <div className="place-visuals-attribution" aria-label="Map view sources and dates">
          <section>
            <h3>Sources</h3>
            {entry.attribution.length ? <ul>{entry.attribution.map((source, index) => <li key={`${source}-${index}`}><SourceAttribution source={source} /></li>)}</ul> : <p>Source attribution unavailable.</p>}
          </section>
          <section>
            <h3>Acquired</h3>
            {entry.acquired.length ? <ul>{entry.acquired.map((date, index) => <li key={`${date}-${index}`}>{date}</li>)}</ul> : <p>Acquisition date unavailable.</p>}
          </section>
          {entry.needsReview && (
            <aside className="place-visuals-review" role="note">
              <strong>Review requested</strong>
              {entry.reviewFlags.length > 0 && <ul>{entry.reviewFlags.map((flag, index) => <li key={`${flag}-${index}`}>{flag}</li>)}</ul>}
            </aside>
          )}
        </div>
      </section>
    </div>,
    document.body,
  );
}

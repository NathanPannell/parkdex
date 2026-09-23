"use client";

import { AlertTriangle, Bug, CheckCircle2, Clipboard, LoaderCircle, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import {
  fieldDiagnostics,
  formatFieldDiagnosticFact,
  type FieldDiagnosticEntry,
  type FieldDiagnosticsStore,
} from "@/lib/field-diagnostics";

const serverSnapshot = { retained: [], visible: [], announcement: "" } as const;

function ToneIcon({ tone }: { tone: FieldDiagnosticEntry["tone"] }) {
  if (tone === "success") return <CheckCircle2 aria-hidden="true" size={19} />;
  if (tone === "warning" || tone === "error") return <AlertTriangle aria-hidden="true" size={19} />;
  return <LoaderCircle aria-hidden="true" size={19} />;
}

export function FieldDiagnosticRegion({ store = fieldDiagnostics }: { store?: FieldDiagnosticsStore }) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, () => serverSnapshot);
  const [detailsId, setDetailsId] = useState<string | null>(null);
  const details = detailsId ? snapshot.retained.find((entry) => entry.id === detailsId) ?? null : null;
  const detailsButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const visibility = () => document.visibilityState === "hidden"
      ? store.pauseAll("document-hidden")
      : store.resumeAll("document-hidden");
    visibility();
    document.addEventListener("visibilitychange", visibility);
    return () => document.removeEventListener("visibilitychange", visibility);
  }, [store]);

  function openDetails(entry: FieldDiagnosticEntry, button: HTMLButtonElement) {
    detailsButtonRef.current = button;
    store.pause(entry.id, "details");
    setDetailsId(entry.id);
  }

  const closeDetails = useCallback(() => {
    if (detailsId) store.resume(detailsId, "details");
    setDetailsId(null);
    requestAnimationFrame(() => detailsButtonRef.current?.focus());
  }, [detailsId, store]);

  return <>
    <section className="field-diagnostic-region" aria-label="Field diagnostics">
      <span className="sr-only" aria-live="polite" aria-atomic="true">{snapshot.announcement}</span>
      {snapshot.visible.map((entry) => <article
        className={`field-diagnostic-toast tone-${entry.tone}`}
        key={entry.id}
        onFocusCapture={() => store.pause(entry.id, "focus")}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) store.resume(entry.id, "focus");
        }}
      >
        <span className="field-diagnostic-icon"><ToneIcon tone={entry.tone} /></span>
        <span className="field-diagnostic-copy"><strong>{entry.title}</strong><small>{entry.summary}</small></span>
        <button className="field-diagnostic-details-button" type="button" onClick={(event) => openDetails(entry, event.currentTarget)}>Details</button>
        <button className="field-diagnostic-dismiss" type="button" onClick={() => store.dismiss(entry.id)} aria-label={`Dismiss ${entry.title}`}><X aria-hidden="true" size={18} /></button>
      </article>)}
    </section>
    {details && <FieldDiagnosticDetails entry={details} copyText={store.copyText(details.id)} onClose={closeDetails} />}
  </>;
}

function FieldDiagnosticDetails({ entry, copyText, onClose }: { entry: FieldDiagnosticEntry; copyText: string; onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    closeRef.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
      if (event.key !== "Tab") return;
      const controls = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button,[href],[tabindex]:not([tabindex="-1"])') ?? [])].filter((control) => !control.hasAttribute("disabled"));
      if (!controls.length) return;
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, [onClose]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(copyText);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  return <div className="field-diagnostic-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={dialogRef} className="field-diagnostic-dialog" role="dialog" aria-modal="true" aria-labelledby="field-diagnostic-title">
      <header><span><Bug aria-hidden="true" size={21} /></span><div><h2 id="field-diagnostic-title">{entry.title}</h2><p>Trace {entry.traceId}</p></div><button ref={closeRef} type="button" onClick={onClose} aria-label="Close diagnostic details"><X aria-hidden="true" size={20} /></button></header>
      <ol className="field-diagnostic-timeline">
        {entry.timeline.map((item) => <li key={item.id} className={`tone-${item.tone}`}>
          <div><strong>{item.summary}</strong><time>+{item.relativeMs < 1_000 ? `${Math.round(item.relativeMs)} ms` : `${(item.relativeMs / 1_000).toFixed(1)} s`}</time></div>
          <small>{item.stage.replaceAll("-", " ")}</small>
          {item.facts.length > 0 && <dl>{item.facts.map((fact, index) => { const [label, value] = formatFieldDiagnosticFact(fact); return <div key={`${fact.kind}-${index}`}><dt>{label}</dt><dd>{value}</dd></div>; })}</dl>}
        </li>)}
      </ol>
      <footer><button type="button" onClick={() => void copy()}><Clipboard aria-hidden="true" size={17} />Copy details</button><span role="status" aria-live="polite">{copyState === "copied" ? "Copied" : copyState === "failed" ? "Could not copy" : ""}</span></footer>
    </div>
  </div>;
}

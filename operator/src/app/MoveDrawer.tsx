import { useEffect, useMemo, useState, type FormEvent } from "react";
import { api, ApiError, errorText } from "../api";
import { Drawer, Icon, Spinner, timeAgo, useConfirm } from "../ui";
import { CHANNEL_NAME, megabytes, moveSummary, shortSha } from "./otaText";
import type { BundleView, Channel, ChannelView, MoveResult } from "./types";

export type MoveTarget = { channel: Channel; sha256: string | null };

type Draft = { channel: Channel; sha256: string; minimum: string; maximum: string; note: string };

function draftFor(target: MoveTarget, bundles: BundleView[], channels: ChannelView[]): Draft {
  const current = channels.find((view) => view.channel === target.channel)?.pointer ?? null;
  // Default to the bundle the channel ran before the current one, which is what a rollback wants.
  const choice = bundles.find((bundle) => bundle.sha256 === target.sha256)
    ?? bundles.find((bundle) => bundle.sha256 !== current?.sha256 && bundle.minimumNativeBuild !== null)
    ?? bundles[0];
  return {
    channel: target.channel,
    sha256: choice?.sha256 ?? "",
    minimum: choice?.minimumNativeBuild ? String(choice.minimumNativeBuild) : "",
    maximum: choice?.maximumNativeBuild ? String(Math.max(choice.maximumNativeBuild, choice.minimumNativeBuild ?? 0)) : choice?.minimumNativeBuild ? String(choice.minimumNativeBuild) : "",
    note: "",
  };
}

/**
 * Points a channel at a bundle that is already in R2. The server re-checks everything; this
 * form only explains the change and asks for confirmation.
 */
export function MoveDrawer({ target, bundles, channels, onClose, onMoved, onStale }: {
  target: MoveTarget | null;
  bundles: BundleView[];
  channels: ChannelView[];
  onClose(): void;
  onMoved(result: MoveResult): void;
  /** The pointer moved underneath the operator: reload before trying again. */
  onStale(): void;
}) {
  const confirm = useConfirm();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setError("");
    setDraft(target ? draftFor(target, bundles, channels) : null);
  }, [target, bundles, channels]);

  const view = draft ? channels.find((item) => item.channel === draft.channel) ?? null : null;
  const bundle = draft ? bundles.find((item) => item.sha256 === draft.sha256) ?? null : null;
  const minimum = Number(draft?.minimum);
  const maximum = Number(draft?.maximum);
  const needs = bundle?.minimumNativeBuild ?? null;
  const problem = useMemo(() => {
    if (!draft || !bundle) return "Choose a bundle.";
    if (needs === null) return "This bundle has no publish record, so the native builds it needs are unknown. Publish it with the script and --record.";
    if (!/^\d{1,10}$/.test(draft.minimum) || !/^\d{1,10}$/.test(draft.maximum) || minimum < 1) return "Native builds are whole version codes.";
    if (minimum < needs) return `This bundle needs native build ${needs} or newer.`;
    if (minimum > maximum) return "The minimum cannot be above the maximum.";
    if (view?.r2 === null) return "The dashboard cannot read this channel in R2.";
    if (view?.r2?.generation === null) return "The current pointer is not valid; repair it with the script first.";
    return "";
  }, [draft, bundle, needs, minimum, maximum, view]);

  function pick(sha256: string) {
    if (!draft) return;
    const next = bundles.find((item) => item.sha256 === sha256);
    setDraft({
      ...draft,
      sha256,
      minimum: next?.minimumNativeBuild ? String(next.minimumNativeBuild) : draft.minimum,
      maximum: next?.maximumNativeBuild ? String(Math.max(next.maximumNativeBuild, next.minimumNativeBuild ?? 0)) : draft.maximum,
    });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!draft || !view || !bundle || problem) return;
    const version = bundle.version ?? shortSha(bundle.sha256);
    const generation = view.r2?.generation ?? 0;
    const ok = await confirm({
      title: `Point ${CHANNEL_NAME[draft.channel].toLowerCase()} at ${version}?`,
      body: <>
        <p>Generation {generation} to {generation + 1}{view.pointer ? `, replacing ${view.pointer.version}` : ""}.</p>
        <ul>{moveSummary(view.pointer, { version, minimumNativeBuild: minimum, maximumNativeBuild: maximum }).map((line) => <li key={line}>{line}</li>)}</ul>
      </>,
      confirmLabel: `Move ${CHANNEL_NAME[draft.channel].toLowerCase()}`,
      icon: "rocket",
      tone: draft.channel === "production" ? "danger" : "default",
    });
    if (!ok) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<MoveResult>("/api/app/updates/move", {
        method: "POST",
        body: JSON.stringify({
          channel: draft.channel, sha256: draft.sha256, expectedGeneration: generation, expectedEtag: view.r2?.etag ?? null,
          minimumNativeBuild: minimum, maximumNativeBuild: maximum, note: draft.note,
        }),
      });
      onMoved(result);
    } catch (reason) {
      setError(errorText(reason, "The move failed."));
      if (reason instanceof ApiError && reason.status === 409) onStale();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer open={Boolean(target)} onClose={() => !busy && onClose()} label="Point a channel at a bundle">
      {draft && (
        <form className="build-form" onSubmit={submit}>
          <div className="drawer__head">
            <div>
              <p className="eyebrow">Publish or roll back</p>
              <h2>Point {CHANNEL_NAME[draft.channel].toLowerCase()} at a bundle</h2>
              <p className="muted">Only bundles already in R2. Build and upload new ones with the script.</p>
            </div>
            <button type="button" className="icon-button" onClick={onClose} aria-label="Close" disabled={busy}><Icon name="close" /></button>
          </div>
          <div className="drawer__body">
            <fieldset className="field">
              <legend>Channel</legend>
              <div className="choice-row choice-row--two">
                {(["staging", "production"] as const).map((channel) => {
                  const current = channels.find((item) => item.channel === channel);
                  return (
                    <label key={channel} className={`choice${draft.channel === channel ? " is-on" : ""}`}>
                      <input type="radio" name="channel" checked={draft.channel === channel} onChange={() => setDraft({ ...draft, channel })} />
                      <strong>{CHANNEL_NAME[channel]}</strong>
                      <span>{current?.pointer ? `Now ${current.pointer.version}, generation ${current.pointer.generation}` : "Nothing published"}</span>
                    </label>
                  );
                })}
              </div>
            </fieldset>

            <fieldset className="field">
              <legend>Bundle</legend>
              <div className="bundle-options" role="radiogroup" aria-label="Bundle">
                {bundles.map((item) => (
                  <label key={item.sha256} className={`bundle-option${draft.sha256 === item.sha256 ? " is-on" : ""}${item.minimumNativeBuild === null ? " is-unknown" : ""}`}>
                    <input type="radio" name="bundle" checked={draft.sha256 === item.sha256} onChange={() => pick(item.sha256)} />
                    <span className="bundle-option__main">
                      <strong className="mono">{item.version ?? shortSha(item.sha256, 12)}</strong>
                      <span className="muted">{megabytes(item.byteSize)}{item.uploadedAt ? ` · uploaded ${timeAgo(item.uploadedAt)}` : ""}</span>
                    </span>
                    <span className="bundle-option__meta">
                      {item.liveOn.map((channel) => <span key={channel} className={`live-tag live-tag--${channel}`}>{CHANNEL_NAME[channel]}</span>)}
                      <span className="muted">{item.minimumNativeBuild === null ? "Needs unknown" : `Needs ${item.minimumNativeBuild}+`}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            <div className="field-row">
              <label className="field">
                <span>Minimum native build</span>
                <input inputMode="numeric" value={draft.minimum} onChange={(event) => setDraft({ ...draft, minimum: event.target.value.trim() })} aria-describedby="move-min-hint" />
                <small className="muted" id="move-min-hint">{needs ? `The oldest build this bundle runs on is ${needs}.` : "Unknown for this bundle."}</small>
              </label>
              <label className="field">
                <span>Maximum native build</span>
                <input inputMode="numeric" value={draft.maximum} onChange={(event) => setDraft({ ...draft, maximum: event.target.value.trim() })} aria-describedby="move-max-hint" />
                <small className="muted" id="move-max-hint">The newest build checked with it. Later Play builds keep their own code.</small>
              </label>
            </div>

            <label className="field">
              <span>Note for the history</span>
              <input value={draft.note} maxLength={300} placeholder="e.g. Roll back: founders card crash on build 13" onChange={(event) => setDraft({ ...draft, note: event.target.value })} />
            </label>

            {bundle && !problem && (
              <div className="move-preview">
                <h3>What changes</h3>
                <ul>{moveSummary(view?.pointer ?? null, { version: bundle.version ?? shortSha(bundle.sha256), minimumNativeBuild: minimum, maximumNativeBuild: maximum }).map((line) => <li key={line}>{line}</li>)}</ul>
                <p className="muted">The dashboard writes generation {(view?.r2?.generation ?? 0) + 1} only if the pointer is still at generation {view?.r2?.generation ?? 0}, then reads it back through R2 and the CDN.</p>
              </div>
            )}
            {problem && draft.sha256 && <div className="notice" role="status"><Icon name="alert" size={18} /> <span>{problem}</span></div>}
            {error && <div className="notice notice--error" role="alert"><Icon name="alert" size={18} /> <span>{error}</span></div>}
          </div>
          <div className="drawer__foot">
            <span className="spacer" />
            <button type="button" className="button button--ghost" onClick={onClose} disabled={busy}>Cancel</button>
            <button type="submit" className="button button--primary" disabled={busy || Boolean(problem)}>{busy ? <><Spinner small /> Moving</> : "Review and move"}</button>
          </div>
        </form>
      )}
    </Drawer>
  );
}

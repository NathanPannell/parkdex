import { useState, type FormEvent } from "react";
import { api, errorText } from "../api";
import { fullDate, Icon, Spinner, timeAgo } from "../ui";
import { Hash } from "./Commands";
import { buildEffects, CHANNEL_NAME, megabytes, STATE_LABEL } from "./otaText";
import type { ChannelView, UpdateCheck } from "./types";

function answerText(answer: unknown): string {
  const value = (answer ?? {}) as Record<string, unknown>;
  if (typeof value.version === "string") return `Offers ${value.version}`;
  if (typeof value.kind === "string") return `${value.kind}${typeof value.error === "string" ? `: ${value.error}` : ""}`;
  return "No answer";
}

/** Sends a sample check to the live endpoint, as an installed build of that channel would. */
function LiveCheck({ view }: { view: ChannelView }) {
  const [build, setBuild] = useState(String(view.pointer?.maximumNativeBuild ?? 12));
  const [result, setResult] = useState<UpdateCheck | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function check(event: FormEvent) {
    event.preventDefault();
    if (!/^\d{1,10}$/.test(build) || Number(build) < 1) return setError("Enter a native version code, such as 12.");
    setBusy(true);
    setError("");
    try {
      setResult(await api<UpdateCheck>(`/api/app/updates/check?channel=${view.channel}&build=${build}`));
    } catch (reason) {
      setError(errorText(reason, "The check failed."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="live-check" onSubmit={check}>
      <label className="live-check__field">
        <span>Sample build</span>
        <input
          inputMode="numeric"
          value={build}
          onChange={(event) => setBuild(event.target.value.trim())}
          aria-label={`${CHANNEL_NAME[view.channel]} sample native build`}
        />
      </label>
      <button type="submit" className="button button--ghost button--small" disabled={busy}>
        {busy ? (
          <>
            <Spinner small /> Checking
          </>
        ) : (
          "Ask the endpoint"
        )}
      </button>
      {error && (
        <span className="live-check__error" role="alert">
          {error}
        </span>
      )}
      {result && (
        <div className="live-check__result" role="status">
          <span className={`check-pill${result.matches ? " check-pill--ok" : " check-pill--warn"}`}>
            {result.matches ? "Matches the pointer" : "Differs from the pointer"}
          </span>
          <span>
            <strong>{new URL(result.endpoint).host}</strong> answered HTTP {result.status || "none"}: <code>{answerText(result.answer)}</code>
          </span>
          {!result.matches && (
            <span className="muted">
              Expected <code>{answerText(result.expected)}</code>. The CDN caches pointers for up to 60 seconds.
            </span>
          )}
        </div>
      )}
    </form>
  );
}

export function ChannelCard({
  view,
  canMove,
  onMove,
  onPromote,
}: {
  view: ChannelView;
  canMove: boolean;
  onMove(): void;
  /** Staging only: send staging's live bundle to production. */
  onPromote?(): void;
}) {
  const pointer = view.pointer;
  const r2Differs = view.r2 && pointer && view.r2.generation !== null && view.r2.generation !== pointer.generation;
  return (
    <section className={`ui-card channel channel--${view.channel}`} aria-labelledby={`channel-${view.channel}`}>
      <header className="ui-card__head channel__head">
        <div>
          <p className="channel__kicker">Channel</p>
          <h2 className="ui-card__title" id={`channel-${view.channel}`}>
            {CHANNEL_NAME[view.channel]}
          </h2>
        </div>
        <span className={`state-pill state-pill--${view.state}`}>{STATE_LABEL[view.state]}</span>
      </header>
      <div className="ui-card__body channel__body">
        <p className="channel__detail">{view.detail}</p>
        {pointer && view.state !== "invalid" ? (
          <dl className="pointer-facts">
            <div>
              <dt>Version</dt>
              <dd className="mono">{pointer.version}</dd>
            </div>
            <div>
              <dt>Native builds</dt>
              <dd>
                {pointer.minimumNativeBuild === pointer.maximumNativeBuild
                  ? pointer.minimumNativeBuild
                  : `${pointer.minimumNativeBuild} to ${pointer.maximumNativeBuild}`}
              </dd>
            </div>
            <div>
              <dt>Generation</dt>
              <dd>
                {pointer.generation}
                {r2Differs && <span className="muted"> (R2: {view.r2!.generation})</span>}
              </dd>
            </div>
            <div>
              <dt>Published</dt>
              <dd title={fullDate(pointer.publishedAt)}>{timeAgo(pointer.publishedAt)}</dd>
            </div>
            <div>
              <dt>Bundle SHA-256</dt>
              <dd>
                <Hash value={pointer.sha256} />
              </dd>
            </div>
            <div>
              <dt>Source commit</dt>
              <dd>
                <Hash value={pointer.sourceCommit} length={7} />
              </dd>
            </div>
            <div>
              <dt>Size</dt>
              <dd>{megabytes(pointer.byteSize)}</dd>
            </div>
            <div>
              <dt>ETag</dt>
              <dd className="mono" title={view.etag ?? undefined}>
                {view.etag ? `${view.etag.replace(/"/g, "").slice(0, 10)}...` : "—"}
              </dd>
            </div>
          </dl>
        ) : (
          <div className="channel__empty">
            <Icon name={view.state === "invalid" ? "alert" : "upload"} size={22} />
            <span>
              {view.state === "invalid"
                ? "Devices are told updates are unavailable until a valid pointer is published."
                : "No pointer at app-bundles/channels/" + view.channel + "/current.json."}
            </span>
          </div>
        )}

        <div className="effects">
          <h3>What installed {view.channel} builds do</h3>
          <ul>
            {buildEffects(view.state === "live" ? pointer : null).map((effect) => (
              <li key={effect.text} className={`effect effect--${effect.tone}`}>
                <Icon name={effect.tone === "update" ? "download" : "check"} size={14} /> {effect.text}
              </li>
            ))}
          </ul>
        </div>

        <LiveCheck view={view} />
      </div>
      <footer className="channel__foot">
        <button
          type="button"
          className="button button--small"
          onClick={onMove}
          disabled={!canMove}
          title={canMove ? undefined : "Needs the Cloudflare token on this deployment"}
        >
          <Icon name="undo" size={15} /> Point at another bundle
        </button>
        {onPromote && (
          <button
            type="button"
            className="button button--primary button--small"
            onClick={onPromote}
            disabled={!canMove || !pointer || view.state === "invalid"}
          >
            <Icon name="rocket" size={15} /> Promote to production
          </button>
        )}
      </footer>
    </section>
  );
}

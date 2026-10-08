import { useEffect, useState } from "react";
import { api, type EmailDelivery, type FeedbackReport, type ReportStatus } from "../api";
import { Drawer, fullDate, Icon, Spinner } from "../ui";
import { COLUMNS, KINDS } from "./FeedbackBoard";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function deliveryLabel(delivery: EmailDelivery): string {
  if (delivery.status === "pending") return "Waiting";
  if (delivery.status === "sending") return "Sending";
  if (delivery.status === "sent") return "Sent";
  if (delivery.status === "failed") return "Failed";
  if (delivery.status === "ambiguous" || delivery.requiresConfirmation) return "Unclear";
  if (delivery.status === "disabled") return "Email off";
  return "Not sent";
}

export function FeedbackDrawer({ reportId, summary, onClose, onMove }: {
  reportId: string | null;
  summary: FeedbackReport | undefined;
  onClose(): void;
  onMove(report: FeedbackReport, status: ReportStatus): void;
  onUpdated?(report: FeedbackReport): void;
}) {
  const [detail, setDetail] = useState<FeedbackReport | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [revision, setRevision] = useState(0);
  const [shot, setShot] = useState<string | null>(null);
  const [shotState, setShotState] = useState<"idle" | "loading" | "ready" | "error">("idle");

  useEffect(() => {
    if (!reportId) return;
    const controller = new AbortController();
    setState("loading");
    api<{ report: FeedbackReport }>(`/api/feedback/${encodeURIComponent(reportId)}`, { signal: controller.signal })
      .then(({ report }) => { setDetail(report); setState("ready"); })
      .catch(() => { if (!controller.signal.aborted) setState("error"); });
    return () => controller.abort();
  }, [reportId, revision]);

  // Keep the drawer in step with drags and undo on the board.
  const report = detail && summary && summary.id === detail.id ? { ...detail, status: summary.status } : detail;

  useEffect(() => {
    if (!reportId || !detail?.hasScreenshot || detail.id !== reportId) {
      setShot(null);
      setShotState("idle");
      return;
    }
    const controller = new AbortController();
    let objectUrl: string | null = null;
    setShotState("loading");
    fetch(`/api/feedback/${encodeURIComponent(reportId)}/attachment`, { signal: controller.signal, credentials: "same-origin" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Screenshot unavailable");
        objectUrl = URL.createObjectURL(await response.blob());
        setShot(objectUrl);
        setShotState("ready");
      })
      .catch(() => { if (!controller.signal.aborted) setShotState("error"); });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [reportId, detail?.id, detail?.hasScreenshot]);

  const deliveries = report?.emails ?? [];
  const replyTo = report?.contact && report.email && EMAIL.test(report.email) ? report.email : null;
  const kind = report ? KINDS[report.kind] ?? KINDS.general : null;
  const appVersion = report?.context.version?.trim();

  return (
    <Drawer open={Boolean(reportId)} onClose={onClose} label="Feedback report">
      <div className="drawer__head">
        {report && kind ? (
          <div>
            <span className={`kind kind--${report.kind}`}><Icon name={kind.icon} size={14} /> {kind.label}</span>
            <p className="muted drawer__received">Received {fullDate(report.createdAt)}</p>
          </div>
        ) : <h2>Feedback report</h2>}
        <div className="drawer__actions">
          {replyTo && <a className="button button--primary button--small" href={`mailto:${replyTo}`} title={`Reply to ${replyTo}`}><Icon name="mail" size={15} /> Reply</a>}
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close"><Icon name="close" /></button>
        </div>
      </div>

      {state === "loading" && !report && <div className="drawer__state"><Spinner /> Opening report...</div>}
      {state === "error" && (
        <div className="drawer__state" role="alert">
          <p>This report could not be opened.</p>
          <button type="button" className="button button--ghost" onClick={() => setRevision((value) => value + 1)}>Try again</button>
        </div>
      )}

      {report && (
        <div className="drawer__body">
          <div className="segmented" role="radiogroup" aria-label="Status">
            {COLUMNS.map((column) => (
              <button
                key={column.status}
                type="button"
                role="radio"
                aria-checked={report.status === column.status}
                className={`segmented__item segmented__item--${column.status}${report.status === column.status ? " is-on" : ""}`}
                onClick={() => onMove(report, column.status)}
              >
                {column.label}
              </button>
            ))}
          </div>

          <figure className="quote">
            <figcaption>{replyTo ? `${replyTo} wrote` : "The player wrote"}</figcaption>
            <blockquote dir="auto">{report.message || "No message supplied."}</blockquote>
          </figure>

          {appVersion && (
            <p className="app-version"><span className="muted">App version</span> <strong>{appVersion}</strong></p>
          )}

          {report.hasScreenshot && (
            <section className="panel" id="attachment">
              <h3>Screenshot</h3>
              {shotState === "loading" && <div className="shot shot--loading"><Spinner small /> Loading screenshot...</div>}
              {shotState === "error" && <p className="muted">The screenshot could not be loaded.</p>}
              {shotState === "ready" && shot && <a href={shot} target="_blank" rel="noreferrer"><img className="shot" src={shot} alt="Screenshot attached to this report" /></a>}
            </section>
          )}

          <section className="panel">
            <h3>Emails</h3>
            {deliveries.length ? (
              <ul className="deliveries">
                {deliveries.map((delivery) => (
                  <li key={delivery.audience}>
                    <span>{delivery.audience === "operator" ? "Copy to you" : "Receipt to player"}</span>
                    <span className={`status-pill status-pill--${delivery.requiresConfirmation ? "confirm" : delivery.status}`}>{deliveryLabel(delivery)}</span>
                    <span className="muted">{delivery.sentAt ? `Sent ${fullDate(delivery.sentAt)}` : delivery.lastAttemptAt ? `Tried ${fullDate(delivery.lastAttemptAt)}` : "Not sent yet"}</span>
                  </li>
                ))}
              </ul>
            ) : <p className="muted">No emails for this report.</p>}
          </section>
        </div>
      )}
    </Drawer>
  );
}

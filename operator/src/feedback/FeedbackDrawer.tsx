import { useEffect, useMemo, useState } from "react";
import { api, errorText, type EmailDelivery, type FeedbackReport, type ReportStatus } from "../api";
import { Drawer, fullDate, Icon, Spinner, useToast } from "../ui";
import { COLUMNS, KINDS } from "./FeedbackBoard";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function deliveryLabel(delivery: EmailDelivery): string {
  if (delivery.requiresConfirmation) return "Check before retry";
  if (delivery.status === "pending") return "Waiting";
  if (delivery.status === "sending") return delivery.canRetry ? "Stuck sending" : "Sending";
  if (delivery.status === "sent") return "Sent";
  if (delivery.status === "failed") return "Failed";
  if (delivery.status === "ambiguous") return "Unclear";
  if (delivery.status === "disabled") return "Email off";
  return "Not sent";
}

function retryable(delivery: EmailDelivery): boolean {
  return delivery.canRetry || delivery.requiresConfirmation || delivery.status === "pending" || delivery.status === "failed";
}

export function FeedbackDrawer({ reportId, summary, onClose, onMove, onUpdated }: {
  reportId: string | null;
  summary: FeedbackReport | undefined;
  onClose(): void;
  onMove(report: FeedbackReport, status: ReportStatus): void;
  onUpdated(report: FeedbackReport): void;
}) {
  const toast = useToast();
  const [detail, setDetail] = useState<FeedbackReport | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [revision, setRevision] = useState(0);
  const [shot, setShot] = useState<string | null>(null);
  const [shotState, setShotState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [confirmRisk, setConfirmRisk] = useState(false);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    if (!reportId) return;
    const controller = new AbortController();
    setState("loading");
    setConfirmRisk(false);
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
  const needsConfirmation = deliveries.some((delivery) => delivery.requiresConfirmation);
  const retryAudiences = useMemo(() => deliveries.filter(retryable).map((delivery) => delivery.audience), [deliveries]);
  const replyTo = report?.contact && report.email && EMAIL.test(report.email) ? report.email : null;

  async function retry() {
    if (!report || !retryAudiences.length || (needsConfirmation && !confirmRisk)) return;
    setRetrying(true);
    try {
      const { results } = await api<{ results: { status: string }[] }>(`/api/feedback/${report.id}/retry-emails`, {
        method: "POST",
        body: JSON.stringify({ audiences: retryAudiences, ...(needsConfirmation ? { confirmAmbiguousAfter24h: true } : {}) }),
      });
      if (results.some((item) => item.status === "requires_confirmation" || item.status === "ambiguous")) toast.show("Delivery is unclear. Check the mailbox before trying again.", { tone: "error" });
      else if (results.some((item) => item.status === "failed")) toast.show("Retry finished, but an email still failed.", { tone: "error" });
      else if (results.some((item) => item.status === "sent")) toast.show("Email sent.");
      else toast.show("No email needed a retry.");
      const fresh = await api<{ report: FeedbackReport }>(`/api/feedback/${report.id}`);
      setDetail(fresh.report);
      onUpdated(fresh.report);
      setConfirmRisk(false);
    } catch (error) {
      toast.show(errorText(error, "Could not retry the email."), { tone: "error" });
    } finally {
      setRetrying(false);
    }
  }

  const kind = report ? KINDS[report.kind] ?? KINDS.general : null;
  const contextRows: [string, string | null | undefined][] = report ? [
    ["Park", report.context.parkName],
    ["Screen", report.context.screen],
    ["Device", report.context.platform],
    ["App version", report.context.version],
    ["Build", report.context.build],
    ["Park ID", report.context.parkId],
  ] : [];

  return (
    <Drawer open={Boolean(reportId)} onClose={onClose} label="Feedback report">
      <div className="drawer__head">
        {report && kind ? (
          <div>
            <span className={`kind kind--${report.kind}`}><Icon name={kind.icon} size={14} /> {kind.label}</span>
            <h2>{report.message.split(/\s+/).slice(0, 8).join(" ") || "Feedback report"}{report.message.split(/\s+/).length > 8 ? "..." : ""}</h2>
            <p className="muted">Received {fullDate(report.createdAt)}</p>
          </div>
        ) : <h2>Feedback report</h2>}
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close"><Icon name="close" /></button>
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

          <section className="panel">
            <h3>Message</h3>
            <p className="message" dir="auto">{report.message || "No message supplied."}</p>
          </section>

          <section className="panel">
            <h3>Sent with the report</h3>
            <dl className="facts">
              {contextRows.filter(([, value]) => value).map(([label, value]) => (
                <div key={label}><dt>{label}</dt><dd>{value}</dd></div>
              ))}
            </dl>
            {!contextRows.some(([, value]) => value) && <p className="muted">No app context was included.</p>}
          </section>

          <section className="panel panel--row">
            <div>
              <h3>Follow-up</h3>
              <p className="muted">
                {replyTo ? "They asked for a reply." : report.contact ? "They asked for a reply, but no usable email was saved." : "They did not ask to be contacted."}
              </p>
            </div>
            {replyTo && <a className="button button--primary" href={`mailto:${replyTo}`}><Icon name="mail" size={16} /> Reply</a>}
          </section>

          {report.hasScreenshot && (
            <section className="panel" id="attachment">
              <h3>Screenshot</h3>
              {shotState === "loading" && <div className="shot shot--loading"><Spinner small /> Loading screenshot...</div>}
              {shotState === "error" && <p className="muted">The screenshot could not be loaded.</p>}
              {shotState === "ready" && shot && <a href={shot} target="_blank" rel="noreferrer"><img className="shot" src={shot} alt="Screenshot attached to this report" /></a>}
            </section>
          )}

          <section className="panel">
            <div className="panel__title-row">
              <h3>Email delivery</h3>
              <button type="button" className="button button--ghost button--small" disabled={!retryAudiences.length || retrying || (needsConfirmation && !confirmRisk)} onClick={() => void retry()}>
                {retrying ? <><Spinner small /> Retrying</> : retryAudiences.length ? <><Icon name="refresh" size={15} /> Retry</> : "Nothing to retry"}
              </button>
            </div>
            {deliveries.length ? (
              <ul className="deliveries">
                {deliveries.map((delivery) => (
                  <li key={delivery.audience}>
                    <span>{delivery.audience === "operator" ? "Copy to you" : "Receipt to player"}</span>
                    <span className={`status-pill status-pill--${delivery.requiresConfirmation ? "confirm" : delivery.status}`}>{deliveryLabel(delivery)}</span>
                    <span className="muted">{delivery.sentAt ? `Sent ${fullDate(delivery.sentAt)}` : delivery.lastAttemptAt ? `Tried ${fullDate(delivery.lastAttemptAt)}` : "Not attempted"} · {delivery.attempts} {delivery.attempts === 1 ? "attempt" : "attempts"}</span>
                    {delivery.lastError && <span className="delivery-error">{delivery.lastError}</span>}
                  </li>
                ))}
              </ul>
            ) : <p className="muted">No email was scheduled for this report.</p>}
            {needsConfirmation && (
              <label className="confirm">
                <input type="checkbox" checked={confirmRisk} onChange={(event) => setConfirmRisk(event.target.checked)} />
                <span>I checked Resend and the mailbox. Nothing was delivered, so retry even though it might send a duplicate.</span>
              </label>
            )}
          </section>
        </div>
      )}
    </Drawer>
  );
}

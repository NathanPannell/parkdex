import { useEffect, useState } from "react";
import { api, errorText } from "../api";
import { useDashboard } from "../shell/DashboardContext";
import type { EmailAudience, EmailDelivery, FeedbackReport, ReportStatus, RetryResult } from "./types";
import { Drawer, fullDate, Icon, Spinner, useConfirm, useToast } from "../ui";
import { COLUMNS, KINDS } from "./FeedbackBoard";
import { appBuildLabel, deletesOn } from "./format";

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

const RETRY_RESULT: Record<string, string> = {
  sent: "Email sent",
  disabled: "Email sending is off on this deployment",
  skipped: "Nothing to retry; it may have been sent already",
  failed: "The email provider refused it again",
  ambiguous: "The provider did not confirm it; check Resend before trying again",
  requires_confirmation: "Check Resend first, then confirm the retry",
};

export function FeedbackDrawer({
  reportId,
  summary,
  onClose,
  onMove,
  onUpdated,
  onRestore,
}: {
  reportId: string | null;
  summary: FeedbackReport | undefined;
  onClose(): void;
  /** Leave undefined for archived reports, which change status only by being restored. */
  onMove?(report: FeedbackReport, status: ReportStatus): void;
  onUpdated?(report: FeedbackReport): void;
  /** Restores an archived report to Done; resolves with the ids that moved. */
  onRestore?(report: FeedbackReport): Promise<string[]>;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const { health } = useDashboard();
  const [retrying, setRetrying] = useState<EmailAudience | null>(null);
  const [restoring, setRestoring] = useState(false);
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
      .then(({ report }) => {
        setDetail(report);
        setState("ready");
      })
      .catch(() => {
        if (!controller.signal.aborted) setState("error");
      });
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
      .catch(() => {
        if (!controller.signal.aborted) setShotState("error");
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [reportId, detail?.id, detail?.hasScreenshot]);

  async function retry(delivery: EmailDelivery) {
    if (!report) return;
    if (delivery.requiresConfirmation) {
      const ok = await confirm({
        title: "Send this email again?",
        body: (
          <>
            <p>The last attempt was more than 24 hours ago and the provider never confirmed it, so a retry could send a second copy.</p>
            <p>Check Resend and the {delivery.audience === "operator" ? "operator" : "player's"} mailbox first.</p>
          </>
        ),
        confirmLabel: "Send again",
        icon: "mail",
      });
      if (!ok) return;
    }
    setRetrying(delivery.audience);
    try {
      const { results } = await api<RetryResult>(`/api/feedback/${encodeURIComponent(report.id)}/retry-emails`, {
        method: "POST",
        body: JSON.stringify({ audiences: [delivery.audience], confirmAmbiguousAfter24h: delivery.requiresConfirmation }),
      });
      const result = results[0];
      toast.show(RETRY_RESULT[result?.status ?? ""] ?? "Retry finished", {
        tone: result?.status === "sent" || result?.status === "skipped" ? "info" : "error",
      });
      const fresh = await api<{ report: FeedbackReport }>(`/api/feedback/${encodeURIComponent(report.id)}`);
      setDetail(fresh.report);
      onUpdated?.(fresh.report);
    } catch (error) {
      toast.show(errorText(error, "Could not retry that email."), { tone: "error" });
    } finally {
      setRetrying(null);
    }
  }

  async function restore() {
    if (!report || !onRestore) return;
    setRestoring(true);
    try {
      const restored = await onRestore(report);
      if (restored.includes(report.id)) setDetail({ ...report, archivedAt: null });
    } finally {
      setRestoring(false);
    }
  }

  const emailOff = health?.emailMode === "unconfigured";
  const deliveries = report?.emails ?? [];
  const replyTo = report?.contact && report.email && EMAIL.test(report.email) ? report.email : null;
  const kind = report ? (KINDS[report.kind] ?? KINDS.general) : null;
  const appVersion = report ? appBuildLabel(report.context) : null;
  const archived = Boolean(report?.archivedAt);

  return (
    <Drawer open={Boolean(reportId)} onClose={onClose} label="Feedback report">
      <div className="drawer__head">
        {report && kind ? (
          <div>
            <span className={`kind kind--${report.kind}`}>
              <Icon name={kind.icon} size={14} /> {kind.label}
            </span>
            <p className="muted drawer__received">Received {fullDate(report.createdAt)}</p>
          </div>
        ) : (
          <h2>Feedback report</h2>
        )}
        <div className="drawer__actions">
          {replyTo && (
            <a className="button button--primary button--small" href={`mailto:${replyTo}`} title={`Reply to ${replyTo}`}>
              <Icon name="mail" size={15} /> Reply
            </a>
          )}
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </div>
      </div>

      {state === "loading" && !report && (
        <div className="drawer__state">
          <Spinner /> Opening report...
        </div>
      )}
      {state === "error" && (
        <div className="drawer__state" role="alert">
          <p>This report could not be opened.</p>
          <button type="button" className="button button--ghost" onClick={() => setRevision((value) => value + 1)}>
            Try again
          </button>
        </div>
      )}

      {report && (
        <div className="drawer__body">
          {report.archivedAt && (
            <div className="archived-note" role="status">
              <Icon name="inbox" size={18} />
              <span>
                Archived {fullDate(report.archivedAt)}. Deleted for good on {fullDate(deletesOn(report.archivedAt))}.
              </span>
              {onRestore && (
                <button type="button" className="button button--small" onClick={() => void restore()} disabled={restoring}>
                  {restoring ? (
                    <>
                      <Spinner small /> Restoring
                    </>
                  ) : (
                    <>
                      <Icon name="undo" size={15} /> Restore to Done
                    </>
                  )}
                </button>
              )}
            </div>
          )}
          {!archived && onMove && (
            <div className="segmented" role="radiogroup" aria-label="Status">
              {COLUMNS.map((column) => (
                <button
                  key={column.status}
                  type="button"
                  role="radio"
                  aria-checked={report.status === column.status}
                  className={`segmented__item segmented__item--${column.status}${report.status === column.status ? " is-on" : ""}`}
                  onClick={() => onMove?.(report, column.status)}
                >
                  {column.label}
                </button>
              ))}
            </div>
          )}

          <figure className="quote">
            <figcaption>{replyTo ? `${replyTo} wrote` : "The player wrote"}</figcaption>
            <blockquote dir="auto">{report.message || "No message supplied."}</blockquote>
          </figure>

          <dl className="facts">
            <div>
              <dt>App</dt>
              <dd>{appVersion ?? "Not sent"}</dd>
            </div>
            <div>
              <dt>Device</dt>
              <dd>{report.context.platform || "Unknown"}</dd>
            </div>
            <div>
              <dt>Screen</dt>
              <dd>{report.context.screen || "Unknown"}</dd>
            </div>
            <div>
              <dt>Park</dt>
              <dd>{report.context.parkName || "None"}</dd>
            </div>
          </dl>

          {report.hasScreenshot && (
            <section className="panel" id="attachment">
              <h3>Screenshot</h3>
              {shotState === "loading" && (
                <div className="shot shot--loading">
                  <Spinner small /> Loading screenshot...
                </div>
              )}
              {shotState === "error" && <p className="muted">The screenshot could not be loaded.</p>}
              {shotState === "ready" && shot && (
                <a href={shot} target="_blank" rel="noreferrer">
                  <img className="shot" src={shot} alt="Screenshot attached to this report" />
                </a>
              )}
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
                    <span className="muted">
                      {delivery.sentAt
                        ? `Sent ${fullDate(delivery.sentAt)}`
                        : delivery.lastAttemptAt
                          ? `Tried ${fullDate(delivery.lastAttemptAt)}${delivery.attempts > 1 ? ` (${delivery.attempts} attempts)` : ""}`
                          : "Not sent yet"}
                    </span>
                    {delivery.lastError && <span className="delivery-error">{delivery.lastError}</span>}
                    {(delivery.canRetry || delivery.requiresConfirmation) && (
                      <span className="delivery-retry">
                        <button
                          type="button"
                          className="button button--ghost button--small"
                          onClick={() => void retry(delivery)}
                          disabled={retrying !== null || emailOff}
                          title={emailOff ? "Email retry needs RESEND_API_KEY on this deployment" : undefined}
                        >
                          {retrying === delivery.audience ? (
                            <>
                              <Spinner small /> Sending
                            </>
                          ) : (
                            <>
                              <Icon name="refresh" size={14} /> {delivery.requiresConfirmation ? "Check, then retry" : "Retry"}
                            </>
                          )}
                        </button>
                        {emailOff && <span className="muted">Email retry is not set up on this deployment.</span>}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">No emails for this report.</p>
            )}
          </section>
        </div>
      )}
    </Drawer>
  );
}

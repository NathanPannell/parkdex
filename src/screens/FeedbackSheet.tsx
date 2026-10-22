import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { App } from "@capacitor/app";
import { Icon } from "../components/Icon";
import { Kip } from "../components/Kip";
import { buzz, sfx } from "../lib/feedback";
import { isNative } from "../lib/native";
import { overTheAirBundleLabel } from "../lib/ota";
import {
  clearFeedbackScreenshot,
  createFeedbackDraftGeneration,
  feedbackScreenshotDataUrl,
  feedbackScreenshotErrorMessage,
  feedbackScreenshotUrl,
  FeedbackScreenshotError,
  loadFeedbackScreenshot,
  loadFeedbackSubmissionAttempt,
  resetFeedbackSubmissionAttempt,
  type SavedFeedbackScreenshot,
} from "../lib/feedbackDraft";
import {
  clearDraft,
  EMPTY_DRAFT,
  FEEDBACK_KINDS,
  feedbackContext,
  loadDraftSession,
  saveDraft,
  submitFeedback,
  type FeedbackContext,
  type FeedbackDraft,
  type FeedbackAppVersion,
  type FeedbackKind,
  type FeedbackNotificationState,
} from "../lib/feedbackReport";
import { useStore, type FeedbackOrigin } from "../lib/store";
import { useContent } from "../lib/content/provider";

type Status = "editing" | "sending" | "failed" | "sent";
type Shot = SavedFeedbackScreenshot & { url: string };
type SavedReport = {
  id: string;
  kind: FeedbackKind;
  email: string;
  contact: boolean;
  operator?: FeedbackNotificationState;
  receipt?: FeedbackNotificationState;
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function notificationCopy(state: FeedbackNotificationState | undefined, target: "operator" | "receipt", email: string) {
  if (target === "operator") {
    switch (state) {
      case "sent":
        return " The Parkdex team was notified.";
      case "pending":
        return " The team notification is pending.";
      case "sending":
      case "ambiguous":
        return " The team notification is pending. The Parkdex team can check it.";
      case "failed":
        return " The team notification wasn't confirmed. The Parkdex team can check it.";
      case "disabled":
        return " Team notifications are unavailable right now.";
      default:
        return "";
    }
  }

  if (!email) return "";
  switch (state) {
    case "sent":
      return ` An email receipt was sent to ${email}.`;
    case "pending":
      return ` The receipt email for ${email} is pending.`;
    case "sending":
    case "ambiguous":
      return ` The receipt email for ${email} is pending. The Parkdex team can check it.`;
    case "failed":
      return ` The receipt email for ${email} wasn't confirmed. The Parkdex team can check it.`;
    case "disabled":
      return " Email receipts aren't available right now.";
    default:
      return " The receipt status wasn't confirmed.";
  }
}

// Origin arrives as a prop so the sheet keeps it while animating out after the store clears it.
export function FeedbackSheet({ origin }: { origin: FeedbackOrigin }) {
  const { dispatch } = useStore();
  const content = useContent();
  const park = origin.parkId ? content?.parkById.get(origin.parkId) : undefined;
  const [initialDraftSession] = useState(() => loadDraftSession());
  const [draftGeneration, setDraftGeneration] = useState(initialDraftSession.generation);
  const [nativeAppVersion, setNativeAppVersion] = useState<FeedbackAppVersion | null>(null);
  const [nativeInfoStatus, setNativeInfoStatus] = useState<"loading" | "ready">(isNative ? "loading" : "ready");
  const context = useMemo(
    () => feedbackContext(origin, park, nativeAppVersion ?? (isNative ? { version: "loading", build: "loading" } : undefined)),
    [origin, park, nativeAppVersion],
  );
  const [draft, setDraft] = useState<FeedbackDraft>(initialDraftSession.draft);
  const [shot, setShot] = useState<Shot | null>(null);
  const [shotLoading, setShotLoading] = useState(true);
  const [shotProcessing, setShotProcessing] = useState(false);
  const [shotError, setShotError] = useState<string | null>(null);
  const [storageError, setStorageError] = useState("");
  const [draftSaveError, setDraftSaveError] = useState("");
  const [attemptResetPending, setAttemptResetPending] = useState(false);
  const [status, setStatus] = useState<Status>("editing");
  const [sendError, setSendError] = useState("");
  const [savedReport, setSavedReport] = useState<SavedReport | null>(null);
  const [emailTouched, setEmailTouched] = useState(false);
  const [retryContext, setRetryContext] = useState<FeedbackContext | null>(null);
  const sendingRef = useRef(false);
  const retryAttemptExistsRef = useRef(false);
  const resetQueueRef = useRef<Promise<void>>(Promise.resolve());
  const resetCountRef = useRef(0);

  useEffect(() => {
    if (!isNative) return;
    let current = true;
    void App.getInfo()
      .then((info) => {
        if (!current) return;
        // Reports from an over-the-air bundle name it, since the native build alone no longer says which code ran.
        const bundle = overTheAirBundleLabel();
        const build = info.build?.trim() || "unavailable";
        setNativeAppVersion({
          version: info.version?.trim() || "unavailable",
          // The server accepts at most 80 characters here.
          build: bundle ? `${build} bundle ${bundle}`.slice(0, 80) : build,
        });
      })
      .catch(() => {
        if (current) setNativeAppVersion({ version: "unavailable", build: "unavailable" });
      })
      .finally(() => {
        if (current) setNativeInfoStatus("ready");
      });
    return () => {
      current = false;
    };
  }, []);

  useEffect(() => {
    if (status === "sent") return;
    if (saveDraft(draft, draftGeneration)) setDraftSaveError("");
    else
      setDraftSaveError(
        "This device couldn't save feedback draft data. Sending is paused, and report details may be lost if you close this sheet. Check device storage and try again.",
      );
  }, [draft, draftGeneration, status]);

  useEffect(() => {
    let current = true;
    void (async () => {
      try {
        const saved = await loadFeedbackScreenshot(initialDraftSession.generation);
        if (!current) return;
        if (saved) setShot({ ...saved, url: feedbackScreenshotUrl(saved.blob) });
        const screenshot = saved ? await feedbackScreenshotDataUrl(saved.blob) : null;
        const candidate = {
          ...initialDraftSession.draft,
          message: initialDraftSession.draft.message.trim(),
          email: initialDraftSession.draft.email.trim(),
          screenshot,
          context,
        };
        const attempt = await loadFeedbackSubmissionAttempt(candidate, initialDraftSession.generation);
        if (!current) return;
        if (attempt) {
          retryAttemptExistsRef.current = true;
          setRetryContext(attempt.report.context);
        }
      } catch {
        if (current) setStorageError("Couldn't check the saved report on this phone. Check device storage before sending again.");
      }
    })()
      .catch(() => {
        if (current) setStorageError("Couldn't check the saved report on this phone. Check device storage before sending again.");
      })
      .finally(() => {
        if (current) setShotLoading(false);
      });
    return () => {
      current = false;
    };
  }, []);

  const shotUrl = shot?.url;
  useEffect(() => {
    if (!shotUrl) return;
    return () => URL.revokeObjectURL(shotUrl);
  }, [shotUrl]);

  const kind = FEEDBACK_KINDS.find((item) => item.id === draft.kind)!;
  const displayContext = retryContext ?? context;
  const email = draft.email.trim();
  const emailFormatOk = !email || EMAIL.test(email);
  const emailOk = emailFormatOk && (!draft.contact || email.length > 0);
  const emailError = !emailFormatOk ? "Check that email address." : draft.contact && !email ? "Add an email address to allow follow-up." : "";
  const isEditingLocked = status === "sending" || shotLoading;
  const canSend =
    draft.message.trim().length > 0 &&
    emailOk &&
    !shotLoading &&
    !shotProcessing &&
    !attemptResetPending &&
    !storageError &&
    !draftSaveError &&
    nativeInfoStatus === "ready" &&
    status !== "sending";
  const isSending = status === "sending";

  const close = () => {
    if (sendingRef.current) return;
    dispatch({ type: "feedback", open: false });
  };

  const invalidateRetryAttempt = () => {
    if (!retryAttemptExistsRef.current) return;
    retryAttemptExistsRef.current = false;
    setRetryContext(null);
    setAttemptResetPending(true);
    const resetNumber = ++resetCountRef.current;
    resetQueueRef.current = resetQueueRef.current
      .catch(() => {})
      .then(() => resetFeedbackSubmissionAttempt(draftGeneration))
      .then(() => {
        if (resetNumber === resetCountRef.current) setStorageError("");
      })
      .catch(() => {
        if (resetNumber === resetCountRef.current)
          setStorageError("Couldn't update the saved report on this phone. Check device storage before sending again.");
      })
      .finally(() => {
        if (resetNumber === resetCountRef.current) setAttemptResetPending(false);
      });
  };

  const edit = (patch: Partial<FeedbackDraft>) => {
    if (sendingRef.current || isSending || shotLoading) return;
    const changed = Object.entries(patch).some(([key, value]) => draft[key as keyof FeedbackDraft] !== value);
    if (!changed) return;
    invalidateRetryAttempt();
    if (status === "failed") {
      setStatus("editing");
      setSendError("");
    }
    setDraft((current) => ({ ...current, ...patch }));
  };

  const removeShot = async () => {
    if (!shot || sendingRef.current || shotProcessing || shotLoading) return;
    setShotProcessing(true);
    try {
      await clearFeedbackScreenshot(draftGeneration);
      setShot(null);
      setShotError(null);
      retryAttemptExistsRef.current = false;
      setRetryContext(null);
      setStorageError("");
      if (status === "failed") {
        setStatus("editing");
        setSendError("");
      }
    } catch {
      setShotError("Couldn't remove the saved screenshot from this phone. Try again.");
    } finally {
      setShotProcessing(false);
    }
  };

  const send = async () => {
    if (sendingRef.current || !canSend) return;
    if (!saveDraft(draft, draftGeneration)) {
      setDraftSaveError(
        "This device couldn't save feedback draft data. Sending is paused, and report details may be lost if you close this sheet. Check device storage and try again.",
      );
      return;
    }
    setDraftSaveError("");
    sendingRef.current = true;
    const submittedDraft = { ...draft, message: draft.message.trim(), email };
    const selectedShot = shot;
    const submittedContext = { ...(retryContext ?? context) };
    setStatus("sending");
    setSendError("");
    sfx.tap();

    try {
      const screenshot = selectedShot ? await feedbackScreenshotDataUrl(selectedShot.blob) : null;
      const result = await submitFeedback({ ...submittedDraft, screenshot, context: submittedContext }, draftGeneration);

      // Advance the draft generation first, so a failed device cleanup cannot restore a sent screenshot.
      const nextGeneration = createFeedbackDraftGeneration();
      clearDraft(nextGeneration);
      setDraftGeneration(nextGeneration);
      retryAttemptExistsRef.current = false;
      setRetryContext(null);
      void clearFeedbackScreenshot(draftGeneration).catch(() => {});
      setShot(null);
      setSavedReport({
        id: result.id,
        kind: submittedDraft.kind,
        email: submittedDraft.email,
        contact: submittedDraft.contact,
        operator: result.notification?.operator,
        receipt: result.notification?.receipt,
      });
      setStatus("sent");
      sfx.chirp();
      buzz([20, 40, 20]);
    } catch (error) {
      setStatus("failed");
      if (error instanceof FeedbackScreenshotError) setSendError(feedbackScreenshotErrorMessage(error));
      else setSendError(error instanceof Error ? error.message : "Couldn't send that report. Your draft is saved on this phone. Try again.");
      buzz(40);
    } finally {
      sendingRef.current = false;
    }
  };

  const startOver = () => {
    retryAttemptExistsRef.current = false;
    setRetryContext(null);
    setDraft(EMPTY_DRAFT);
    setShot(null);
    setSavedReport(null);
    setEmailTouched(false);
    setShotError(null);
    setSendError("");
    setStatus("editing");
  };

  return (
    <>
      <motion.div className="sheet-scrim fb-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={close} />
      <motion.div
        className="sheet fb-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="fb-title"
        initial={{ y: "100%" }}
        animate={{ y: 0 }}
        exit={{ y: "100%", transition: { type: "spring", stiffness: 400, damping: 40 } }}
        transition={{ type: "spring", stiffness: 300, damping: 30 }}
      >
        <div className="sheet__handle" />
        <button className="park-sheet__close" onClick={close} aria-label="Close feedback" disabled={isSending}>
          <Icon name="close" size={18} stroke={3} />
        </button>

        <AnimatePresence mode="wait" initial={false}>
          {status === "sent" && savedReport ? (
            <motion.div key="sent" className="fb-done" initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}>
              <Kip pose="cheer" size={150} />
              <span className="eyebrow">
                Report PD-
                {savedReport.id
                  .toUpperCase()
                  .replace(/[^A-Z0-9]/g, "")
                  .slice(0, 10)}
              </span>
              {/* The same reference as the receipt email (worker/emails.ts). */}
              <h2>Feedback saved</h2>
              <p>
                Your {FEEDBACK_KINDS.find((item) => item.id === savedReport.kind)?.label.toLowerCase()} report is saved.
                {notificationCopy(savedReport.operator, "operator", savedReport.email)}
                {notificationCopy(savedReport.receipt, "receipt", savedReport.email)}
                {savedReport.contact && ` You allowed follow-up by email at ${savedReport.email}. No marketing.`}
              </p>
              <div className="fb-done__actions">
                <button className="btn btn--block btn--ink" onClick={close}>
                  Done
                </button>
                <button className="fb-link" onClick={startOver}>
                  Send another
                </button>
              </div>
            </motion.div>
          ) : (
            <motion.div key="form" className="fb-form" exit={{ opacity: 0 }}>
              <header className="fb-head">
                <span className="fb-head__kip">
                  <Kip pose="avatar" size={52} />
                </span>
                <div>
                  <h2 id="fb-title">Send feedback</h2>
                </div>
              </header>

              <div className="fb-body scroll">
                <div className="fb-kinds" role="radiogroup" aria-label="Feedback type">
                  {FEEDBACK_KINDS.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      role="radio"
                      aria-checked={draft.kind === item.id}
                      className={`fb-kind ${draft.kind === item.id ? "is-on" : ""}`}
                      disabled={isEditingLocked}
                      onClick={() => {
                        sfx.tap();
                        edit({ kind: item.id });
                      }}
                    >
                      <Icon name={item.icon} size={20} />
                      {item.label}
                    </button>
                  ))}
                </div>

                <label className="fb-field">
                  <span className="fb-label">
                    {kind.prompt} <em>Required</em>
                  </span>
                  <textarea
                    className="fb-input fb-textarea"
                    aria-label={kind.prompt}
                    value={draft.message}
                    onChange={(event) => edit({ message: event.target.value })}
                    placeholder={draft.kind === "bug" ? "I held Plant your flag at Beacon Hill and nothing happened…" : "Type here…"}
                    rows={5}
                    maxLength={4000}
                    disabled={isEditingLocked}
                  />
                </label>

                {/* Photos are retired (PRODUCT.md): nothing new can be attached. A screenshot saved with a
                    draft from an older version still shows, and can be sent or removed. */}
                {shot && (
                  <div className="fb-field">
                    <span className="fb-label">Screenshot</span>
                    <div className="fb-shot card">
                      <img src={shot.url} alt="Attached screenshot" />
                      <span className="fb-shot__name">{shot.name}</span>
                      <button
                        type="button"
                        className="fb-shot__remove"
                        onClick={() => void removeShot()}
                        aria-label="Remove screenshot"
                        disabled={isEditingLocked || shotProcessing}
                      >
                        <Icon name="close" size={16} stroke={3} />
                      </button>
                    </div>
                    {shotError && (
                      <span className="fb-error-text" role="alert">
                        {shotError}
                      </span>
                    )}
                  </div>
                )}

                <label className="fb-field">
                  <span className="fb-label">
                    Email for a receipt <em>Optional</em>
                  </span>
                  <input
                    className="fb-input"
                    type="email"
                    inputMode="email"
                    autoComplete="email"
                    placeholder="you@example.com"
                    value={draft.email}
                    onChange={(event) => edit({ email: event.target.value })}
                    onBlur={() => setEmailTouched(true)}
                    aria-label="Email for feedback receipt"
                    aria-invalid={Boolean(emailError && emailTouched)}
                    disabled={isEditingLocked}
                  />
                  {emailError && emailTouched ? (
                    <span className="fb-error-text">{emailError}</span>
                  ) : (
                    <span className="fb-error-text" style={{ color: "var(--ink-soft)" }}>
                      Used for a receipt. The switch below separately allows follow-up. No marketing.
                    </span>
                  )}
                </label>

                <div className="fb-field">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={draft.contact}
                    aria-label="Allow follow-up by email"
                    className={`fb-switch ${draft.contact ? "is-on" : ""}`}
                    disabled={isEditingLocked}
                    onClick={() => {
                      const contact = !draft.contact;
                      if (contact) setEmailTouched(true);
                      edit({ contact });
                    }}
                  >
                    <span className="fb-switch__text">
                      <strong>Allow follow-up about this report</strong>
                      <span>Parkdex may email about this report only. No marketing.</span>
                    </span>
                    <span className="fb-switch__track">
                      <motion.span className="fb-switch__knob" layout transition={{ type: "spring", stiffness: 600, damping: 32 }} />
                    </span>
                  </button>
                  <AnimatePresence initial={false}>
                    {draft.contact && (
                      <motion.div
                        className="fb-email"
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                      >
                        <span className="fb-error-text" style={{ color: "var(--ink-soft)" }}>
                          Follow-up uses the receipt email above. An email address is required for this permission.
                        </span>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>

                <details className="fb-context">
                  <summary>
                    <span>Sent with your report</span>
                    <Icon name="next" size={16} stroke={3} />
                  </summary>
                  <dl>
                    <dt>App</dt>
                    <dd>
                      {nativeInfoStatus === "loading" && !retryContext
                        ? "Loading installed app details…"
                        : `Parkdex ${displayContext.version} · build ${displayContext.build} · ${displayContext.platform}`}
                    </dd>
                    <dt>Screen</dt>
                    <dd>{displayContext.screen}</dd>
                    {displayContext.parkName && (
                      <>
                        <dt>Park</dt>
                        <dd>{displayContext.parkName}</dd>
                      </>
                    )}
                  </dl>
                  <p>Your location, photos and logs are never included. Screenshots are only sent if you attach one.</p>
                </details>
                {storageError && (
                  <span className="fb-error-text" role="alert">
                    {storageError}
                  </span>
                )}
                {draftSaveError && (
                  <span className="fb-error-text" role="alert">
                    {draftSaveError}
                  </span>
                )}
              </div>

              <div className="fb-foot">
                <AnimatePresence>
                  {status === "failed" && (
                    <motion.div
                      className="fb-failed"
                      role="alert"
                      initial={{ y: 16, opacity: 0 }}
                      animate={{ y: 0, opacity: 1 }}
                      exit={{ y: 16, opacity: 0 }}
                      transition={{ type: "spring", stiffness: 500, damping: 30 }}
                    >
                      <strong>Couldn't send that.</strong> {sendError || "Your draft is saved on this phone. Check your connection and try again."}
                    </motion.div>
                  )}
                </AnimatePresence>
                <button className="btn btn--block" onClick={send} disabled={!canSend}>
                  {status === "sending" ? (
                    <>
                      <span className="fb-spinner" /> Sending…
                    </>
                  ) : status === "failed" ? (
                    <>
                      <Icon name="refresh" size={20} /> Try again
                    </>
                  ) : (
                    "Send feedback"
                  )}
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </>
  );
}

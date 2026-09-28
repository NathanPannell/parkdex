import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { Icon } from "../components/Icon";
import { Kip } from "../components/Kip";
import { buzz, sfx } from "../lib/feedback";
import {
  clearDraft,
  EMPTY_DRAFT,
  FEEDBACK_KINDS,
  feedbackContext,
  loadDraft,
  saveDraft,
  submitFeedback,
  type FeedbackDraft,
} from "../lib/feedbackReport";
import { useStore, type FeedbackOrigin } from "../lib/store";
import { useContent } from "../lib/content/provider";

type Status = "editing" | "sending" | "failed" | "sent";

const MAX_SHOT_MB = 8;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Origin arrives as a prop so the sheet keeps it while animating out after the store clears it.
export function FeedbackSheet({ origin }: { origin: FeedbackOrigin }) {
  const { dispatch } = useStore();
  const content = useContent();
  const park = origin.parkId ? content?.parkById.get(origin.parkId) : undefined;
  const context = useMemo(() => feedbackContext(origin, park), [origin, park]);
  const [draft, setDraft] = useState<FeedbackDraft>(loadDraft);
  const [shot, setShot] = useState<{ url: string; name: string } | null>(null);
  const [shotError, setShotError] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>("editing");
  const [reportId, setReportId] = useState("");
  const [emailTouched, setEmailTouched] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (status !== "sent") saveDraft(draft);
  }, [draft, status]);

  const kind = FEEDBACK_KINDS.find((k) => k.id === draft.kind)!;
  const emailOk = !draft.contact || EMAIL.test(draft.email.trim());
  const canSend = draft.message.trim().length > 0 && emailOk && status !== "sending";

  const close = () => dispatch({ type: "feedback", open: false });
  const edit = (patch: Partial<FeedbackDraft>) => setDraft((d) => ({ ...d, ...patch }));

  const pickShot = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > MAX_SHOT_MB * 1024 * 1024) {
      setShotError(`That image is over ${MAX_SHOT_MB} MB. Try a smaller screenshot.`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setShot({ url: String(reader.result), name: file.name });
      setShotError(null);
    };
    reader.readAsDataURL(file);
  };

  const send = async () => {
    if (!canSend) return;
    setStatus("sending");
    sfx.tap();
    try {
      const { id } = await submitFeedback({ ...draft, screenshot: shot?.url ?? null, context });
      clearDraft();
      setReportId(id);
      setStatus("sent");
      sfx.chirp();
      buzz([20, 40, 20]);
    } catch {
      setStatus("failed");
      buzz(40);
    }
  };

  const startOver = () => {
    setDraft(EMPTY_DRAFT);
    setShot(null);
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
        <button className="park-sheet__close" onClick={close} aria-label="Close feedback">
          <Icon name="close" size={18} stroke={3} />
        </button>

        <AnimatePresence mode="wait" initial={false}>
          {status === "sent" ? (
            <motion.div key="sent" className="fb-done" initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}>
              <Kip pose="cheer" size={150} />
              <span className="eyebrow">Report {reportId}</span>
              <h2>Thanks! Kip passed it on.</h2>
              <p>
                Your {kind.label.toLowerCase()} report is saved.{" "}
                {draft.contact ? `We may email ${draft.email.trim()} if we have questions.` : "The team reviews every report."}
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
                  <span className="eyebrow">Internal testing</span>
                  <h2 id="fb-title">Send feedback</h2>
                </div>
              </header>

              <div className="fb-body scroll">
                <div className="fb-kinds" role="radiogroup" aria-label="Feedback type">
                  {FEEDBACK_KINDS.map((k) => (
                    <button
                      key={k.id}
                      role="radio"
                      aria-checked={draft.kind === k.id}
                      className={`fb-kind ${draft.kind === k.id ? "is-on" : ""}`}
                      onClick={() => {
                        sfx.tap();
                        edit({ kind: k.id });
                      }}
                    >
                      <Icon name={k.icon} size={20} />
                      {k.label}
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
                    onChange={(e) => edit({ message: e.target.value })}
                    placeholder={draft.kind === "bug" ? "I tapped Claim at Beacon Hill and the camera stayed black…" : "Type here…"}
                    rows={5}
                    maxLength={4000}
                  />
                </label>

                <div className="fb-field">
                  <span className="fb-label">
                    Screenshot <em>Optional</em>
                  </span>
                  <input ref={fileRef} type="file" accept="image/*" hidden onChange={pickShot} />
                  {shot ? (
                    <div className="fb-shot card">
                      <img src={shot.url} alt="Attached screenshot" />
                      <span className="fb-shot__name">{shot.name}</span>
                      <button className="fb-shot__remove" onClick={() => setShot(null)} aria-label="Remove screenshot">
                        <Icon name="close" size={16} stroke={3} />
                      </button>
                    </div>
                  ) : (
                    <button className="fb-attach" onClick={() => fileRef.current?.click()}>
                      <Icon name="image" size={20} /> Attach a screenshot
                    </button>
                  )}
                  {shotError && <span className="fb-error-text">{shotError}</span>}
                </div>

                <div className="fb-field">
                  <button
                    role="switch"
                    aria-checked={draft.contact}
                    aria-label="You can contact me about this"
                    className={`fb-switch ${draft.contact ? "is-on" : ""}`}
                    onClick={() => edit({ contact: !draft.contact })}
                  >
                    <span className="fb-switch__text">
                      <strong>You can contact me about this</strong>
                      <span>Only to follow up or say it's fixed.</span>
                    </span>
                    <span className="fb-switch__track">
                      <motion.span className="fb-switch__knob" layout transition={{ type: "spring", stiffness: 600, damping: 32 }} />
                    </span>
                  </button>
                  <AnimatePresence initial={false}>
                    {draft.contact && (
                      <motion.div className="fb-email" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}>
                        <input
                          className="fb-input"
                          type="email"
                          inputMode="email"
                          autoComplete="email"
                          placeholder="you@example.com"
                          value={draft.email}
                          onChange={(e) => edit({ email: e.target.value })}
                          onBlur={() => setEmailTouched(true)}
                          aria-label="Email for follow-up"
                          aria-invalid={!emailOk && emailTouched}
                        />
                        {!emailOk && emailTouched && <span className="fb-error-text">Check that email address.</span>}
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
                      Parkdex {context.version} · {context.platform}
                    </dd>
                    <dt>Screen</dt>
                    <dd>{context.screen}</dd>
                    {context.parkName && (
                      <>
                        <dt>Park</dt>
                        <dd>{context.parkName}</dd>
                      </>
                    )}
                  </dl>
                  <p>Your location, photos and logs are never included. Screenshots are only sent if you attach one.</p>
                </details>
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
                      <strong>Couldn't send that.</strong> Your draft is saved on this phone. Check your connection and try again.
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

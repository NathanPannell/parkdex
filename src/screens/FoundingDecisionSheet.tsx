import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Kip } from "../components/Kip";
import { useContentRuntime } from "../lib/content/provider";
import { useBackHandler } from "../lib/backStack";
import { buzz, sfx } from "../lib/feedback";
import { coverImageUrl, markFoundingReviewsSeen } from "../lib/founders";
import { createDecisionQueue, decisionMessage, type DecisionQueue } from "../lib/foundingReviews";
import type { FoundingDecision } from "../lib/game/client";
import { useGame } from "../lib/game/GameProvider";
import { press } from "../lib/motion";
import { forgetSummaries } from "../lib/parkSummary";
import "../game.css";
import "../game-ui.css";
import "../found-park.css";

/**
 * The next manual review decision to show, one at a time and once each, whenever the player's
 * state loads or refreshes. The queue starts over for another account.
 */
export function useFoundingDecisions(allowed: boolean): { current: FoundingDecision | null; dismiss: () => void } {
  const game = useGame();
  const accountId = game.accountId;
  const queue = useRef<{ accountId: string | null; queue: DecisionQueue } | null>(null);
  if (!queue.current || queue.current.accountId !== accountId) {
    queue.current = {
      accountId,
      queue: createDecisionQueue((ids) => (accountId ? markFoundingReviewsSeen(accountId, ids) : Promise.resolve())),
    };
  }
  const [, setDismissed] = useState(0);
  const decided = game.me?.foundingReviews?.decided ?? [];
  const current = allowed && accountId ? queue.current.queue.next(decided) : null;
  const runtime = useContentRuntime();
  const refreshFlags = game.refreshFlags;

  // An approval publishes a cover, and maybe a new park, that this device has not seen yet.
  const approvedId = current?.status === "approved" ? current.requestId : null;
  useEffect(() => {
    if (!approvedId) return;
    forgetSummaries();
    void runtime.retry().catch(() => {});
    void refreshFlags();
  }, [approvedId]);

  const dismiss = useCallback(() => {
    const owner = queue.current;
    if (!current || !owner) return;
    buzz(10);
    void owner.queue.dismiss(current.requestId);
    setDismissed((value) => value + 1);
  }, [current?.requestId]);

  return { current, dismiss };
}

/** "Your photo was approved", "wasn't approved" or "someone else became the founder first", in the takeover sheet's style. */
export function FoundingDecisionSheet({ decision, onDismiss }: { decision: FoundingDecision | null; onDismiss: () => void }) {
  const message = decision ? decisionMessage(decision) : null;
  const cover = decision?.status === "approved" ? coverImageUrl(decision.coverUrl) : null;
  const [coverFailed, setCoverFailed] = useState(false);
  // Android back dismisses the message before anything underneath it.
  useBackHandler(onDismiss, !!decision);
  useEffect(() => {
    setCoverFailed(false);
    if (decision?.status === "approved") sfx.claim();
  }, [decision?.requestId]);

  return (
    <AnimatePresence>
      {decision && message && (
        <>
          <motion.div
            key="decision-scrim"
            className="sheet-scrim takeover-scrim"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onDismiss}
          />
          <motion.div
            key={`decision-${decision.requestId}`}
            className="sheet takeover-sheet decision-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="decision-title"
            aria-describedby="decision-text"
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ type: "spring", stiffness: 320, damping: 32 }}
          >
            <div className="sheet__handle" />
            <div className="takeover-sheet__head">
              <motion.div initial={{ rotate: -20, scale: 0.6 }} animate={{ rotate: [0, -8, 8, 0], scale: 1 }} transition={{ duration: 0.6, delay: 0.2 }}>
                <Kip pose={message.kip} size={56} />
              </motion.div>
              <div>
                <span className="eyebrow">{message.eyebrow}</span>
                <h2 id="decision-title">{message.title}</h2>
              </div>
            </div>
            <div className="decision-sheet__body">
              {cover && !coverFailed && (
                <div className="polaroid decision-sheet__cover">
                  <div className="polaroid__img">
                    <img src={cover} alt={`${decision.parkName}, your cover photo`} onError={() => setCoverFailed(true)} />
                  </div>
                </div>
              )}
              <p id="decision-text" className="decision-sheet__text">
                {message.text}
              </p>
            </div>
            <div className="takeover-sheet__foot">
              <motion.button whileTap={press} className="btn btn--sun btn--block" onClick={onDismiss}>
                Got it
              </motion.button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

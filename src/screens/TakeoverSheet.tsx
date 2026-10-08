import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { Flag } from "../components/Flag";
import { Kip } from "../components/Kip";
import { useContent } from "../lib/content/provider";
import { buzz } from "../lib/feedback";
import { markTakeoversSeen } from "../lib/game/client";
import { useGame } from "../lib/game/GameProvider";
import { latestTakeoverAt } from "../lib/game/visit";
import "../game.css";

function timeAgo(at: string, now: number): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(at)) / 60_000));
  if (!Number.isFinite(minutes)) return "";
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

/** "@sam took Blueberry" for each park lost since the player last looked. */
export function TakeoverMessages({ allowed }: { allowed: boolean }) {
  const game = useGame();
  const content = useContent();
  const takeovers = game.me?.takeovers ?? [];
  const latest = latestTakeoverAt(takeovers);
  // Hidden locally at once; the server catches up when the seen call lands.
  const [dismissedAt, setDismissedAt] = useState<string | null>(null);
  const open = allowed && !!game.accountId && !!latest && latest !== dismissedAt;

  const dismiss = () => {
    if (!latest || !game.accountId) return;
    setDismissedAt(latest);
    buzz(10);
    void markTakeoversSeen(game.accountId, latest).then(() => game.refresh()).catch(() => {
      // Unseen messages come back on the next open, which is the right outcome offline.
    });
  };

  const sorted = [...takeovers].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div key="scrim" className="sheet-scrim takeover-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={dismiss} />
          <motion.div
            key="sheet"
            className="sheet takeover-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="takeover-title"
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ type: "spring", stiffness: 320, damping: 32 }}
          >
            <div className="sheet__handle" />
            <div className="takeover-sheet__head">
              <Kip pose="think" size={56} />
              <div>
                <span className="eyebrow">While you were away</span>
                <h2 id="takeover-title">{sorted.length === 1 ? "A park was taken" : `${sorted.length} parks were taken`}</h2>
              </div>
            </div>
            <ul className="takeover-list scroll">
              {sorted.map((takeover) => {
                const park = content?.parkById.get(takeover.parkId);
                return (
                  <li key={`${takeover.parkId}:${takeover.at}`} className="takeover-row">
                    <Flag seed={takeover.byFlagSeed} size={44} />
                    <span>
                      <strong>@{takeover.byHandle} took {park?.short ?? park?.name ?? "one of your parks"}</strong>
                      <em>{timeAgo(takeover.at, game.serverNow())}</em>
                    </span>
                  </li>
                );
              })}
            </ul>
            <div className="takeover-sheet__foot">
              <p className="account-help">Visit a park again to take it back.</p>
              <button className="btn btn--sun btn--block" onClick={dismiss}>Got it</button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

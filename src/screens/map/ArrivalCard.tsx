import { AnimatePresence, motion } from "motion/react";
import { Icon } from "../../components/Icon";
import { Bubble, Kip } from "../../components/Kip";
import { Rays } from "../../components/Motion";
import type { Park } from "../../lib/parks";
import { takeLabel, type ParkHolder } from "../../lib/game/visit";
import { formatClockTime, formatMinutesLeft, loggedVisitLine, type CrewPhase } from "../../lib/game/crew";
import { handleFit } from "../../lib/game/handleFit";

export function ArrivalCard({
  park,
  holder,
  flagDays,
  visitLabel,
  visited = false,
  crew = { kind: "none" },
  now = Date.now(),
  onCheckIn,
  onScanCrew,
  onDismiss,
}: {
  park: Park;
  holder: ParkHolder;
  flagDays: number;
  visitLabel: string;
  /** Already visited today: another visit would not count, so there is nothing to press. */
  visited?: boolean;
  /** The player's crew phase here (#171); `none` unless the crews flag is on. */
  crew?: CrewPhase;
  now?: number;
  onCheckIn: () => void;
  onScanCrew?: () => void;
  onDismiss: () => void;
}) {
  const flown = flagDays === 1 ? "1 day" : `${flagDays} days`;
  const outsider = crew.kind === "outsider" && !visited ? crew : null;
  const message = outsider
    ? outsider.logged
      ? loggedVisitLine(outsider.until)
      : onScanCrew
        ? `@${outsider.leader}'s crew flag is protected for ${formatMinutesLeft(outsider.until, now)}. Scan their crew code to join, or log your visit.`
        : `@${outsider.leader}'s flag is protected for ${formatMinutesLeft(outsider.until, now)}. Log your visit now, and take it after ${formatClockTime(outsider.until)}.`
    : visited
      ? holder.kind === "mine"
        ? "Your flag is flying here. You visited today, so come back tomorrow to check in again."
        : holder.kind === "other"
          ? `@${holder.flag.handle} holds it now. You visited today, so come back tomorrow to take it.`
          : "You visited today. Come back tomorrow to plant your flag."
      : holder.kind === "mine"
        ? flagDays < 1
          ? "You planted your flag here today. It is still flying."
          : `Your flag has flown here for ${flown}. Check in to keep it up.`
        : holder.kind === "other"
          ? flagDays < 1
            ? `@${holder.flag.handle} planted a flag here today. ${takeLabel(flagDays)}.`
            : `@${holder.flag.handle}'s flag has flown here for ${flown}. ${takeLabel(flagDays)}.`
          : holder.kind === "empty"
            ? "Nobody holds this park yet. Plant your flag and earn a point every hour it flies."
            : "Plant your flag here. You need a connection to see who holds it.";
  return (
    <motion.div
      className="arrival"
      initial={{ y: 420 }}
      animate={{ y: 0 }}
      exit={{ y: 460, transition: { duration: 0.25 } }}
      transition={{ type: "spring", stiffness: 260, damping: 22 }}
    >
      <div className="arrival__rays">
        <Rays color="#FFC93C" size={520} opacity={0.55} speed={18} />
      </div>
      {/* Kip grows from his feet on the card's edge, so the bubble never dips over the card on the way in. */}
      <motion.div
        className="arrival__kip"
        style={{ transformOrigin: "100% 100%" }}
        initial={{ scale: 0 }}
        animate={{ scale: 1 }}
        transition={{ type: "spring", delay: 0.25, stiffness: 400, damping: 14 }}
      >
        <Bubble side="to-right" style={{ position: "relative", marginBottom: 36, whiteSpace: "nowrap" }}>
          KLEEP! You made it!
        </Bubble>
        <Kip pose="cheer" size={92} />
      </motion.div>
      <div className="arrival__card card" style={handleFit(holder.kind === "other" ? holder.flag.handle : null)}>
        <motion.span
          className="arrival__tag"
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          transition={{ type: "spring", delay: 0.15, stiffness: 600, damping: 14 }}
        >
          <Icon name="check" size={14} stroke={3.4} /> Inside the boundary
        </motion.span>
        <h2>
          Welcome to
          <br />
          {park.short}
        </h2>
        <p>{message}</p>
        <AnimatePresence>
          {outsider ? (
            <motion.div key="crew" className="arrival__crew" initial={{ scale: 0.8 }} animate={{ scale: 1 }} transition={{ type: "spring", delay: 0.4 }}>
              {onScanCrew && (
                <button className="btn btn--block btn--glow" onClick={onScanCrew}>
                  <Icon name="qr" /> Scan crew code
                </button>
              )}
              <button className="btn btn--block btn--paper" onClick={onCheckIn} disabled={outsider.logged}>
                <Icon name="flag" /> {outsider.logged ? "Visit logged" : visitLabel}
              </button>
            </motion.div>
          ) : visited ? (
            <motion.p className="arrival__visited" role="status" initial={{ scale: 0.8 }} animate={{ scale: 1 }} transition={{ type: "spring", delay: 0.4 }}>
              <Icon name="check" size={18} stroke={3} /> {visitLabel}
            </motion.p>
          ) : (
            <motion.button
              className="btn btn--block btn--glow"
              onClick={onCheckIn}
              initial={{ scale: 0.8 }}
              animate={{ scale: 1 }}
              transition={{ type: "spring", delay: 0.4 }}
            >
              <Icon name="flag" /> {visitLabel}
            </motion.button>
          )}
        </AnimatePresence>
        <button className="arrival__later" onClick={onDismiss}>
          {visited ? "Got it" : "Look around first"}
        </button>
      </div>
    </motion.div>
  );
}

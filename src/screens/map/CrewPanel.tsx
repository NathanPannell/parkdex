import { motion } from "motion/react";
import { Icon } from "../../components/Icon";
import type { Crew, ParkFlag } from "../../lib/game/client";
import { crewHeadline, loggedVisitLine, type CrewPhase } from "../../lib/game/crew";
import { press } from "../../lib/motion";

type Props = {
  phase: CrewPhase;
  flag: ParkFlag;
  /** The crew read when the page opened, when it matches the flag on the map. */
  crew: Crew | null;
  now: number;
  onShowCode: () => void;
};

/**
 * The crew part of the park page's status block (#171): the protected hour for the leader,
 * members and everyone else, and the way to show the crew code. Only the leader gets the big
 * code button during the hour; members get a small one. The crew list itself sits under
 * "More about this park". After the hour, one quiet line says the window closed.
 */
export function CrewPanel({ phase, flag, crew, now, onShowCode }: Props) {
  if (phase.kind === "none") return null;
  const size = crew?.size ?? flag.crew?.size ?? 1;

  if (phase.kind === "closed") {
    return (
      <div className="crew-panel is-closed" aria-label="Crew" role="group">
        <p className="crew-panel__closed"><Icon name="lock" size={14} /> Crew window closed · crew of {size}</p>
      </div>
    );
  }

  return (
    <div className={`crew-panel is-${phase.kind}`} aria-label="Crew" role="group">
      <p className="crew-panel__status" role="timer" aria-live="off">
        <Icon name="shield" size={18} />
        <strong>{crewHeadline(phase, now)}</strong>
      </p>
      {phase.kind === "outsider" ? (
        <p className={`crew-panel__note${phase.logged ? " crew-panel__note--logged" : ""}`}>
          {phase.logged ? loggedVisitLine(phase.until) : "Ask the crew for their code to join."}
        </p>
      ) : phase.kind === "leader" ? (
        <>
          <p className="crew-panel__note">{size === 1 ? "Just you so far." : `Crew of ${size}.`}</p>
          <motion.button whileTap={press} className="btn btn--sun btn--block crew-panel__code" onClick={onShowCode}>
            <Icon name="qr" size={20} /> Show crew code
          </motion.button>
        </>
      ) : (
        <div className="crew-panel__row">
          <p className="crew-panel__note">{`Crew of ${size}.`}</p>
          <button className="btn btn--paper btn--sm crew-panel__code crew-panel__code--quiet" onClick={onShowCode}>
            <Icon name="qr" size={16} /> Crew code
          </button>
        </div>
      )}
    </div>
  );
}

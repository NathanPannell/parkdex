import { motion } from "motion/react";
import { CrewList } from "../../components/CrewList";
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
  myHandle: string | null;
  onShowCode: () => void;
};

/**
 * The park page's crew panel (#171): the protected hour for the leader, members and everyone
 * else, the way to show the crew code, and the crew list. After the hour, the crew list stays
 * under the holder row with "Crew window closed".
 */
export function CrewPanel({ phase, flag, crew, now, myHandle, onShowCode }: Props) {
  if (phase.kind === "none") return null;
  const headline = crewHeadline(phase, now);
  const size = crew?.size ?? flag.crew?.size ?? 1;
  const list = crew && crew.members.length > 0 ? <CrewList members={crew.members} flagSince={crew.flagSince} myHandle={myHandle} /> : null;

  if (phase.kind === "closed") {
    return (
      <section className="crew-panel is-closed" aria-label="Crew">
        <p className="crew-panel__closed"><Icon name="lock" size={14} /> Crew window closed{list ? "" : ` · crew of ${size}`}</p>
        {list}
      </section>
    );
  }

  return (
    <section className={`crew-panel is-${phase.kind}`} aria-label="Crew">
      <p className="crew-panel__status" role="timer" aria-live="off">
        <Icon name="shield" size={20} />
        <strong>{headline}</strong>
      </p>
      {phase.kind === "outsider" ? (
        phase.logged
          ? <p className="crew-panel__note crew-panel__note--logged">{loggedVisitLine(phase.until)}</p>
          : <p className="crew-panel__note">Ask the crew for their code to join.</p>
      ) : (
        <>
          <motion.button whileTap={press} className="btn btn--sun btn--block crew-panel__code" onClick={onShowCode}>
            <Icon name="qr" size={20} /> Show crew code
          </motion.button>
          {list ?? <p className="crew-panel__note">{size === 1 ? "Just you so far." : `Crew of ${size}.`}</p>}
        </>
      )}
    </section>
  );
}

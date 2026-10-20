import { Icon } from "../../components/Icon";
import type { Crew, ParkFlag } from "../../lib/game/client";
import { crewHeadline, loggedVisitLine, type CrewPhase } from "../../lib/game/crew";
import { CrewList } from "../../components/CrewList";

type Props = {
  phase: CrewPhase;
  flag: ParkFlag;
  /** The crew read when the page opened, when it matches the flag on the map. */
  crew: Crew | null;
  now: number;
  myHandle: string | null;
  /** False when the page's main button is already "Show crew code". */
  showCode: boolean;
  onShowCode: () => void;
};

/**
 * The crew part of the park page's flag card (#171): the protected hour for the leader, members
 * and everyone else, who is in the crew, and a small way to show the crew code. The page's main
 * button becomes "Show crew code" when that is the obvious next step, so this one then hides.
 * After the hour, one quiet line says the window closed.
 */
export function CrewPanel({ phase, flag, crew, now, myHandle, showCode, onShowCode }: Props) {
  if (phase.kind === "none") return null;
  const size = crew?.size ?? flag.crew?.size ?? 1;
  const members = crew && crew.members.length > 1 ? <CrewList members={crew.members} flagSince={crew.flagSince} myHandle={myHandle} /> : null;

  if (phase.kind === "closed") {
    return (
      <div className="crew-panel is-closed" aria-label="Crew" role="group">
        <p className="crew-panel__closed">
          <Icon name="lock" size={14} /> Crew window closed · crew of {size}
        </p>
        {members}
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
          {phase.logged ? loggedVisitLine(phase.until) : "Join with the crew's code, or log your visit."}
        </p>
      ) : (
        <div className="crew-panel__row">
          <p className="crew-panel__note">{size === 1 ? "Just you so far." : `Crew of ${size}.`}</p>
          {showCode && (
            <button className="btn btn--paper btn--sm crew-panel__code crew-panel__code--quiet" onClick={onShowCode}>
              <Icon name="qr" size={16} /> Crew code
            </button>
          )}
        </div>
      )}
      {members}
    </div>
  );
}

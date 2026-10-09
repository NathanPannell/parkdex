import { AnimatePresence, motion } from "motion/react";
import { FlagPin } from "../../components/Flag";
import { Icon } from "../../components/Icon";
import { Bubble, Kip } from "../../components/Kip";
import { Rays } from "../../components/Motion";
import { formatTrip, type Trip } from "../../lib/drive";
import { formatDistance } from "../../lib/geo";
import type { Park } from "../../lib/parks";
import type { ParkHolder } from "../../lib/game/visit";
import { DEMO_TOOLS } from "../../lib/demo";
import { directionsUrl, parkLocationUrl } from "./ParkSheet";
import { recordDirectionsOpened } from "../../lib/interactions";

function holderSeed(holder: ParkHolder): string | null {
  return holder.kind === "mine" || holder.kind === "other" ? holder.flag.flagSeed : null;
}

type TripProps = {
  park: Park;
  holder: ParkHolder;
  flagDays: number;
  remaining: Trip;
  totalKm: number;
  simulating: boolean;
  onSimulate: () => void;
  onEnd: () => void;
  onOpen: () => void;
  entryPoint: "map" | "nearby" | "collection";
  contentReleaseId: string;
};

export function TripPanel({ park, holder, flagDays, remaining, totalKm, simulating, onSimulate, onEnd, onOpen, entryPoint, contentReleaseId }: TripProps) {
  const accessUnknown = remaining.mode === "unknown";
  const remainingKm = remaining.km;
  const progress = totalKm > 0 ? Math.min(1, Math.max(0, 1 - remainingKm / totalKm)) : 0;
  return (
    <motion.div
      className="trip card"
      initial={{ y: 240, scale: 0.9 }}
      animate={{ y: 0, scale: 1 }}
      exit={{ y: 260, transition: { duration: 0.25 } }}
      transition={{ type: "spring", stiffness: 320, damping: 26 }}
    >
      <div className="trip__row">
        <button className="trip__badge" onClick={onOpen} aria-label="Park details">
          <motion.div animate={{ rotate: [0, -6, 6, 0] }} transition={{ duration: 2.4, repeat: Infinity }}>
            <FlagPin seed={holderSeed(holder)} days={flagDays} size={50} />
          </motion.div>
        </button>
        <div className="trip__text">
          <span className="eyebrow">{accessUnknown ? "Park location" : "Heading to"}</span>
          <strong>{park.short}</strong>
        </div>
        <button className="trip__end" onClick={onEnd} aria-label="End trip">
          <Icon name="close" size={16} stroke={3} />
        </button>
      </div>
      <div className="trip__meter">
        {accessUnknown ? (
          <div className="trip__big">
            <span>Access unknown</span>
            <small>Check local access before you go</small>
          </div>
        ) : (
          <>
            <div className="trip__big">
              <motion.span key={formatDistance(remainingKm)} initial={{ y: 8, opacity: 0.4 }} animate={{ y: 0, opacity: 1 }}>
                {formatDistance(remainingKm)}
              </motion.span>
              <small>by road · about {formatTrip(remaining)}</small>
            </div>
            <div className="trip__bar">
              <motion.div className="trip__fill" animate={{ width: `${progress * 100}%` }} transition={{ type: "spring", stiffness: 120, damping: 20 }} />
              <motion.div className="trip__car" animate={{ left: `${progress * 100}%` }} transition={{ type: "spring", stiffness: 120, damping: 20 }}>
                <Icon name="car" size={16} stroke={2.6} />
              </motion.div>
              <div className="trip__flag">
                <Icon name="pin" size={16} stroke={2.6} />
              </div>
            </div>
          </>
        )}
      </div>
      <div className="trip__actions">
        <a className="btn btn--paper btn--sm" href={accessUnknown ? parkLocationUrl(park) : directionsUrl(park)} target="_blank" rel="noreferrer" onClick={() => {
          if (!accessUnknown) void recordDirectionsOpened({ parkId: park.id, entryPoint, provider: "google_maps", travelMode: "driving", contentReleaseId }).catch(() => {});
        }}>
          <Icon name={accessUnknown ? "pin" : "car"} size={18} /> {accessUnknown ? "View park location" : "Open in Maps"}
        </a>
        {DEMO_TOOLS && !accessUnknown && (
          <button className="btn btn--sun btn--sm trip__sim" onClick={onSimulate} disabled={simulating}>
            <Icon name="play" size={14} /> {simulating ? "Travelling…" : "Demo: simulate trip"}
          </button>
        )}
      </div>
    </motion.div>
  );
}

export function ArrivalCard({ park, holder, flagDays, visitLabel, onCheckIn, onDismiss }: {
  park: Park;
  holder: ParkHolder;
  flagDays: number;
  visitLabel: string;
  onCheckIn: () => void;
  onDismiss: () => void;
}) {
  const flown = flagDays === 1 ? "1 day" : `${flagDays} days`;
  const message = holder.kind === "mine"
    ? flagDays < 1 ? "You planted your flag here today. It is still flying." : `Your flag has flown here for ${flown}. Check in to keep it up.`
    : holder.kind === "other"
      ? flagDays < 1
        ? `@${holder.flag.handle} planted a flag here today. Take it for your own.`
        : `@${holder.flag.handle}'s flag has flown here for ${flown}. Take it for +${flagDays} ${flagDays === 1 ? "point" : "points"}.`
      : holder.kind === "empty"
        ? "Nobody holds this park yet. Plant your flag and earn a point every day it flies."
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
      <motion.div className="arrival__kip" initial={{ scale: 0, y: 40 }} animate={{ scale: 1, y: 0 }} transition={{ type: "spring", delay: 0.25, stiffness: 400, damping: 14 }}>
        <Bubble side="to-right" style={{ position: "relative", marginBottom: 26, whiteSpace: "nowrap" }}>
          KLEEP! You made it!
        </Bubble>
        <Kip pose="cheer" size={92} />
      </motion.div>
      <div className="arrival__card card">
        <motion.span className="arrival__tag" initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: "spring", delay: 0.15, stiffness: 600, damping: 14 }}>
          <Icon name="check" size={14} stroke={3.4} /> Inside the boundary
        </motion.span>
        <h2>
          Welcome to
          <br />
          {park.short}
        </h2>
        <p>{message}</p>
        <AnimatePresence>
          <motion.button className="btn btn--block btn--glow" onClick={onCheckIn} initial={{ scale: 0.8 }} animate={{ scale: 1 }} transition={{ type: "spring", delay: 0.4 }}>
            <Icon name="flag" /> {visitLabel}
          </motion.button>
        </AnimatePresence>
        <button className="arrival__later" onClick={onDismiss}>
          Look around first
        </button>
      </div>
    </motion.div>
  );
}

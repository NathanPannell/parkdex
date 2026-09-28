import { AnimatePresence, motion } from "motion/react";
import { Badge } from "../../components/Badge";
import { Icon } from "../../components/Icon";
import { Bubble, Kip } from "../../components/Kip";
import { Rays } from "../../components/Motion";
import { formatTrip, type Trip } from "../../lib/drive";
import { formatDistance } from "../../lib/geo";
import type { Park } from "../../lib/parks";
import { FIELD } from "../../lib/native";
import { directionsUrl } from "./ParkSheet";
import { recordDirectionsOpened } from "../../lib/interactions";

type TripProps = {
  park: Park;
  remaining: Trip;
  totalKm: number;
  simulating: boolean;
  onSimulate: () => void;
  onEnd: () => void;
  onOpen: () => void;
  entryPoint: "map" | "nearby" | "collection";
  contentReleaseId: string;
};

export function TripPanel({ park, remaining, totalKm, simulating, onSimulate, onEnd, onOpen, entryPoint, contentReleaseId }: TripProps) {
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
            <Badge park={park} size={58} showName={false} state="preview" />
          </motion.div>
        </button>
        <div className="trip__text">
          <span className="eyebrow">Heading to</span>
          <strong>{park.short}</strong>
        </div>
        <button className="trip__end" onClick={onEnd} aria-label="End trip">
          <Icon name="close" size={16} stroke={3} />
        </button>
      </div>
      <div className="trip__meter">
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
      </div>
      <div className="trip__actions">
        <a className="btn btn--paper btn--sm" href={directionsUrl(park)} target="_blank" rel="noreferrer" onClick={() => void recordDirectionsOpened({ parkId: park.id, entryPoint, provider: "google_maps", travelMode: "driving", contentReleaseId }).catch(() => {})}>
          <Icon name="car" size={18} /> Open in Maps
        </a>
        {!FIELD && (
          <button className="btn btn--sun btn--sm trip__sim" onClick={onSimulate} disabled={simulating}>
            <Icon name="play" size={14} /> {simulating ? "Travelling…" : "Demo: simulate trip"}
          </button>
        )}
      </div>
    </motion.div>
  );
}

export function ArrivalCard({ park, onCheckIn, onDismiss }: { park: Park; onCheckIn: () => void; onDismiss: () => void }) {
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
        <Kip pose="cheer" size={112} />
        <Bubble side="right" style={{ right: 84, top: -6, whiteSpace: "nowrap" }}>
          KLEEP! You made it!
        </Bubble>
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
        <p>Snap a photo of where you're standing to claim your badge.</p>
        <AnimatePresence>
          <motion.button className="btn btn--block btn--glow" onClick={onCheckIn} initial={{ scale: 0.8 }} animate={{ scale: 1 }} transition={{ type: "spring", delay: 0.4 }}>
            <Icon name="camera" /> Check in &amp; snap
          </motion.button>
        </AnimatePresence>
        <button className="arrival__later" onClick={onDismiss}>
          Look around first
        </button>
      </div>
    </motion.div>
  );
}

import { motion, type PanInfo } from "motion/react";
import { Badge } from "../../components/Badge";
import { Icon } from "../../components/Icon";
import { Rays, Tilt } from "../../components/Motion";
import { distanceKm, formatDistance, formatMinutes, travelEstimate, type LngLat } from "../../lib/geo";
import { BIOME_LABEL, CATEGORY_LABEL, isLive, PALETTES, RARITY, type Park } from "../../lib/parks";
import type { Claim } from "../../lib/store";

type Props = {
  park: Park;
  user: LngLat;
  claim?: Claim;
  inside: boolean;
  onClose: () => void;
  onGo: () => void;
  onCheckIn: () => void;
  onViewCase: () => void;
};

const stagger = { show: { transition: { staggerChildren: 0.05, delayChildren: 0.12 } } };
const item = {
  hidden: { y: 16, opacity: 0 },
  show: { y: 0, opacity: 1, transition: { type: "spring" as const, stiffness: 420, damping: 30 } },
};

export function directionsUrl(park: Park) {
  return `https://www.google.com/maps/dir/?api=1&destination=${park.lat},${park.lng}`;
}

export function ParkSheet({ park, user, claim, inside, onClose, onGo, onCheckIn, onViewCase }: Props) {
  const km = distanceKm(user, [park.lng, park.lat]);
  const { driveMin } = travelEstimate(km);
  const finalWalk = 3 + (park.seed % 11);
  const live = isLive(park);
  const pal = live ? PALETTES[park.biome] : { skyTop: "#E9DFCB", skyBottom: "#F7F0E2" };
  const rarity = RARITY[park.rarity];

  const onDragEnd = (_: unknown, info: PanInfo) => {
    if (info.offset.y > 110 || info.velocity.y > 600) onClose();
  };

  return (
    <motion.div
      className="sheet park-sheet"
      initial={{ y: "100%" }}
      animate={{ y: 0 }}
      exit={{ y: "100%", transition: { type: "spring", stiffness: 400, damping: 40 } }}
      transition={{ type: "spring", stiffness: 300, damping: 30 }}
      drag="y"
      dragConstraints={{ top: 0, bottom: 0 }}
      dragElastic={{ top: 0.05, bottom: 0.7 }}
      onDragEnd={onDragEnd}
    >
      <div className="park-sheet__hero" style={{ background: `linear-gradient(180deg, ${pal.skyTop}, ${pal.skyBottom})` }}>
        <div className="sheet__handle" />
        <button className="park-sheet__close" onClick={onClose} aria-label="Close">
          <Icon name="close" size={18} stroke={3} />
        </button>
        <div className="park-sheet__rays">
          <Rays color="#FFFFFF" size={460} opacity={0.35} />
        </div>
        <motion.div
          className="park-sheet__badge"
          layoutId={`badge-${park.id}`}
          initial={{ scale: 0.3, rotate: -25, y: 60 }}
          animate={{ scale: 1, rotate: 0, y: 0 }}
          transition={{ type: "spring", stiffness: 260, damping: 15, delay: 0.08 }}
        >
          <Tilt>
            <Badge park={park} size={176} animated state={claim ? "earned" : "preview"} />
          </Tilt>
        </motion.div>
        <motion.div className="park-sheet__earn" initial={{ scale: 0, rotate: -10 }} animate={{ scale: 1, rotate: -4 }} transition={{ type: "spring", delay: 0.35, stiffness: 500, damping: 15 }}>
          {claim ? "In your case" : live ? "You'll earn this" : "Badge coming soon"}
        </motion.div>
      </div>

      <motion.div className="park-sheet__body scroll" variants={stagger} initial="hidden" animate="show">
        <motion.div className="park-sheet__pills" variants={item}>
          {live ? (
            <span className="pill" style={{ background: rarity.color, color: rarity.ink }}>
              {"★".repeat(rarity.stars)} {rarity.label}
            </span>
          ) : (
            <span className="pill">Badge coming soon</span>
          )}
          <span className="pill">{BIOME_LABEL[park.biome]}</span>
        </motion.div>
        <motion.h2 variants={item} className="park-sheet__name">
          {park.name}
        </motion.h2>
        <motion.p variants={item} className="park-sheet__meta">
          {CATEGORY_LABEL[park.category]} · {park.region}
        </motion.p>

        <motion.div variants={item} className="stats">
          <div className="stat">
            <Icon name="pin" size={18} />
            <strong>{inside ? "Here!" : formatDistance(km)}</strong>
            <span>away</span>
          </div>
          <div className="stat">
            <Icon name="car" size={18} />
            <strong>{inside ? "0 min" : formatMinutes(driveMin)}</strong>
            <span>to get there</span>
          </div>
          <div className="stat">
            <Icon name="walk" size={18} />
            <strong>{finalWalk} min</strong>
            <span>final walk in</span>
          </div>
        </motion.div>

        <motion.p variants={item} className="park-sheet__blurb">
          {park.blurb}
        </motion.p>

        <motion.div variants={item} className="park-sheet__how">
          <span className="park-sheet__how-step">1</span> Get to the park
          <span className="park-sheet__how-dash" />
          <span className="park-sheet__how-step">2</span> Step inside
          <span className="park-sheet__how-dash" />
          <span className="park-sheet__how-step">3</span> Snap + claim
        </motion.div>
      </motion.div>

      <motion.div className="park-sheet__cta" initial={{ y: 80 }} animate={{ y: 0 }} transition={{ type: "spring", stiffness: 380, damping: 28, delay: 0.2 }}>
        {claim ? (
          <button className="btn btn--block btn--ink" onClick={onViewCase}>
            <Icon name="case" /> View in your case
          </button>
        ) : !live ? (
          <>
            <button className="btn btn--block btn--paper" disabled>
              Badge art coming soon
            </button>
            <a className="btn btn--paper btn--icon" href={directionsUrl(park)} target="_blank" rel="noreferrer" aria-label="Directions in Google Maps">
              <Icon name="car" />
            </a>
          </>
        ) : inside ? (
          <button className="btn btn--block btn--glow" onClick={onCheckIn}>
            <Icon name="camera" /> Check in &amp; claim
          </button>
        ) : (
          <>
            <button className="btn btn--block" onClick={onGo}>
              <Icon name="route" /> Let's go
            </button>
            <a className="btn btn--paper btn--icon" href={directionsUrl(park)} target="_blank" rel="noreferrer" aria-label="Directions in Google Maps">
              <Icon name="car" />
            </a>
          </>
        )}
      </motion.div>
    </motion.div>
  );
}

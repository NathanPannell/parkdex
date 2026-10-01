import { motion, type PanInfo } from "motion/react";
import { Badge } from "../../components/Badge";
import { EarnedBadge } from "../../components/EarnedBadge";
import { Icon } from "../../components/Icon";
import { Rays, Tilt } from "../../components/Motion";
import { boundaryAreaKm2, formatArea } from "../../lib/area";
import { useBoundaries } from "../../lib/boundaries";
import { estimateTrip } from "../../lib/drive";
import { distanceKm, formatDistance, type LngLat } from "../../lib/geo";
import { isNative } from "../../lib/native";
import { CATEGORY_LABEL, isLive, LANDSCAPE_TINT, landscapeLabel, landscapeOf, PALETTES, RARITY, type Park } from "../../lib/parks";
import type { ParkRarityEligibility } from "../../lib/progression";
import { RarityGuide } from "../../components/RarityGuide";
import { rarityLockMessage } from "../../lib/rarityUi";
import type { Claim } from "../../lib/store";
import { useContent } from "../../lib/content/provider";
import { recordDirectionsOpened } from "../../lib/interactions";

type Props = {
  park: Park;
  user: LngLat;
  claim?: Claim;
  inside: boolean;
  eligibility: ParkRarityEligibility;
  progressReady: boolean;
  onClose: () => void;
  onGo: () => void;
  onCheckIn: () => void;
  onViewCase: () => void;
  onFeedback: () => void;
  entryPoint: "map" | "nearby" | "collection";
};

const stagger = { show: { transition: { staggerChildren: 0.05, delayChildren: 0.12 } } };
const item = {
  hidden: { y: 16, opacity: 0 },
  show: { y: 0, opacity: 1, transition: { type: "spring" as const, stiffness: 420, damping: 30 } },
};

export function directionsUrl(park: Park) {
  return `https://www.google.com/maps/dir/?api=1&destination=${park.lat},${park.lng}`;
}

export function parkLocationUrl(park: Park) {
  return `https://www.google.com/maps/search/?api=1&query=${park.lat},${park.lng}`;
}

export function ParkSheet({ park, user, claim, inside, eligibility, progressReady, onClose, onGo, onCheckIn, onViewCase, onFeedback, entryPoint }: Props) {
  const content = useContent();
  const trip = estimateTrip(user, park, content?.drive);
  const accessUnknown = trip.mode === "unknown";
  const boundary = useBoundaries()?.byId.get(park.id);
  const areaKm2 = boundary ? boundaryAreaKm2(boundary) : 0;
  const straightKm = distanceKm(user, [park.lng, park.lat]);
  const landscape = landscapeOf(park);
  const tint = LANDSCAPE_TINT[landscape];
  const live = isLive(park);
  const locked = eligibility.reason === "locked" || eligibility.reason === "unsupported-rarity";
  const pal = live ? PALETTES[park.biome] : { skyTop: "#E9DFCB", skyBottom: "#F7F0E2" };
  const rarity = RARITY[park.rarity];
  const openDirections = () => {
    if (content && !accessUnknown) void recordDirectionsOpened({ parkId: park.id, entryPoint, provider: "google_maps", travelMode: "driving", contentReleaseId: content.releaseId }).catch(() => {});
  };
  const badge = claim
    ? <EarnedBadge park={park} claim={claim} size={176} animated state="earned" />
    : <Badge park={park} size={176} animated state="preview" />;

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
          {/* Android WebView mispaints SVG badge text under Tilt's 3D transform. */}
          {isNative ? badge : <Tilt>{badge}</Tilt>}
        </motion.div>
        <motion.div className="park-sheet__earn" initial={{ scale: 0, rotate: -10 }} animate={{ scale: 1, rotate: -4 }} transition={{ type: "spring", delay: 0.35, stiffness: 500, damping: 15 }}>
          {claim ? "In your Dex" : eligibility.reason === "unavailable" ? "Checking rarity" : locked ? `${rarity.label} · Locked` : live ? "You can claim this" : "Claimable · art coming soon"}
        </motion.div>
      </div>

      <motion.div className="park-sheet__body scroll" variants={stagger} initial="hidden" animate="show">
        <motion.div className="park-sheet__pills" variants={item}>
          <span className="pill" style={{ background: rarity.color, color: rarity.ink }}>
            {"★".repeat(rarity.stars)} {rarity.label}
          </span>
          {!live && <span className="pill park-sheet__art-pill">Badge art coming soon</span>}
        </motion.div>
        <motion.h2 variants={item} className="park-sheet__name">
          {park.name}
        </motion.h2>
        <motion.p variants={item} className="park-sheet__meta">
          {CATEGORY_LABEL[park.category]} · {park.region}
        </motion.p>
        <RarityGuide rarity={park.rarity} eligibility={eligibility} />

        <motion.div variants={item} className="stats">
          <div className="stat">
            <Icon name="pin" size={18} />
            <strong>{inside ? "Here!" : formatDistance(straightKm)}</strong>
            <span>{inside ? "you made it" : "from you"}</span>
          </div>
          <div className="stat">
            <Icon name="corners" size={18} />
            <strong>{areaKm2 > 0 ? formatArea(areaKm2) : "Unknown"}</strong>
            <span>park area</span>
          </div>
          <div className="stat stat--landscape" style={{ background: tint.bg, color: tint.ink }}>
            <Icon name={landscape === "legendary" ? "sparkle" : landscape} size={18} />
            <strong>{landscapeLabel(park)}</strong>
          </div>
        </motion.div>

        <motion.p variants={item} className="park-sheet__blurb">
          {park.blurb}
        </motion.p>

        <motion.button variants={item} className="fb-link park-sheet__report" onClick={onFeedback}>
          <Icon name="chat" size={16} /> Something wrong with this park? Tell us
        </motion.button>
      </motion.div>

      <motion.div className="park-sheet__cta" initial={{ y: 80 }} animate={{ y: 0 }} transition={{ type: "spring", stiffness: 380, damping: 28, delay: 0.2 }}>
        {claim ? (
          <button className="btn btn--block btn--ink" onClick={onViewCase}>
            <Icon name="case" /> View in your Dex
          </button>
        ) : !eligibility.eligible ? (
          eligibility.reason === "unavailable" || !progressReady ? (
            <button className="btn btn--block btn--paper" disabled>
              Checking saved progress
            </button>
          ) : inside ? (
            <button className="btn btn--block btn--paper" disabled aria-label={rarityLockMessage(eligibility)}>
              {rarityLockMessage(eligibility)}
            </button>
          ) : (
            <>
              <button className="btn btn--block" onClick={onGo}>
                <Icon name={accessUnknown ? "pin" : "route"} /> {accessUnknown ? "View park location" : "Preview route"}
              </button>
              <a className="btn btn--paper btn--icon" href={accessUnknown ? parkLocationUrl(park) : directionsUrl(park)} target="_blank" rel="noreferrer" aria-label={accessUnknown ? "Park location in Google Maps" : "Directions in Google Maps"} onClick={openDirections}>
                <Icon name={accessUnknown ? "pin" : "car"} />
              </a>
            </>
          )
        ) : inside ? (
          <button className="btn btn--block btn--glow" onClick={onCheckIn}>
            <Icon name="camera" /> Check in &amp; claim
          </button>
        ) : (
          <>
            <button className="btn btn--block" onClick={onGo}>
              <Icon name={accessUnknown ? "pin" : "route"} /> {accessUnknown ? "View park location" : "Let's go"}
            </button>
            <a className="btn btn--paper btn--icon" href={accessUnknown ? parkLocationUrl(park) : directionsUrl(park)} target="_blank" rel="noreferrer" aria-label={accessUnknown ? "Park location in Google Maps" : "Directions in Google Maps"} onClick={openDirections}>
              <Icon name={accessUnknown ? "pin" : "car"} />
            </a>
          </>
        )}
      </motion.div>
    </motion.div>
  );
}

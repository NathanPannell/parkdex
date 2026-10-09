import { motion, type PanInfo } from "motion/react";
import { useState } from "react";
import { Badge } from "../../components/Badge";
import { EarnedBadge } from "../../components/EarnedBadge";
import { FlagPin } from "../../components/Flag";
import { Icon } from "../../components/Icon";
import { Rays, Tilt } from "../../components/Motion";
import { boundaryAreaKm2, formatArea } from "../../lib/area";
import { useBoundaries } from "../../lib/boundaries";
import { estimateTrip } from "../../lib/drive";
import { distanceKm, formatDistance, type LngLat } from "../../lib/geo";
import { isNative } from "../../lib/native";
import { CATEGORY_LABEL, isLive, LANDSCAPE_TINT, landscapeLabel, landscapeOf, PALETTES, RARITY, type Park } from "../../lib/parks";
import type { ParkHolder } from "../../lib/game/visit";
import type { Claim } from "../../lib/store";
import { useContent } from "../../lib/content/provider";
import { recordDirectionsOpened } from "../../lib/interactions";
import { SHOW_BADGE_ART } from "../../lib/parks";
import { founderCta, summaryCover, summaryStats, useParkSummary } from "../../lib/parkSummary";
import { useGame } from "../../lib/game/GameProvider";
import "../../found-park.css";

type Props = {
  park: Park;
  user: LngLat;
  claim?: Claim;
  inside: boolean;
  /** Who holds the park's flag right now. */
  holder: ParkHolder;
  flagDays: number;
  /** Plant, take or visit, or sign in first. */
  visitLabel: string;
  signedIn: boolean;
  /** Inside this park's boundary, as visits count it; founding needs it. */
  insideForFounding: boolean;
  /** Founding is offered in this build. */
  canFound: boolean;
  onFound: () => void;
  onClose: () => void;
  onGo: () => void;
  onCheckIn: () => void;
  onFeedback: () => void;
  entryPoint: "map" | "nearby" | "collection";
};

const stagger = { show: { transition: { staggerChildren: 0.05, delayChildren: 0.12 } } };
const item = {
  hidden: { y: 16, opacity: 0 },
  show: { y: 0, opacity: 1, transition: { type: "spring" as const, stiffness: 420, damping: 30 } },
};

export function directionsUrl(park: Park) {
  return park.googleMapsUrl || `https://www.google.com/maps/dir/?api=1&destination=${park.lat},${park.lng}`;
}

// A researched link is the better target even when road access is unknown.
export function parkLocationUrl(park: Park) {
  return park.googleMapsUrl || `https://www.google.com/maps/search/?api=1&query=${park.lat},${park.lng}`;
}

export function ParkSheet({ park, user, claim, inside, holder, flagDays, visitLabel, signedIn, insideForFounding, canFound, onFound, onClose, onGo, onCheckIn, onFeedback, entryPoint }: Props) {
  const content = useContent();
  const game = useGame();
  const summary = useParkSummary(park.id, game.accountId);
  const cover = summaryCover(summary);
  const [coverFailed, setCoverFailed] = useState(false);
  const showCover = !!cover && !coverFailed;
  const founder = founderCta(summary, insideForFounding, canFound);
  const stats = summaryStats(summary, signedIn);
  const trip = estimateTrip(user, park, content?.drive);
  const accessUnknown = trip.mode === "unknown";
  const boundary = useBoundaries()?.byId.get(park.id);
  const areaKm2 = boundary ? boundaryAreaKm2(boundary) : 0;
  const straightKm = distanceKm(user, [park.lng, park.lat]);
  const landscape = landscapeOf(park);
  const tint = LANDSCAPE_TINT[landscape];
  const live = isLive(park);
  const holderLine = flagStatus(holder, flagDays);
  const pal = live ? PALETTES[park.biome] : { skyTop: "#E9DFCB", skyBottom: "#F7F0E2" };
  const rarity = RARITY[park.rarity];
  const openDirections = () => {
    if (content && !accessUnknown) void recordDirectionsOpened({ parkId: park.id, entryPoint, provider: "google_maps", travelMode: "driving", contentReleaseId: content.releaseId }).catch(() => {});
  };
  // Every park gets the same primary button, the in-app trip. Maps is the secondary action:
  // driving directions when a road route is known, otherwise the park's location.
  const mapsButton = accessUnknown ? (
    <a className="btn btn--paper btn--icon" href={parkLocationUrl(park)} target="_blank" rel="noreferrer" aria-label="Open the park in Google Maps" onClick={openDirections}>
      <Icon name="pin" />
    </a>
  ) : (
    <a className="btn btn--paper btn--icon" href={directionsUrl(park)} target="_blank" rel="noreferrer" aria-label="Directions in Google Maps" onClick={openDirections}>
      <Icon name="car" />
    </a>
  );
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
      <div className={`park-sheet__hero${showCover ? " has-cover" : ""}`} style={{ background: `linear-gradient(180deg, ${pal.skyTop}, ${pal.skyBottom})` }}>
        <div className="sheet__handle" />
        <button className="park-sheet__close" onClick={onClose} aria-label="Close">
          <Icon name="close" size={18} stroke={3} />
        </button>
        {showCover ? (
          // The founder's approved photo replaces the badge as the park's face.
          <motion.div className="park-sheet__cover" initial={{ scale: 0.92, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: "spring", stiffness: 300, damping: 24, delay: 0.05 }}>
            <img src={cover} alt={`${park.name}, photographed by its founder`} onError={() => setCoverFailed(true)} />
          </motion.div>
        ) : (
          <>
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
          </>
        )}
        <motion.div className="park-sheet__earn" initial={{ scale: 0, rotate: -10 }} animate={{ scale: 1, rotate: -4 }} transition={{ type: "spring", delay: 0.35, stiffness: 500, damping: 15 }}>
          {holder.kind === "mine" ? "Your flag flies here" : holder.kind === "other" ? `@${holder.flag.handle}'s park` : holder.kind === "empty" ? "No flag yet" : "Flags need a connection"}
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
        <motion.div variants={item} className={`park-sheet__holder is-${holder.kind}`}>
          <FlagPin seed={holder.kind === "mine" || holder.kind === "other" ? holder.flag.flagSeed : null} days={flagDays} size={44} showAge={false} className="is-waving-pin" />
          <span>
            <strong>{holderLine.title}</strong>
            <em>{holderLine.detail}</em>
          </span>
          {holder.kind === "other" && flagDays > 0 && (
            <motion.span
              className="park-sheet__bounty"
              initial={{ scale: 0, rotate: -12 }}
              animate={{ scale: [1, 1.08, 1], rotate: -4 }}
              transition={{ scale: { duration: 1.6, repeat: Infinity, delay: 0.6 }, rotate: { type: "spring", stiffness: 500, damping: 14 } }}
              aria-label={`Worth ${flagDays} points`}
            >
              +{flagDays}
            </motion.span>
          )}
        </motion.div>

        {founder.kind !== "hidden" && (
          <motion.button
            variants={item}
            className="founder-cta"
            onClick={onFound}
            disabled={founder.kind !== "found"}
            aria-label={founder.kind === "found" ? `Become the founder of ${park.name}, plus ${founder.points} points` : founder.text}
          >
            <span className="founder-cta__icon"><Icon name="camera" size={22} /></span>
            <span className="founder-cta__text">
              <strong>Become the founder</strong>
              <em>{founder.kind === "found" ? "Take its first photo. It becomes the park's cover." : founder.text}</em>
            </span>
            <span className="founder-cta__points">+{founder.points}</span>
          </motion.button>
        )}

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

        {SHOW_BADGE_ART && (
          <motion.p variants={item} className="park-sheet__blurb">
            {park.blurb}
          </motion.p>
        )}

        <motion.section variants={item} className={`park-summary${stats.pending ? " is-pending" : ""}`} aria-label="Park stats" aria-busy={stats.pending}>
          <p className="park-summary__founder">
            <Icon name="flagPlus" size={18} /> {stats.founder}
          </p>
          <dl className="park-summary__counts">
            <div>
              <dt>Your visits</dt>
              <dd>{stats.mine}</dd>
            </div>
            <div>
              <dt>All visits</dt>
              <dd>{stats.total}</dd>
            </div>
            <div>
              <dt>Last 30 days</dt>
              <dd>{stats.last30Days}</dd>
            </div>
          </dl>
          {stats.note && <p className="park-summary__note">{stats.note}</p>}
        </motion.section>

        <motion.button variants={item} className="fb-link park-sheet__report" onClick={onFeedback}>
          <Icon name="chat" size={16} /> Something wrong with this park? Tell us
        </motion.button>
      </motion.div>

      <motion.div className="park-sheet__cta" initial={{ y: 80 }} animate={{ y: 0 }} transition={{ type: "spring", stiffness: 380, damping: 28, delay: 0.2 }}>
        {inside ? (
          <button className="btn btn--block btn--glow" onClick={onCheckIn}>
            <Icon name="flag" /> {visitLabel}
          </button>
        ) : (
          <>
            <button className="btn btn--block" onClick={onGo}>
              <Icon name="route" /> Let's go
            </button>
            {mapsButton}
          </>
        )}
      </motion.div>
    </motion.div>
  );
}

function flagStatus(holder: ParkHolder, days: number): { title: string; detail: string } {
  const flown = days === 1 ? "1 day" : `${days} days`;
  switch (holder.kind) {
    case "mine":
      return { title: "Your flag", detail: days < 1 ? "Planted today" : `Flying for ${flown}` };
    case "other":
      return { title: `@${holder.flag.handle}`, detail: days < 1 ? "Planted today." : `Flying for ${flown}. Take it for +${days} ${days === 1 ? "point" : "points"}.` };
    case "empty":
      return { title: "No flag yet", detail: "Get inside the boundary to plant yours." };
    case "unknown":
      return { title: "Flag unknown", detail: "Connect to the internet to see who holds this park." };
  }
}

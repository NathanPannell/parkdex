import { motion, type PanInfo } from "motion/react";
import { useState, type KeyboardEvent } from "react";
import { Badge } from "../../components/Badge";
import { EarnedBadge } from "../../components/EarnedBadge";
import { FlagPin } from "../../components/Flag";
import { FullscreenViewer } from "../../components/FullscreenViewer";
import { Icon } from "../../components/Icon";
import { Rays, Tilt } from "../../components/Motion";
import { estimateTrip, formatTrip } from "../../lib/drive";
import { distanceKm, formatDistance, type LngLat } from "../../lib/geo";
import { isNative } from "../../lib/native";
import { CATEGORY_LABEL, isLive, LANDSCAPE_TINT, landscapeLabel, landscapeOf, PALETTES, type Park } from "../../lib/parks";
import { takePoints, VISITED_TODAY_LABEL, type ParkHolder } from "../../lib/game/visit";
import { handleFit } from "../../lib/game/handleFit";
import type { Claim } from "../../lib/store";
import { useContent } from "../../lib/content/provider";
import { recordDirectionsOpened } from "../../lib/interactions";
import { founderCta, summaryCover, summaryStats, useParkSummary, visitsLine } from "../../lib/parkSummary";
import { useGame } from "../../lib/game/GameProvider";
import { hasPendingReview } from "../../lib/foundingReviews";
import { formatClockTime, protectionPhase, type ProtectionPhase } from "../../lib/game/protection";
import { buzz } from "../../lib/feedback";
import { PARK_COVER_ASPECT } from "../../lib/photoCrop";
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
  onCheckIn: () => void;
  /** Dev builds only: put the player inside this park. */
  onDemoTeleport?: () => void;
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

export function ParkSheet({
  park,
  user,
  claim,
  inside,
  holder,
  flagDays,
  visitLabel,
  signedIn,
  insideForFounding,
  canFound,
  onFound,
  onClose,
  onCheckIn,
  onDemoTeleport,
  onFeedback,
  entryPoint,
}: Props) {
  const content = useContent();
  const game = useGame();
  const summary = useParkSummary(park.id, game.accountId);
  const cover = summaryCover(summary, game.flags?.founders.get(park.id)?.coverUrl ?? null);
  const [coverFailed, setCoverFailed] = useState(false);
  const showCover = !!cover && !coverFailed;
  const [viewingCover, setViewingCover] = useState(false);
  // Tapping the cover opens it full screen (FullscreenViewer, mounted at the end of the sheet).
  const coverOpener = showCover
    ? {
        role: "button",
        tabIndex: 0,
        "aria-label": `Show the photo of ${park.name} full screen`,
        onClick: () => setViewingCover(true),
        onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          setViewingCover(true);
        },
      }
    : {};
  // Tapping "Visited today, back tomorrow" only nudges the button: it already says why.
  const [nudged, setNudged] = useState(false);
  const founder = founderCta(summary, insideForFounding, canFound, hasPendingReview(game.me, park.id));
  const stats = summaryStats(summary, signedIn);
  const trip = estimateTrip(user, park, content?.drive);
  const accessUnknown = trip.mode === "unknown";
  const straightKm = distanceKm(user, [park.lng, park.lat]);
  const landscape = landscapeOf(park);
  const tint = LANDSCAPE_TINT[landscape];
  const live = isLive(park);
  // Someone else's protected hour (#170): a visit is only logged until it ends.
  const flag = holder.kind === "mine" || holder.kind === "other" ? holder.flag : null;
  const phase = protectionPhase({ flag, myHandle: game.me?.player?.handle ?? null, me: signedIn ? game.me : null, now: game.serverNow() });
  const holderLine = flagStatus(holder, flagDays, phase, inside);
  // The button reads "Visited today, back tomorrow" exactly when today's visit is spent.
  const restingToday = visitLabel === VISITED_TODAY_LABEL;
  // Who founded it and how busy it is, on one quiet line.
  const facts = [stats.founder, visitsLine(stats, signedIn)].filter(Boolean).join(" · ");
  const pal = live ? PALETTES[park.biome] : { skyTop: "#E9DFCB", skyBottom: "#F7F0E2" };
  const openDirections = () => {
    if (content && !accessUnknown)
      void recordDirectionsOpened({ parkId: park.id, entryPoint, provider: "google_maps", travelMode: "driving", contentReleaseId: content.releaseId }).catch(
        () => {},
      );
  };
  // Outside the park, the main button opens Google Maps: driving directions when a road route
  // is known, otherwise the park's location.
  const directions = (
    <a
      className="btn btn--block btn--xl"
      href={accessUnknown ? parkLocationUrl(park) : directionsUrl(park)}
      target="_blank"
      rel="noreferrer"
      onClick={openDirections}
    >
      <Icon name={accessUnknown ? "pin" : "car"} /> {accessUnknown ? "Find it on the map" : "Get directions"}
    </a>
  );
  const badge = claim ? (
    <EarnedBadge park={park} claim={claim} size={160} animated state="earned" />
  ) : (
    <Badge park={park} size={160} animated state="preview" />
  );

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
      // The holder line is "@handle"; it and the take button fit that line.
      style={handleFit(holderLine.title.startsWith("@") ? holderLine.title.slice(1) : null)}
    >
      {/* The page scrolls under a finger, so the strip at the top is where the sheet drags down. */}
      <div className="park-sheet__grab" aria-hidden="true">
        <div className="sheet__handle" />
      </div>
      <button className="park-sheet__close" onClick={onClose} aria-label="Close">
        <Icon name="close" size={18} stroke={3} />
      </button>

      {/* The hero scrolls away with the page, so nothing ever sits underneath it. */}
      <div className="park-sheet__scroll scroll">
        <div
          className={`park-sheet__hero${showCover ? " has-cover viewer-open" : ""}`}
          style={{ aspectRatio: PARK_COVER_ASPECT, background: `linear-gradient(180deg, ${pal.skyTop}, ${pal.skyBottom})` }}
          {...coverOpener}
        >
          {showCover ? (
            // The founder's approved photo replaces the badge as the park's face.
            <motion.div
              className="park-sheet__cover"
              initial={{ scale: 0.96, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: "spring", stiffness: 300, damping: 24, delay: 0.05 }}
            >
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
        </div>

        <motion.div className="park-sheet__body" variants={stagger} initial="hidden" animate="show">
          {/* 1. What park this is, and where it is from you. */}
          <motion.h2 variants={item} className="park-sheet__name">
            {park.name}
          </motion.h2>
          <motion.p variants={item} className="park-sheet__meta">
            {CATEGORY_LABEL[park.category]} · {park.region}
          </motion.p>
          <motion.ul variants={item} className="park-facts__chips park-sheet__chips" aria-label="Where it is">
            <li>
              <Icon name="pin" size={16} />{" "}
              {inside ? "You're here" : accessUnknown ? `${formatDistance(straightKm)} away` : `${formatDistance(straightKm)} · ${formatTrip(trip)}`}
            </li>
            <li style={{ background: tint.bg, color: tint.ink }}>
              <Icon name={landscape === "legendary" ? "sparkle" : landscape} size={16} /> {landscapeLabel(park)}
            </li>
          </motion.ul>

          {/* 2. Whose park it is, and what taking it is worth. */}
          <motion.section variants={item} className={`park-status is-${holder.kind}`} aria-label="Flag">
            <div className="park-sheet__holder">
              <FlagPin
                seed={holder.kind === "mine" || holder.kind === "other" ? holder.flag.flagSeed : null}
                patches={holder.kind === "mine" || holder.kind === "other" ? holder.flag.patches : undefined}
                days={flagDays}
                size={48}
                showAge={false}
                className="is-waving-pin"
              />
              <span>
                <strong>{holderLine.title}</strong>
                <em>{holderLine.detail}</em>
              </span>
              {holder.kind === "other" && phase.kind !== "outsider" && (
                <motion.span
                  className="park-sheet__bounty"
                  initial={{ scale: 0, rotate: -12 }}
                  animate={{ scale: 1, rotate: -4 }}
                  transition={{ type: "spring", stiffness: 500, damping: 14 }}
                  aria-label={`Worth ${takePoints(flagDays)} points`}
                >
                  +{takePoints(flagDays)}
                </motion.span>
              )}
            </div>
          </motion.section>

          {/* 3. The one photo anyone takes: the park's own, which makes you its founder. */}
          {founder.kind === "found" ? (
            <motion.button
              variants={item}
              className="btn btn--block btn--sun btn--xl park-sheet__found"
              onClick={onFound}
              aria-label={`Become the founder of ${park.name}, plus ${founder.points} points`}
            >
              <Icon name="camera" size={24} /> Become the founder
              <span className="park-sheet__points">+{founder.points}</span>
            </motion.button>
          ) : founder.kind === "pending" ? (
            <motion.p variants={item} className="park-sheet__pending" role="status">
              <Icon name="image" size={18} /> {founder.text}
            </motion.p>
          ) : null}

          {/* 4. Who founded it and how busy it is, in one quiet line. */}
          <motion.p variants={item} className={`park-sheet__line${stats.pending ? " is-pending" : ""}`} aria-busy={stats.pending}>
            <Icon name="flagPlus" size={18} /> {facts}
          </motion.p>
          {stats.note && (
            <motion.p variants={item} className="park-summary__note">
              {stats.note}
            </motion.p>
          )}

          <motion.div variants={item} className="park-sheet__links">
            <button className="fb-link park-sheet__report" onClick={onFeedback}>
              <Icon name="chat" size={16} /> Report a problem
            </button>
            {onDemoTeleport && (
              <button className="fb-link" onClick={onDemoTeleport}>
                <Icon name="sparkle" size={16} /> Demo: teleport here
              </button>
            )}
          </motion.div>
        </motion.div>
      </div>

      {/* One big button, always the next thing to do here. */}
      <motion.div className="park-sheet__cta" initial={{ y: 80 }} animate={{ y: 0 }} transition={{ type: "spring", stiffness: 380, damping: 28, delay: 0.2 }}>
        {inside && !restingToday && phase.kind === "outsider" ? (
          // Someone else's protected hour: logging the visit is all there is to do until it ends.
          <button className="btn btn--block btn--xl btn--glow" onClick={onCheckIn} disabled={phase.logged}>
            <Icon name="flag" /> {visitLabel}
          </button>
        ) : inside && restingToday ? (
          // Today's visit is spent: a quiet, clearly disabled button. A tap only nudges it.
          <button
            className={`btn btn--block btn--xl btn--rest${nudged ? " is-nudged" : ""}`}
            aria-disabled="true"
            onClick={() => {
              buzz(20);
              setNudged(true);
            }}
            onAnimationEnd={() => setNudged(false)}
          >
            <Icon name="check" /> {visitLabel}
          </button>
        ) : inside ? (
          <button className="btn btn--block btn--xl btn--glow" onClick={onCheckIn}>
            <Icon name="flag" /> {visitLabel}
          </button>
        ) : (
          directions
        )}
      </motion.div>
      <FullscreenViewer
        slides={showCover ? [{ key: "cover", src: cover, alt: `${park.name}, photographed by its founder` }] : []}
        index={viewingCover ? 0 : null}
        onClose={() => setViewingCover(false)}
        label={`Cover photo of ${park.name}`}
      />
    </motion.div>
  );
}

function flagStatus(holder: ParkHolder, days: number, protection: ProtectionPhase, inside: boolean): { title: string; detail: string } {
  const age = days < 1 ? "today" : days === 1 ? "for 1 day" : `for ${days} days`;
  switch (holder.kind) {
    case "mine":
      return { title: "Your park", detail: days < 1 ? "You took it today" : `Yours ${age}` };
    case "other":
      // Someone else's protected hour (#170): it can't be taken until it ends.
      return {
        title: `@${holder.flag.handle}`,
        detail: protection.kind === "outsider" ? `New flag · free at ${formatClockTime(protection.until)}` : days < 1 ? "Took it today" : `Has held it ${age}`,
      };
    case "empty":
      return { title: "Nobody's park yet", detail: inside ? "Plant your flag to make it yours." : "Walk in and make it yours." };
    case "unknown":
      return { title: "Flag unknown", detail: "Go online to see whose park it is." };
  }
}

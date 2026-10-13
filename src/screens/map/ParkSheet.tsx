import { motion, type PanInfo } from "motion/react";
import { useState } from "react";
import { Badge } from "../../components/Badge";
import { AddDexPhoto } from "../../components/DexPhoto";
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
import { takeLabel, takePoints, VISITED_TODAY_LABEL, type ParkHolder } from "../../lib/game/visit";
import { handleFit } from "../../lib/game/handleFit";
import type { Claim } from "../../lib/store";
import { useContent } from "../../lib/content/provider";
import { recordDirectionsOpened } from "../../lib/interactions";
import { SHOW_BADGE_ART } from "../../lib/parks";
import { founderCta, summaryCover, summaryStats, useParkSummary } from "../../lib/parkSummary";
import { useGame } from "../../lib/game/GameProvider";
import { hasPendingReview } from "../../lib/foundingReviews";
import { crewMatchesFlag, crewPhase, isProtectedPhase } from "../../lib/game/crew";
import { useCrew } from "../../lib/game/CrewProvider";
import { useParkCrew, useServerClock } from "../../lib/game/useParkCrew";
import { useKipTip } from "../../lib/kipTips";
import { buzz } from "../../lib/feedback";
import { PARK_COVER_ASPECT } from "../../lib/photoCrop";
import { CrewList } from "../../components/CrewList";
import { CrewPanel } from "./CrewPanel";
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
  const cover = summaryCover(summary, game.flags?.founders.get(park.id)?.coverUrl ?? null);
  const [coverFailed, setCoverFailed] = useState(false);
  const showCover = !!cover && !coverFailed;
  // "Add another photo" for parks you have visited (#174), from a claim here or visits on the server.
  const visited = !!claim || (summary.summary?.visits.mine ?? 0) > 0 || !!game.me?.visitedToday?.includes(park.id);
  const [adding, setAdding] = useState(false);
  // Tapping "Visited today, back tomorrow" only nudges the button: it already says why.
  const [nudged, setNudged] = useState(false);
  const founder = founderCta(summary, insideForFounding, canFound, hasPendingReview(game.me, park.id));
  const stats = summaryStats(summary, signedIn);
  const trip = estimateTrip(user, park, content?.drive);
  const accessUnknown = trip.mode === "unknown";
  const boundary = useBoundaries()?.byId.get(park.id);
  const areaKm2 = boundary ? boundaryAreaKm2(boundary) : 0;
  const straightKm = distanceKm(user, [park.lng, park.lat]);
  const landscape = landscapeOf(park);
  const tint = LANDSCAPE_TINT[landscape];
  const live = isLive(park);
  // Crews (#171), behind the crews flag: the protected hour, the code and the crew list.
  const crewUi = useCrew();
  const flag = holder.kind === "mine" || holder.kind === "other" ? holder.flag : null;
  const myHandle = game.me?.player?.handle ?? null;
  const crewInput = { enabled: crewUi.enabled && signedIn, flag, myHandle, me: game.me };
  const firstPhase = crewPhase({ ...crewInput, now: game.serverNow() });
  // Members and the leader see the crew list (and outsiders after the hour), so read it once as the page opens.
  const parkCrew = useParkCrew(park.id, firstPhase.kind === "leader" || firstPhase.kind === "member" || firstPhase.kind === "closed");
  const crew = crewMatchesFlag(parkCrew.crew, flag) ? parkCrew.crew : null;
  const now = useServerClock(isProtectedPhase(firstPhase));
  const phase = crewPhase({ ...crewInput, crew, now });
  useKipTip("crew-leader", phase.kind === "leader");
  useKipTip("crew-outsider", phase.kind === "outsider" && !phase.logged);
  const holderLine = flagStatus(holder, flagDays, phase.kind === "outsider");
  // The button reads "Visited today, back tomorrow" exactly when today's visit is spent.
  const restingToday = visitLabel === VISITED_TODAY_LABEL;
  const crewList = crew && crew.members.length > 0 ? crew : null;
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
    ? <EarnedBadge park={park} claim={claim} size={160} animated state="earned" />
    : <Badge park={park} size={160} animated state="preview" />;

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
      // The holder line is "@handle" or "@handle's crew"; it and the take button fit that line.
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
          className={`park-sheet__hero${showCover ? " has-cover" : ""}`}
          style={{ aspectRatio: PARK_COVER_ASPECT, background: `linear-gradient(180deg, ${pal.skyTop}, ${pal.skyBottom})` }}
        >
          {showCover ? (
            // The founder's approved photo replaces the badge as the park's face.
            <motion.div className="park-sheet__cover" initial={{ scale: 0.96, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: "spring", stiffness: 300, damping: 24, delay: 0.05 }}>
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

          {/* One status block: who holds the flag and, during the protected hour, the crew. */}
          <motion.section variants={item} className={`park-status is-${holder.kind}`} aria-label="Flag">
            <div className="park-sheet__holder">
              <FlagPin
                seed={holder.kind === "mine" || holder.kind === "other" ? holder.flag.flagSeed : null}
                patches={holder.kind === "mine" || holder.kind === "other" ? holder.flag.patches : undefined}
                days={flagDays}
                size={44}
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
            {flag && phase.kind !== "none" && (
              <CrewPanel phase={phase} flag={flag} crew={crew} now={now} onShowCode={() => crewUi.openCodeSheet(park.id)} />
            )}
          </motion.section>

          <motion.section variants={item} className={`park-summary park-facts${stats.pending ? " is-pending" : ""}`} aria-label="Park stats" aria-busy={stats.pending}>
            <ul className="park-facts__chips">
              <li>
                <Icon name="pin" size={16} /> {inside ? "You're here" : `${formatDistance(straightKm)} away`}
              </li>
              <li>
                <Icon name="corners" size={16} /> {areaKm2 > 0 ? formatArea(areaKm2) : "Area unknown"}
              </li>
              <li style={{ background: tint.bg, color: tint.ink }}>
                <Icon name={landscape === "legendary" ? "sparkle" : landscape} size={16} /> {landscapeLabel(park)}
              </li>
            </ul>
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

          {founder.kind === "pending" && (
            <motion.div variants={item} className="founder-review" role="status">
              <span className="founder-review__icon"><Icon name="image" size={18} /></span>
              <span className="founder-review__text">
                <strong>{founder.text}</strong>
                <em>We'll let you know when it's checked.</em>
              </span>
            </motion.div>
          )}

          {(founder.kind === "found" || founder.kind === "hint") && (
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

          {/* The crew list, the photo button and the report link wait behind one row. */}
          <motion.details variants={item} className="park-sheet__more">
            <summary>
              More about this park <Icon name="next" size={16} />
            </summary>
            <div className="park-sheet__more-body">
              {crewList && <CrewList members={crewList.members} flagSince={crewList.flagSince} myHandle={myHandle} />}
              {SHOW_BADGE_ART && <p className="park-sheet__blurb">{park.blurb}</p>}
              {visited && (
                <button className="btn btn--paper btn--sm btn--block park-sheet__photo" onClick={() => setAdding(true)}>
                  <Icon name="camera" size={18} /> Add another photo
                </button>
              )}
              <button className="fb-link park-sheet__report" onClick={onFeedback}>
                <Icon name="chat" size={16} /> Something wrong with this park? Tell us
              </button>
            </div>
          </motion.details>
        </motion.div>
      </div>

      <motion.div className="park-sheet__cta" initial={{ y: 80 }} animate={{ y: 0 }} transition={{ type: "spring", stiffness: 380, damping: 28, delay: 0.2 }}>
        {inside && phase.kind === "outsider" ? (
          // Outsiders during the protected hour: joining is the main way in, logging the visit the second.
          <>
            <button className="btn btn--block btn--glow" onClick={() => crewUi.openScanner(park.id)}>
              <Icon name="qr" /> Scan crew code
            </button>
            <button className="btn btn--paper park-sheet__log" onClick={onCheckIn} disabled={phase.logged}>
              {phase.logged ? "Logged" : "Log visit"}
            </button>
          </>
        ) : inside && restingToday ? (
          // Today's visit is spent: a quiet, clearly disabled button. A tap only nudges it.
          <button
            className={`btn btn--block btn--rest${nudged ? " is-nudged" : ""}`}
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
      <AddDexPhoto park={park} open={adding} onClose={() => setAdding(false)} />
    </motion.div>
  );
}

function flagStatus(holder: ParkHolder, days: number, protectedNow = false): { title: string; detail: string } {
  const flown = days === 1 ? "1 day" : `${days} days`;
  switch (holder.kind) {
    case "mine":
      if (holder.member) return { title: `@${holder.flag.handle}'s crew`, detail: `You hold it together. ${days < 1 ? "Planted today" : `Flying for ${flown}`}` };
      return { title: "Your flag", detail: days < 1 ? "Planted today" : `Flying for ${flown}` };
    case "other":
      // During someone else's protected hour the flag can't be taken yet (#171).
      return { title: `@${holder.flag.handle}`, detail: `${days < 1 ? "Planted today" : `Flying for ${flown}`}. ${protectedNow ? "Protected for now." : `${takeLabel(days)}.`}` };
    case "empty":
      return { title: "No flag yet", detail: "Get inside the boundary to plant yours." };
    case "unknown":
      return { title: "Flag unknown", detail: "Connect to the internet to see who holds this park." };
  }
}

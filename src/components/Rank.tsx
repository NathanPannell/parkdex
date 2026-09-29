import { motion } from "motion/react";
import { createPortal } from "react-dom";
import { RARITY } from "../lib/parks";
import { RANKS, type CollectionRankProgress, type ProgressionRarity, type Rank } from "../lib/progression";
import { parksLabel } from "../lib/rarityUi";
import { Icon } from "./Icon";
import { Bubble, Kip } from "./Kip";
import { Rays } from "./Motion";
import "../rank.css";

const GLYPHS: Record<ProgressionRarity, string> = {
  // Feather: Kip's first flight.
  common: "M19 4C12 4 7.5 8.5 7 15l-2 5M7 15c3.5 0 7-1.4 9.2-4.2M9.2 11.4c2 0 4-.6 5.6-1.8",
  // Trail flag.
  uncommon: "M6.5 21V4M6.5 4.5h10l-2.4 3.8 2.4 3.7h-10",
  // Compass.
  rare: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM15.5 8.5l-2 5-5 2 2-5 5-2Z",
  // Crown over the island.
  legendary: "M4 17.5 5.5 8l4 4L12 6l2.5 6 4-4L20 17.5H4ZM4 20.5h16",
};

export function RankEmblem({ rank, size = 64, locked = false }: { rank: Rank; size?: number; locked?: boolean }) {
  const tone = RARITY[rank.rarity];
  return (
    <span
      className={`rank-emblem ${locked ? "is-locked" : ""}`}
      style={{ width: size, height: size, ["--size" as string]: `${size}px`, ["--tone" as string]: tone.color, ["--tone-ink" as string]: tone.ink }}
      role="img"
      aria-label={`${rank.name} emblem${locked ? ", not reached yet" : ""}`}
    >
      <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true">
        <path className="rank-emblem__rosette" d={rosette(32, 32, 30, 26, 12)} />
        <circle className="rank-emblem__face" cx="32" cy="32" r="21" />
        <circle className="rank-emblem__ring" cx="32" cy="32" r="17.5" />
        <g transform="translate(20 20)">
          <path className="rank-emblem__glyph" d={locked ? LOCK : GLYPHS[rank.rarity]} />
        </g>
      </svg>
      <span className="rank-emblem__stars" aria-hidden="true">{"★".repeat(tone.stars)}</span>
    </span>
  );
}

const LOCK = "M7 11V8a5 5 0 0 1 10 0v3M5.5 11h13v9h-13z";

function rosette(cx: number, cy: number, outer: number, inner: number, points: number) {
  const steps = points * 2;
  return Array.from({ length: steps }, (_, i) => {
    const radius = i % 2 === 0 ? outer : inner;
    const angle = (Math.PI * i) / points - Math.PI / 2;
    return `${i === 0 ? "M" : "L"}${(cx + radius * Math.cos(angle)).toFixed(2)} ${(cy + radius * Math.sin(angle)).toFixed(2)}`;
  }).join(" ") + "Z";
}

function rankProgressShare(progress: CollectionRankProgress) {
  if (!progress.rank || !progress.next) return 1;
  const span = progress.next.parks - progress.rank.parks;
  return Math.min(1, Math.max(0, (progress.visited - progress.rank.parks) / span));
}

/** The one place the Dex shows rank progress. Opens the full trail. */
export function RankCard({ progress, onOpen }: { progress: CollectionRankProgress; onOpen: () => void }) {
  if (!progress.available || !progress.rank) {
    return (
      <div className="rank-card rank-card--loading" aria-live="polite">
        <span className="rank-card__label">Your rank</span>
        <strong>Checking your saved visits…</strong>
      </div>
    );
  }
  const { rank, next } = progress;
  return (
    <button className="rank-card" onClick={onOpen} aria-label={`Rank: ${rank.name}. ${next ? `${parksLabel(next.remaining)} to ${next.name}.` : "Top rank reached."} Open your rank trail.`}>
      <RankEmblem rank={rank} size={62} />
      <span className="rank-card__body">
        <span className="rank-card__label">Your rank</span>
        <strong className="rank-card__name">{rank.name}</strong>
        <span className="rank-card__bar" aria-hidden="true">
          <motion.span
            className="rank-card__fill"
            style={{ background: RARITY[next?.rarity ?? rank.rarity].ink }}
            initial={{ width: 0 }}
            animate={{ width: `${Math.max(4, rankProgressShare(progress) * 100)}%` }}
            transition={{ type: "spring", stiffness: 90, damping: 18, delay: 0.25 }}
          />
        </span>
        <span className="rank-card__next">
          {next
            ? <><b>{next.remaining}</b> more {next.remaining === 1 ? "park" : "parks"} to {next.name} · opens {RARITY[next.rarity].label}</>
            : "Every rarity is open. Legendary parks await."}
        </span>
      </span>
      <Icon name="next" size={20} />
    </button>
  );
}

/** Full-screen view of all four ranks, reached from the Dex rank card. */
export function RankTrail({ progress, onClose, onExplore }: { progress: CollectionRankProgress; onClose: () => void; onExplore: () => void }) {
  const current = progress.rank ? RANKS.indexOf(progress.rank) : 0;
  return createPortal(
    <motion.div className="rank-trail" role="dialog" aria-modal="true" aria-labelledby="rank-trail-title" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
      <motion.div
        className="rank-trail__sheet"
        onClick={(event) => event.stopPropagation()}
        initial={{ y: "100%" }}
        animate={{ y: 0 }}
        exit={{ y: "100%" }}
        transition={{ type: "spring", stiffness: 300, damping: 32 }}
      >
        <div className="rank-trail__head">
          <div>
            <span className="eyebrow">{parksLabel(progress.visited)} visited</span>
            <h2 id="rank-trail-title">Your rank trail</h2>
            <p>Every new park moves you along. Each rank opens rarer parks on the map.</p>
          </div>
          <button className="btn btn--paper btn--icon rank-trail__close" onClick={onClose} aria-label="Close rank trail">
            <Icon name="close" size={18} />
          </button>
        </div>
        <ol className="rank-trail__steps">
          {RANKS.map((rank, index) => {
            const reached = progress.visited >= rank.parks;
            const here = index === current;
            const tone = RARITY[rank.rarity];
            const remaining = Math.max(0, rank.parks - progress.visited);
            return (
              <motion.li
                key={rank.name}
                className={`rank-trail__step ${reached ? "is-reached" : ""} ${here ? "is-here" : ""}`}
                initial={{ x: 30, opacity: 0 }}
                animate={{ x: 0, opacity: 1 }}
                transition={{ delay: 0.12 + index * 0.07, type: "spring", stiffness: 360, damping: 26 }}
              >
                <RankEmblem rank={rank} size={54} locked={!reached} />
                <div className="rank-trail__text">
                  <strong>{rank.name}</strong>
                  <span className="rank-trail__need">{rank.parks === 0 ? "Where every collector starts" : `Visit ${parksLabel(rank.parks)}`}</span>
                  <span className="rank-trail__opens" style={{ background: tone.color, color: tone.ink }}>
                    {"★".repeat(tone.stars)} {tone.label} parks {rank.parks === 0 ? "open" : "unlock"}
                  </span>
                </div>
                <span className="rank-trail__state">
                  {here ? "You're here" : reached ? <Icon name="check" size={16} stroke={3.2} /> : `${remaining} to go`}
                </span>
              </motion.li>
            );
          })}
        </ol>
        <p className="rank-trail__note">Any park counts, once. Parks you already have stay in your Dex.</p>
        <button className="btn btn--block" onClick={onExplore}>
          <Icon name="map" /> Find a new park
        </button>
      </motion.div>
    </motion.div>,
    document.querySelector(".device") ?? document.body,
  );
}

/** Celebration shown after the claim that reaches a new rank. */
export function RankUp({ rank, onExplore, onDone }: { rank: Rank; onExplore: () => void; onDone: () => void }) {
  const tone = RARITY[rank.rarity];
  const next = RANKS[RANKS.indexOf(rank) + 1];
  return (
    <motion.div className="rankup" role="dialog" aria-modal="true" aria-labelledby="rankup-title" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <div className="rankup__rays"><Rays color={tone.color} size={720} opacity={0.35} speed={24} /></div>
      <motion.span className="rankup__stamp" initial={{ scale: 3, rotate: -20, opacity: 0 }} animate={{ scale: 1, rotate: -4, opacity: 1 }} transition={{ type: "spring", stiffness: 480, damping: 15, delay: 0.15 }}>
        Rank up!
      </motion.span>
      <motion.div className="rankup__emblem" initial={{ scale: 0.2, rotate: -180 }} animate={{ scale: 1, rotate: 0 }} transition={{ type: "spring", stiffness: 180, damping: 13, delay: 0.3 }}>
        <RankEmblem rank={rank} size={168} />
      </motion.div>
      <motion.div className="rankup__text" initial={{ y: 30, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ delay: 0.7, type: "spring", stiffness: 300, damping: 24 }}>
        <span className="eyebrow eyebrow--light">You're now a</span>
        <h2 id="rankup-title">{rank.name}</h2>
        <span className="rankup__opens" style={{ background: tone.color, color: tone.ink }}>
          <Icon name="sparkle" size={16} /> {tone.label} parks unlocked
        </span>
        <p>{next ? `Visit ${parksLabel(next.parks)} to become ${next.name}.` : "You've opened every rarity on the Island."}</p>
      </motion.div>
      <motion.div className="rankup__kip" initial={{ x: 120 }} animate={{ x: 0 }} transition={{ delay: 0.9, type: "spring", stiffness: 220, damping: 16 }}>
        <Bubble side="to-right">KLEEP! Look at you!</Bubble>
        <Kip pose="cheer" size={92} flip />
      </motion.div>
      <motion.div className="rankup__actions" initial={{ y: 60, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ delay: 1, type: "spring", stiffness: 320, damping: 26 }}>
        <button className="btn btn--block btn--sun" onClick={onExplore}>
          <Icon name="map" /> Find {tone.label} parks
        </button>
        <button className="btn btn--block btn--paper rankup__done" onClick={onDone}>Keep celebrating</button>
      </motion.div>
    </motion.div>
  );
}

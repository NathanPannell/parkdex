import { memo, useId } from "react";
import { badgeArtUrl, type BadgeDefinition } from "../lib/game/badges";
import { PALETTES, RARITY } from "../lib/parks";
import { RIM, Ribbon, SHAPES, Star } from "./Badge";

type Props = {
  badge: BadgeDefinition;
  size?: number;
  /** Locked badges are dark silhouettes in a plain frame. */
  locked?: boolean;
  showName?: boolean;
  className?: string;
};

const LOCKED_RIM = ["#E6DECC", "#B9B09C"];

/**
 * An achievement badge (#175): the park badge's frame and rarity rim from Badge.tsx around bundled
 * park art. Rarer badges have shinier rims and more stars.
 */
function AchievementBadgeImpl({ badge, size = 96, locked = false, showName = false, className }: Props) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const shape = SHAPES[badge.shape];
  const rim = locked ? LOCKED_RIM : RIM[badge.rarity];
  const stars = RARITY[badge.rarity].stars;
  const shiny = !locked && (badge.rarity === "rare" || badge.rarity === "epic" || badge.rarity === "legendary");
  const ribbon = { ...PALETTES.forest, ribbon: locked ? "#8A8F87" : RARITY[badge.rarity].ink, ribbonText: "#FFF8EC" };
  return (
    <svg
      viewBox="-4 -4 208 208"
      width={size}
      height={size}
      className={`badge achievement ${locked ? "achievement--locked" : "achievement--earned"} ${className ?? ""}`}
      role="img"
      aria-label={locked ? `${badge.name}, locked` : `${badge.name} badge`}
    >
      <defs>
        <clipPath id={`c${uid}`}>
          <path d={shape} />
        </clipPath>
        <linearGradient id={`r${uid}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={rim[0]} />
          <stop offset="0.5" stopColor={rim[1]} />
          <stop offset="1" stopColor={rim[0]} />
        </linearGradient>
        <linearGradient id={`h${uid}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#FF6BD6" />
          <stop offset="0.25" stopColor="#FFE66B" />
          <stop offset="0.5" stopColor="#6BFFB8" />
          <stop offset="0.75" stopColor="#6BB8FF" />
          <stop offset="1" stopColor="#C86BFF" />
        </linearGradient>
        <radialGradient id={`v${uid}`} cx="0.5" cy="0.42" r="0.62">
          <stop offset="0.62" stopColor="#14231C" stopOpacity="0" />
          <stop offset="1" stopColor="#14231C" stopOpacity="0.28" />
        </radialGradient>
      </defs>
      <path d={shape} fill={`url(#r${uid})`} stroke="#14231C" strokeWidth={4} transform="translate(0 3)" opacity={0.25} />
      <g clipPath={`url(#c${uid})`}>
        <rect x={-10} y={-10} width={220} height={220} fill={locked ? "#EDE3CF" : "#FFF8EC"} />
        <image
          href={badgeArtUrl(badge.id)}
          x={-4}
          y={-4}
          width={208}
          height={208}
          preserveAspectRatio="xMidYMid slice"
          className={locked ? "achievement__art--locked" : undefined}
        />
        <rect x={-10} y={-10} width={220} height={220} fill={`url(#v${uid})`} />
        {shiny && <rect x={-60} y={-60} width={320} height={320} fill={`url(#h${uid})`} className="badge__holo" style={{ mixBlendMode: "soft-light" }} />}
      </g>
      <path d={shape} fill="none" stroke={`url(#r${uid})`} strokeWidth={10} />
      <path d={shape} fill="none" stroke="#14231C" strokeWidth={3} />
      <path d={shape} fill="none" stroke="#FFFFFF" strokeOpacity={0.75} strokeWidth={1.6} strokeDasharray="4 3.2" transform="translate(100 100) scale(0.9) translate(-100 -100)" />
      <g>
        {Array.from({ length: stars }, (_, index) => (
          <Star key={index} x={100 + (index - (stars - 1) / 2) * 15} y={badge.shape === "arch" ? 30 : 26} r={6.5} fill={locked ? "#CFC7B4" : "#FFD23F"} />
        ))}
      </g>
      {showName && <Ribbon text={badge.name} p={ribbon} />}
    </svg>
  );
}

export const AchievementBadge = memo(AchievementBadgeImpl);

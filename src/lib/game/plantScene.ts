import type { VisitOutcome } from "./client";
import type { ParkHolder } from "./visit";

/**
 * The planting scene's choreography, kept apart from the animation code so the order of
 * beats per outcome is testable: knock the old flag over, drive the flag in, kick up dirt,
 * unfurl the cloth, then count the points.
 */

export type PlantBeat = "topple" | "slam" | "dirt" | "unfurl" | "points" | "settle";

export function plantBeats(outcome: VisitOutcome): PlantBeat[] {
  switch (outcome) {
    case "planted":
      return ["slam", "dirt", "unfurl", "points"];
    case "took":
      return ["topple", "slam", "dirt", "unfurl", "points"];
    case "held":
      return ["slam", "dirt", "unfurl"];
    case "already_today":
      return ["settle"];
  }
}

/** Where the player's flag starts: already standing in the mound when it is theirs, else held aloft. */
export function startsPlanted(holder: ParkHolder): boolean {
  return holder.kind === "mine";
}

/** The flag standing in the mound before the visit, if it belongs to someone else. */
export function standingRival(holder: ParkHolder) {
  return holder.kind === "other" ? holder.flag : null;
}

export type DirtClod = { x: number; peak: number; y: number; rotate: number; size: number; color: string; delay: number };

const SOIL = ["#6B4423", "#8B5A2B", "#A0703F", "#5A3A1E", "#7A9A3A"];

/** A fan of clods thrown up and out from the impact point. Seeded so each throw differs but tests can pin it. */
export function dirtClods(count: number, seed: number): DirtClod[] {
  let state = (seed * 2654435761) >>> 0 || 1;
  const next = () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 4294967296;
  };
  return Array.from({ length: count }, (_, index) => {
    // Spread across the upper half-circle, with a little jitter.
    const angle = Math.PI * ((index + 0.5) / count) + (next() - 0.5) * 0.35;
    const distance = 50 + next() * 70;
    const x = Math.cos(angle) * distance;
    const peak = -Math.sin(angle) * distance - 20 - next() * 30;
    return {
      x: Math.round(x),
      peak: Math.round(peak),
      // Clods fall back below their peak, landing near the mound.
      y: Math.round(10 + next() * 26),
      rotate: Math.round((next() - 0.5) * 540),
      size: Math.round(5 + next() * 8),
      color: SOIL[Math.floor(next() * SOIL.length)],
      delay: Math.round(next() * 60) / 1000,
    };
  });
}

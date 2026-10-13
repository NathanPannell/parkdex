import type { VisitResult } from "./client";
import { flagSpec } from "./flag";
import type { ParkHolder } from "./visit";

/**
 * The planting scene's choreography, kept apart from the animation code so what each outcome
 * plays is testable. A take yanks the rival flag out and throws it away; planting and taking
 * slam the flag in hard and pay off with confetti; a revisit gets a smaller re-plant; each of
 * those counts up the points it earned. A second visit the same day settles the flag back with
 * a wiggle and a wave from Kip. A logged visit during someone else's protected hour settles back
 * too, and counts its point. Joining a crew (#170) raises the player's pennant under the leader's
 * flag instead of planting.
 */

export type PlantPlan = {
  /** Pull the rival's flag out and toss it off screen first. */
  yank: boolean;
  slam: "big" | "small" | null;
  /** Lower the flag back without planting. */
  settle: boolean;
  /** Hoist the player's pennant up the leader's pole: joining a crew. */
  raise: boolean;
  payoff: "big" | "small" | "tiny";
  /** Points to count up on screen, or null when the outcome has no points to show. */
  count: number | null;
};

const earned = (points: number) => (points > 0 ? points : null);

export function plantPlan(visit: Pick<VisitResult, "outcome" | "pointsEarned">): PlantPlan {
  switch (visit.outcome) {
    case "took":
      return { yank: true, slam: "big", settle: false, raise: false, payoff: "big", count: earned(visit.pointsEarned) };
    case "planted":
      return { yank: false, slam: "big", settle: false, raise: false, payoff: "big", count: earned(visit.pointsEarned) };
    case "held":
      return { yank: false, slam: "small", settle: false, raise: false, payoff: "small", count: earned(visit.pointsEarned) };
    case "joined":
      return { yank: false, slam: null, settle: false, raise: true, payoff: "big", count: earned(visit.pointsEarned) };
    case "logged":
      return { yank: false, slam: null, settle: true, raise: false, payoff: "tiny", count: earned(visit.pointsEarned) };
    case "already_today":
      return { yank: false, slam: null, settle: true, raise: false, payoff: "tiny", count: null };
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

/** Confetti in the player's own flag colours, with a little gold so it still sparkles. */
export function flagConfetti(seed: string | null): string[] {
  if (!seed) return ["#FF5A1F", "#FFC93C", "#FFF8EC"];
  const spec = flagSpec(seed);
  return [...new Set([spec.field, spec.accent, spec.emblemColor, "#FFC93C"])];
}

/** How long the points counter takes per step: fast for big bounties, never under a second overall. */
export function countStepMs(points: number): number {
  if (points <= 0) return 0;
  return Math.max(28, Math.min(140, Math.round(1100 / points)));
}

export type DirtClod = { x: number; peak: number; land: number; hop: number; rotate: number; size: number; color: string; delay: number };

const SOIL = ["#6B4423", "#8B5A2B", "#A0703F", "#5A3A1E", "#7A9A3A"];

/**
 * A fan of clods thrown up and out from the impact point. Each flies to a peak, lands, takes a
 * small hop and settles. Seeded so each throw differs but tests can pin it.
 */
export function dirtClods(count: number, seed: number, power = 1): DirtClod[] {
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
    const distance = (60 + next() * 110) * power;
    const x = Math.cos(angle) * distance;
    const peak = -Math.sin(angle) * distance - (30 + next() * 50) * power;
    const land = 8 + next() * 34;
    return {
      x: Math.round(x),
      peak: Math.round(peak),
      land: Math.round(land),
      hop: Math.round(land - 8 - next() * 14),
      rotate: Math.round((next() - 0.5) * 720),
      size: Math.round(5 + next() * 10),
      color: SOIL[Math.floor(next() * SOIL.length)],
      delay: Math.round(next() * 50) / 1000,
    };
  });
}

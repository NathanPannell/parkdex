import type { GameMe, ParkFlag, VisitResult } from "./client";

/** Who holds a park, from the player's point of view. */
export type ParkHolder = { kind: "empty" } | { kind: "mine"; flag: ParkFlag } | { kind: "other"; flag: ParkFlag } | { kind: "unknown" };

export function parkHolder(parkId: string, flags: ReadonlyMap<string, ParkFlag> | null | undefined, myHandle: string | null | undefined): ParkHolder {
  if (!flags) return { kind: "unknown" };
  const flag = flags.get(parkId);
  if (!flag) return { kind: "empty" };
  return myHandle && flag.handle === myHandle ? { kind: "mine", flag } : { kind: "other", flag };
}

/** What a visit button does next: sign in, pick a handle first, or go plant. */
export type VisitStep = "sign-in" | "pick-handle" | "plant";

export function nextVisitStep(signedIn: boolean, me: GameMe | null): VisitStep {
  if (!signedIn) return "sign-in";
  // Without a fresh answer from /me, go ahead: the server asks for a handle if one is missing.
  if (me && !me.player) return "pick-handle";
  return "plant";
}

/**
 * Whether this account already visited the park today, so another visit would only say
 * "already visited". Visits count once per park per day in Victoria. The server says when
 * that day ends, because time zone rules on phones lag: British Columbia stays on UTC-7
 * from November 2026, and older tz data still falls back to UTC-8.
 */
export function hasVisitedToday(me: GameMe | null | undefined, parkId: string, now: number): boolean {
  const until = me?.visitedTodayUntil ? Date.parse(me.visitedTodayUntil) : Number.NaN;
  if (!Number.isFinite(until) || now >= until) return false;
  return !!me?.visitedToday?.includes(parkId);
}

export const VISITED_TODAY_LABEL = "Visited today, back tomorrow";

export function visitLabel(signedIn: boolean, holder: ParkHolder, visited = false): string {
  if (!signedIn) return "Sign in to plant your flag";
  if (visited) return VISITED_TODAY_LABEL;
  if (holder.kind === "mine") return "Visit your flag";
  if (holder.kind === "other") return `Take it from @${holder.flag.handle}`;
  return "Plant your flag";
}

/** The short label on the bottom bar's button while standing in a park. */
export function visitShortLabel(holder: ParkHolder, visited = false): string {
  if (visited) return "Tomorrow";
  return holder.kind === "mine" ? "Visit" : holder.kind === "other" ? "Take!" : "Plant!";
}

/**
 * Points rules (#169), decided by the server. The app only uses them to label what a visit
 * would pay; results always show the server's own numbers.
 */
export const POINTS = { plant: 6, take: 4, held: 1 } as const;

export const HOURLY_POINTS_COPY = "One point for every hour your flag flies.";

/** A score with thousands separators: hourly points reach four and five digits. */
export function formatScore(score: number): string {
  return Math.max(0, Math.floor(Number.isFinite(score) ? score : 0)).toLocaleString("en-CA");
}

export function formatPoints(score: number): string {
  return `${formatScore(score)} ${score === 1 ? "point" : "points"}`;
}

/** What taking a flag that has flown this many whole days pays: 4, plus 1 for each day. */
export function takePoints(days: number): number {
  return POINTS.take + Math.max(0, Math.floor(Number.isFinite(days) ? days : 0));
}

export function takeLabel(days: number): string {
  const points = takePoints(days);
  return `Take it for +${points} ${points === 1 ? "point" : "points"}`;
}

const daysPhrase = (days: number) => (days === 1 ? "that day" : `those ${days} days`);

/** What Kip shouts when the flag lands, with the points part by part: +6, +4 and +N days, +1. */
export function plantCheer(result: Pick<VisitResult, "outcome" | "pointsBreakdown">): string {
  const { base, days } = result.pointsBreakdown;
  switch (result.outcome) {
    case "took":
      return days > 0 ? `KLEEP! +${base} for the take, +${days} for ${daysPhrase(days)}!` : `KLEEP! +${base} for the take!`;
    case "planted":
      return `KLEEP! Flag's up! +${base}`;
    case "held":
      return `Still flying! +${base}`;
    case "already_today":
      return "See you tomorrow!";
  }
}

export type VisitHeadline = { title: string; detail: string };

export function visitHeadline(result: VisitResult, parkName: string): VisitHeadline {
  switch (result.outcome) {
    case "planted":
      return { title: "Flag planted", detail: `Your flag is flying over ${parkName}. ${HOURLY_POINTS_COPY}` };
    case "took": {
      const from = result.previousHolder ? ` from @${result.previousHolder.handle}` : "";
      return { title: `You took ${parkName}${from}`, detail: HOURLY_POINTS_COPY };
    }
    case "held":
      return { title: "Your flag is still flying", detail: `${parkName} is still yours.` };
    case "already_today":
      return { title: "Already visited today", detail: "One visit per park counts each day. Come back tomorrow." };
  }
}

/** The newest takeover time, which marks every message up to it as seen. */
export function latestTakeoverAt(takeovers: readonly { at: string }[]): string | null {
  let latest: string | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const takeover of takeovers) {
    const ms = Date.parse(takeover.at);
    if (Number.isFinite(ms) && ms > latestMs) {
      latestMs = ms;
      latest = takeover.at;
    }
  }
  return latest;
}

/** Held parks, longest-flying first. */
export function sortHeldParks<T extends { days: number; since: string }>(parks: readonly T[]): T[] {
  return [...parks].sort((a, b) => b.days - a.days || Date.parse(a.since) - Date.parse(b.since));
}

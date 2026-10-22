import type { GameMe, ParkFlag } from "./client";

/**
 * The protected hour (#170). Planting or taking a flag protects it for an hour, on the server,
 * for every build: anyone else's visit in that hour is only logged (+1), and they can take the
 * park once the hour is over. It stops two walkers trading a park back and forth on the spot.
 *
 * Crews, which let friends join a flag during that hour, are retired (docs/crews.md): the app
 * shows no crew UI, and the server refuses new joins.
 */

/** What a logged visit pays, as the server decides it (#170). */
export const LOGGED_POINTS = 1;

/**
 * Where the player stands with a park's protected hour right now.
 * - `outsider` while someone else's flag is in its protected hour
 * - `none` otherwise: no flag, the player's own flag (or one they hold with others), or after the hour
 */
export type ProtectionPhase = { kind: "none" } | { kind: "outsider"; until: string; holder: string; logged: boolean };

export type ProtectionInput = {
  flag: ParkFlag | null | undefined;
  myHandle: string | null | undefined;
  me: GameMe | null | undefined;
  now: number;
};

/** Parks with only a logged visit today, until the Victoria day the server named ends. */
export function hasLoggedToday(me: GameMe | null | undefined, parkId: string, now: number): boolean {
  const until = me?.visitedTodayUntil ? Date.parse(me.visitedTodayUntil) : Number.NaN;
  if (!Number.isFinite(until) || now >= until) return false;
  return !!me?.loggedToday?.includes(parkId);
}

export function protectionPhase({ flag, myHandle, me, now }: ProtectionInput): ProtectionPhase {
  if (!flag) return { kind: "none" };
  const until = flag.crew?.protectedUntil ?? null;
  const ends = until ? Date.parse(until) : Number.NaN;
  if (!until || !Number.isFinite(ends) || now >= ends) return { kind: "none" };
  // The holder, and anyone who joined their flag before crews were retired (/me lists it), holds it already.
  if ((myHandle && flag.handle === myHandle) || me?.parks.some((park) => park.parkId === flag.parkId)) return { kind: "none" };
  return { kind: "outsider", until, holder: flag.handle, logged: hasLoggedToday(me, flag.parkId, now) };
}

/** Minutes left in the protected hour, rounded up, as "42 min". */
export function formatMinutesLeft(until: string, now: number): string {
  const left = Date.parse(until) - now;
  if (!Number.isFinite(left) || left <= 0) return "0 min";
  return `${Math.max(1, Math.ceil(left / 60_000))} min`;
}

/** A time of day on this device's clock, such as "3:42 pm". */
export function formatClockTime(instant: string | number): string {
  const date = new Date(typeof instant === "number" ? instant : Date.parse(instant));
  if (!Number.isFinite(date.getTime())) return "later";
  const hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours % 12 || 12}:${minutes} ${hours < 12 ? "am" : "pm"}`;
}

/** What a logged visit means: +1 now, and the park can be taken once the hour ends. */
export function loggedVisitLine(until: string): string {
  return `Visit logged · +${LOGGED_POINTS}. Come back after ${formatClockTime(until)} to take this park.`;
}

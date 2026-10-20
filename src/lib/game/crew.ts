import { friendLinkOrigin } from "../friends/links";
import { normalizeSocialCode } from "../social/codes";
import { parseAppLink } from "../social/links";
import type { Crew, CrewMember, GameMe, ParkFlag } from "./client";

/**
 * Crew flags in the app (#171, rules in docs/crews.md). Friends at a park hold its flag as a
 * crew: planting or taking starts a protected hour, members share a 6-character crew code, and
 * anyone who scans it inside the park joins. The rules run on the server for every build; the
 * `crews` feature flag only shows this UI.
 */

export const CREW_CODE_LENGTH = 6;
export const CREW_LINK_PREFIX = "/crew/";
export const CREW_CAP = 8;
/** What joining pays and what a logged visit pays, as the server decides them (#170). */
export const CREW_POINTS = { join: 2, logged: 1 } as const;

/** Crew links are `https://<web host>/crew/CODE?park=<parkId>`, on the same App Link host as friend links. */
export function crewLink(code: string, parkId: string | null, origin = friendLinkOrigin()): string {
  const park = parkId ? `?park=${encodeURIComponent(parkId)}` : "";
  return `${origin}${CREW_LINK_PREFIX}${code}${park}`;
}

export type CrewCodeTarget = { code: string; parkId: string | null };

/** The crew code (and park, when the link names one) in a scanned QR, a crew link or typed text. */
export function crewCodeFromText(input: string): CrewCodeTarget | null {
  const value = input.trim();
  const link = parseAppLink(value, [CREW_LINK_PREFIX]);
  const code = normalizeSocialCode(link ? link.value : value, CREW_CODE_LENGTH);
  if (!code) return null;
  return { code, parkId: link ? crewLinkPark(link.url) : null };
}

/** The park a crew link names, if it is a plausible park ID. */
export function crewLinkPark(url: URL): string | null {
  const park = url.searchParams.get("park")?.trim() ?? "";
  return /^[A-Za-z0-9_.:-]{1,160}$/.test(park) ? park : null;
}

/**
 * Where the player stands with a park's crew right now.
 * - `leader`, `member` and `outsider` while the protected hour runs
 * - `closed` after the hour, for a crew of two or more
 * - `none` otherwise: no flag, or a solo flag after its hour
 *
 * The server protects every new flag for an hour on every build (#170), so `outsider` is
 * reported whatever the `crews` flag says: a take would only log a visit. `enabled` (the crews
 * UI) only decides whether `leader`, `member` and `closed` show.
 */
export type CrewPhase =
  | { kind: "none" }
  | { kind: "leader"; until: string }
  | { kind: "member"; until: string; leader: string }
  | { kind: "outsider"; until: string; leader: string; logged: boolean }
  | { kind: "closed"; size: number };

export type CrewPhaseInput = {
  enabled: boolean;
  flag: ParkFlag | null | undefined;
  myHandle: string | null | undefined;
  me: GameMe | null | undefined;
  /** The crew read for this park, when the park page fetched it. */
  crew?: Crew | null;
  now: number;
};

/** Whether `crew` describes the flag on the map now, not an older one at the same park. */
export function crewMatchesFlag(crew: Crew | null | undefined, flag: ParkFlag | null | undefined): crew is Crew {
  return !!crew && !!flag && crew.parkId === flag.parkId && crew.leader.handle === flag.handle && Date.parse(crew.flagSince) === Date.parse(flag.since);
}

/** The parks this account holds as a crew member, not as the flag's own holder. */
export function isCrewMember(me: GameMe | null | undefined, flag: ParkFlag, myHandle: string | null | undefined): boolean {
  if (!me || (myHandle && flag.handle === myHandle)) return false;
  return me.parks.some((park) => park.parkId === flag.parkId);
}

/** Parks with only a logged visit today, until the Victoria day the server named ends. */
export function hasLoggedToday(me: GameMe | null | undefined, parkId: string, now: number): boolean {
  const until = me?.visitedTodayUntil ? Date.parse(me.visitedTodayUntil) : Number.NaN;
  if (!Number.isFinite(until) || now >= until) return false;
  return !!me?.loggedToday?.includes(parkId);
}

export function crewPhase({ enabled, flag, myHandle, me, crew, now }: CrewPhaseInput): CrewPhase {
  if (!flag) return { kind: "none" };
  const known = crewMatchesFlag(crew, flag) ? crew : null;
  const held = me?.parks.find((park) => park.parkId === flag.parkId)?.crew;
  const until = known?.protectedUntil ?? flag.crew?.protectedUntil ?? held?.protectedUntil ?? null;
  const ends = until ? Date.parse(until) : Number.NaN;
  if (until && Number.isFinite(ends) && now < ends) {
    if (myHandle && flag.handle === myHandle) return enabled ? { kind: "leader", until } : { kind: "none" };
    if (known?.member || isCrewMember(me, flag, myHandle)) return enabled ? { kind: "member", until, leader: flag.handle } : { kind: "none" };
    return { kind: "outsider", until, leader: flag.handle, logged: hasLoggedToday(me, flag.parkId, now) };
  }
  if (!enabled) return { kind: "none" };
  const size = Math.max(known?.size ?? 0, flag.crew?.size ?? 0, held?.size ?? 0, 1);
  return size > 1 ? { kind: "closed", size } : { kind: "none" };
}

export function isProtectedPhase(phase: CrewPhase): phase is Extract<CrewPhase, { until: string }> {
  return phase.kind === "leader" || phase.kind === "member" || phase.kind === "outsider";
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

/** The status line at the top of the park page's crew panel. */
export function crewHeadline(phase: CrewPhase, now: number): string | null {
  switch (phase.kind) {
    case "leader":
      return `Your flag is protected · ${formatMinutesLeft(phase.until, now)}`;
    case "member":
      return `You're in @${phase.leader}'s crew · protected ${formatMinutesLeft(phase.until, now)}`;
    case "outsider":
      return `@${phase.leader}'s crew flag is protected · ${formatMinutesLeft(phase.until, now)}`;
    case "closed":
      return `Crew of ${phase.size}`;
    case "none":
      return null;
  }
}

/** What a logged visit means: +1 now, and the park can be taken once the hour ends. */
export function loggedVisitLine(until: string): string {
  return `Visit logged · +${CREW_POINTS.logged}. Come back after ${formatClockTime(until)} to take this park.`;
}

/** "planted" for the leader, else how long after the flag went up they joined: "joined +12 min". */
export function crewMemberNote(member: Pick<CrewMember, "leader" | "joinedAt">, flagSince: string): string {
  if (member.leader) return "planted";
  const minutes = Math.max(0, Math.round((Date.parse(member.joinedAt) - Date.parse(flagSince)) / 60_000));
  return Number.isFinite(minutes) ? `joined +${minutes} min` : "joined";
}

/** Crew members to offer as friends: everyone else in the crew who is not a friend yet. */
export function friendOffers(crew: Pick<Crew, "members">, myHandle: string | null | undefined, friendHandles: ReadonlySet<string>): CrewMember[] {
  return crew.members.filter((member) => member.handle !== myHandle && !friendHandles.has(member.handle));
}

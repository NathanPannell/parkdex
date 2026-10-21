import type { DashboardEnv } from "../api.js";
import type { AccountDeleter } from "./deletion.js";
import { DB_EVENT_TYPES } from "./filters.js";
import { ALL_FEATURES, unavailableNotes, type Features } from "./schema.js";
import { maskEmail } from "./store.js";
import type { PostHogClient, QueryResult, TemplateParams } from "./posthog.js";
import { buildTemplate, guardCustomQuery, posthogStatus } from "./posthog.js";
import type { AnalyticsDependencies } from "./routes.js";
import type {
  AccountDetail,
  AccountQuery,
  AccountRow,
  AnalyticsStore,
  DeletionRow,
  EventCursor,
  EventFilter,
  EventRow,
  HistogramBucket,
  Overview,
} from "./types.js";

/** In-memory analytics for tests and the local demo server. Never used by a deployment. */

const DAY = 86_400_000;
const FALL_MS = 720 * 3_600_000;

export interface MemoryAccount {
  id: string;
  email: string;
  handle: string | null;
  createdAt: string;
  deletionState: "active" | "deleting";
  google: boolean;
  password: boolean;
  sessions: { createdAt: string; expiresAt: string; revokedAt: string | null }[];
}

export interface MemoryVisit {
  accountId: string;
  parkId: string;
  visitedAt: string;
  outcome: "planted" | "took" | "held" | "imported";
  points: number;
}

export interface MemoryTenure {
  parkId: string;
  holder: string;
  startedAt: string;
  lastVisitAt: string;
  endedAt: string | null;
  bounty: number;
}

export interface MemoryPhotoCheck {
  accountId: string;
  createdAt: string;
  outcome: "approve" | "reject" | "unsure" | "unavailable";
  flags: string[];
}

export interface MemoryReceipt {
  receiptId: string;
  accountId: string;
  status: "pending" | "complete";
  createdAt: string;
  photoObjects: number;
  attempts: number;
  lastError: string | null;
}

/** Victoria calendar day, the same grouping the game uses. */
const VICTORIA_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Vancouver", year: "numeric", month: "2-digit", day: "2-digit" });
const dayCache = new Map<string | number, string>();
function localDay(value: string | number): string {
  let day = dayCache.get(value);
  if (day === undefined) {
    if (dayCache.size > 50_000) dayCache.clear();
    day = VICTORIA_DAY.format(new Date(value));
    dayCache.set(value, day);
  }
  return day;
}

function wholeDays(from: number, to: number): number {
  return Math.max(0, Math.floor((to - from) / DAY));
}

export class MemoryAnalyticsStore implements AnalyticsStore {
  accounts: MemoryAccount[] = [];
  events: EventRow[] = [];
  visits: MemoryVisit[] = [];
  tenures: MemoryTenure[] = [];
  founded: { parkId: string; accountId: string; foundedAt: string }[] = [];
  photoChecks: MemoryPhotoCheck[] = [];
  parks = new Map<string, string>();
  receipts: MemoryReceipt[] = [];
  securityEvents: { eventType: string; outcome: string }[] = [];
  feedbackOpen = 0;
  /** Set founders to false to act like a database a release behind (no kip_founders schema). */
  available: Features = { ...ALL_FEATURES };

  async features() {
    return { ...this.available };
  }

  private handleOf(accountId: string | null): string | null {
    return accountId ? (this.accounts.find((account) => account.id === accountId)?.handle ?? null) : null;
  }

  async overview(now: Date, days: number): Promise<Overview> {
    const t = now.getTime();
    const p = days * DAY;
    const within = (value: string, from: number, to: number) => {
      const at = Date.parse(value);
      return at > t - from && at <= t - to;
    };
    const count = <T>(items: T[], test: (item: T) => boolean) => items.filter(test).length;
    const accounts = this.accounts;
    const visits = this.visits.filter((visit) => visit.outcome !== "imported");
    const active = (from: number, to: number) =>
      new Set(this.events.filter((event) => event.accountId && within(event.receivedAt, from, to)).map((event) => event.accountId)).size;
    const dayList: string[] = [];
    for (let i = days - 1; i >= 0; i -= 1) dayList.push(localDay(t - i * DAY));
    const perDay = <T>(items: T[], at: (item: T) => string, test: (item: T) => boolean = () => true) => {
      const counts = new Map<string, number>();
      for (const item of items) if (test(item)) counts.set(localDay(at(item)), (counts.get(localDay(at(item))) ?? 0) + 1);
      return dayList.map((day) => counts.get(day) ?? 0);
    };
    const activeByDay = new Map<string, Set<string>>();
    for (const event of this.events) {
      if (!event.accountId) continue;
      const key = localDay(event.receivedAt);
      activeByDay.set(key, (activeByDay.get(key) ?? new Set<string>()).add(event.accountId));
    }
    const activePerDay = dayList.map((day) => activeByDay.get(day)?.size ?? 0);
    const checksNow = this.photoChecks.filter((check) => within(check.createdAt, p, 0));
    const flags = new Map<string, number>();
    for (const check of checksNow) for (const flag of check.flags) flags.set(flag, (flags.get(flag) ?? 0) + 1);
    const parkVisits = new Map<string, { visits: number; players: Set<string> }>();
    for (const visit of visits.filter((item) => within(item.visitedAt, p, 0))) {
      const entry = parkVisits.get(visit.parkId) ?? { visits: 0, players: new Set<string>() };
      entry.visits += 1;
      entry.players.add(visit.accountId);
      parkVisits.set(visit.parkId, entry);
    }
    const outcome = (name: MemoryVisit["outcome"]) => ({
      current: count(visits, (v) => v.outcome === name && within(v.visitedAt, p, 0)),
      previous: count(visits, (v) => v.outcome === name && within(v.visitedAt, 2 * p, p)),
    });
    return {
      generatedAt: now.toISOString(),
      days,
      accounts: {
        total: accounts.length,
        new7: count(accounts, (a) => within(a.createdAt, 7 * DAY, 0)),
        new30: count(accounts, (a) => within(a.createdAt, 30 * DAY, 0)),
        period: { current: count(accounts, (a) => within(a.createdAt, p, 0)), previous: count(accounts, (a) => within(a.createdAt, 2 * p, p)) },
        deleting: count(accounts, (a) => a.deletionState === "deleting"),
        withHandle: count(accounts, (a) => Boolean(a.handle) && a.deletionState === "active"),
      },
      players: {
        day: { current: active(DAY, 0), previous: active(2 * DAY, DAY) },
        week: { current: active(7 * DAY, 0), previous: active(14 * DAY, 7 * DAY) },
        month: { current: active(30 * DAY, 0), previous: active(60 * DAY, 30 * DAY) },
      },
      founded: !this.available.founders
        ? null
        : {
            total: this.founded.length,
            new7: count(this.founded, (f) => within(f.foundedAt, 7 * DAY, 0)),
            period: { current: count(this.founded, (f) => within(f.foundedAt, p, 0)), previous: count(this.founded, (f) => within(f.foundedAt, 2 * p, p)) },
          },
      visits: { planted: outcome("planted"), took: outcome("took"), held: outcome("held") },
      photoChecks: !this.available.founders
        ? null
        : {
            total: { current: checksNow.length, previous: count(this.photoChecks, (c) => within(c.createdAt, 2 * p, p)) },
            approved: {
              current: count(checksNow, (c) => c.outcome === "approve"),
              previous: count(this.photoChecks, (c) => c.outcome === "approve" && within(c.createdAt, 2 * p, p)),
            },
            rejected: count(checksNow, (c) => c.outcome === "reject"),
            unsure: count(checksNow, (c) => c.outcome === "unsure"),
            unavailable: count(checksNow, (c) => c.outcome === "unavailable"),
          },
      feedbackOpen: this.feedbackOpen,
      series: {
        days: dayList,
        newAccounts: perDay(accounts, (a) => a.createdAt),
        activePlayers: activePerDay,
        planted: perDay(
          visits,
          (v) => v.visitedAt,
          (v) => v.outcome === "planted",
        ),
        took: perDay(
          visits,
          (v) => v.visitedAt,
          (v) => v.outcome === "took",
        ),
        held: perDay(
          visits,
          (v) => v.visitedAt,
          (v) => v.outcome === "held",
        ),
        foundings: this.available.founders ? perDay(this.founded, (f) => f.foundedAt) : null,
      },
      topParks: [...parkVisits.entries()]
        .map(([parkId, entry]) => ({ parkId, name: this.parks.get(parkId) ?? parkId, visits: entry.visits, players: entry.players.size }))
        .sort((a, b) => b.visits - a.visits || a.parkId.localeCompare(b.parkId))
        .slice(0, 10),
      rejectionFlags: !this.available.founders
        ? []
        : [...flags.entries()].map(([flag, total]) => ({ flag, count: total })).sort((a, b) => b.count - a.count || a.flag.localeCompare(b.flag)),
      unavailable: unavailableNotes(this.available),
    };
  }

  private row(account: MemoryAccount, now: Date): AccountRow {
    const t = now.getTime();
    const tenures = this.tenures.filter((tenure) => tenure.holder === account.id && Date.parse(tenure.startedAt) <= t);
    const score =
      tenures.reduce((sum, tenure) => {
        const end = Math.min(tenure.endedAt ? Date.parse(tenure.endedAt) : Infinity, Date.parse(tenure.lastVisitAt) + FALL_MS, t);
        return sum + wholeDays(Date.parse(tenure.startedAt), end) + tenure.bounty;
      }, 0) + (this.available.founders ? this.founded.filter((park) => park.accountId === account.id).length * 10 : 0);
    const lastEvent =
      this.events
        .filter((event) => event.accountId === account.id)
        .map((event) => event.receivedAt)
        .sort()
        .at(-1) ?? null;
    const lastSession =
      account.sessions
        .map((session) => session.createdAt)
        .sort()
        .at(-1) ?? null;
    return {
      id: account.id,
      handle: account.handle,
      createdAt: account.createdAt,
      lastActiveAt:
        [lastEvent, lastSession]
          .filter((value): value is string => Boolean(value))
          .sort()
          .at(-1) ?? null,
      providers: [...(account.google ? ["google"] : []), ...(account.password ? ["email"] : [])],
      visits: this.visits.filter((visit) => visit.accountId === account.id && visit.outcome !== "imported").length,
      parksHeld: tenures.filter((tenure) => !tenure.endedAt && Date.parse(tenure.lastVisitAt) + FALL_MS > t).length,
      score,
      foundedParks: this.available.founders ? this.founded.filter((park) => park.accountId === account.id).length : null,
      deletionState: account.deletionState,
    };
  }

  async listAccounts(query: AccountQuery, now: Date) {
    const search = query.search?.trim().toLowerCase() ?? "";
    return this.accounts
      .filter((account) => !search || account.id === search || account.email === search || Boolean(account.handle?.includes(search)))
      .filter((account) => !query.state || account.deletionState === query.state)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .filter(
        (account) =>
          !query.cursor || account.createdAt < query.cursor.createdAt || (account.createdAt === query.cursor.createdAt && account.id < query.cursor.id),
      )
      .slice(0, query.limit)
      .map((account) => this.row(account, now));
  }

  async getAccount(id: string, now: Date): Promise<AccountDetail | null> {
    const account = this.accounts.find((item) => item.id === id);
    if (!account) return null;
    const receipt = this.receipts
      .filter((item) => item.accountId === id)
      .sort((a, b) => Number(b.status === "pending") - Number(a.status === "pending") || b.createdAt.localeCompare(a.createdAt))[0];
    return {
      ...this.row(account, now),
      maskedEmail: maskEmail(account.email),
      emailVerified: true,
      activeSessions: account.sessions.filter((session) => !session.revokedAt && Date.parse(session.expiresAt) > now.getTime()).length,
      lastSignInAt:
        account.sessions
          .map((session) => session.createdAt)
          .sort()
          .at(-1) ?? null,
      recentEvents: this.events
        .filter((event) => event.accountId === id)
        .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
        .slice(0, 50),
      recentVisits: this.visits
        .filter((visit) => visit.accountId === id)
        .sort((a, b) => b.visitedAt.localeCompare(a.visitedAt))
        .slice(0, 20)
        .map((visit) => ({
          parkId: visit.parkId,
          parkName: this.parks.get(visit.parkId) ?? visit.parkId,
          visitedAt: visit.visitedAt,
          outcome: visit.outcome,
          points: visit.points,
        })),
      founded: !this.available.founders
        ? null
        : this.founded
            .filter((park) => park.accountId === id)
            .map((park) => ({ parkId: park.parkId, parkName: this.parks.get(park.parkId) ?? park.parkId, foundedAt: park.foundedAt })),
      deletion: receipt ? { receiptId: receipt.receiptId, status: receipt.status, createdAt: receipt.createdAt } : null,
    };
  }

  async accountEmail(id: string) {
    return this.accounts.find((account) => account.id === id)?.email ?? null;
  }

  async accountIdForHandle(handle: string) {
    return this.accounts.find((account) => account.handle === handle.toLowerCase())?.id ?? null;
  }

  private matching(filter: EventFilter): EventRow[] {
    return this.events.filter(
      (event) =>
        event.receivedAt >= filter.from &&
        event.receivedAt < filter.to &&
        filter.types.includes(event.type) &&
        (!filter.accountId || event.accountId === filter.accountId) &&
        (!filter.parkId || event.parkId === filter.parkId) &&
        (!filter.route || event.route === filter.route) &&
        (!filter.result || (filter.result === "ok" ? event.result === "ok" : event.result !== null && event.result !== "ok")),
    );
  }

  async listEvents(filter: EventFilter, cursor: EventCursor | null, limit: number) {
    return this.matching(filter)
      .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt) || b.id.localeCompare(a.id))
      .filter((event) => !cursor || event.receivedAt < cursor.receivedAt || (event.receivedAt === cursor.receivedAt && event.id < cursor.id))
      .slice(0, limit)
      .map((event) => ({ ...event, handle: this.handleOf(event.accountId) }));
  }

  async histogram(filter: EventFilter, bucket: "hour" | "day"): Promise<HistogramBucket[]> {
    const buckets = new Map<string, HistogramBucket>();
    for (const event of this.matching(filter)) {
      const date = new Date(event.receivedAt);
      // Hours are the same everywhere for a whole-hour zone offset; days follow Victoria.
      const key =
        bucket === "hour"
          ? new Date(Math.floor(date.getTime() / 3_600_000) * 3_600_000).toISOString()
          : new Date(`${localDay(event.receivedAt)}T12:00:00Z`).toISOString();
      const entry = buckets.get(key) ?? { at: key, count: 0, db: 0 };
      entry.count += 1;
      if ((DB_EVENT_TYPES as readonly string[]).includes(event.type)) entry.db += 1;
      buckets.set(key, entry);
    }
    return [...buckets.values()].sort((a, b) => a.at.localeCompare(b.at));
  }

  async routes() {
    return [...new Set(this.events.map((event) => event.route).filter((route): route is string => Boolean(route)))].sort();
  }

  async pendingDeletions(): Promise<DeletionRow[]> {
    return this.receipts
      .filter((receipt) => receipt.status === "pending")
      .map((receipt) => {
        const account = this.accounts.find((item) => item.id === receipt.accountId);
        return {
          receiptId: receipt.receiptId,
          accountId: receipt.accountId,
          handle: account?.handle ?? null,
          createdAt: receipt.createdAt,
          photoObjects: receipt.photoObjects,
          attempts: receipt.attempts,
          lastError: receipt.lastError,
          accountState: account?.deletionState ?? "gone",
        };
      });
  }

  async beginDeletion(accountId: string, receiptId: string, now: Date) {
    const account = this.accounts.find((item) => item.id === accountId);
    if (!account) return null;
    const pending = this.receipts.find((receipt) => receipt.accountId === accountId && receipt.status === "pending");
    if (account.deletionState === "active") {
      account.deletionState = "deleting";
      for (const session of account.sessions) session.revokedAt ??= now.toISOString();
      this.receipts.push({ receiptId, accountId, status: "pending", createdAt: now.toISOString(), photoObjects: 2, attempts: 0, lastError: null });
      return { receiptId, created: true };
    }
    return pending ? { receiptId: pending.receiptId, created: false } : null;
  }

  async recordSecurityEvent(eventType: string, outcome: string) {
    this.securityEvents.push({ eventType, outcome });
  }

  /** What completeDeletion does: the account and everything that cascades from it go. */
  completeDeletion(receiptId: string): boolean {
    const receipt = this.receipts.find((item) => item.receiptId === receiptId);
    if (!receipt) return false;
    receipt.status = "complete";
    receipt.photoObjects = 0;
    const id = receipt.accountId;
    this.accounts = this.accounts.filter((account) => account.id !== id);
    this.visits = this.visits.filter((visit) => visit.accountId !== id);
    this.tenures = this.tenures.filter((tenure) => tenure.holder !== id);
    this.founded = this.founded.filter((park) => park.accountId !== id);
    this.photoChecks = this.photoChecks.filter((check) => check.accountId !== id);
    return true;
  }
}

/**
 * A pretend photo service: a receipt whose photo cleanup failed before ("photo service timed
 * out") succeeds when resumed, like a real retry after an outage.
 */
export class MemoryAccountDeleter implements AccountDeleter {
  constructor(
    private readonly store: MemoryAnalyticsStore,
    private readonly photoServiceUp: () => boolean = () => true,
  ) {}

  async resume(receiptId: string): Promise<"pending" | "complete"> {
    const receipt = this.store.receipts.find((item) => item.receiptId === receiptId);
    if (!receipt) return "pending";
    if (receipt.status === "complete") return "complete";
    if (!this.photoServiceUp()) {
      receipt.attempts += 1;
      receipt.lastError = "Private photo cleanup is incomplete.";
      return "pending";
    }
    return this.store.completeDeletion(receiptId) ? "complete" : "pending";
  }
}

// Seeded so the demo looks the same on every start.
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function uuid(next: () => number): string {
  const hex = Array.from({ length: 32 }, () => Math.floor(next() * 16).toString(16)).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const DEMO_PARKS: [string, string][] = [
  ["regional-thetis-lake", "Thetis Lake Regional Park"],
  ["municipal-beacon-hill", "Beacon Hill Park"],
  ["regional-mount-douglas", "Mount Douglas Park"],
  ["provincial-goldstream", "Goldstream Provincial Park"],
  ["regional-elk-beaver-lake", "Elk/Beaver Lake Regional Park"],
  ["regional-francis-king", "Francis/King Regional Park"],
  ["municipal-cattle-point", "Cattle Point"],
  ["municipal-gonzales-beach", "Gonzales Beach Park"],
  ["regional-east-sooke", "East Sooke Regional Park"],
  ["regional-witty-s-lagoon", "Witty's Lagoon Regional Park"],
  ["regional-sooke-potholes", "Sooke Potholes Regional Park"],
  ["regional-mount-work", "Mount Work Regional Park"],
  ["regional-island-view-beach", "Island View Beach Regional Park"],
  ["municipal-mystic-vale", "Mystic Vale"],
  ["osm-way-118204551", "Cadboro-Gyro Park"],
  ["osm-way-24433920", "Summit Park"],
  ["municipal-willows-beach", "Willows Beach Park"],
  ["regional-mill-hill", "Mill Hill Regional Park"],
  ["provincial-french-beach", "French Beach Provincial Park"],
  ["municipal-dallas-road", "Dallas Road Waterfront"],
  ["regional-lone-tree-hill", "Lone Tree Hill Regional Park"],
  ["municipal-mount-tolmie", "Mount Tolmie Park"],
  ["regional-matheson-lake", "Matheson Lake Regional Park"],
  ["municipal-swan-lake", "Swan Lake Nature Sanctuary"],
  ["provincial-gowlland-tod", "Gowlland Tod Provincial Park"],
  ["municipal-cedar-hill", "Cedar Hill Park"],
];

const HANDLES = [
  "trailhound",
  "mossy_maddie",
  "salal_sam",
  "cedar_kid",
  "tidepool_tess",
  "garry_oak",
  "fernwalker",
  "otter_ollie",
  "kip_fan_92",
  "lagoon_lou",
  "bluff_runner",
  "arbutus_ash",
  "heron_hana",
  "summit_sid",
  "drift_dana",
  "madrona_max",
  "camas_cleo",
  "orca_ori",
  "trillium_tia",
  "eagle_eli",
  "pebble_pat",
  "sooke_sky",
  "beacon_bea",
  "foggy_finn",
  "rain_rhea",
  "kelp_kai",
  "nettle_ned",
  "puddle_pia",
  "stump_stan",
  "willow_wren",
];

const ROUTES = [
  "GET /api/content/snapshot",
  "GET /api/content/changes",
  "POST /api/game/visits",
  "GET /api/game/leaderboard",
  "GET /api/game/flags",
  "GET /api/claims",
  "PUT /api/claims/:id",
  "PUT /api/claims/:id/photo",
  "POST /api/founders/photo-check",
  "POST /api/founders/found",
  "GET /api/app-config",
  "POST /api/game/handle",
  "GET /api/account",
];

const FLAG_SETS = [["people"], ["not_park"], ["lighting"], ["people", "personal_info"], ["not_photo"], ["inappropriate"], ["lighting", "not_park"]];

/** About thirty players over the last two months, with a busy last fortnight. */
export function seedDemoAnalytics(store: MemoryAnalyticsStore, now = Date.now(), seed = 135): MemoryAnalyticsStore {
  const next = random(seed);
  const pick = <T>(items: readonly T[]) => items[Math.floor(next() * items.length)];
  const at = (msAgo: number) => new Date(now - msAgo).toISOString();
  for (const [id, name] of DEMO_PARKS) store.parks.set(id, name);

  for (let i = 0; i < 42; i += 1) {
    // Sign-ups lean recent, as after a launch.
    const age = Math.floor(next() ** 1.7 * 60 * DAY) + 3_600_000;
    const handle = i < HANDLES.length ? HANDLES[i] : null;
    const id = uuid(next);
    const sessionStart = now - Math.floor(next() * Math.min(age, 20 * DAY));
    store.accounts.push({
      id,
      handle,
      createdAt: at(age),
      deletionState: "active",
      email: `${handle ?? `player${i}`}@${pick(["gmail.com", "outlook.com", "shaw.ca", "telus.net"])}`,
      google: next() > 0.08,
      password: next() < 0.1,
      sessions: [{ createdAt: new Date(sessionStart).toISOString(), expiresAt: new Date(sessionStart + 30 * DAY).toISOString(), revokedAt: null }],
    });
  }

  const players = store.accounts.filter((account) => account.handle);
  const holders = new Map<string, MemoryTenure>();
  // Visits play forward in time so plants, holds and takes line up with tenures.
  const visitTimes = Array.from({ length: 420 }, () => now - Math.floor(next() ** 1.25 * 58 * DAY)).sort((a, b) => a - b);
  for (const time of visitTimes) {
    // A few keen players do most of the visiting, and they often return to parks they hold.
    const player = players[Math.floor(next() ** 1.6 * players.length)];
    const own = [...holders.values()].filter((tenure) => tenure.holder === player.id && !tenure.endedAt);
    const parkId = own.length && next() < 0.45 ? pick(own).parkId : DEMO_PARKS[Math.floor(next() ** 1.5 * DEMO_PARKS.length)][0];
    if (Date.parse(player.createdAt) > time) continue;
    if (store.visits.some((visit) => visit.accountId === player.id && visit.parkId === parkId && localDay(visit.visitedAt) === localDay(time))) continue;
    const open = holders.get(parkId);
    let outcome: MemoryVisit["outcome"];
    let points = 0;
    if (!open || open.endedAt) {
      outcome = "planted";
      const tenure = {
        parkId,
        holder: player.id,
        startedAt: new Date(time).toISOString(),
        lastVisitAt: new Date(time).toISOString(),
        endedAt: null,
        bounty: 0,
      };
      store.tenures.push(tenure);
      holders.set(parkId, tenure);
    } else if (open.holder === player.id) {
      outcome = "held";
      open.lastVisitAt = new Date(time).toISOString();
    } else {
      outcome = "took";
      points = wholeDays(Date.parse(open.startedAt), time);
      open.endedAt = new Date(time).toISOString();
      const tenure = {
        parkId,
        holder: player.id,
        startedAt: new Date(time).toISOString(),
        lastVisitAt: new Date(time).toISOString(),
        endedAt: null,
        bounty: points,
      };
      store.tenures.push(tenure);
      holders.set(parkId, tenure);
    }
    store.visits.push({ accountId: player.id, parkId, visitedAt: new Date(time).toISOString(), outcome, points });
  }

  for (const [index, [parkId]] of DEMO_PARKS.entries()) {
    if (index % 3 === 2) continue;
    const founder = pick(players);
    store.founded.push({ parkId, accountId: founder.id, foundedAt: at(Math.floor(next() * 40 * DAY)) });
  }

  for (let i = 0; i < 140; i += 1) {
    const roll = next();
    const outcome: MemoryPhotoCheck["outcome"] = roll < 0.62 ? "approve" : roll < 0.88 ? "reject" : roll < 0.97 ? "unsure" : "unavailable";
    store.photoChecks.push({
      accountId: pick(players).id,
      createdAt: at(Math.floor(next() ** 1.3 * 50 * DAY)),
      outcome,
      flags: outcome === "reject" || outcome === "unsure" ? pick(FLAG_SETS) : [],
    });
  }

  const gameTypes = [
    "flag_planted",
    "flag_taken",
    "flag_held",
    "visit_already_today",
    "leaderboard_viewed",
    "takeover_message_seen",
    "founder_photo_checked",
    "park_founded",
    "handle_set",
    "flag_fell",
  ];
  const installations = store.accounts.map(() => uuid(next));
  for (let i = 0; i < 2600; i += 1) {
    const signedIn = next() < 0.72;
    // Engagement is uneven: most events come from a handful of accounts.
    const index = Math.floor(next() ** 2.4 * store.accounts.length);
    const db = next() < 0.58;
    // Players without a handle have not joined the game yet, so only their queries show up.
    const account = signedIn && (db || store.accounts[index].handle) ? store.accounts[index] : null;
    const received = now - Math.floor(next() ** 1.2 * 58 * DAY);
    if (account && Date.parse(account.createdAt) > received) continue;
    const type = db ? (next() < 0.8 ? "db_read" : "db_write") : pick(gameTypes);
    const route = db
      ? pick(ROUTES)
      : type.startsWith("flag") || type === "visit_already_today"
        ? "POST /api/game/visits"
        : type === "leaderboard_viewed"
          ? "GET /api/game/leaderboard"
          : type === "handle_set"
            ? "POST /api/game/handle"
            : type === "takeover_message_seen"
              ? "POST /api/game/takeovers/seen"
              : type === "park_founded"
                ? "POST /api/founders/found"
                : "POST /api/founders/photo-check";
    const parkId = !db && type !== "leaderboard_viewed" && type !== "handle_set" && type !== "takeover_message_seen" ? pick(DEMO_PARKS)[0] : null;
    const failed = db && next() < 0.015;
    store.events.push({
      id: uuid(next),
      type,
      occurredAt: new Date(received - Math.floor(next() * 400)).toISOString(),
      receivedAt: new Date(received).toISOString(),
      route,
      accountId: account?.id ?? null,
      handle: null,
      installationId: installations[index],
      appVersion: pick(["0.4.2+41", "0.4.3+42", "0.4.3+42", "0.4.4+43"]),
      bundleId: pick(["9f2c1ab", "4e81d07", "4e81d07"]),
      environment: "main",
      operation: db ? (type === "db_read" ? "read" : "write") : null,
      tables: db ? [pick(["kip_game.visits", "kip_game.tenures", "public.parks", "kip_account.sessions", "kip_account.claims", "kip_founders.parks"])] : null,
      durationMs: db ? Math.floor(4 + next() ** 3 * 380) : null,
      result: db ? (failed ? pick(["57014", "23505", "error"]) : "ok") : null,
      parkId,
      properties: db
        ? null
        : type === "founder_photo_checked"
          ? { outcome: pick(["approve", "approve", "reject", "unsure"]), flags: pick(["", "people", "lighting"]) }
          : type === "flag_taken"
            ? { points: Math.floor(next() * 9), previous_holder: pick(HANDLES) }
            : type === "leaderboard_viewed"
              ? { rows: 30 }
              : { source: "visit" },
    });
  }

  // One deletion stuck on the photo service, to show resume.
  const stuck = store.accounts.find((account) => !account.handle && Date.parse(account.createdAt) < now - 5 * DAY);
  if (stuck) {
    stuck.deletionState = "deleting";
    for (const session of stuck.sessions) session.revokedAt = at(2 * DAY + 3_600_000);
    store.receipts.push({
      receiptId: uuid(next),
      accountId: stuck.id,
      status: "pending",
      createdAt: at(2 * DAY + 3_600_000),
      photoObjects: 3,
      attempts: 2,
      lastError: "Private photo cleanup is incomplete.",
    });
  }
  store.feedbackOpen = 7;
  return store;
}

/** Sample PostHog answers shaped like the real query API, so the App events tab can be explored offline. */
export class DemoPostHogClient implements PostHogClient {
  constructor(private readonly now = () => Date.now()) {}

  status() {
    return { ...posthogStatus({ POSTHOG_PERSONAL_API_KEY: "demo", POSTHOG_PROJECT_ID: "1" }), host: "https://us.posthog.com (demo data)" };
  }

  async template(name: string, params: TemplateParams, environment: string, now: Date): Promise<QueryResult> {
    buildTemplate(name, params, environment, now);
    const next = random(name.length * 31 + params.days);
    const t = this.now();
    if (name === "events_per_day") {
      return {
        columns: ["day", "events", "people"],
        rows: Array.from({ length: params.days }, (_, i) => {
          const day = new Date(t - (params.days - 1 - i) * DAY).toISOString().slice(0, 10);
          const people = Math.floor(8 + i * 0.6 + next() * 6);
          return [day, people * Math.floor(30 + next() * 25), people];
        }),
        hasMore: false,
        nextCursor: null,
      };
    }
    if (name === "top_events") {
      const names = [
        "$autocapture",
        "$pageview",
        "$screen",
        "found_park_started",
        "found_park_completed",
        "found_park_photo_rejected",
        "$pageleave",
        "$web_vitals",
      ];
      return {
        columns: ["event", "events", "people"],
        rows: names.map((event, i) => [event, Math.floor(4200 / (i + 1) + next() * 90), Math.floor(36 / (i * 0.4 + 1))]),
        hasMore: false,
        nextCursor: null,
      };
    }
    if (name === "taps" || name === "screens") {
      const screens = ["/map", "/park", "/leaderboard", "/found", "/profile", "/settings"];
      const labels = ["Plant flag", "Directions", "Leaderboard", "Found this park", "Take photo", "Use photo", "Close", "Sign in with Google", "Menu"];
      if (name === "screens")
        return {
          columns: ["screen", "views", "people"],
          rows: screens.map((screen, i) => [screen, Math.floor(2600 / (i + 1)), Math.floor(38 / (i * 0.5 + 1))]),
          hasMore: false,
          nextCursor: null,
        };
      return {
        columns: ["screen", "label", "taps", "people"],
        rows: labels.map((label, i) => [screens[i % screens.length], label, Math.floor(1300 / (i + 1) + next() * 40), Math.floor(30 / (i * 0.3 + 1))]),
        hasMore: false,
        nextCursor: null,
      };
    }
    const before = params.before ? Date.parse(params.before) : t;
    const events = ["$autocapture", "$pageview", "$autocapture", "found_park_started", "$autocapture", "$pageleave"];
    const rows = Array.from({ length: 100 }, (_, i) => {
      const time = new Date(before - (i + 1) * Math.floor(40_000 + next() * 200_000)).toISOString();
      const event = params.event ?? pick(events, next);
      return [
        time,
        event,
        params.distinctId ?? uuid(next),
        pick(["/map", "/park", "/leaderboard", "/found"], next),
        event === "$autocapture" ? pick(["Plant flag", "Directions", "Menu", "Close"], next) : null,
        "0.4.4+43",
        "android",
        "capacitor://localhost/map",
      ];
    });
    return {
      columns: ["timestamp", "event", "distinct_id", "screen", "label", "app_version", "platform", "url"],
      rows,
      hasMore: true,
      nextCursor: String(rows[rows.length - 1][0]),
    };
  }

  async custom(text: unknown, limit: unknown): Promise<QueryResult> {
    const hogql = guardCustomQuery(text, limit);
    return { columns: ["query_sent", "note"], rows: [[hogql.query, "Demo data: a deployment sends this to PostHog."]], hasMore: false, nextCursor: null };
  }
}

function pick<T>(items: readonly T[], next: () => number): T {
  return items[Math.floor(next() * items.length)];
}

/** Sample analytics for the local demo server (server/demo.ts). */
export function demoAnalytics(): AnalyticsDependencies {
  const stores = new Map<string, MemoryAnalyticsStore>();
  const storeFor = (env: DashboardEnv) => {
    const key = env.DASHBOARD_ENVIRONMENT === "staging" ? "staging" : "production";
    let store = stores.get(key);
    if (!store) {
      store = seedDemoAnalytics(new MemoryAnalyticsStore(), Date.now(), key === "staging" ? 76 : 135);
      if (key === "staging") store.accounts = store.accounts.slice(0, 12);
      // OPERATOR_DEMO_WITHOUT_FOUNDERS=1 shows production as a release behind, without kip_founders.
      if (key === "production" && process.env.OPERATOR_DEMO_WITHOUT_FOUNDERS === "1") store.available.founders = false;
      stores.set(key, store);
    }
    return store;
  };
  return {
    analyticsStore: storeFor,
    accountDeleter: (env) => new MemoryAccountDeleter(storeFor(env)),
    photoService: () => ({ available: true, missing: [] }),
    posthog: () => new DemoPostHogClient(),
  };
}

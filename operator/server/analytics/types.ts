/** Shapes the analytics API returns. The UI keeps its own copy in src/analytics/types.ts. */

export interface Period {
  current: number;
  previous: number;
}

export interface Overview {
  generatedAt: string;
  /** Length of the chart period and of the "this period" tiles, in Victoria days. */
  days: number;
  accounts: { total: number; new7: number; new30: number; period: Period; deleting: number; withHandle: number };
  /** Signed-in players: accounts with at least one server event in the window. */
  players: { day: Period; week: Period; month: Period };
  founded: { total: number; new7: number; period: Period };
  visits: { planted: Period; took: Period; held: Period };
  photoChecks: { total: Period; approved: Period; rejected: number; unsure: number; unavailable: number };
  feedbackOpen: number;
  /** One entry per Victoria day, oldest first. */
  series: {
    days: string[];
    newAccounts: number[];
    activePlayers: number[];
    planted: number[];
    took: number[];
    held: number[];
    foundings: number[];
  };
  topParks: { parkId: string; name: string; visits: number; players: number }[];
  rejectionFlags: { flag: string; count: number }[];
}

export type DeletionState = "active" | "deleting";

export interface AccountRow {
  id: string;
  handle: string | null;
  createdAt: string;
  lastActiveAt: string | null;
  providers: string[];
  visits: number;
  parksHeld: number;
  score: number;
  foundedParks: number;
  deletionState: DeletionState;
}

export interface AccountCursor {
  createdAt: string;
  id: string;
}

export interface AccountQuery {
  /** A handle fragment, a full account ID or a full email address. */
  search: string | null;
  state: DeletionState | null;
  cursor: AccountCursor | null;
  limit: number;
}

export interface EventRow {
  id: string;
  type: string;
  occurredAt: string | null;
  receivedAt: string;
  route: string | null;
  accountId: string | null;
  handle: string | null;
  installationId: string | null;
  appVersion: string | null;
  bundleId: string | null;
  environment: string;
  operation: string | null;
  tables: string[] | null;
  durationMs: number | null;
  result: string | null;
  parkId: string | null;
  /** Game event properties, or the interaction fields for the older app events. */
  properties: Record<string, unknown> | null;
}

export interface AccountDetail extends AccountRow {
  maskedEmail: string;
  emailVerified: boolean;
  activeSessions: number;
  lastSignInAt: string | null;
  recentEvents: EventRow[];
  recentVisits: { parkId: string; parkName: string; visitedAt: string; outcome: string; points: number }[];
  founded: { parkId: string; parkName: string; foundedAt: string }[];
  deletion: { receiptId: string; status: "pending" | "complete"; createdAt: string } | null;
}

export interface EventFilter {
  types: string[];
  from: string;
  to: string;
  accountId: string | null;
  parkId: string | null;
  route: string | null;
  /** "ok", "failed" (anything else) or null for any. */
  result: "ok" | "failed" | null;
}

export interface EventCursor {
  receivedAt: string;
  id: string;
}

export interface HistogramBucket {
  at: string;
  count: number;
  db: number;
}

export interface DeletionRow {
  receiptId: string;
  accountId: string;
  handle: string | null;
  createdAt: string;
  /** Private photos still waiting for the photo service. */
  photoObjects: number;
  attempts: number;
  lastError: string | null;
  /** "gone" once the account row is deleted but the receipt was not marked complete. */
  accountState: DeletionState | "gone";
}

export interface AnalyticsStore {
  overview(now: Date, days: number): Promise<Overview>;
  listAccounts(query: AccountQuery, now: Date): Promise<AccountRow[]>;
  getAccount(id: string, now: Date): Promise<AccountDetail | null>;
  accountEmail(id: string): Promise<string | null>;
  accountIdForHandle(handle: string): Promise<string | null>;
  listEvents(filter: EventFilter, cursor: EventCursor | null, limit: number): Promise<EventRow[]>;
  histogram(filter: EventFilter, bucket: "hour" | "day"): Promise<HistogramBucket[]>;
  /** Every distinct route seen in the retained events, for the route filter. */
  routes(): Promise<string[]>;
  pendingDeletions(): Promise<DeletionRow[]>;
  /**
   * Marks an active account as deleting, signs it out everywhere and opens a receipt, as the
   * app's own deletion does. Returns the open receipt when one exists already, or null when the
   * account is not there.
   */
  beginDeletion(accountId: string, receiptId: string, now: Date): Promise<{ receiptId: string; created: boolean } | null>;
  recordSecurityEvent(eventType: string, outcome: string): Promise<void>;
}

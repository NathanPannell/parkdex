/** Responses from /api/analytics/*. The server's own copy is operator/server/analytics/types.ts. */

export type Period = { current: number; previous: number };

export type Overview = {
  generatedAt: string;
  days: number;
  accounts: { total: number; new7: number; new30: number; period: Period; deleting: number; withHandle: number };
  players: { day: Period; week: Period; month: Period };
  /** Null when the database has no kip_founders schema yet; `unavailable` says why. */
  founded: { total: number; new7: number; period: Period } | null;
  visits: { planted: Period; took: Period; held: Period };
  photoChecks: { total: Period; approved: Period; rejected: number; unsure: number; unavailable: number } | null;
  feedbackOpen: number;
  series: { days: string[]; newAccounts: number[]; activePlayers: number[]; planted: number[]; took: number[]; held: number[]; foundings: number[] | null };
  topParks: { parkId: string; name: string; visits: number; players: number }[];
  rejectionFlags: { flag: string; count: number }[];
  /** For example ["founders not deployed"] on a database a release behind. */
  unavailable: string[];
};

export type DeletionSetup = { available: boolean; missing: string[] };

export type AccountRow = {
  id: string;
  handle: string | null;
  createdAt: string;
  lastActiveAt: string | null;
  providers: string[];
  visits: number;
  parksHeld: number;
  score: number;
  foundedParks: number | null;
  deletionState: "active" | "deleting";
};

export type EventRow = {
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
  properties: Record<string, unknown> | null;
};

export type AccountDetail = AccountRow & {
  maskedEmail: string;
  emailVerified: boolean;
  activeSessions: number;
  lastSignInAt: string | null;
  recentEvents: EventRow[];
  recentVisits: { parkId: string; parkName: string; visitedAt: string; outcome: string; points: number }[];
  founded: { parkId: string; parkName: string; foundedAt: string }[] | null;
  deletion: { receiptId: string; status: "pending" | "complete"; createdAt: string } | null;
};

export type DeletionRow = {
  receiptId: string;
  accountId: string;
  handle: string | null;
  createdAt: string;
  photoObjects: number;
  attempts: number;
  lastError: string | null;
  accountState: "active" | "deleting" | "gone";
};

export type EventsPage = { events: EventRow[]; nextCursor: string | null; filter: { from: string; to: string; types: string[] }; unknownHandle: string | null; unavailable: string[] };
export type Histogram = { bucket: "hour" | "day"; from: string; to: string; buckets: { at: string; count: number; db: number }[]; dbOmitted: boolean; unknownHandle: string | null };

export type PostHogStatus = { configured: boolean; host: string; missing: string[]; problem: string | null; environment: string };
export type QueryResult = { columns: string[]; rows: unknown[][]; hasMore: boolean; nextCursor: string | null };

/** Every server event type, in the order the type filter lists them. */
export const EVENT_TYPES = [
  "flag_planted", "flag_taken", "flag_held", "visit_already_today", "flag_fell",
  "leaderboard_viewed", "takeover_message_seen", "handle_set",
  "park_founded", "founder_photo_checked", "founding_review_requested", "founding_review_decided",
  "park_viewed", "directions_opened", "park_claimed",
  "db_read", "db_write",
] as const;

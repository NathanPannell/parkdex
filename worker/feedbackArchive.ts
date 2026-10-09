import { database } from "./db.js";
import { feedbackSelect, mapReport, type FeedbackCursor, type OperatorFeedbackRecord } from "./store.js";
import type { FeedbackStatus } from "./validation.js";

/**
 * The feedback archive. "Clear done" on the operator board archives every done (closed) report
 * by setting archived_at: the report leaves the board, stays searchable in the archive and can be
 * restored. The daily retention job deletes archived reports 90 days after they were archived;
 * their screenshot and email rows go with them through ON DELETE CASCADE.
 *
 * The app never lists reports, so only the operator dashboard reads these queries. They live
 * here, beside the feedback store, so the dashboard and the retention job share one definition.
 */

export const FEEDBACK_ARCHIVE_RETENTION_DAYS = 90;
const RETENTION_MS = FEEDBACK_ARCHIVE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
/** One run deletes at most this many. Archiving is manual, so a day never comes close. */
export const FEEDBACK_PURGE_BATCH_LIMIT = 1000;
/** "Clear done" archives at most this many per click; the board asks again if there are more. */
export const CLEAR_DONE_LIMIT = 500;
export const ARCHIVE_SEARCH_MAX = 100;

export interface ArchivedFeedbackRecord extends OperatorFeedbackRecord {
  archivedAt: string | null;
}

export interface FeedbackPurgeResult {
  deleted: number;
  remainingExpired: number;
}

export interface FeedbackArchiveStore {
  /** Reports on the board: not archived, newest first. */
  listBoard(limit: number, status: FeedbackStatus | null, cursor: FeedbackCursor | null): Promise<ArchivedFeedbackRecord[]>;
  getReport(id: string): Promise<ArchivedFeedbackRecord | null>;
  /** Archived reports, most recently archived first. The cursor's createdAt holds archivedAt. */
  listArchive(limit: number, search: string | null, cursor: FeedbackCursor | null): Promise<ArchivedFeedbackRecord[]>;
  countArchive(search: string | null): Promise<number>;
  /** Archives done reports that are still on the board and returns their ids. */
  archiveDone(limit: number): Promise<string[]>;
  /** Puts archived reports back on the board (in Done) and returns the ids that moved. */
  restore(ids: string[]): Promise<string[]>;
  /** Board counts by status, without archived reports. */
  liveCounts(): Promise<Record<string, number>>;
}

export type QueryRunner = (text: string, params: unknown[]) => Promise<Record<string, unknown>[]>;

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function toRecord(row: Record<string, unknown>): ArchivedFeedbackRecord {
  return { ...mapReport(row), archivedAt: iso(row.archived_at) };
}

/** A LIKE pattern that matches the operator's text literally. */
export function containsPattern(search: string): string {
  return `%${search.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

function selectWithArchive(): string {
  return feedbackSelect().replace("SELECT r.id,", "SELECT r.archived_at, r.id,");
}

const SEARCH_CLAUSE = `($1::text IS NULL OR r.message ILIKE $1 OR r.context->>'parkName' ILIKE $1 OR r.email ILIKE $1
  OR r.context->>'version' ILIKE $1 OR r.context->>'build' ILIKE $1 OR r.id::text = lower($2::text))`;

export function createSqlFeedbackArchiveStore(run: QueryRunner): FeedbackArchiveStore {
  return {
    async listBoard(limit, status, cursor) {
      const rows = await run(`${selectWithArchive()}
        WHERE r.archived_at IS NULL
          AND ($1::text IS NULL OR r.status = $1::text)
          AND ($2::timestamptz IS NULL OR (r.created_at, r.id) < ($2::timestamptz, $3::uuid))
        ORDER BY r.created_at DESC, r.id DESC LIMIT $4`,
      [status, cursor?.createdAt ?? null, cursor?.id ?? null, Math.min(Math.max(limit, 1), 101)]);
      return rows.map(toRecord);
    },
    async getReport(id) {
      const rows = await run(`${selectWithArchive()} WHERE r.id = $1::uuid LIMIT 1`, [id]);
      return rows[0] ? toRecord(rows[0]) : null;
    },
    async listArchive(limit, search, cursor) {
      const rows = await run(`${selectWithArchive()}
        WHERE r.archived_at IS NOT NULL AND ${SEARCH_CLAUSE}
          AND ($3::timestamptz IS NULL OR (r.archived_at, r.id) < ($3::timestamptz, $4::uuid))
        ORDER BY r.archived_at DESC, r.id DESC LIMIT $5`,
      [search ? containsPattern(search) : null, search, cursor?.createdAt ?? null, cursor?.id ?? null, Math.min(Math.max(limit, 1), 101)]);
      return rows.map(toRecord);
    },
    async countArchive(search) {
      const rows = await run(`SELECT count(*)::int AS count FROM kip_feedback.reports r WHERE r.archived_at IS NOT NULL AND ${SEARCH_CLAUSE}`,
        [search ? containsPattern(search) : null, search]);
      return Number(rows[0]?.count ?? 0);
    },
    async archiveDone(limit) {
      const rows = await run(`
        WITH done AS MATERIALIZED (
          SELECT id FROM kip_feedback.reports
          WHERE status = 'closed' AND archived_at IS NULL
          ORDER BY created_at, id LIMIT $1
          FOR UPDATE SKIP LOCKED
        )
        UPDATE kip_feedback.reports r SET archived_at = now(), updated_at = now()
        FROM done WHERE r.id = done.id RETURNING r.id`, [Math.min(Math.max(limit, 1), CLEAR_DONE_LIMIT)]);
      return rows.map((row) => String(row.id));
    },
    async restore(ids) {
      if (ids.length === 0) return [];
      const rows = await run(`
        UPDATE kip_feedback.reports SET archived_at = NULL, updated_at = now()
        WHERE id = ANY($1::uuid[]) AND archived_at IS NOT NULL RETURNING id`, [ids]);
      return rows.map((row) => String(row.id));
    },
    async liveCounts() {
      const rows = await run("SELECT status, count(*)::int AS count FROM kip_feedback.reports WHERE archived_at IS NULL GROUP BY status", []);
      return Object.fromEntries(rows.map((row) => [String(row.status), Number(row.count)]));
    },
  };
}

export function createNeonFeedbackArchiveStore(databaseUrl: string): FeedbackArchiveStore {
  const sql = database(databaseUrl);
  return createSqlFeedbackArchiveStore((text, params) => sql.query(text, params) as Promise<Record<string, unknown>[]>);
}

/** The cutoff for a retention run at `now`: reports archived at or before it are deleted. */
export function feedbackRetentionCutoff(now: number): string {
  return new Date(now - RETENTION_MS).toISOString();
}

/** When an archived report is deleted for good. */
export function archiveDeletesAt(archivedAt: string): string {
  return new Date(Date.parse(archivedAt) + RETENTION_MS).toISOString();
}

/**
 * Deletes reports archived at or before `cutoff`, oldest first and bounded, in one statement.
 * Reports still on the board are never touched, however old they are.
 */
export async function purgeArchivedFeedback(run: QueryRunner, cutoff: string, batchLimit = FEEDBACK_PURGE_BATCH_LIMIT): Promise<FeedbackPurgeResult> {
  const rows = await run(`
    WITH expired AS MATERIALIZED (
      SELECT id FROM kip_feedback.reports
      WHERE archived_at IS NOT NULL AND archived_at <= $1::timestamptz
      ORDER BY archived_at, id LIMIT $2
    ),
    removed AS (
      DELETE FROM kip_feedback.reports r USING expired WHERE r.id = expired.id RETURNING r.id
    )
    SELECT (SELECT count(*) FROM removed)::int AS deleted,
      ((SELECT count(*) FROM kip_feedback.reports WHERE archived_at IS NOT NULL AND archived_at <= $1::timestamptz)
        - (SELECT count(*) FROM removed))::int AS remaining`, [cutoff, batchLimit]);
  return { deleted: Number(rows[0]?.deleted ?? 0), remainingExpired: Math.max(0, Number(rows[0]?.remaining ?? 0)) };
}

export function purgeArchivedFeedbackFromDatabase(databaseUrl: string, cutoff: string): Promise<FeedbackPurgeResult> {
  const sql = database(databaseUrl);
  return purgeArchivedFeedback((text, params) => sql.query(text, params) as Promise<Record<string, unknown>[]>, cutoff);
}

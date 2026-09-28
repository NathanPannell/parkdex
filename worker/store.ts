import { neon } from "@neondatabase/serverless";
import type {
  EmailAudience,
  EmailStatus,
  FeedbackContext,
  FeedbackEmailReport,
  FeedbackKind,
  FeedbackStatus,
  ValidatedFeedback,
} from "./validation.ts";

export interface ResendPayload {
  from: string;
  to: string[];
  subject: string;
  html: string;
  text: string;
  reply_to?: string;
}

export interface MailIntent {
  audience: EmailAudience;
  recipient: string;
  payload: ResendPayload;
  idempotencyKey: string;
  initialStatus: "pending" | "failed";
  initialError: string | null;
}

export interface SaveFeedbackArgs {
  id: string;
  payloadHash: string;
  ipHash: string;
  recipientHash: string | null;
  createdAt: string;
  feedback: ValidatedFeedback;
  mails: MailIntent[];
}

export interface EmailDeliveryView {
  audience: EmailAudience;
  status: EmailStatus;
  attempts: number;
  lastAttemptAt: string | null;
  sentAt: string | null;
  providerMessageId: string | null;
  lastError: string | null;
  canRetry: boolean;
  requiresConfirmation: boolean;
}

export interface OperatorFeedbackRecord extends FeedbackEmailReport {
  submissionId: string;
  status: FeedbackStatus;
  emails: EmailDeliveryView[];
  screenshot: null | { contentType: string; size: number };
}

export interface AttachmentRecord {
  contentType: string;
  size: number;
  base64: string;
}

export interface FeedbackCursor {
  createdAt: string;
  id: string;
}

export interface ClaimedEmail extends MailIntent {
  attempts: number;
}

export type SaveFeedbackResult =
  | { status: "saved"; report: OperatorFeedbackRecord }
  | { status: "duplicate"; report: OperatorFeedbackRecord }
  | { status: "rate_limited" }
  | { status: "conflict" };

export type ClaimEmailState = "sent" | "disabled" | "sending" | "pending" | "failed" | "ambiguous" | "missing";
export type ClaimEmailResult = { status: "claimed"; email: ClaimedEmail } | { status: ClaimEmailState };

export interface FeedbackStore {
  saveFeedback(args: SaveFeedbackArgs): Promise<SaveFeedbackResult>;
  findBySubmissionId(submissionId: string): Promise<{ id: string; payloadHash: string } | null>;
  getReport(id: string): Promise<OperatorFeedbackRecord | null>;
  listReports(limit: number, status: FeedbackStatus | null, cursor: FeedbackCursor | null): Promise<OperatorFeedbackRecord[]>;
  getAttachment(id: string): Promise<AttachmentRecord | null>;
  updateStatus(id: string, status: FeedbackStatus): Promise<OperatorFeedbackRecord | null>;
  getEmailDelivery(id: string, audience: EmailAudience): Promise<EmailDeliveryView | null>;
  claimEmail(id: string, audience: EmailAudience, leaseToken: string, confirmAmbiguousAfter24h: boolean): Promise<ClaimEmailResult>;
  markEmailDisabled(id: string, audience: EmailAudience): Promise<void>;
  finishEmail(id: string, audience: EmailAudience, leaseToken: string, state: "sent" | "failed" | "ambiguous", error: string | null, providerMessageId?: string | null): Promise<void>;
  consumeLoginRateLimit(ipHash: string): Promise<boolean>;
}

function stringValue(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : stringValue(value);
}

function jsonValue<T>(value: unknown, fallback: T): T {
  if (typeof value === "string") {
    try { return JSON.parse(value) as T; } catch { return fallback; }
  }
  return (value ?? fallback) as T;
}

function mapEmail(row: Record<string, unknown>): EmailDeliveryView {
  return {
    audience: row.audience as EmailAudience,
    status: row.status as EmailStatus,
    attempts: Number(row.attempts ?? 0),
    lastAttemptAt: nullableString(row.last_attempt_at),
    sentAt: nullableString(row.sent_at),
    providerMessageId: nullableString(row.provider_message_id),
    lastError: nullableString(row.last_error),
    canRetry: row.can_retry === true,
    requiresConfirmation: row.requires_confirmation === true,
  };
}

function mapReport(row: Record<string, unknown>): OperatorFeedbackRecord {
  const emailRows = jsonValue<Record<string, unknown>[]>(row.emails, []);
  const size = row.attachment_size === null || row.attachment_size === undefined ? null : Number(row.attachment_size);
  return {
    id: stringValue(row.id),
    submissionId: stringValue(row.submission_id),
    kind: row.kind as FeedbackKind,
    message: stringValue(row.message),
    email: nullableString(row.email),
    contact: row.contact === true,
    context: jsonValue<FeedbackContext>(row.context, { version: "", platform: "", screen: "", parkId: null, parkName: null }),
    createdAt: stringValue(row.created_at),
    hasScreenshot: size !== null,
    status: row.status as FeedbackStatus,
    emails: emailRows.map(mapEmail),
    screenshot: size === null ? null : { contentType: stringValue(row.attachment_type), size },
  };
}

function feedbackSelect(): string {
  return `
    SELECT r.id, r.submission_id, r.kind, r.message, r.email, r.contact, r.context, r.created_at, r.status,
      a.content_type AS attachment_type, a.size_bytes AS attachment_size,
      COALESCE((
        SELECT json_agg(json_build_object(
          'audience', d.audience, 'status', d.status, 'attempts', d.attempts,
          'last_attempt_at', d.last_attempt_at, 'sent_at', d.sent_at,
          'provider_message_id', d.provider_message_id, 'last_error', d.last_error,
          'can_retry', (d.status IN ('pending', 'failed') OR
            (d.status = 'ambiguous' AND d.last_attempt_at > now() - interval '24 hours') OR
            (d.status = 'sending' AND d.lease_until <= now() AND d.last_attempt_at > now() - interval '24 hours')),
          'requires_confirmation', ((d.status = 'ambiguous' AND d.last_attempt_at <= now() - interval '24 hours') OR
            (d.status = 'sending' AND d.lease_until <= now() AND d.last_attempt_at <= now() - interval '24 hours'))
        ) ORDER BY d.audience)
        FROM kip_feedback.email_deliveries d WHERE d.report_id = r.id
      ), '[]'::json) AS emails
    FROM kip_feedback.reports r
    LEFT JOIN kip_feedback.attachments a ON a.report_id = r.id`;
}

export function createNeonFeedbackStore(databaseUrl: string): FeedbackStore {
  const sql = neon(databaseUrl);

  async function findBySubmissionId(submissionId: string) {
    const rows = await sql`SELECT id, payload_hash FROM kip_feedback.reports WHERE submission_id = ${submissionId}::uuid LIMIT 1`;
    const row = rows[0] as Record<string, unknown> | undefined;
    return row ? { id: stringValue(row.id), payloadHash: stringValue(row.payload_hash).trim() } : null;
  }

  async function getReport(id: string): Promise<OperatorFeedbackRecord | null> {
    const query = `${feedbackSelect()} WHERE r.id = $1::uuid LIMIT 1`;
    const rows = await sql.query(query, [id]);
    return rows[0] ? mapReport(rows[0] as Record<string, unknown>) : null;
  }

  return {
    findBySubmissionId,
    async saveFeedback(args) {
      const existing = await findBySubmissionId(args.feedback.submissionId);
      if (existing) {
        if (existing.payloadHash !== args.payloadHash) return { status: "conflict" };
        const report = await getReport(existing.id);
        return report ? { status: "duplicate", report } : { status: "conflict" };
      }

      const contextJson = JSON.stringify(args.feedback.context);
      const feedback = args.feedback;
      const operatorMail = args.mails.find((mail) => mail.audience === "operator");
      const receiptMail = args.mails.find((mail) => mail.audience === "receipt");
      const operatorPayload = operatorMail ? JSON.stringify(operatorMail.payload) : null;
      const receiptPayload = receiptMail ? JSON.stringify(receiptMail.payload) : null;
      const screenshotType = feedback.screenshot?.contentType ?? null;
      const screenshotBase64 = feedback.screenshot?.base64 ?? null;
      const transaction = await sql.transaction([
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${feedback.submissionId}, 0))`,
        sql`
        WITH prior AS MATERIALIZED (
          SELECT id, payload_hash FROM kip_feedback.reports WHERE submission_id = ${feedback.submissionId}::uuid
        ),
        ip_bucket AS (
          INSERT INTO kip_feedback.rate_limits (bucket, subject_hash, window_started_at, hit_count)
          SELECT 'submission_ip', ${args.ipHash}, now(), 1 WHERE NOT EXISTS (SELECT 1 FROM prior)
          ON CONFLICT (bucket, subject_hash) DO UPDATE SET
            window_started_at = CASE
              WHEN kip_feedback.rate_limits.window_started_at <= now() - interval '1 hour' THEN now()
              ELSE kip_feedback.rate_limits.window_started_at
            END,
            hit_count = CASE
              WHEN kip_feedback.rate_limits.window_started_at <= now() - interval '1 hour' THEN 1
              ELSE kip_feedback.rate_limits.hit_count + 1
            END,
            updated_at = now()
          RETURNING hit_count
        ),
        recipient_bucket AS (
          INSERT INTO kip_feedback.rate_limits (bucket, subject_hash, window_started_at, hit_count)
          SELECT 'submission_recipient', ${args.recipientHash}::text, now(), 1
          FROM ip_bucket WHERE ${args.recipientHash}::text IS NOT NULL
          ON CONFLICT (bucket, subject_hash) DO UPDATE SET
            window_started_at = CASE
              WHEN kip_feedback.rate_limits.window_started_at <= now() - interval '24 hours' THEN now()
              ELSE kip_feedback.rate_limits.window_started_at
            END,
            hit_count = CASE
              WHEN kip_feedback.rate_limits.window_started_at <= now() - interval '24 hours' THEN 1
              ELSE kip_feedback.rate_limits.hit_count + 1
            END,
            updated_at = now()
          RETURNING hit_count
        ),
        quota AS (
          SELECT COALESCE((SELECT hit_count <= 20 FROM ip_bucket), true)
            AND COALESCE((SELECT hit_count <= 5 FROM recipient_bucket), true) AS allowed
        ),
        new_report AS (
          INSERT INTO kip_feedback.reports
            (id, submission_id, payload_hash, kind, message, email, contact, context, created_at)
          SELECT ${args.id}::uuid, ${feedback.submissionId}::uuid, ${args.payloadHash}, ${feedback.kind},
            ${feedback.message}, ${feedback.email}, ${feedback.contact}, ${contextJson}::jsonb, ${args.createdAt}::timestamptz
          FROM quota WHERE quota.allowed
          ON CONFLICT (submission_id) DO NOTHING
          RETURNING id
        ),
        new_attachment AS (
          INSERT INTO kip_feedback.attachments (report_id, content_type, content, size_bytes)
          SELECT new_report.id, ${screenshotType}::text, decode(${screenshotBase64}::text, 'base64'),
            octet_length(decode(${screenshotBase64}::text, 'base64'))
          FROM new_report WHERE ${screenshotBase64}::text IS NOT NULL
          ON CONFLICT (report_id) DO NOTHING
          RETURNING report_id
        ),
        new_operator_email AS (
          INSERT INTO kip_feedback.email_deliveries
            (report_id, audience, recipient, payload, status, idempotency_key, last_error)
          SELECT new_report.id, 'operator', ${operatorMail?.recipient ?? ""}, ${operatorPayload}::jsonb,
            ${operatorMail?.initialStatus ?? "failed"}, ${operatorMail?.idempotencyKey ?? `feedback-${args.id}-operator-v1`},
            ${operatorMail?.initialError ?? "Operator mail intent was not prepared."}
          FROM new_report WHERE ${operatorPayload}::text IS NOT NULL
          ON CONFLICT (report_id, audience) DO NOTHING
          RETURNING report_id
        ),
        new_receipt_email AS (
          INSERT INTO kip_feedback.email_deliveries
            (report_id, audience, recipient, payload, status, idempotency_key, last_error)
          SELECT new_report.id, 'receipt', ${receiptMail?.recipient ?? ""}, ${receiptPayload}::jsonb,
            ${receiptMail?.initialStatus ?? "failed"}, ${receiptMail?.idempotencyKey ?? `feedback-${args.id}-receipt-v1`},
            ${receiptMail?.initialError ?? "Receipt mail intent was not prepared."}
          FROM new_report WHERE ${receiptPayload}::text IS NOT NULL
          ON CONFLICT (report_id, audience) DO NOTHING
          RETURNING report_id
        )
        SELECT quota.allowed, prior.id AS prior_id, prior.payload_hash AS prior_payload_hash, new_report.id AS new_id
        FROM quota LEFT JOIN prior ON true LEFT JOIN new_report ON true`,
      ]);
      const rows = transaction[1] as Array<Record<string, unknown>>;
      const row = rows[0] as Record<string, unknown> | undefined;
      const found = await findBySubmissionId(feedback.submissionId);
      if (found) {
        if (found.payloadHash !== args.payloadHash) return { status: "conflict" };
        const report = await getReport(found.id);
        if (!report) throw new Error("saved report could not be loaded");
        if (row?.new_id) return { status: "saved", report };
        return { status: "duplicate", report };
      }
      if (row?.allowed === false) return { status: "rate_limited" };
      throw new Error("feedback save returned no report");
    },
    async getReport(id) {
      return getReport(id);
    },
    async listReports(limit, status, cursor) {
      const query = `${feedbackSelect()}
        WHERE ($1::text IS NULL OR r.status = $1::text)
          AND ($2::timestamptz IS NULL OR (r.created_at, r.id) < ($2::timestamptz, $3::uuid))
        ORDER BY r.created_at DESC, r.id DESC LIMIT $4`;
      const rows = await sql.query(query, [status, cursor?.createdAt ?? null, cursor?.id ?? null, Math.min(Math.max(limit, 1), 101)]);
      return rows.map((row) => mapReport(row as Record<string, unknown>));
    },
    async getAttachment(id) {
      const rows = await sql`
        SELECT content_type, size_bytes, encode(content, 'base64') AS content_base64
        FROM kip_feedback.attachments WHERE report_id = ${id}::uuid LIMIT 1`;
      const row = rows[0] as Record<string, unknown> | undefined;
      if (!row) return null;
      return { contentType: stringValue(row.content_type), size: Number(row.size_bytes), base64: stringValue(row.content_base64) };
    },
    async updateStatus(id, status) {
      const rows = await sql`
        UPDATE kip_feedback.reports SET status = ${status}, updated_at = now()
        WHERE id = ${id}::uuid RETURNING id`;
      if (!rows[0]) return null;
      return getReport(id);
    },
    async getEmailDelivery(id, audience) {
      const rows = await sql`
        SELECT audience, status, attempts, last_attempt_at, sent_at, provider_message_id, last_error
        FROM kip_feedback.email_deliveries WHERE report_id = ${id}::uuid AND audience = ${audience} LIMIT 1`;
      return rows[0] ? mapEmail(rows[0] as Record<string, unknown>) : null;
    },
    async claimEmail(id, audience, leaseToken, confirmAmbiguousAfter24h) {
      await sql`
        UPDATE kip_feedback.email_deliveries
        SET status = 'ambiguous', lease_token = NULL, lease_until = NULL,
          last_error = 'Email outcome is unknown after the provider idempotency window.', updated_at = now()
        WHERE report_id = ${id}::uuid AND audience = ${audience} AND status = 'sending'
          AND lease_until <= now() AND last_attempt_at <= now() - interval '24 hours'`;
      const rows = await sql`
        UPDATE kip_feedback.email_deliveries
        SET status = 'sending', lease_token = ${leaseToken}::uuid,
          lease_until = now() + interval '90 seconds', attempts = attempts + 1,
          last_attempt_at = now(), last_error = NULL, updated_at = now(),
          idempotency_key = CASE
            WHEN last_attempt_at <= now() - interval '24 hours'
              AND (status = 'failed' OR (status = 'ambiguous' AND ${confirmAmbiguousAfter24h}))
              THEN 'feedback-' || report_id::text || '-' || audience || '-attempt-' || (attempts + 1)::text
            ELSE idempotency_key
          END
        WHERE report_id = ${id}::uuid AND audience = ${audience}
          AND (
            status = 'pending'
            OR (status = 'failed' AND (last_attempt_at IS NULL OR last_attempt_at > now() - interval '24 hours'))
            OR (status = 'failed' AND last_attempt_at <= now() - interval '24 hours')
            OR (status = 'ambiguous' AND (last_attempt_at > now() - interval '24 hours' OR ${confirmAmbiguousAfter24h}))
            OR (status = 'sending' AND lease_until <= now() AND last_attempt_at > now() - interval '24 hours')
          )
        RETURNING audience, recipient, payload, idempotency_key, attempts`;
      const row = rows[0] as Record<string, unknown> | undefined;
      if (row) {
        const payload = jsonValue<ResendPayload>(row.payload, { from: "", to: [], subject: "", html: "", text: "" });
        return {
          status: "claimed",
          email: {
            audience: row.audience as EmailAudience,
            recipient: stringValue(row.recipient),
            payload,
            idempotencyKey: stringValue(row.idempotency_key),
            initialStatus: "pending",
            initialError: null,
            attempts: Number(row.attempts),
          },
        };
      }
      const current = await sql`
        SELECT status FROM kip_feedback.email_deliveries
        WHERE report_id = ${id}::uuid AND audience = ${audience} LIMIT 1`;
      const status = current[0] ? stringValue((current[0] as Record<string, unknown>).status) : "missing";
      if (status === "sent" || status === "disabled" || status === "sending" || status === "pending" || status === "failed" || status === "ambiguous") {
        return { status };
      }
      return { status: "missing" };
    },
    async markEmailDisabled(id, audience) {
      await sql`
        UPDATE kip_feedback.email_deliveries SET status = 'disabled', last_error = NULL, updated_at = now()
        WHERE report_id = ${id}::uuid AND audience = ${audience} AND status IN ('pending', 'failed')`;
    },
    async finishEmail(id, audience, leaseToken, state, error, providerMessageId = null) {
      await sql`
        UPDATE kip_feedback.email_deliveries SET status = ${state}, lease_token = NULL, lease_until = NULL,
          last_error = ${error}, sent_at = CASE WHEN ${state} = 'sent' THEN now() ELSE sent_at END,
          provider_message_id = CASE WHEN ${state} = 'sent' THEN ${providerMessageId} ELSE provider_message_id END,
          updated_at = now()
        WHERE report_id = ${id}::uuid AND audience = ${audience} AND status = 'sending' AND lease_token = ${leaseToken}::uuid`;
    },
    async consumeLoginRateLimit(ipHash) {
      const rows = await sql`
        INSERT INTO kip_feedback.rate_limits (bucket, subject_hash, window_started_at, hit_count)
        VALUES ('operator_login_ip', ${ipHash}, now(), 1)
        ON CONFLICT (bucket, subject_hash) DO UPDATE SET
          window_started_at = CASE
            WHEN kip_feedback.rate_limits.window_started_at <= now() - interval '15 minutes' THEN now()
            ELSE kip_feedback.rate_limits.window_started_at
          END,
          hit_count = CASE
            WHEN kip_feedback.rate_limits.window_started_at <= now() - interval '15 minutes' THEN 1
            ELSE kip_feedback.rate_limits.hit_count + 1
          END,
          updated_at = now()
        RETURNING hit_count <= 8 AS allowed`;
      return rows[0]?.allowed === true;
    },
  };
}

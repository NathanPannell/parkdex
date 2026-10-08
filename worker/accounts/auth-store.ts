import { database } from "../db.js";

export type AccountProvider = "email" | "google";
export type AuthTransport = "cookie" | "bearer";
export type StoredTransport = "web" | "native";

export interface AccountSummary {
  id: string;
  email: string;
  emailVerified: boolean;
  displayName: string | null;
  providers: AccountProvider[];
}

export interface AccountCredentials extends AccountSummary {
  passwordHash: string | null;
  deletionState: "active" | "deleting";
}

export interface StoredSession extends AccountSummary {
  sessionId: string;
  tokenHash: string;
  csrfHash: string | null;
  transport: StoredTransport;
  expiresAt: string;
  absoluteExpiresAt: string;
  reauthenticatedAt: string | null;
}

export interface SessionInsert {
  id: string;
  tokenHash: string;
  csrfHash: string | null;
  transport: StoredTransport;
  expiresAt: string;
  absoluteExpiresAt: string;
}

export interface CreateAccountInput {
  accountId: string;
  email: string;
  passwordHash: string;
  displayName: string | null;
  session: SessionInsert;
  verificationTokenHash: string | null;
  verificationExpiresAt: string | null;
}

export interface GoogleChallengeInput {
  nonceHash: string;
  purpose: "sign_in" | "reauth" | "link";
  transport: StoredTransport;
  accountId: string | null;
  sessionId: string | null;
  expiresAt: string;
}

export interface GoogleChallengeRecord {
  purpose: "sign_in" | "reauth" | "link";
  transport: StoredTransport;
  accountId: string | null;
  sessionId: string | null;
}

export interface GoogleSignInInput {
  subject: string;
  email: string;
  displayName: string | null;
  accountId: string;
  session: SessionInsert;
  now: string;
}

export type GoogleSignInResult =
  | { status: "ok"; account: AccountSummary; sessionId: string; expiresAt: string; absoluteExpiresAt: string }
  | { status: "email_conflict" | "account_unavailable" | "retry" };

export type GoogleLinkResult = "ok" | "email_conflict" | "subject_conflict" | "retry";

export interface DeletionReceipt {
  receiptId: string;
  accountId: string;
  status: "pending" | "complete";
}

export interface AccountAuthStore {
  reserveRateLimit(action: string, scopeHash: string, limit: number, windowMs: number): Promise<{ allowed: boolean; retryAfterSeconds: number }>;
  clearRateLimit(action: string, scopeHash: string): Promise<void>;
  recordSecurityEvent(eventType: string, scopeHash: string | null, outcome: string): Promise<void>;
  createAccount(input: CreateAccountInput): Promise<{ account: AccountSummary; sessionId: string; expiresAt: string; absoluteExpiresAt: string } | null>;
  findAccountByEmail(email: string): Promise<AccountCredentials | null>;
  findAccountById(accountId: string): Promise<AccountCredentials | null>;
  createSession(accountId: string, session: SessionInsert): Promise<{ account: AccountSummary; sessionId: string; expiresAt: string; absoluteExpiresAt: string } | null>;
  findSession(tokenHash: string): Promise<StoredSession | null>;
  rotateSession(sessionId: string, previousTokenHash: string, session: SessionInsert, now: string): Promise<string | null>;
  revokeSession(sessionId: string, tokenHash: string, now: string): Promise<boolean>;
  issueActionToken(accountId: string, purpose: "verification" | "password_reset", tokenHash: string, expiresAt: string): Promise<boolean>;
  hasValidActionToken(tokenHash: string, purpose: "verification" | "password_reset", now: string): Promise<boolean>;
  consumeVerificationToken(tokenHash: string, now: string): Promise<boolean>;
  consumePasswordResetToken(tokenHash: string, passwordHash: string, now: string): Promise<boolean>;
  createGoogleChallenge(input: GoogleChallengeInput): Promise<void>;
  consumeGoogleChallenge(nonceHash: string, now: string): Promise<GoogleChallengeRecord | null>;
  completeGoogleSignIn(input: GoogleSignInInput): Promise<GoogleSignInResult>;
  completeGoogleReauthentication(input: { subject: string; accountId: string; sessionId: string; tokenHash: string; now: string }): Promise<boolean>;
  completeGoogleLink(input: { subject: string; email: string; accountId: string; sessionId: string; tokenHash: string; now: string }): Promise<GoogleLinkResult>;
  confirmPasswordReauthentication(accountId: string, sessionId: string, tokenHash: string, now: string): Promise<boolean>;
  beginDeletion(accountId: string, sessionId: string, tokenHash: string, receiptId: string, now: string): Promise<string | null>;
  findDeletionReceipt(receiptId: string): Promise<DeletionReceipt | null>;
  completeDeletion(receiptId: string, now: string): Promise<boolean>;
  purgeRetention(now: string, auditCutoff: string, rateLimitCutoff: string, batchLimit: number): Promise<{ deleted: number; remainingExpired: number }>;
}

type Row = Record<string, unknown>;

const ACCOUNT_COLUMNS = `
  a.id::text AS account_id,
  a.normalized_email AS email,
  (a.email_verified_at IS NOT NULL) AS email_verified,
  a.display_name,
  COALESCE((
    SELECT json_agg(p.provider ORDER BY p.provider)
    FROM (
      SELECT 'email'::text AS provider WHERE a.password_hash IS NOT NULL
      UNION
      SELECT g.provider FROM kip_account.google_identities g WHERE g.account_id = a.id
    ) p
  ), '[]'::json) AS providers`;

function stringValue(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" ? value.trim() : "";
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : stringValue(value);
}

function accountSummary(row: Row): AccountSummary {
  let rawProviders = row.providers;
  if (typeof rawProviders === "string") {
    try { rawProviders = JSON.parse(rawProviders) as unknown; } catch { rawProviders = []; }
  }
  const providers = Array.isArray(rawProviders)
    ? rawProviders.filter((value): value is AccountProvider => value === "email" || value === "google")
    : [];
  return {
    id: stringValue(row.account_id ?? row.id),
    email: stringValue(row.email),
    emailVerified: row.email_verified === true,
    displayName: nullableString(row.display_name),
    providers: [...new Set(providers)],
  };
}

function credentials(row: Row): AccountCredentials {
  return {
    ...accountSummary(row),
    passwordHash: nullableString(row.password_hash),
    deletionState: row.deletion_state === "deleting" ? "deleting" : "active",
  };
}

function createdSession(row: Row): { account: AccountSummary; sessionId: string; expiresAt: string; absoluteExpiresAt: string } {
  return {
    account: accountSummary(row),
    sessionId: stringValue(row.session_id),
    expiresAt: stringValue(row.expires_at),
    absoluteExpiresAt: stringValue(row.absolute_expires_at),
  };
}

export function createNeonAccountAuthStore(databaseUrl: string): AccountAuthStore {
  const sql = database(databaseUrl);
  const query = async (text: string, params: unknown[] = []): Promise<Row[]> =>
    await sql.query(text, params) as unknown as Row[];

  return {
    async reserveRateLimit(action, scopeHash, limit, windowMs) {
      const rows = await query(`
        WITH attempted AS (
          INSERT INTO kip_account.rate_limits (action, scope_hash, window_started_at, attempt_count)
          VALUES ($1, $2, now(), 1)
          ON CONFLICT (action, scope_hash) DO UPDATE SET
            attempt_count = CASE
              WHEN kip_account.rate_limits.window_started_at <= now() - ($4::double precision * interval '1 millisecond') THEN 1
              ELSE kip_account.rate_limits.attempt_count + 1
            END,
            window_started_at = CASE
              WHEN kip_account.rate_limits.window_started_at <= now() - ($4::double precision * interval '1 millisecond') THEN now()
              ELSE kip_account.rate_limits.window_started_at
            END,
            updated_at = now()
          WHERE kip_account.rate_limits.window_started_at <= now() - ($4::double precision * interval '1 millisecond')
             OR kip_account.rate_limits.attempt_count < $3
          RETURNING window_started_at
        )
        SELECT EXISTS(SELECT 1 FROM attempted) AS allowed,
          GREATEST(1, CEIL(EXTRACT(EPOCH FROM (
            COALESCE(
              (SELECT window_started_at FROM attempted),
              (SELECT window_started_at FROM kip_account.rate_limits WHERE action = $1 AND scope_hash = $2)
            ) + ($4::double precision * interval '1 millisecond') - now()
          )))::integer) AS retry_after_seconds`, [action, scopeHash, limit, windowMs]);
      return { allowed: rows[0]?.allowed === true, retryAfterSeconds: Number(rows[0]?.retry_after_seconds ?? 1) };
    },

    async clearRateLimit(action, scopeHash) {
      await query("DELETE FROM kip_account.rate_limits WHERE action = $1 AND scope_hash = $2", [action, scopeHash]);
    },

    async recordSecurityEvent(eventType, scopeHash, outcome) {
      await query(`
        INSERT INTO kip_account.security_events (id, event_type, scope_hash, outcome)
        VALUES ($1::uuid, $2, $3, $4)`, [crypto.randomUUID(), eventType, scopeHash, outcome]);
    },

    async createAccount(input) {
      const rows = await query(`
        WITH created_account AS (
          INSERT INTO kip_account.accounts (id, normalized_email, password_hash, display_name)
          VALUES ($1::uuid, $2, $3, $4)
          ON CONFLICT (normalized_email) DO NOTHING
          RETURNING id, normalized_email, display_name, email_verified_at, password_hash
        ),
        created_session AS (
          INSERT INTO kip_account.sessions (
            id, account_id, token_hash, csrf_hash, transport, expires_at, absolute_expires_at
          )
          SELECT $5::uuid, id, $6, $7, $8, $9::timestamptz, $10::timestamptz
          FROM created_account
          RETURNING id AS session_id, account_id, expires_at, absolute_expires_at
        ),
        created_action AS (
          INSERT INTO kip_account.action_tokens (token_hash, account_id, purpose, expires_at)
          SELECT $11::char(64), id, 'verification', $12::timestamptz
          FROM created_account
          WHERE $11::char(64) IS NOT NULL
          RETURNING account_id
        )
        SELECT c.id::text AS account_id, c.normalized_email AS email,
          (c.email_verified_at IS NOT NULL) AS email_verified, c.display_name,
          json_build_array('email') AS providers,
          s.session_id::text AS session_id, s.expires_at, s.absolute_expires_at
        FROM created_account c
        JOIN created_session s ON s.account_id = c.id`, [
        input.accountId, input.email, input.passwordHash, input.displayName,
        input.session.id, input.session.tokenHash, input.session.csrfHash, input.session.transport,
        input.session.expiresAt, input.session.absoluteExpiresAt,
        input.verificationTokenHash, input.verificationExpiresAt,
      ]);
      return rows[0] ? createdSession(rows[0]) : null;
    },

    async findAccountByEmail(email) {
      const rows = await query(`
        SELECT ${ACCOUNT_COLUMNS}, a.password_hash, a.deletion_state
        FROM kip_account.accounts a
        WHERE a.normalized_email = $1
        LIMIT 1`, [email]);
      return rows[0] ? credentials(rows[0]) : null;
    },

    async findAccountById(accountId) {
      const rows = await query(`
        SELECT ${ACCOUNT_COLUMNS}, a.password_hash, a.deletion_state
        FROM kip_account.accounts a
        WHERE a.id = $1::uuid
        LIMIT 1`, [accountId]);
      return rows[0] ? credentials(rows[0]) : null;
    },

    async createSession(accountId, session) {
      const rows = await query(`
        WITH created_session AS (
          INSERT INTO kip_account.sessions (
            id, account_id, token_hash, csrf_hash, transport, expires_at, absolute_expires_at
          )
          SELECT $1::uuid, a.id, $2, $3, $4, $5::timestamptz, $6::timestamptz
          FROM kip_account.accounts a
          WHERE a.id = $7::uuid AND a.deletion_state = 'active'
          RETURNING id AS session_id, account_id, expires_at, absolute_expires_at
        )
        SELECT ${ACCOUNT_COLUMNS}, s.session_id::text AS session_id, s.expires_at, s.absolute_expires_at
        FROM created_session s
        JOIN kip_account.accounts a ON a.id = s.account_id`, [
        session.id, session.tokenHash, session.csrfHash, session.transport,
        session.expiresAt, session.absoluteExpiresAt, accountId,
      ]);
      return rows[0] ? createdSession(rows[0]) : null;
    },

    async findSession(tokenHash) {
      const rows = await query(`
        SELECT ${ACCOUNT_COLUMNS}, s.id::text AS session_id, s.token_hash, s.csrf_hash, s.transport,
          s.expires_at, s.absolute_expires_at, s.reauthenticated_at
        FROM kip_account.sessions s
        JOIN kip_account.accounts a ON a.id = s.account_id
        WHERE s.token_hash = $1
          AND s.revoked_at IS NULL
          AND s.expires_at > now()
          AND s.absolute_expires_at > now()
          AND a.deletion_state = 'active'
        LIMIT 1`, [tokenHash]);
      if (!rows[0]) return null;
      const row = rows[0];
      return {
        ...accountSummary(row),
        sessionId: stringValue(row.session_id),
        tokenHash: stringValue(row.token_hash),
        csrfHash: nullableString(row.csrf_hash),
        transport: row.transport === "native" ? "native" : "web",
        expiresAt: stringValue(row.expires_at),
        absoluteExpiresAt: stringValue(row.absolute_expires_at),
        reauthenticatedAt: nullableString(row.reauthenticated_at),
      };
    },

    async rotateSession(sessionId, previousTokenHash, session, now) {
      const rows = await query(`
        UPDATE kip_account.sessions s SET
          token_hash = $3,
          csrf_hash = $4,
          transport = $5,
          expires_at = LEAST($6::timestamptz, s.absolute_expires_at)
        FROM kip_account.accounts a
        WHERE s.id = $1::uuid
          AND s.token_hash = $2
          AND s.account_id = a.id
          AND s.revoked_at IS NULL
          AND s.expires_at > $7::timestamptz
          AND s.absolute_expires_at > $7::timestamptz
          AND s.expires_at <= $7::timestamptz + interval '7 days'
          AND a.deletion_state = 'active'
        RETURNING s.expires_at`, [
        sessionId, previousTokenHash, session.tokenHash, session.csrfHash, session.transport,
        session.expiresAt, now,
      ]);
      return rows[0] ? stringValue(rows[0].expires_at) : null;
    },

    async revokeSession(sessionId, tokenHash, now) {
      const rows = await query(`
        UPDATE kip_account.sessions
        SET revoked_at = $3::timestamptz
        WHERE id = $1::uuid AND token_hash = $2 AND revoked_at IS NULL
        RETURNING id`, [sessionId, tokenHash, now]);
      return rows.length > 0;
    },

    async issueActionToken(accountId, purpose, tokenHash, expiresAt) {
      const rows = await query(`
        WITH target AS MATERIALIZED (
          SELECT id FROM kip_account.accounts
          WHERE id = $1::uuid AND deletion_state = 'active'
            AND ($2::text <> 'password_reset' OR password_hash IS NOT NULL)
          FOR UPDATE
        ),
        retired AS (
          UPDATE kip_account.action_tokens SET used_at = now()
          WHERE account_id IN (SELECT id FROM target) AND purpose = $2 AND used_at IS NULL
          RETURNING token_hash
        ),
        issued AS (
          INSERT INTO kip_account.action_tokens (token_hash, account_id, purpose, expires_at)
          SELECT $3, id, $2, $4::timestamptz FROM target
          RETURNING account_id
        )
        SELECT EXISTS(SELECT 1 FROM issued) AS issued`, [accountId, purpose, tokenHash, expiresAt]);
      return rows[0]?.issued === true;
    },

    async hasValidActionToken(tokenHash, purpose, now) {
      const rows = await query(`
        SELECT EXISTS (
          SELECT 1 FROM kip_account.action_tokens t
          JOIN kip_account.accounts a ON a.id = t.account_id
          WHERE t.token_hash = $1 AND t.purpose = $2 AND t.used_at IS NULL
            AND t.expires_at > $3::timestamptz AND a.deletion_state = 'active'
        ) AS valid`, [tokenHash, purpose, now]);
      return rows[0]?.valid === true;
    },

    async consumeVerificationToken(tokenHash, now) {
      const rows = await query(`
        WITH consumed AS (
          UPDATE kip_account.action_tokens t SET used_at = $2::timestamptz
          FROM kip_account.accounts a
          WHERE t.token_hash = $1 AND t.purpose = 'verification' AND t.used_at IS NULL
            AND t.expires_at > $2::timestamptz AND t.account_id = a.id AND a.deletion_state = 'active'
          RETURNING t.account_id
        ), verified AS (
          UPDATE kip_account.accounts a SET email_verified_at = COALESCE(a.email_verified_at, $2::timestamptz), updated_at = $2::timestamptz
          WHERE a.id IN (SELECT account_id FROM consumed)
          RETURNING a.id
        )
        SELECT EXISTS(SELECT 1 FROM verified) AS confirmed`, [tokenHash, now]);
      return rows[0]?.confirmed === true;
    },

    async consumePasswordResetToken(tokenHash, passwordHash, now) {
      const rows = await query(`
        WITH consumed AS (
          UPDATE kip_account.action_tokens t SET used_at = $3::timestamptz
          FROM kip_account.accounts a
          WHERE t.token_hash = $1 AND t.purpose = 'password_reset' AND t.used_at IS NULL
            AND t.expires_at > $3::timestamptz AND t.account_id = a.id AND a.deletion_state = 'active'
            AND a.password_hash IS NOT NULL
          RETURNING t.account_id
        ), updated AS (
          UPDATE kip_account.accounts a SET password_hash = $2, updated_at = $3::timestamptz
          WHERE a.id IN (SELECT account_id FROM consumed) AND a.deletion_state = 'active'
          RETURNING a.id
        ), revoked AS (
          UPDATE kip_account.sessions s SET revoked_at = $3::timestamptz
          WHERE s.account_id IN (SELECT id FROM updated) AND s.revoked_at IS NULL
          RETURNING s.id
        )
        SELECT EXISTS(SELECT 1 FROM updated) AS confirmed`, [tokenHash, passwordHash, now]);
      return rows[0]?.confirmed === true;
    },

    async createGoogleChallenge(input) {
      await query(`
        INSERT INTO kip_account.google_challenges (nonce_hash, purpose, transport, account_id, session_id, expires_at)
        VALUES ($1, $2, $3, $4::uuid, $5::uuid, $6::timestamptz)`, [
        input.nonceHash, input.purpose, input.transport, input.accountId, input.sessionId, input.expiresAt,
      ]);
    },

    async consumeGoogleChallenge(nonceHash, now) {
      const rows = await query(`
        UPDATE kip_account.google_challenges SET consumed_at = $2::timestamptz
        WHERE nonce_hash = $1 AND consumed_at IS NULL AND expires_at > $2::timestamptz
        RETURNING purpose, transport, account_id::text AS account_id, session_id::text AS session_id`, [nonceHash, now]);
      if (!rows[0]) return null;
      const row = rows[0];
      return {
        purpose: row.purpose as GoogleChallengeRecord["purpose"],
        transport: row.transport === "native" ? "native" : "web",
        accountId: nullableString(row.account_id),
        sessionId: nullableString(row.session_id),
      };
    },

    async completeGoogleSignIn(input) {
      const params = [
        input.subject, input.email, input.accountId, input.displayName,
        input.session.id, input.session.tokenHash, input.session.csrfHash, input.session.transport,
        input.session.expiresAt, input.session.absoluteExpiresAt, input.now,
      ];
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const rows = await query(`
          WITH subject_lock AS MATERIALIZED (
            SELECT pg_advisory_xact_lock(hashtextextended('kip-google-sub:' || $1, 0))
          ),
          email_lock AS MATERIALIZED (
            SELECT pg_advisory_xact_lock(hashtextextended('kip-account-email:' || $2, 0)) FROM subject_lock
          ),
          existing_identity AS MATERIALIZED (
            SELECT a.id, a.deletion_state, ${ACCOUNT_COLUMNS}
            FROM kip_account.google_identities g
            JOIN kip_account.accounts a ON a.id = g.account_id
            WHERE g.provider = 'google' AND g.subject = $1
              AND EXISTS (SELECT 1 FROM email_lock)
          ),
          email_collision AS MATERIALIZED (
            SELECT a.id FROM kip_account.accounts a
            WHERE a.normalized_email = $2 AND NOT EXISTS (SELECT 1 FROM existing_identity)
              AND EXISTS (SELECT 1 FROM email_lock)
          ),
          created_account AS (
            INSERT INTO kip_account.accounts (id, normalized_email, display_name, email_verified_at)
            SELECT $3::uuid, $2, $4, $11::timestamptz
            WHERE NOT EXISTS (SELECT 1 FROM existing_identity)
              AND NOT EXISTS (SELECT 1 FROM email_collision)
            ON CONFLICT (normalized_email) DO NOTHING
            RETURNING id, normalized_email, display_name, email_verified_at
          ),
          created_identity AS (
            INSERT INTO kip_account.google_identities (provider, subject, account_id)
            SELECT 'google', $1, id FROM created_account
            ON CONFLICT (provider, subject) DO NOTHING
            RETURNING account_id
          ),
          resolved AS MATERIALIZED (
            SELECT e.id FROM existing_identity e WHERE e.deletion_state = 'active'
            UNION ALL
            SELECT account_id AS id FROM created_identity
          ),
          created_session AS (
            INSERT INTO kip_account.sessions (
              id, account_id, token_hash, csrf_hash, transport, expires_at, absolute_expires_at
            )
            SELECT $5::uuid, r.id, $6, $7, $8, $9::timestamptz, $10::timestamptz
            FROM resolved r
            RETURNING id AS session_id, account_id, expires_at, absolute_expires_at
          ),
          account_data AS (
            SELECT e.account_id, e.email, e.email_verified, e.display_name, e.providers,
              s.session_id::text AS session_id, s.expires_at, s.absolute_expires_at
            FROM existing_identity e JOIN created_session s ON s.account_id = e.id
            WHERE e.deletion_state = 'active'
            UNION ALL
            SELECT c.id::text AS account_id, c.normalized_email AS email,
              (c.email_verified_at IS NOT NULL) AS email_verified, c.display_name,
              json_build_array('google') AS providers,
              s.session_id::text AS session_id, s.expires_at, s.absolute_expires_at
            FROM created_account c
            JOIN created_identity g ON g.account_id = c.id
            JOIN created_session s ON s.account_id = c.id
          )
          SELECT CASE
            WHEN EXISTS (SELECT 1 FROM account_data) THEN 'ok'
            WHEN EXISTS (SELECT 1 FROM existing_identity) THEN 'account_unavailable'
            WHEN EXISTS (SELECT 1 FROM email_collision) THEN 'email_conflict'
            WHEN EXISTS (SELECT 1 FROM created_account) AND NOT EXISTS (SELECT 1 FROM created_identity) THEN 'retry'
            ELSE 'retry'
          END AS status,
          (SELECT to_jsonb(account_data) FROM account_data LIMIT 1) AS result`, params);
        const row = rows[0];
        if (!row) return { status: "retry" };
        const status = stringValue(row.status);
        if (status === "ok" && row.result && typeof row.result === "object") {
          const result = row.result as Row;
          const summary = accountSummary(result);
          return {
            status: "ok",
            account: summary,
            sessionId: stringValue(result.session_id),
            expiresAt: stringValue(result.expires_at),
            absoluteExpiresAt: stringValue(result.absolute_expires_at),
          };
        }
        if (status !== "retry") return { status: status as "email_conflict" | "account_unavailable" };
        await query(`
          DELETE FROM kip_account.accounts a
          WHERE a.id = $1::uuid AND a.password_hash IS NULL
            AND NOT EXISTS (SELECT 1 FROM kip_account.google_identities g WHERE g.account_id = a.id)
            AND NOT EXISTS (SELECT 1 FROM kip_account.sessions s WHERE s.account_id = a.id)`, [input.accountId]);
      }
      return { status: "retry" };
    },

    async completeGoogleReauthentication(input) {
      const rows = await query(`
        WITH identity AS MATERIALIZED (
          SELECT a.id FROM kip_account.google_identities g
          JOIN kip_account.accounts a ON a.id = g.account_id
          WHERE g.provider = 'google' AND g.subject = $1 AND a.id = $2::uuid AND a.deletion_state = 'active'
        ), updated AS (
          UPDATE kip_account.sessions s SET reauthenticated_at = $5::timestamptz
          FROM identity i, kip_account.accounts a
          WHERE s.id = $3::uuid AND s.token_hash = $4 AND s.account_id = i.id AND a.id = s.account_id
            AND a.deletion_state = 'active' AND s.revoked_at IS NULL AND s.expires_at > $5::timestamptz
            AND s.absolute_expires_at > $5::timestamptz
          RETURNING s.id
        )
        SELECT EXISTS(SELECT 1 FROM updated) AS confirmed`, [
        input.subject, input.accountId, input.sessionId, input.tokenHash, input.now,
      ]);
      return rows[0]?.confirmed === true;
    },

    async completeGoogleLink(input) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const rows = await query(`
          WITH subject_lock AS MATERIALIZED (
            SELECT pg_advisory_xact_lock(hashtextextended('kip-google-sub:' || $1, 0))
          ),
          email_lock AS MATERIALIZED (
            SELECT pg_advisory_xact_lock(hashtextextended('kip-account-email:' || $2, 0)) FROM subject_lock
          ),
          target AS MATERIALIZED (
            SELECT a.id, a.deletion_state FROM kip_account.accounts a
            JOIN kip_account.sessions s ON s.account_id = a.id
            WHERE a.id = $3::uuid AND s.id = $4::uuid AND s.token_hash = $5
              AND a.deletion_state = 'active' AND s.revoked_at IS NULL
              AND s.expires_at > $6::timestamptz AND s.absolute_expires_at > $6::timestamptz
              AND s.reauthenticated_at >= $6::timestamptz - interval '5 minutes'
              AND EXISTS (SELECT 1 FROM email_lock)
          ),
          existing_subject AS MATERIALIZED (
            SELECT account_id FROM kip_account.google_identities
            WHERE provider = 'google' AND subject = $1
          ),
          email_owner AS MATERIALIZED (
            SELECT id FROM kip_account.accounts WHERE normalized_email = $2
          ),
          inserted AS (
            INSERT INTO kip_account.google_identities (provider, subject, account_id)
            SELECT 'google', $1, t.id FROM target t
            WHERE NOT EXISTS (SELECT 1 FROM existing_subject)
              AND (NOT EXISTS (SELECT 1 FROM email_owner) OR EXISTS (SELECT 1 FROM email_owner WHERE id = t.id))
            ON CONFLICT (provider, subject) DO NOTHING
            RETURNING account_id
          )
          SELECT CASE
            WHEN NOT EXISTS (SELECT 1 FROM target) THEN 'retry'
            WHEN EXISTS (SELECT 1 FROM existing_subject WHERE account_id = $3::uuid) THEN 'ok'
            WHEN EXISTS (SELECT 1 FROM existing_subject) THEN 'subject_conflict'
            WHEN EXISTS (SELECT 1 FROM email_owner WHERE id <> $3::uuid) THEN 'email_conflict'
            WHEN EXISTS (SELECT 1 FROM inserted) THEN 'ok'
            ELSE 'retry'
          END AS status`, [input.subject, input.email, input.accountId, input.sessionId, input.tokenHash, input.now]);
        const status = stringValue(rows[0]?.status);
        if (status !== "retry") return status as GoogleLinkResult;
      }
      return "retry";
    },

    async confirmPasswordReauthentication(accountId, sessionId, tokenHash, now) {
      const rows = await query(`
        UPDATE kip_account.sessions s SET reauthenticated_at = $4::timestamptz
        FROM kip_account.accounts a
        WHERE s.id = $2::uuid AND s.account_id = $1::uuid AND s.token_hash = $3
          AND s.account_id = a.id AND a.deletion_state = 'active'
          AND s.revoked_at IS NULL AND s.expires_at > $4::timestamptz AND s.absolute_expires_at > $4::timestamptz
        RETURNING s.id`, [accountId, sessionId, tokenHash, now]);
      return rows.length > 0;
    },

    async beginDeletion(accountId, sessionId, tokenHash, receiptId, now) {
      const rows = await query(`
        WITH eligible AS MATERIALIZED (
          SELECT a.id FROM kip_account.accounts a
          JOIN kip_account.sessions current_session ON current_session.account_id = a.id
          WHERE a.id = $1::uuid AND current_session.id = $2::uuid AND current_session.token_hash = $3
            AND a.deletion_state = 'active' AND current_session.revoked_at IS NULL
            AND current_session.expires_at > $5::timestamptz AND current_session.absolute_expires_at > $5::timestamptz
            AND current_session.reauthenticated_at >= $5::timestamptz - interval '5 minutes'
          FOR UPDATE OF a
        ), marked AS (
          UPDATE kip_account.accounts a SET deletion_state = 'deleting', updated_at = $5::timestamptz
          WHERE a.id IN (SELECT id FROM eligible) AND a.deletion_state = 'active'
          RETURNING a.id
        ), revoked AS (
          UPDATE kip_account.sessions s SET revoked_at = $5::timestamptz
          WHERE s.account_id IN (SELECT id FROM marked) AND s.revoked_at IS NULL
          RETURNING s.id
        ), receipt AS (
          INSERT INTO kip_account.account_deletion_receipts (receipt_id, account_id)
          SELECT $4::uuid, id FROM marked
          RETURNING receipt_id, account_id
        )
        SELECT receipt_id::text AS receipt_id FROM receipt`, [accountId, sessionId, tokenHash, receiptId, now]);
      return rows[0] ? stringValue(rows[0].receipt_id) : null;
    },

    async findDeletionReceipt(receiptId) {
      const rows = await query(`
        SELECT receipt_id::text AS receipt_id, account_id::text AS account_id, status
        FROM kip_account.account_deletion_receipts WHERE receipt_id = $1::uuid LIMIT 1`, [receiptId]);
      if (!rows[0]) return null;
      return {
        receiptId: stringValue(rows[0].receipt_id),
        accountId: stringValue(rows[0].account_id),
        status: rows[0].status === "complete" ? "complete" : "pending",
      };
    },

    async completeDeletion(receiptId, now) {
      const rows = await query(`
        WITH receipt AS MATERIALIZED (
          SELECT account_id, status FROM kip_account.account_deletion_receipts
          WHERE receipt_id = $1::uuid FOR UPDATE
        ), deleted AS (
          DELETE FROM kip_account.accounts a
          WHERE a.id IN (SELECT account_id FROM receipt WHERE status = 'pending')
            AND a.deletion_state = 'deleting'
          RETURNING a.id
        ), completed AS (
          UPDATE kip_account.account_deletion_receipts r SET status = 'complete', completed_at = $2::timestamptz
          WHERE r.receipt_id = $1::uuid AND r.status = 'pending'
            AND (EXISTS (SELECT 1 FROM deleted) OR NOT EXISTS (
              SELECT 1 FROM kip_account.accounts a WHERE a.id = r.account_id
            ))
          RETURNING r.receipt_id
        )
        SELECT EXISTS(SELECT 1 FROM completed) OR EXISTS(SELECT 1 FROM receipt WHERE status = 'complete') AS complete`, [receiptId, now]);
      return rows[0]?.complete === true;
    },

    async purgeRetention(now, auditCutoff, rateLimitCutoff, batchLimit) {
      const rows = await query(`
        WITH expired_sessions AS MATERIALIZED (
          SELECT count(*)::bigint AS total FROM kip_account.sessions
          WHERE COALESCE(revoked_at, absolute_expires_at) < $2::timestamptz
        ), expired_tokens AS MATERIALIZED (
          SELECT count(*)::bigint AS total FROM kip_account.action_tokens
          WHERE expires_at < $1::timestamptz OR used_at < $1::timestamptz - interval '1 day'
        ), expired_challenges AS MATERIALIZED (
          SELECT count(*)::bigint AS total FROM kip_account.google_challenges
          WHERE expires_at < $1::timestamptz OR consumed_at < $1::timestamptz - interval '1 day'
        ), expired_events AS MATERIALIZED (
          SELECT count(*)::bigint AS total FROM kip_account.security_events WHERE created_at < $2::timestamptz
        ), expired_limits AS MATERIALIZED (
          SELECT count(*)::bigint AS total FROM kip_account.rate_limits WHERE updated_at < $3::timestamptz
        ), old_sessions AS MATERIALIZED (
          SELECT ctid FROM kip_account.sessions
          WHERE COALESCE(revoked_at, absolute_expires_at) < $2::timestamptz
          ORDER BY COALESCE(revoked_at, absolute_expires_at), ctid
          LIMIT $4::integer
        ), deleted_sessions AS (
          DELETE FROM kip_account.sessions s USING old_sessions o WHERE s.ctid = o.ctid RETURNING 1
        ), old_tokens AS MATERIALIZED (
          SELECT ctid FROM kip_account.action_tokens
          WHERE expires_at < $1::timestamptz OR used_at < $1::timestamptz - interval '1 day'
          ORDER BY LEAST(expires_at, COALESCE(used_at, expires_at)), ctid
          LIMIT $4::integer
        ), deleted_tokens AS (
          DELETE FROM kip_account.action_tokens t USING old_tokens o WHERE t.ctid = o.ctid RETURNING 1
        ), old_challenges AS MATERIALIZED (
          SELECT ctid FROM kip_account.google_challenges
          WHERE expires_at < $1::timestamptz OR consumed_at < $1::timestamptz - interval '1 day'
          ORDER BY LEAST(expires_at, COALESCE(consumed_at, expires_at)), ctid
          LIMIT $4::integer
        ), deleted_challenges AS (
          DELETE FROM kip_account.google_challenges c USING old_challenges o WHERE c.ctid = o.ctid RETURNING 1
        ), old_events AS MATERIALIZED (
          SELECT ctid FROM kip_account.security_events
          WHERE created_at < $2::timestamptz
          ORDER BY created_at, ctid
          LIMIT $4::integer
        ), deleted_events AS (
          DELETE FROM kip_account.security_events e USING old_events o WHERE e.ctid = o.ctid RETURNING 1
        ), old_limits AS MATERIALIZED (
          SELECT ctid FROM kip_account.rate_limits
          WHERE updated_at < $3::timestamptz
          ORDER BY updated_at, ctid
          LIMIT $4::integer
        ), deleted_limits AS (
          DELETE FROM kip_account.rate_limits l USING old_limits o WHERE l.ctid = o.ctid RETURNING 1
        )
        SELECT
          (SELECT count(*) FROM deleted_sessions) + (SELECT count(*) FROM deleted_tokens) +
          (SELECT count(*) FROM deleted_challenges) + (SELECT count(*) FROM deleted_events) +
          (SELECT count(*) FROM deleted_limits) AS deleted,
          GREATEST((SELECT total FROM expired_sessions) - (SELECT count(*) FROM deleted_sessions), 0) +
          GREATEST((SELECT total FROM expired_tokens) - (SELECT count(*) FROM deleted_tokens), 0) +
          GREATEST((SELECT total FROM expired_challenges) - (SELECT count(*) FROM deleted_challenges), 0) +
          GREATEST((SELECT total FROM expired_events) - (SELECT count(*) FROM deleted_events), 0) +
          GREATEST((SELECT total FROM expired_limits) - (SELECT count(*) FROM deleted_limits), 0) AS remaining_expired`, [now, auditCutoff, rateLimitCutoff, batchLimit]);
      return {
        deleted: Number(rows[0]?.deleted ?? 0),
        remainingExpired: Number(rows[0]?.remaining_expired ?? 0),
      };
    },
  };
}

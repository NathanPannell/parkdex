CREATE SCHEMA IF NOT EXISTS kip_account;

CREATE TABLE IF NOT EXISTS kip_account.accounts (
  id uuid PRIMARY KEY,
  normalized_email text NOT NULL UNIQUE
    CHECK (length(normalized_email) BETWEEN 3 AND 254)
    CHECK (normalized_email = lower(normalized_email)),
  password_hash text,
  display_name text
    CHECK (display_name IS NULL OR length(display_name) BETWEEN 1 AND 80),
  email_verified_at timestamptz,
  deletion_state text NOT NULL DEFAULT 'active'
    CHECK (deletion_state IN ('active', 'deleting')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (password_hash IS NULL OR length(password_hash) <= 512)
);

CREATE TABLE IF NOT EXISTS kip_account.google_identities (
  provider text NOT NULL DEFAULT 'google' CHECK (provider = 'google'),
  subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 255),
  account_id uuid NOT NULL REFERENCES kip_account.accounts(id) ON DELETE CASCADE,
  linked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, subject)
);

CREATE INDEX IF NOT EXISTS google_identities_account_idx
  ON kip_account.google_identities (account_id, provider);

CREATE TABLE IF NOT EXISTS kip_account.sessions (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES kip_account.accounts(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  csrf_hash char(64) CHECK (csrf_hash IS NULL OR csrf_hash ~ '^[0-9a-f]{64}$'),
  transport text NOT NULL CHECK (transport IN ('web', 'native')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  reauthenticated_at timestamptz,
  revoked_at timestamptz,
  CHECK (expires_at <= absolute_expires_at),
  CHECK ((transport = 'web') = (csrf_hash IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS sessions_account_active_idx
  ON kip_account.sessions (account_id, expires_at)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS sessions_retention_absolute_idx
  ON kip_account.sessions (absolute_expires_at);

CREATE INDEX IF NOT EXISTS sessions_retention_revoked_idx
  ON kip_account.sessions (revoked_at)
  WHERE revoked_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS kip_account.action_tokens (
  token_hash char(64) PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  account_id uuid NOT NULL REFERENCES kip_account.accounts(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('verification', 'password_reset')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);

CREATE INDEX IF NOT EXISTS action_tokens_account_purpose_idx
  ON kip_account.action_tokens (account_id, purpose, expires_at)
  WHERE used_at IS NULL;

CREATE INDEX IF NOT EXISTS action_tokens_expiry_idx
  ON kip_account.action_tokens (expires_at);

CREATE INDEX IF NOT EXISTS action_tokens_used_idx
  ON kip_account.action_tokens (used_at)
  WHERE used_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS kip_account.google_challenges (
  nonce_hash char(64) PRIMARY KEY CHECK (nonce_hash ~ '^[0-9a-f]{64}$'),
  purpose text NOT NULL CHECK (purpose IN ('sign_in', 'reauth', 'link')),
  transport text NOT NULL CHECK (transport IN ('web', 'native')),
  account_id uuid REFERENCES kip_account.accounts(id) ON DELETE CASCADE,
  session_id uuid REFERENCES kip_account.sessions(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CHECK ((purpose = 'sign_in') = (account_id IS NULL AND session_id IS NULL)),
  CHECK ((account_id IS NULL) = (session_id IS NULL))
);

CREATE INDEX IF NOT EXISTS google_challenges_session_idx
  ON kip_account.google_challenges (session_id, expires_at)
  WHERE consumed_at IS NULL;

CREATE INDEX IF NOT EXISTS google_challenges_expiry_idx
  ON kip_account.google_challenges (expires_at);

CREATE INDEX IF NOT EXISTS google_challenges_consumed_idx
  ON kip_account.google_challenges (consumed_at)
  WHERE consumed_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS kip_account.rate_limits (
  action text NOT NULL CHECK (length(action) BETWEEN 1 AND 48),
  scope_hash char(64) NOT NULL CHECK (scope_hash ~ '^[0-9a-f]{64}$'),
  window_started_at timestamptz NOT NULL,
  attempt_count integer NOT NULL CHECK (attempt_count > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (action, scope_hash)
);

CREATE INDEX IF NOT EXISTS rate_limits_updated_idx
  ON kip_account.rate_limits (updated_at);

CREATE TABLE IF NOT EXISTS kip_account.security_events (
  id uuid PRIMARY KEY,
  event_type text NOT NULL CHECK (length(event_type) BETWEEN 1 AND 48),
  scope_hash char(64) CHECK (scope_hash IS NULL OR scope_hash ~ '^[0-9a-f]{64}$'),
  outcome text NOT NULL CHECK (length(outcome) BETWEEN 1 AND 48),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS security_events_created_idx
  ON kip_account.security_events (created_at DESC);

CREATE TABLE IF NOT EXISTS kip_account.account_deletion_receipts (
  receipt_id uuid PRIMARY KEY,
  account_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'complete')),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK ((status = 'complete') = (completed_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS one_pending_account_deletion_idx
  ON kip_account.account_deletion_receipts (account_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS pending_account_deletions_idx
  ON kip_account.account_deletion_receipts (created_at)
  WHERE status = 'pending';

ALTER TABLE accounts
    ALTER COLUMN password_hash DROP NOT NULL,
    ADD COLUMN email_verified_at TIMESTAMPTZ;

CREATE TABLE account_action_tokens (
    token_hash CHAR(64) PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    purpose TEXT NOT NULL CHECK (purpose IN ('password_reset', 'email_verification')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    CHECK (expires_at > created_at)
);

CREATE INDEX account_action_tokens_account_purpose_idx
    ON account_action_tokens (account_id, purpose, expires_at);

CREATE TABLE account_oauth_identities (
    provider TEXT NOT NULL CHECK (provider = 'google'),
    subject TEXT NOT NULL,
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    email_at_link TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (provider, subject),
    UNIQUE (provider, account_id)
);

CREATE TABLE oauth_authorization_states (
    state_hash CHAR(64) PRIMARY KEY CHECK (state_hash ~ '^[0-9a-f]{64}$'),
    nonce_hash CHAR(64) NOT NULL CHECK (nonce_hash ~ '^[0-9a-f]{64}$'),
    code_challenge CHAR(43) NOT NULL CHECK (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    CHECK (expires_at > created_at)
);

CREATE TABLE auth_rate_limits (
    action TEXT NOT NULL,
    scope_hash CHAR(64) NOT NULL CHECK (scope_hash ~ '^[0-9a-f]{64}$'),
    attempt_count INTEGER NOT NULL CHECK (attempt_count > 0),
    window_started_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (action, scope_hash)
);

CREATE TABLE auth_security_events (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_type TEXT NOT NULL,
    scope_hash CHAR(64) CHECK (scope_hash ~ '^[0-9a-f]{64}$'),
    outcome TEXT NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX auth_security_events_occurred_at_idx
    ON auth_security_events (occurred_at DESC);

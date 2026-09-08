CREATE TABLE accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT NOT NULL UNIQUE CHECK (
        email = LOWER(BTRIM(email)) AND CHAR_LENGTH(email) BETWEEN 3 AND 254
    ),
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE account_sessions (
    token_hash CHAR(64) PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    CHECK (expires_at > created_at)
);

CREATE INDEX account_sessions_account_id_idx ON account_sessions (account_id);
CREATE INDEX account_sessions_active_expiry_idx ON account_sessions (expires_at)
    WHERE revoked_at IS NULL;

CREATE TABLE account_visits (
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    place_id TEXT NOT NULL REFERENCES places(id) ON DELETE CASCADE,
    visited_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (account_id, place_id)
);

CREATE INDEX account_visits_account_id_idx ON account_visits (account_id);

CREATE TABLE guest_trail_completions (
    owner_hash CHAR(64) NOT NULL CHECK (owner_hash ~ '^[0-9a-f]{64}$'),
    trail_id TEXT NOT NULL CHECK (trail_id IN ('west_coast_trail', 'juan_de_fuca_trail')),
    completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (owner_hash, trail_id)
);

CREATE TABLE account_trail_completions (
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    trail_id TEXT NOT NULL CHECK (trail_id IN ('west_coast_trail', 'juan_de_fuca_trail')),
    completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (account_id, trail_id)
);

CREATE TABLE auth_login_attempts (
    scope_hash CHAR(64) PRIMARY KEY CHECK (scope_hash ~ '^[0-9a-f]{64}$'),
    failure_count INTEGER NOT NULL CHECK (failure_count > 0),
    window_started_at TIMESTAMPTZ NOT NULL,
    blocked_until TIMESTAMPTZ
);


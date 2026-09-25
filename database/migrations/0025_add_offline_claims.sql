-- Account-bound offline grants and idempotent claim receipts. Grants retain
-- only a one-way token hash. Progress reset invalidates receipts so a delayed
-- retry cannot restore cleared progress; account deletion cascades these rows.
CREATE TABLE IF NOT EXISTS offline_claim_grants (
    token_hash CHAR(64) PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    boundary_version CHAR(64) NOT NULL CHECK (boundary_version ~ '^[0-9a-f]{64}$'),
    issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    CHECK (expires_at > issued_at),
    CHECK (expires_at <= issued_at + INTERVAL '30 days')
);

CREATE INDEX IF NOT EXISTS offline_claim_grants_account_expiry_idx
    ON offline_claim_grants (account_id, expires_at);

CREATE TABLE IF NOT EXISTS offline_claim_requests (
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    request_id UUID NOT NULL,
    request_fingerprint CHAR(64) NOT NULL
        CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
    confirmation JSONB NOT NULL CHECK (jsonb_typeof(confirmation) = 'object'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    invalidated_at TIMESTAMPTZ,
    PRIMARY KEY (account_id, request_id)
);

-- Retain the latest per-place undo time so an unreceipted offline fix captured
-- before another device's undo cannot restore that visit when it syncs later.
CREATE TABLE IF NOT EXISTS offline_claim_undo_tombstones (
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    place_id TEXT NOT NULL REFERENCES places(id) ON DELETE CASCADE,
    undone_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (account_id, place_id)
);

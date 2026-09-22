-- A short-lived, non-PII receipt lets a client retry a confirmed delete when
-- the response was lost after the account and bearer session were removed.
-- The hash is derived from the bearer token and client request id; neither is
-- stored in this table.  Expired receipts are ignored by the API and may be
-- removed opportunistically by a later request.
CREATE TABLE account_deletion_receipts (
    request_hash CHAR(64) PRIMARY KEY CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    photo_cleanup_pending BOOLEAN NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    CHECK (expires_at > created_at),
    CHECK (expires_at <= created_at + INTERVAL '24 hours')
);

CREATE INDEX account_deletion_receipts_expiry_idx
    ON account_deletion_receipts (expires_at);

-- Link only the one-way receipt hash to the durable photo intent.  The link
-- lets a later receipt retry report current outbox state after manual cleanup;
-- it carries no bearer, email, or account identifier.
ALTER TABLE photo_object_deletions
    ADD COLUMN IF NOT EXISTS account_deletion_request_hash CHAR(64)
        NULL REFERENCES account_deletion_receipts(request_hash) ON DELETE SET NULL
        CHECK (
            account_deletion_request_hash IS NULL
            OR account_deletion_request_hash ~ '^[0-9a-f]{64}$'
        );

CREATE INDEX photo_object_deletions_account_deletion_receipt_idx
    ON photo_object_deletions (account_deletion_request_hash)
    WHERE account_deletion_request_hash IS NOT NULL;

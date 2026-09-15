-- Postcard bytes live only in private R2 (or an injected local test adapter).
-- Postgres stores the owner-scoped object key and normalized representation
-- metadata needed to render a card without downloading the object.
ALTER TABLE account_visit_claims
    ADD COLUMN photo_object_key TEXT,
    ADD COLUMN photo_mime TEXT,
    ADD COLUMN photo_width INTEGER,
    ADD COLUMN photo_height INTEGER,
    ADD COLUMN photo_byte_length INTEGER,
    ADD COLUMN photo_sha256 CHAR(64),
    ADD COLUMN photo_updated_at TIMESTAMPTZ,
    ADD COLUMN photo_account_modified BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE account_visit_claims
    ADD CONSTRAINT account_visit_claims_photo_key_check
        CHECK (photo_object_key IS NULL OR photo_object_key LIKE 'postcards/%'),
    ADD CONSTRAINT account_visit_claims_photo_mime_check
        CHECK (photo_mime IS NULL OR photo_mime = 'image/jpeg'),
    ADD CONSTRAINT account_visit_claims_photo_width_check
        CHECK (photo_width IS NULL OR photo_width > 0),
    ADD CONSTRAINT account_visit_claims_photo_height_check
        CHECK (photo_height IS NULL OR photo_height > 0),
    ADD CONSTRAINT account_visit_claims_photo_length_check
        CHECK (photo_byte_length IS NULL OR photo_byte_length > 0),
    ADD CONSTRAINT account_visit_claims_photo_hash_check
        CHECK (photo_sha256 IS NULL OR photo_sha256 ~ '^[0-9a-f]{64}$'),
    ADD CONSTRAINT account_visit_claims_photo_metadata_check
        CHECK ((photo_object_key IS NULL) = (photo_mime IS NULL)),
    ADD CONSTRAINT account_visit_claims_photo_width_presence_check
        CHECK ((photo_object_key IS NULL) = (photo_width IS NULL)),
    ADD CONSTRAINT account_visit_claims_photo_height_presence_check
        CHECK ((photo_object_key IS NULL) = (photo_height IS NULL)),
    ADD CONSTRAINT account_visit_claims_photo_length_presence_check
        CHECK ((photo_object_key IS NULL) = (photo_byte_length IS NULL)),
    ADD CONSTRAINT account_visit_claims_photo_hash_presence_check
        CHECK ((photo_object_key IS NULL) = (photo_sha256 IS NULL)),
    ADD CONSTRAINT account_visit_claims_photo_updated_presence_check
        CHECK ((photo_object_key IS NULL) = (photo_updated_at IS NULL));

-- A delete intent is committed with the metadata tombstone.  A worker deletes
-- the private R2 object and removes this row only after the provider confirms
-- the idempotent delete; failed attempts remain durable for retry.  This table
-- intentionally does not reference account_visit_claims: visit/account reset
-- deletes cascade that row, while the object key must survive long enough for
-- cleanup.  Account deletion sets the owner to NULL for the same reason.
CREATE TABLE photo_object_deletions (
    object_key TEXT PRIMARY KEY,
    account_id UUID NULL REFERENCES accounts(id) ON DELETE SET NULL,
    enqueued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    last_attempted_at TIMESTAMPTZ,
    last_error TEXT,
    CONSTRAINT photo_object_deletions_key_check CHECK (
        CHAR_LENGTH(object_key) <= 512
        AND object_key LIKE 'postcards/%'
        AND object_key ~ '^postcards/[^/]+(/[^/]+)*$'
        AND object_key !~ '(^|/)\.{1,2}(/|$)'
        AND POSITION(CHR(92) IN object_key) = 0
    )
);

CREATE INDEX photo_object_deletions_account_idx
    ON photo_object_deletions (account_id)
    WHERE account_id IS NOT NULL;

CREATE INDEX photo_object_deletions_retry_idx
    ON photo_object_deletions (enqueued_at, last_attempted_at);

-- Recommendation grants are bearer capabilities scoped to the exact session
-- that requested them. The column remains nullable for N-1 APIs during a
-- rolling deploy; the new API only issues and redeems non-null session-bound
-- rows, so legacy unbound grants fail closed.
ALTER TABLE claim_recommendations
    ADD COLUMN IF NOT EXISTS session_hash CHAR(64);

ALTER TABLE claim_recommendations
    ADD CONSTRAINT claim_recommendations_session_hash_check
        CHECK (session_hash IS NULL OR session_hash ~ '^[0-9a-f]{64}$'),
    ADD CONSTRAINT claim_recommendations_session_hash_fkey
        FOREIGN KEY (session_hash) REFERENCES account_sessions(token_hash)
        ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS claim_recommendations_session_hash_idx
    ON claim_recommendations (session_hash)
    WHERE session_hash IS NOT NULL;

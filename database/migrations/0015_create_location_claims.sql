-- Authenticated location-claim evidence.  Legacy visits remain in the
-- existing account_visits table and are intentionally not backfilled.
CREATE TABLE claim_recommendations (
    token_hash CHAR(64) PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    place_id TEXT NOT NULL REFERENCES places(id) ON DELETE CASCADE,
    captured_at TIMESTAMPTZ NOT NULL,
    latitude DOUBLE PRECISION NOT NULL CHECK (latitude BETWEEN -90 AND 90),
    longitude DOUBLE PRECISION NOT NULL CHECK (longitude BETWEEN -180 AND 180),
    accuracy_m DOUBLE PRECISION NOT NULL CHECK (accuracy_m > 0 AND accuracy_m <= 50),
    boundary_version CHAR(64) NOT NULL CHECK (boundary_version ~ '^[0-9a-f]{64}$'),
    match_kind TEXT NOT NULL CHECK (match_kind IN ('exact', 'buffer')),
    distance_m DOUBLE PRECISION NOT NULL CHECK (distance_m >= 0),
    issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    CHECK (expires_at = captured_at + INTERVAL '60 seconds'),
    CHECK (expires_at > issued_at - INTERVAL '10 seconds')
);

CREATE INDEX claim_recommendations_account_expiry_idx
    ON claim_recommendations (account_id, expires_at);

-- Account-scoped lookups use the index above.  Expiry-leading cleanup also
-- needs to find old recommendations without scanning every account's rows.
CREATE INDEX claim_recommendations_expires_at_idx
    ON claim_recommendations (expires_at, account_id);

CREATE TABLE account_visit_claims (
    account_id UUID NOT NULL,
    place_id TEXT NOT NULL,
    recommendation_hash CHAR(64) NOT NULL CHECK (recommendation_hash ~ '^[0-9a-f]{64}$'),
    claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    captured_at TIMESTAMPTZ NOT NULL,
    latitude DOUBLE PRECISION NOT NULL CHECK (latitude BETWEEN -90 AND 90),
    longitude DOUBLE PRECISION NOT NULL CHECK (longitude BETWEEN -180 AND 180),
    accuracy_m DOUBLE PRECISION NOT NULL CHECK (accuracy_m > 0 AND accuracy_m <= 50),
    boundary_version CHAR(64) NOT NULL CHECK (boundary_version ~ '^[0-9a-f]{64}$'),
    match_kind TEXT NOT NULL CHECK (match_kind IN ('exact', 'buffer')),
    distance_m DOUBLE PRECISION NOT NULL CHECK (distance_m >= 0),
    PRIMARY KEY (account_id, place_id),
    UNIQUE (account_id, recommendation_hash),
    FOREIGN KEY (account_id, place_id)
        REFERENCES account_visits(account_id, place_id) ON DELETE CASCADE
);

CREATE INDEX account_visit_claims_account_idx
    ON account_visit_claims (account_id, claimed_at);

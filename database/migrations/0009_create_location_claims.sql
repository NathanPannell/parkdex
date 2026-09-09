CREATE TABLE claim_recommendations (
    token_hash CHAR(64) PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    account_id UUID REFERENCES accounts(id) ON DELETE CASCADE,
    owner_hash CHAR(64) CHECK (owner_hash ~ '^[0-9a-f]{64}$'),
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
    CHECK ((account_id IS NOT NULL) <> (owner_hash IS NOT NULL)),
    CHECK (expires_at = captured_at + INTERVAL '60 seconds')
);

CREATE INDEX claim_recommendations_account_expiry_idx
    ON claim_recommendations (account_id, expires_at) WHERE account_id IS NOT NULL;
CREATE INDEX claim_recommendations_guest_expiry_idx
    ON claim_recommendations (owner_hash, expires_at) WHERE owner_hash IS NOT NULL;

CREATE TABLE guest_visit_claims (
    owner_hash CHAR(64) NOT NULL,
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
    photo_bytes BYTEA,
    photo_mime TEXT,
    photo_width INTEGER CHECK (photo_width > 0),
    photo_height INTEGER CHECK (photo_height > 0),
    photo_sha256 CHAR(64) CHECK (photo_sha256 ~ '^[0-9a-f]{64}$'),
    photo_updated_at TIMESTAMPTZ,
    PRIMARY KEY (owner_hash, place_id),
    UNIQUE (owner_hash, recommendation_hash),
    FOREIGN KEY (owner_hash, place_id) REFERENCES visits(owner_hash, place_id) ON DELETE CASCADE,
    CHECK ((photo_bytes IS NULL) = (photo_mime IS NULL)),
    CHECK ((photo_bytes IS NULL) = (photo_width IS NULL)),
    CHECK ((photo_bytes IS NULL) = (photo_height IS NULL)),
    CHECK ((photo_bytes IS NULL) = (photo_sha256 IS NULL)),
    CHECK ((photo_bytes IS NULL) = (photo_updated_at IS NULL))
);

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
    photo_bytes BYTEA,
    photo_mime TEXT,
    photo_width INTEGER CHECK (photo_width > 0),
    photo_height INTEGER CHECK (photo_height > 0),
    photo_sha256 CHAR(64) CHECK (photo_sha256 ~ '^[0-9a-f]{64}$'),
    photo_updated_at TIMESTAMPTZ,
    PRIMARY KEY (account_id, place_id),
    UNIQUE (account_id, recommendation_hash),
    FOREIGN KEY (account_id, place_id) REFERENCES account_visits(account_id, place_id) ON DELETE CASCADE,
    CHECK ((photo_bytes IS NULL) = (photo_mime IS NULL)),
    CHECK ((photo_bytes IS NULL) = (photo_width IS NULL)),
    CHECK ((photo_bytes IS NULL) = (photo_height IS NULL)),
    CHECK ((photo_bytes IS NULL) = (photo_sha256 IS NULL)),
    CHECK ((photo_bytes IS NULL) = (photo_updated_at IS NULL))
);

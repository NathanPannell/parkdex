DROP TABLE IF EXISTS monitors;

CREATE TABLE places (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL CHECK (CHAR_LENGTH(BTRIM(name)) BETWEEN 1 AND 200),
    category TEXT NOT NULL CHECK (category IN ('national', 'provincial', 'regional', 'island')),
    latitude DOUBLE PRECISION NOT NULL CHECK (latitude BETWEEN 47 AND 52),
    longitude DOUBLE PRECISION NOT NULL CHECK (longitude BETWEEN -130 AND -122),
    region TEXT NOT NULL,
    description TEXT NOT NULL,
    source_url TEXT NOT NULL,
    source_name TEXT NOT NULL,
    source_id TEXT,
    active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE INDEX places_category_name_idx ON places (category, name);

CREATE TABLE visits (
    owner_hash CHAR(64) NOT NULL CHECK (owner_hash ~ '^[0-9a-f]{64}$'),
    place_id TEXT NOT NULL REFERENCES places(id) ON DELETE CASCADE,
    visited_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (owner_hash, place_id)
);

CREATE INDEX visits_owner_hash_idx ON visits (owner_hash);

CREATE TABLE monitors (
    id UUID PRIMARY KEY,
    url TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'UNKNOWN'
        CHECK (status IN ('UNKNOWN', 'UP', 'DOWN')),
    http_status INTEGER,
    response_time_ms INTEGER CHECK (response_time_ms >= 0),
    checked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX monitors_created_at_idx ON monitors (created_at DESC);


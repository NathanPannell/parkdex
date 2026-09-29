-- Additive accepted visitor facts. Canonical place identity and geometry remain
-- owned by places; sparse details live in this one-to-one table.
CREATE TABLE IF NOT EXISTS place_visitor_details (
    place_id TEXT PRIMARY KEY REFERENCES places(id) ON DELETE CASCADE,
    schema_version TEXT NOT NULL CHECK (schema_version = '1.0.0'),
    snapshot_date DATE NOT NULL,
    dataset_sha256 CHAR(64) NOT NULL CHECK (dataset_sha256 ~ '^[0-9a-f]{64}$'),
    source_checked_at TIMESTAMPTZ,
    visitor_details JSONB NOT NULL
        CHECK (jsonb_typeof(visitor_details) = 'object')
        CHECK (visitor_details->>'schemaVersion' = schema_version)
        CHECK (jsonb_typeof(visitor_details->'scope') = 'object')
        CHECK (jsonb_typeof(visitor_details->'source') = 'object')
        CHECK (NOT (visitor_details ? 'placeId'))
        CHECK (NOT (visitor_details ? 'identity'))
        CHECK (NOT (visitor_details ? 'reviewFlagIds'))
        CHECK (NOT ((visitor_details->'source') ? 'archiveIds'))
        CHECK (NOT ((visitor_details->'source') ? 'extractionMethod'))
);

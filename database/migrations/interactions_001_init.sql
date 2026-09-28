CREATE SCHEMA IF NOT EXISTS kip_analytics;

CREATE TABLE IF NOT EXISTS kip_analytics.events (
  event_id uuid PRIMARY KEY,
  event_type text NOT NULL CHECK (event_type IN ('park_viewed', 'directions_opened', 'park_claimed')),
  installation_id uuid NOT NULL,
  session_id uuid NOT NULL,
  client_occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  schema_version integer NOT NULL CHECK (schema_version = 1),
  app_version text NOT NULL CHECK (length(app_version) BETWEEN 1 AND 64 AND app_version ~ '^[A-Za-z0-9.+_-]+$'),
  app_build text NOT NULL CHECK (length(app_build) BETWEEN 1 AND 80 AND app_build ~ '^[A-Za-z0-9._-]+$'),
  content_release_id text NOT NULL CHECK (length(content_release_id) = 64 AND content_release_id ~ '^[0-9a-f]{64}$'),
  environment text NOT NULL CHECK (environment IN ('staging', 'main', 'preview')),
  park_id text NOT NULL CHECK (length(park_id) BETWEEN 1 AND 128 AND park_id ~ '^[a-z0-9][a-z0-9-]*$'),
  entry_point text,
  provider text,
  travel_mode text,
  claim_id uuid,
  claim_status text,
  payload_hash text NOT NULL CHECK (length(payload_hash) = 64 AND payload_hash ~ '^[0-9a-f]{64}$'),
  CHECK (
    (event_type = 'park_viewed'
      AND entry_point IS NOT NULL AND entry_point IN ('map', 'nearby', 'collection')
      AND provider IS NULL AND travel_mode IS NULL AND claim_id IS NULL AND claim_status IS NULL)
    OR
    (event_type = 'directions_opened'
      AND entry_point IS NOT NULL AND entry_point IN ('map', 'nearby', 'collection')
      AND provider IS NOT NULL AND provider IN ('google_maps', 'apple_maps')
      AND travel_mode IS NOT NULL AND travel_mode IN ('driving', 'walking', 'bicycling', 'transit')
      AND claim_id IS NULL AND claim_status IS NULL)
    OR
    (event_type = 'park_claimed'
      AND entry_point IS NULL AND provider IS NULL AND travel_mode IS NULL
      AND claim_id IS NOT NULL AND claim_status IS NOT NULL AND claim_status IN ('first', 'repeat'))
  )
);

CREATE INDEX IF NOT EXISTS interactions_received_at_idx
  ON kip_analytics.events (received_at, event_id);

CREATE INDEX IF NOT EXISTS interactions_type_received_at_idx
  ON kip_analytics.events (event_type, received_at);

-- Only a keyed digest is retained for anonymous request throttling. Raw addresses are never stored.
CREATE TABLE IF NOT EXISTS kip_analytics.rate_limits (
  subject_hash text PRIMARY KEY CHECK (length(subject_hash) = 64 AND subject_hash ~ '^[0-9a-f]{64}$'),
  window_started_at timestamptz NOT NULL,
  hit_count integer NOT NULL CHECK (hit_count > 0),
  expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS interactions_rate_limits_expires_at_idx
  ON kip_analytics.rate_limits (expires_at);

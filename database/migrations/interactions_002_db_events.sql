-- Widens kip_analytics.events for server-side events: one row per API database query
-- (db_read, db_write) and the named game events. Additive and idempotent, because it runs on
-- every deploy. Rows from interactions_001 and older app builds keep their original rules.

ALTER TABLE kip_analytics.events
  ADD COLUMN IF NOT EXISTS account_id uuid,
  ADD COLUMN IF NOT EXISTS request_id uuid,
  ADD COLUMN IF NOT EXISTS route text,
  ADD COLUMN IF NOT EXISTS occurred_at timestamptz,
  ADD COLUMN IF NOT EXISTS operation text,
  ADD COLUMN IF NOT EXISTS tables text[],
  ADD COLUMN IF NOT EXISTS duration_ms integer,
  ADD COLUMN IF NOT EXISTS result text,
  ADD COLUMN IF NOT EXISTS bundle_id text,
  ADD COLUMN IF NOT EXISTS properties jsonb;

-- Server events have no client session, content release or payload hash. The shape check below
-- still requires all of these for the three interaction event types.
ALTER TABLE kip_analytics.events
  ALTER COLUMN installation_id DROP NOT NULL,
  ALTER COLUMN session_id DROP NOT NULL,
  ALTER COLUMN client_occurred_at DROP NOT NULL,
  ALTER COLUMN app_build DROP NOT NULL,
  ALTER COLUMN app_version DROP NOT NULL,
  ALTER COLUMN content_release_id DROP NOT NULL,
  ALTER COLUMN park_id DROP NOT NULL,
  ALTER COLUMN payload_hash DROP NOT NULL;

-- Constraints are replaced only when their v2 name is missing, so later deploys do not take
-- the table lock and rescan every row again. A future change adds a v3 name the same way.
DO $$
DECLARE
  events regclass := 'kip_analytics.events'::regclass;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = events AND conname = 'events_event_type_v2_check') THEN
    ALTER TABLE kip_analytics.events DROP CONSTRAINT IF EXISTS events_event_type_check;
    ALTER TABLE kip_analytics.events ADD CONSTRAINT events_event_type_v2_check CHECK (event_type IN (
      'park_viewed', 'directions_opened', 'park_claimed',
      'db_read', 'db_write',
      'flag_planted', 'flag_taken', 'flag_held', 'visit_already_today', 'flag_fell',
      'leaderboard_viewed', 'takeover_message_seen', 'handle_set'
    ));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = events AND conname = 'events_shape_v2_check') THEN
    ALTER TABLE kip_analytics.events DROP CONSTRAINT IF EXISTS events_check;
    ALTER TABLE kip_analytics.events ADD CONSTRAINT events_shape_v2_check CHECK (
      (event_type IN ('park_viewed', 'directions_opened', 'park_claimed')
        AND installation_id IS NOT NULL AND session_id IS NOT NULL AND client_occurred_at IS NOT NULL
        AND app_version IS NOT NULL AND app_build IS NOT NULL AND content_release_id IS NOT NULL
        AND park_id IS NOT NULL AND payload_hash IS NOT NULL
        AND operation IS NULL AND tables IS NULL AND duration_ms IS NULL AND result IS NULL
        AND (
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
        ))
      OR
      (event_type IN ('db_read', 'db_write')
        AND operation IS NOT NULL AND operation = CASE event_type WHEN 'db_read' THEN 'read' ELSE 'write' END
        AND tables IS NOT NULL AND duration_ms IS NOT NULL AND result IS NOT NULL
        AND route IS NOT NULL AND request_id IS NOT NULL AND occurred_at IS NOT NULL
        AND properties IS NULL
        AND entry_point IS NULL AND provider IS NULL AND travel_mode IS NULL AND claim_id IS NULL AND claim_status IS NULL)
      OR
      (event_type IN ('flag_planted', 'flag_taken', 'flag_held', 'visit_already_today', 'flag_fell',
          'leaderboard_viewed', 'takeover_message_seen', 'handle_set')
        AND route IS NOT NULL AND request_id IS NOT NULL AND occurred_at IS NOT NULL
        AND operation IS NULL AND tables IS NULL AND duration_ms IS NULL AND result IS NULL
        AND entry_point IS NULL AND provider IS NULL AND travel_mode IS NULL AND claim_id IS NULL AND claim_status IS NULL)
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = events AND conname = 'events_server_fields_v1_check') THEN
    ALTER TABLE kip_analytics.events ADD CONSTRAINT events_server_fields_v1_check CHECK (
      (route IS NULL OR (length(route) BETWEEN 3 AND 200 AND route ~ '^[A-Z]+ /[a-z0-9_:/-]*$'))
      AND (operation IS NULL OR operation IN ('read', 'write'))
      AND (tables IS NULL OR (cardinality(tables) <= 16
        AND array_to_string(tables, ',') ~ '^([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*(,|$))*$'))
      AND (duration_ms IS NULL OR duration_ms >= 0)
      AND (result IS NULL OR result ~ '^(ok|error|aborted|[0-9A-Z]{5})$')
      AND (bundle_id IS NULL OR bundle_id ~ '^[A-Za-z0-9._-]{1,80}$')
      AND (properties IS NULL OR (jsonb_typeof(properties) = 'object' AND octet_length(properties::text) <= 4096))
    );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS interactions_account_received_at_idx
  ON kip_analytics.events (account_id, received_at) WHERE account_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS interactions_installation_received_at_idx
  ON kip_analytics.events (installation_id, received_at) WHERE installation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS interactions_route_received_at_idx
  ON kip_analytics.events (route, received_at) WHERE route IS NOT NULL;

-- Manual review of founding photos (#153). A player whose founding photo the check rejected,
-- or could not decide on, can ask the operator to look at it. The photo of such a check is kept
-- for a day so a request can reuse it; a request keeps its own copy until 90 days after the
-- decision. An approval founds the park through the same transaction as an instant approval.
-- Additive and idempotent: runs on every deploy after founders_001_init.sql.
CREATE SCHEMA IF NOT EXISTS kip_founders;

-- The photo and position of a rejected or unsure check, with its metadata already removed.
-- The daily retention run deletes rows older than 24 hours; asking for a review moves the row
-- into review_requests.
CREATE TABLE IF NOT EXISTS kip_founders.check_photos (
  check_id uuid PRIMARY KEY REFERENCES kip_founders.photo_checks(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES kip_account.accounts(id) ON DELETE CASCADE,
  attempt_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  park_name text NOT NULL CHECK (length(park_name) BETWEEN 1 AND 200),
  -- The OpenStreetMap outline the check was made against, for a park not in Parkdex yet, so an
  -- approval publishes exactly what the player stood in.
  osm_feature jsonb CHECK (osm_feature IS NULL OR jsonb_typeof(osm_feature) = 'object'),
  latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  accuracy_m double precision NOT NULL CHECK (accuracy_m >= 0),
  photo_sha256 text NOT NULL CHECK (photo_sha256 ~ '^[0-9a-f]{64}$'),
  photo_bytes bytea NOT NULL CHECK (octet_length(photo_bytes) BETWEEN 1 AND 1572864),
  photo_width integer NOT NULL CHECK (photo_width BETWEEN 1 AND 2048),
  photo_height integer NOT NULL CHECK (photo_height BETWEEN 1 AND 2048),
  CHECK (photo_sha256 = encode(sha256(photo_bytes), 'hex'))
);

CREATE INDEX IF NOT EXISTS check_photos_attempt_idx ON kip_founders.check_photos (account_id, attempt_id);
CREATE INDEX IF NOT EXISTS check_photos_created_idx ON kip_founders.check_photos (created_at);

-- One row per request. The check it appeals is copied in, so the request stands on its own.
CREATE TABLE IF NOT EXISTS kip_founders.review_requests (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES kip_account.accounts(id) ON DELETE CASCADE,
  attempt_id uuid NOT NULL UNIQUE,
  check_id uuid NOT NULL,
  -- The target: a catalogue park, or the id an OpenStreetMap park gets when it is published.
  park_id text NOT NULL CHECK (park_id ~ '^[a-z0-9][a-z0-9-]*$' AND length(park_id) <= 160),
  osm_type text CHECK (osm_type IS NULL OR osm_type IN ('way', 'relation')),
  osm_id bigint CHECK (osm_id IS NULL OR osm_id > 0),
  park_name text NOT NULL CHECK (length(park_name) BETWEEN 1 AND 200),
  osm_feature jsonb CHECK (osm_feature IS NULL OR jsonb_typeof(osm_feature) = 'object'),
  latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  accuracy_m double precision NOT NULL CHECK (accuracy_m >= 0),
  -- Null once the retention run removed it, 90 days after the decision.
  photo_bytes bytea CHECK (photo_bytes IS NULL OR octet_length(photo_bytes) BETWEEN 1 AND 1572864),
  photo_sha256 text NOT NULL CHECK (photo_sha256 ~ '^[0-9a-f]{64}$'),
  photo_width integer NOT NULL CHECK (photo_width BETWEEN 1 AND 2048),
  photo_height integer NOT NULL CHECK (photo_height BETWEEN 1 AND 2048),
  photo_purged_at timestamptz,
  -- The automatic check: its outcome, flags and the model's answers.
  outcome text NOT NULL CHECK (outcome IN ('reject', 'unsure')),
  flags text[] NOT NULL DEFAULT '{}'
    CHECK (flags <@ ARRAY['people', 'lighting', 'not_park', 'inappropriate', 'not_photo', 'personal_info']::text[]),
  moderation jsonb CHECK (moderation IS NULL OR jsonb_typeof(moderation) = 'object'),
  checked_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'superseded')),
  reason_code text CHECK (reason_code IS NULL OR reason_code IN ('people', 'lighting', 'not_park', 'inappropriate', 'other')),
  -- What the player reads when the request is rejected.
  decision_reason text CHECK (decision_reason IS NULL OR length(decision_reason) BETWEEN 1 AND 300),
  -- The park the approval founded. An OpenStreetMap target that turned out to be a catalogue
  -- park is founded as that park.
  founded_park_id text CHECK (founded_park_id IS NULL OR length(founded_park_id) <= 160),
  decided_at timestamptz,
  -- When the player's app showed the decision.
  seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((osm_type IS NULL) = (osm_id IS NULL)),
  CHECK ((status = 'pending') = (decided_at IS NULL)),
  CHECK (status <> 'rejected' OR decision_reason IS NOT NULL),
  CHECK (status = 'approved' OR founded_park_id IS NULL),
  CHECK (photo_bytes IS NOT NULL OR photo_purged_at IS NOT NULL),
  CHECK (photo_bytes IS NULL OR photo_sha256 = encode(sha256(photo_bytes), 'hex'))
);

-- One pending request per account and park; the API checks first, this backs it up.
CREATE UNIQUE INDEX IF NOT EXISTS review_requests_one_pending_idx
  ON kip_founders.review_requests (account_id, park_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS review_requests_status_created_idx ON kip_founders.review_requests (status, created_at);
CREATE INDEX IF NOT EXISTS review_requests_park_pending_idx ON kip_founders.review_requests (park_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS review_requests_account_created_idx ON kip_founders.review_requests (account_id, created_at);
CREATE INDEX IF NOT EXISTS review_requests_decided_idx ON kip_founders.review_requests (decided_at) WHERE photo_bytes IS NOT NULL AND decided_at IS NOT NULL;

-- Widen the analytics event checks under the same names, like founders_001 did, keeping every
-- earlier type. founders_001 only widens when park_founded is missing, so a replay of it leaves
-- this version in place. A later migration that adds event types must keep all of these.
DO $$
DECLARE
  events regclass := to_regclass('kip_analytics.events');
BEGIN
  IF events IS NULL THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = events AND conname = 'events_event_type_v2_check'
      AND pg_get_constraintdef(oid) NOT LIKE '%founding_review_decided%') THEN
    ALTER TABLE kip_analytics.events DROP CONSTRAINT events_event_type_v2_check;
    ALTER TABLE kip_analytics.events ADD CONSTRAINT events_event_type_v2_check CHECK (event_type IN (
      'park_viewed', 'directions_opened', 'park_claimed',
      'db_read', 'db_write',
      'flag_planted', 'flag_taken', 'flag_held', 'visit_already_today', 'flag_fell',
      'leaderboard_viewed', 'takeover_message_seen', 'handle_set',
      'park_founded', 'founder_photo_checked',
      'founding_review_requested', 'founding_review_decided'
    )) NOT VALID;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = events AND conname = 'events_shape_v2_check'
      AND pg_get_constraintdef(oid) NOT LIKE '%founding_review_decided%') THEN
    ALTER TABLE kip_analytics.events DROP CONSTRAINT events_shape_v2_check;
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
          'leaderboard_viewed', 'takeover_message_seen', 'handle_set', 'park_founded', 'founder_photo_checked',
          'founding_review_requested', 'founding_review_decided')
        AND route IS NOT NULL AND request_id IS NOT NULL AND occurred_at IS NOT NULL
        AND operation IS NULL AND tables IS NULL AND duration_ms IS NULL AND result IS NULL
        AND entry_point IS NULL AND provider IS NULL AND travel_mode IS NULL AND claim_id IS NULL AND claim_status IS NULL)
    ) NOT VALID;
  END IF;
END
$$;

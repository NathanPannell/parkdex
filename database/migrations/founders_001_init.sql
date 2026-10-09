-- Park founders (#126): the first player to stand in a park and take an approved photo founds
-- it. One founder and one public cover photo per park, every photo check for rate limits and
-- analytics, and a one-time founder bonus in the flag game score.
-- Additive and idempotent: runs on every deploy after game_001_init.sql and osm_parks_001_init.sql.
CREATE SCHEMA IF NOT EXISTS kip_founders;

-- The founder bonus lives here only; the API reads it back from the founding transaction.
CREATE OR REPLACE FUNCTION kip_founders.bonus_points()
RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 10 $$;

CREATE TABLE IF NOT EXISTS kip_founders.parks (
  park_id text PRIMARY KEY REFERENCES public.parks(id) ON DELETE CASCADE,
  -- Deleting the account removes the founder and the cover photo; the park can be founded again.
  account_id uuid NOT NULL REFERENCES kip_account.accounts(id) ON DELETE CASCADE,
  attempt_id uuid NOT NULL,
  founded_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL CHECK (source IN ('osm_new', 'existing')),
  -- The approved photo with its metadata segments removed, served as the public cover.
  photo_sha256 text NOT NULL CHECK (photo_sha256 ~ '^[0-9a-f]{64}$'),
  photo_bytes bytea NOT NULL CHECK (octet_length(photo_bytes) BETWEEN 1 AND 1572864),
  photo_width integer NOT NULL CHECK (photo_width BETWEEN 1 AND 2048),
  photo_height integer NOT NULL CHECK (photo_height BETWEEN 1 AND 2048),
  -- The model's answers only, never the image.
  moderation jsonb NOT NULL CHECK (jsonb_typeof(moderation) = 'object'),
  CHECK (photo_sha256 = encode(sha256(photo_bytes), 'hex')),
  UNIQUE (account_id, attempt_id)
);

CREATE INDEX IF NOT EXISTS parks_account_founded_idx ON kip_founders.parks (account_id, founded_at);

-- One row per photo check. No image bytes. The position is never stored.
CREATE TABLE IF NOT EXISTS kip_founders.photo_checks (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES kip_account.accounts(id) ON DELETE CASCADE,
  attempt_id uuid NOT NULL,
  -- The catalogue park, or the id an OpenStreetMap park gets when it is published.
  park_id text NOT NULL CHECK (park_id ~ '^[a-z0-9][a-z0-9-]*$' AND length(park_id) <= 160),
  osm_type text CHECK (osm_type IS NULL OR osm_type IN ('way', 'relation')),
  osm_id bigint CHECK (osm_id IS NULL OR osm_id > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  outcome text NOT NULL CHECK (outcome IN ('approve', 'reject', 'unsure', 'unavailable')),
  flags text[] NOT NULL DEFAULT '{}'
    CHECK (flags <@ ARRAY['people', 'lighting', 'not_park', 'inappropriate', 'not_photo', 'personal_info']::text[]),
  photo_sha256 text NOT NULL CHECK (photo_sha256 ~ '^[0-9a-f]{64}$'),
  moderation jsonb CHECK (moderation IS NULL OR jsonb_typeof(moderation) = 'object'),
  CHECK ((osm_type IS NULL) = (osm_id IS NULL))
);

CREATE INDEX IF NOT EXISTS photo_checks_account_created_idx ON kip_founders.photo_checks (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS photo_checks_attempt_idx ON kip_founders.photo_checks (account_id, attempt_id, created_at DESC);

-- A founded OpenStreetMap park keeps its proposal row as the audit record, now with the founder.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'kip_proposals' AND table_name = 'parks' AND column_name = 'founder_account_id'
  ) THEN
    ALTER TABLE kip_proposals.parks
      ADD COLUMN founder_account_id uuid REFERENCES kip_account.accounts(id) ON DELETE SET NULL;
  END IF;
END
$$;

-- Founder bonus points of one account at p_now.
CREATE OR REPLACE FUNCTION kip_founders.founder_points(p_account_id uuid, p_now timestamptz)
RETURNS integer LANGUAGE sql STABLE AS $$
  SELECT (count(*) * kip_founders.bonus_points())::integer
  FROM kip_founders.parks WHERE account_id = p_account_id AND founded_at <= p_now
$$;

-- Same columns as game_001_init.sql, plus the founder bonus in the score. game_001 replays first
-- on every deploy and briefly restores its own version; this one follows in the same deploy.
CREATE OR REPLACE FUNCTION kip_game.player_scores(p_now timestamptz)
RETURNS TABLE (account_id uuid, handle text, flag_seed text, created_at timestamptz, score integer, parks_held integer)
LANGUAGE sql STABLE AS $$
  SELECT p.account_id, p.handle, p.flag_seed, p.created_at,
    (coalesce(sum(kip_game.holding_points(t.started_at, t.last_visit_at, t.ended_at, p_now) + t.bounty_points), 0)
      + kip_founders.founder_points(p.account_id, p_now))::integer,
    (count(*) FILTER (WHERE kip_game.flag_up(t.last_visit_at, t.ended_at, p_now)))::integer
  FROM kip_game.players p
  JOIN kip_account.accounts a ON a.id = p.account_id AND a.deletion_state = 'active'
  LEFT JOIN kip_game.tenures t ON t.holder_account_id = p.account_id AND t.started_at <= p_now
  GROUP BY p.account_id, p.handle, p.flag_seed, p.created_at
$$;

-- The analytics table checks event types by name. interactions_002 only adds its v2 constraints
-- when they are missing, so widen them under the same names, once, rather than adding v3 names
-- that a replay of interactions_002 would undo. NOT VALID: existing rows met the narrower check.
-- A later migration that adds event types must keep both new types in its lists.
DO $$
DECLARE
  events regclass := to_regclass('kip_analytics.events');
BEGIN
  IF events IS NULL THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = events AND conname = 'events_event_type_v2_check'
      AND pg_get_constraintdef(oid) NOT LIKE '%park_founded%') THEN
    ALTER TABLE kip_analytics.events DROP CONSTRAINT events_event_type_v2_check;
    ALTER TABLE kip_analytics.events ADD CONSTRAINT events_event_type_v2_check CHECK (event_type IN (
      'park_viewed', 'directions_opened', 'park_claimed',
      'db_read', 'db_write',
      'flag_planted', 'flag_taken', 'flag_held', 'visit_already_today', 'flag_fell',
      'leaderboard_viewed', 'takeover_message_seen', 'handle_set',
      'park_founded', 'founder_photo_checked'
    )) NOT VALID;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = events AND conname = 'events_shape_v2_check'
      AND pg_get_constraintdef(oid) NOT LIKE '%park_founded%') THEN
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
          'leaderboard_viewed', 'takeover_message_seen', 'handle_set', 'park_founded', 'founder_photo_checked')
        AND route IS NOT NULL AND request_id IS NOT NULL AND occurred_at IS NOT NULL
        AND operation IS NULL AND tables IS NULL AND duration_ms IS NULL AND result IS NULL
        AND entry_point IS NULL AND provider IS NULL AND travel_mode IS NULL AND claim_id IS NULL AND claim_status IS NULL)
    ) NOT VALID;
  END IF;
END
$$;

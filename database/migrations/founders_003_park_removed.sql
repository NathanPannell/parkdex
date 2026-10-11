-- Remove from map (operator dashboard): the operator takes a park off the map and unfounds it,
-- keeping its OpenStreetMap outline so it can be founded again (docs/park-founders.md). The only
-- schema change is the analytics event that records it, `park_removed`.
-- Additive and idempotent: runs on every deploy after founders_002_reviews.sql.

-- Widen the analytics event checks under the same names, like founders_001 and founders_002 did,
-- keeping every earlier type. founders_002 only widens when founding_review_decided is missing,
-- so a replay of it leaves this version in place. A later migration that adds event types must
-- keep all of these.
DO $$
DECLARE
  events regclass := to_regclass('kip_analytics.events');
BEGIN
  IF events IS NULL THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = events AND conname = 'events_event_type_v2_check'
      AND pg_get_constraintdef(oid) NOT LIKE '%park_removed%') THEN
    ALTER TABLE kip_analytics.events DROP CONSTRAINT events_event_type_v2_check;
    ALTER TABLE kip_analytics.events ADD CONSTRAINT events_event_type_v2_check CHECK (event_type IN (
      'park_viewed', 'directions_opened', 'park_claimed',
      'db_read', 'db_write',
      'flag_planted', 'flag_taken', 'flag_held', 'visit_already_today', 'flag_fell',
      'leaderboard_viewed', 'takeover_message_seen', 'handle_set',
      'park_founded', 'founder_photo_checked',
      'founding_review_requested', 'founding_review_decided',
      'park_removed'
    )) NOT VALID;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = events AND conname = 'events_shape_v2_check'
      AND pg_get_constraintdef(oid) NOT LIKE '%park_removed%') THEN
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
          'founding_review_requested', 'founding_review_decided', 'park_removed')
        AND route IS NOT NULL AND request_id IS NOT NULL AND occurred_at IS NOT NULL
        AND operation IS NULL AND tables IS NULL AND duration_ms IS NULL AND result IS NULL
        AND entry_point IS NULL AND provider IS NULL AND travel_mode IS NULL AND claim_id IS NULL AND claim_status IS NULL)
    ) NOT VALID;
  END IF;
END
$$;

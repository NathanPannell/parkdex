-- Badges (#175): achievements made from park art, worn as patches on the player's flag.
--
--   Badges are decorative. They never add points: nothing here reads or changes player_scores.
--   Each badge has a rule: a metric of the player's play and a goal. The metrics come from
--   visits, claims, tenures, crew members, founders and the catalogue (region, biome).
--   A badge unlocks once, in kip_game.player_badges, and stays unlocked.
--   Unlocks are checked in the same transaction as each visit, crew join and instant founding,
--   so their responses can announce new badges. GET /api/game/me checks every rule again, which
--   catches badges that unlock with time (hold-7, hold-30) or through someone else's action.
--   Players sew up to 3 unlocked badges onto their flag: kip_game.players.flag_patches.
--
-- To add a badge: add a row to kip_game.badge_rules() in a later migration (a new metric goes in
-- kip_game.badge_metrics()), and add its name and art to src/lib/game/badges.ts.
--
-- Additive and idempotent: runs on every deploy after game_003_crews.sql. It wraps game_003's
-- record_visit and join_crew instead of redefining them, so their replays never undo it.

CREATE TABLE IF NOT EXISTS kip_game.player_badges (
  account_id uuid NOT NULL REFERENCES kip_game.players(account_id) ON DELETE CASCADE,
  badge_id text NOT NULL CHECK (badge_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(badge_id) <= 40),
  unlocked_at timestamptz NOT NULL,
  -- The visit, crew join or founding visit whose transaction unlocked it, so a replay of that
  -- request announces it again. Null when GET /api/game/me found it.
  visit_id uuid,
  PRIMARY KEY (account_id, badge_id)
);

CREATE INDEX IF NOT EXISTS player_badges_visit_idx
  ON kip_game.player_badges (account_id, visit_id) WHERE visit_id IS NOT NULL;

-- Up to 3 unlocked badges worn on the flag, in the order the player chose. Added once, so a
-- replay takes no lock on players. set_flag_patches checks that each one is unlocked.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'kip_game' AND table_name = 'players' AND column_name = 'flag_patches'
  ) THEN
    ALTER TABLE kip_game.players
      ADD COLUMN flag_patches text[] NOT NULL DEFAULT '{}',
      ADD CONSTRAINT players_flag_patches_check CHECK (cardinality(flag_patches) <= 3 AND array_position(flag_patches, NULL) IS NULL);
  END IF;
END
$$;

-- Every badge: its metric, the goal that unlocks it and its place on the shelf.
CREATE OR REPLACE FUNCTION kip_game.badge_rules()
RETURNS TABLE (badge_id text, metric text, goal integer, sort_order integer)
LANGUAGE sql IMMUTABLE AS $$
  VALUES
    ('parks-1', 'parks', 1, 1),
    ('parks-10', 'parks', 10, 2),
    ('parks-25', 'parks', 25, 3),
    ('parks-50', 'parks', 50, 4),
    ('parks-100', 'parks', 100, 5),
    ('regular-3', 'same_park_days', 3, 6),
    ('regular-10', 'same_park_days', 10, 7),
    ('regular-25', 'same_park_days', 25, 8),
    ('planter-5', 'planted', 5, 9),
    ('taker-5', 'taken', 5, 10),
    ('taker-25', 'taken', 25, 11),
    ('hold-7', 'hold_days', 7, 12),
    ('hold-30', 'hold_days', 30, 13),
    ('crew-1', 'crews', 1, 14),
    ('crew-10', 'crews', 10, 15),
    ('biomes-5', 'biomes', 5, 16),
    ('regions-3', 'regions', 3, 17),
    ('founder', 'founded', 1, 18),
    ('coast-to-coast', 'coast_to_coast', 2, 19)
$$;

-- The province of a catalogue region. public.parks.region is free text, so this mirrors the
-- hand-kept list in src/lib/dex/regions.ts; src/lib/game/badgeSql.test.ts keeps them in step.
CREATE OR REPLACE FUNCTION kip_game.region_province(p_region text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN lower(btrim(p_region)) IN (
      'southern vancouver island', 'northern vancouver island', 'thompson & okanagan', 'kootenays', 'south coast',
      'cariboo & central interior', 'north coast & haida gwaii', 'northeast', 'nechako', 'central coast', 'gulf islands',
      'west coast', 'capital region', 'central island', 'north island', 'south island', 'cowichan valley',
      'northern islands', 'northern gulf islands', 'west coast islands', 'discovery islands'
    ) THEN 'British Columbia'
    WHEN lower(btrim(p_region)) IN (
      'halifax metro', 'south shore', 'yarmouth and acadian shores', 'bay of fundy and annapolis valley',
      'northumberland shore', 'eastern shore', 'cape breton island'
    ) THEN 'Nova Scotia'
  END
$$;

-- Each metric for one account at p_now.
--   parks           distinct parks visited, from visits (any outcome) and claims, like My Dex
--   same_park_days  the most distinct Victoria days at one park
--   planted, taken  visits that planted a flag in an empty park, and visits that took one
--   hold_days       the longest whole days one holding lasted: from planting, taking or joining
--                   to the earliest of its end, its fall and now. A flag is down at its fall, so a
--                   flag nobody revisits flies just under 30 days: hold-30 needs a return visit.
--   crews           flags held in a crew of 2 or more, as leader or member
--   biomes, regions distinct catalogue biomes and regions of the parks visited
--   coast_to_coast  1 for a park visited in British Columbia, plus 1 for one in Nova Scotia
--   founded         parks founded
CREATE OR REPLACE FUNCTION kip_game.badge_metrics(p_account_id uuid, p_now timestamptz)
RETURNS TABLE (metric text, value integer)
LANGUAGE sql STABLE AS $$
  WITH visited AS (
    SELECT v.park_id, v.local_day FROM kip_game.visits v
    WHERE v.account_id = p_account_id AND v.visited_at <= p_now
    UNION
    SELECT c.park_id, kip_game.local_day(c.claimed_at) FROM kip_account.claims c
    WHERE c.account_id = p_account_id AND c.claimed_at <= p_now
  ), places AS (
    SELECT DISTINCT v.park_id, nullif(lower(btrim(p.region)), '') AS region, p.biome, kip_game.region_province(p.region) AS province
    FROM visited v LEFT JOIN public.parks p ON p.id = v.park_id
  ), outcomes AS (
    SELECT count(*) FILTER (WHERE v.outcome = 'planted') AS planted, count(*) FILTER (WHERE v.outcome = 'took') AS taken
    FROM kip_game.visits v
    WHERE v.account_id = p_account_id AND v.visited_at <= p_now AND v.source = 'visit'
  )
  SELECT 'parks', (SELECT count(*) FROM places)::integer
  UNION ALL
  SELECT 'same_park_days', coalesce((SELECT max(days) FROM (SELECT count(DISTINCT local_day) AS days FROM visited GROUP BY park_id) d), 0)::integer
  UNION ALL
  SELECT 'planted', (SELECT planted FROM outcomes)::integer
  UNION ALL
  SELECT 'taken', (SELECT taken FROM outcomes)::integer
  UNION ALL
  SELECT 'hold_days', coalesce((
    SELECT max(kip_game.whole_days(h.held_from,
      least(coalesce(h.ended_at, 'infinity'::timestamptz), kip_game.fall_at(h.last_visit_at) - interval '1 microsecond', p_now)))
    FROM kip_game.holdings(p_now) h
    WHERE h.account_id = p_account_id
  ), 0)::integer
  UNION ALL
  SELECT 'crews', (
    SELECT count(*) FROM kip_game.tenures t
    WHERE t.started_at <= p_now
      AND (t.holder_account_id = p_account_id OR EXISTS (
        SELECT 1 FROM kip_game.crew_members m WHERE m.tenure_id = t.tenure_id AND m.account_id = p_account_id AND m.joined_at <= p_now))
      AND EXISTS (
        SELECT 1 FROM kip_game.crew_members m WHERE m.tenure_id = t.tenure_id AND m.account_id <> t.holder_account_id AND m.joined_at <= p_now)
  )::integer
  UNION ALL
  SELECT 'biomes', (SELECT count(DISTINCT biome) FROM places)::integer
  UNION ALL
  SELECT 'regions', (SELECT count(DISTINCT region) FROM places)::integer
  UNION ALL
  SELECT 'coast_to_coast', (
    SELECT (count(*) FILTER (WHERE province = 'British Columbia') > 0)::integer + (count(*) FILTER (WHERE province = 'Nova Scotia') > 0)::integer
    FROM places
  )
  UNION ALL
  SELECT 'founded', (SELECT count(*) FROM kip_founders.parks f WHERE f.account_id = p_account_id AND f.founded_at <= p_now)::integer
$$;

-- Unlocks every badge whose goal the account has reached, at p_now, and returns the new ones as
-- [{id, unlockedAt}]. Idempotent: an unlocked badge is never unlocked again. Only an active
-- account with a handle gets badges.
CREATE OR REPLACE FUNCTION kip_game.award_badges(p_account_id uuid, p_now timestamptz, p_visit_id uuid)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_added jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM kip_game.players p JOIN kip_account.accounts a ON a.id = p.account_id AND a.deletion_state = 'active'
    WHERE p.account_id = p_account_id
  ) THEN
    RETURN '[]'::jsonb;
  END IF;
  WITH added AS (
    INSERT INTO kip_game.player_badges (account_id, badge_id, unlocked_at, visit_id)
    SELECT p_account_id, r.badge_id, p_now, p_visit_id
    FROM kip_game.badge_rules() r
    JOIN kip_game.badge_metrics(p_account_id, p_now) m ON m.metric = r.metric
    WHERE m.value >= r.goal
    ON CONFLICT (account_id, badge_id) DO NOTHING
    RETURNING badge_id, unlocked_at
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', a.badge_id, 'unlockedAt', a.unlocked_at) ORDER BY r.sort_order), '[]'::jsonb)
  INTO v_added
  FROM added a JOIN kip_game.badge_rules() r ON r.badge_id = a.badge_id;
  RETURN v_added;
END
$$;

-- The badges one visit, join or founding unlocked, for a replay of that request.
CREATE OR REPLACE FUNCTION kip_game.visit_badges(p_account_id uuid, p_visit_id uuid)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', b.badge_id, 'unlockedAt', b.unlocked_at) ORDER BY r.sort_order, b.badge_id), '[]'::jsonb)
  FROM kip_game.player_badges b
  LEFT JOIN kip_game.badge_rules() r ON r.badge_id = b.badge_id
  WHERE b.account_id = p_account_id AND b.visit_id = p_visit_id
$$;

-- Every badge as the account sees it at p_now: progress toward its goal and when it unlocked.
-- A badge unlocked under a rule that has since gone is still listed.
CREATE OR REPLACE FUNCTION kip_game.badges_json(p_account_id uuid, p_now timestamptz)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  WITH metrics AS (
    SELECT * FROM kip_game.badge_metrics(p_account_id, p_now)
  ), listed AS (
    SELECT r.badge_id, r.sort_order, r.goal, least(coalesce(m.value, 0), r.goal) AS progress
    FROM kip_game.badge_rules() r LEFT JOIN metrics m ON m.metric = r.metric
    UNION ALL
    SELECT b.badge_id, 1000, 1, 1 FROM kip_game.player_badges b
    WHERE b.account_id = p_account_id AND NOT EXISTS (SELECT 1 FROM kip_game.badge_rules() r WHERE r.badge_id = b.badge_id)
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id', l.badge_id, 'progress', CASE WHEN b.badge_id IS NULL THEN l.progress ELSE l.goal END, 'goal', l.goal, 'unlockedAt', b.unlocked_at
    ) ORDER BY l.sort_order, l.badge_id), '[]'::jsonb)
  FROM listed l
  LEFT JOIN kip_game.player_badges b ON b.account_id = p_account_id AND b.badge_id = l.badge_id
$$;

-- game_003's record_visit, then the badges it unlocked: {status, visit?, badges?}. A replay
-- answers with the badges the first request unlocked. Other statuses changed nothing.
CREATE OR REPLACE FUNCTION kip_game.record_visit_with_badges(
  p_visit_id uuid, p_account_id uuid, p_park_id text, p_visited_at timestamptz
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_result jsonb := kip_game.record_visit(p_visit_id, p_account_id, p_park_id, p_visited_at);
BEGIN
  IF v_result->>'status' IN ('recorded', 'protected') THEN
    RETURN v_result || jsonb_build_object('badges', kip_game.award_badges(p_account_id, p_visited_at, p_visit_id));
  ELSIF v_result->>'status' = 'replayed' THEN
    RETURN v_result || jsonb_build_object('badges', kip_game.visit_badges(p_account_id, p_visit_id));
  END IF;
  RETURN v_result;
END
$$;

-- game_003's join_crew, then the badges it unlocked: the joiner's in the answer, and the rest of
-- the crew's quietly, because their crew just grew. {status, visit?, crew?, badges?}.
CREATE OR REPLACE FUNCTION kip_game.join_crew_with_badges(
  p_account_id uuid, p_code text, p_visit_id uuid, p_now timestamptz
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_result jsonb := kip_game.join_crew(p_account_id, p_code, p_visit_id, p_now);
  v_tenure_id uuid;
  v_badges jsonb;
BEGIN
  IF v_result->>'status' = 'joined' THEN
    v_badges := kip_game.award_badges(p_account_id, p_now, p_visit_id);
    SELECT tenure_id INTO v_tenure_id FROM kip_game.visits WHERE account_id = p_account_id AND visit_id = p_visit_id;
    PERFORM kip_game.award_badges(crew.account_id, p_now, NULL)
    FROM (
      SELECT holder_account_id AS account_id FROM kip_game.tenures WHERE tenure_id = v_tenure_id
      UNION
      SELECT account_id FROM kip_game.crew_members WHERE tenure_id = v_tenure_id
    ) crew
    WHERE crew.account_id <> p_account_id;
    RETURN v_result || jsonb_build_object('badges', v_badges);
  ELSIF v_result->>'status' = 'replayed' THEN
    RETURN v_result || jsonb_build_object('badges', kip_game.visit_badges(p_account_id, p_visit_id));
  END IF;
  RETURN v_result;
END
$$;

-- Sets the badges worn on the flag. Returns {status, patches?}; status is one of saved,
-- too_many, duplicate, locked, handle_required, account_unavailable.
CREATE OR REPLACE FUNCTION kip_game.set_flag_patches(p_account_id uuid, p_patches text[])
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_saved text[];
BEGIN
  p_patches := coalesce(p_patches, '{}'::text[]);
  IF cardinality(p_patches) > 3 THEN RETURN jsonb_build_object('status', 'too_many'); END IF;
  IF array_position(p_patches, NULL) IS NOT NULL
    OR (SELECT count(DISTINCT patch) FROM unnest(p_patches) AS patch) <> cardinality(p_patches) THEN
    RETURN jsonb_build_object('status', 'duplicate');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM kip_account.accounts WHERE id = p_account_id AND deletion_state = 'active') THEN
    RETURN jsonb_build_object('status', 'account_unavailable');
  END IF;
  -- Lock the player, so a patch is always checked against the badges at the moment it is saved.
  PERFORM 1 FROM kip_game.players WHERE account_id = p_account_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'handle_required'); END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(p_patches) AS patch
    WHERE NOT EXISTS (SELECT 1 FROM kip_game.player_badges b WHERE b.account_id = p_account_id AND b.badge_id = patch)
  ) THEN
    RETURN jsonb_build_object('status', 'locked');
  END IF;
  UPDATE kip_game.players SET flag_patches = p_patches WHERE account_id = p_account_id RETURNING flag_patches INTO v_saved;
  RETURN jsonb_build_object('status', 'saved', 'patches', to_jsonb(v_saved));
END
$$;

-- Analytics event types for badges, added the way game_003_crews.sql adds the crew types: read
-- the live definitions and only add what is missing, so no other migration's types are dropped,
-- in any replay order. NOT VALID: existing rows met the narrower checks.
DO $$
DECLARE
  events regclass := to_regclass('kip_analytics.events');
  badge_types constant text[] := ARRAY['badge_unlocked', 'flag_patches_set'];
  def text;
  existing text[];
  missing text[];
BEGIN
  IF events IS NULL THEN RETURN; END IF;

  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
  WHERE conrelid = events AND conname = 'events_event_type_v2_check';
  IF def IS NOT NULL THEN
    existing := ARRAY(SELECT DISTINCT m[1] FROM regexp_matches(def, '''([a-z0-9_]+)''::text', 'g') AS m);
    missing := ARRAY(SELECT t FROM unnest(badge_types) AS t WHERE NOT t = ANY (existing));
    IF cardinality(existing) < 5 THEN
      -- Never rebuild from a definition this could not read; badge events would only fail to record.
      RAISE WARNING 'events_event_type_v2_check has an unexpected definition; badge event types not added';
    ELSIF cardinality(missing) > 0 THEN
      EXECUTE format(
        'ALTER TABLE kip_analytics.events DROP CONSTRAINT events_event_type_v2_check, '
        'ADD CONSTRAINT events_event_type_v2_check CHECK (event_type IN (%s)) NOT VALID',
        (SELECT string_agg(quote_literal(t), ', ' ORDER BY t) FROM unnest(existing || missing) AS t));
    END IF;
  END IF;

  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
  WHERE conrelid = events AND conname = 'events_shape_v2_check';
  IF def IS NOT NULL THEN
    missing := ARRAY(SELECT t FROM unnest(badge_types) AS t WHERE position('''' || t || '''' IN def) = 0);
    IF cardinality(missing) > 0 THEN
      -- The same shape as the other named server events: request fields, no client or db fields.
      EXECUTE format(
        'ALTER TABLE kip_analytics.events DROP CONSTRAINT events_shape_v2_check, '
        'ADD CONSTRAINT events_shape_v2_check CHECK ((%s) OR (event_type IN (%s) '
        'AND route IS NOT NULL AND request_id IS NOT NULL AND occurred_at IS NOT NULL '
        'AND operation IS NULL AND tables IS NULL AND duration_ms IS NULL AND result IS NULL '
        'AND entry_point IS NULL AND provider IS NULL AND travel_mode IS NULL AND claim_id IS NULL AND claim_status IS NULL)) NOT VALID',
        regexp_replace(def, '^CHECK \((.*)\)( NOT VALID)?$', '\1'),
        (SELECT string_agg(quote_literal(t), ', ') FROM unnest(missing) AS t));
    END IF;
  END IF;
END
$$;

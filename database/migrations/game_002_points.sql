-- Flag game points (#169): 1 point per whole hour a flag flies, plus a bonus for each visit.
--
--   Holding a flag          +1 per whole hour from planting or taking, until it is taken, falls or now
--   Planting an empty park  +6
--   Taking a flag           +4, plus 1 per whole day the taken flag had flown
--   Visiting your own flag  +1
--   Founding a park         +24 (kip_founders.bonus_points)
--
-- Holding points are still computed on read, so every tenure, old ones included, is scored in
-- hours as soon as this runs. Visit bonuses are stored in visits.points_earned when the visit
-- is recorded; historic takes keep the day bonus they were paid.
--
-- Additive and idempotent: runs on every deploy after game_001_init.sql and founders_001_init.sql,
-- both of which replay first and briefly restore their own versions of the functions below.
-- Crews (#170) build on kip_game.holdings and kip_game.visit_base_points.

-- The day bonus part of points_earned, so a take can show "+4, +N days". Added once.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'kip_game' AND table_name = 'visits' AND column_name = 'day_bonus'
  ) THEN
    ALTER TABLE kip_game.visits
      ADD COLUMN day_bonus integer NOT NULL DEFAULT 0,
      ADD CONSTRAINT visits_day_bonus_check CHECK (day_bonus BETWEEN 0 AND points_earned);
    -- Before this migration a take earned its day bonus and nothing else.
    UPDATE kip_game.visits SET day_bonus = points_earned WHERE outcome = 'took';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION kip_game.whole_hours(p_from timestamptz, p_to timestamptz)
RETURNS integer LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT greatest(0, floor(extract(epoch FROM (p_to - p_from)) / 3600))::integer
$$;

-- The points a visit earns before any day bonus. Crews (#170) add their outcomes here.
CREATE OR REPLACE FUNCTION kip_game.visit_base_points(p_outcome text)
RETURNS integer LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT CASE p_outcome WHEN 'planted' THEN 6 WHEN 'took' THEN 4 WHEN 'held' THEN 1 ELSE 0 END
$$;

-- Holding points of one holding at p_now: whole hours from p_started_at, when this account
-- started holding the flag, to the earliest of the tenure's end, its fall and now. The holder
-- passes the tenure start; a crew member (#170) passes their own join time. The parameter
-- names are game_001's, which CREATE OR REPLACE cannot rename.
CREATE OR REPLACE FUNCTION kip_game.holding_points(
  p_started_at timestamptz, p_last_visit_at timestamptz, p_ended_at timestamptz, p_now timestamptz
) RETURNS integer LANGUAGE sql IMMUTABLE AS $$
  SELECT kip_game.whole_hours(
    p_started_at,
    least(coalesce(p_ended_at, 'infinity'::timestamptz), kip_game.fall_at(p_last_visit_at), p_now)
  )
$$;

-- Who holds which flag, and from when, at p_now. Today that is each tenure's holder from its
-- start. Crews (#170) redefine this to add each member from their joined_at, and scores, parks
-- held and /api/game/me follow. Not STRICT, so the planner can inline it.
CREATE OR REPLACE FUNCTION kip_game.holdings(p_now timestamptz)
RETURNS TABLE (
  account_id uuid, tenure_id uuid, park_id text, held_from timestamptz,
  flag_since timestamptz, last_visit_at timestamptz, ended_at timestamptz
)
LANGUAGE sql STABLE AS $$
  SELECT t.holder_account_id, t.tenure_id, t.park_id, t.started_at, t.started_at, t.last_visit_at, t.ended_at
  FROM kip_game.tenures t
  WHERE t.started_at <= p_now
$$;

-- The founder bonus (#126), was 10. founders_001_init.sql replays first with its own value.
CREATE OR REPLACE FUNCTION kip_founders.bonus_points()
RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 24 $$;

-- Same columns as game_001_init.sql and founders_001_init.sql. The score is holding hours,
-- plus every stored visit bonus, plus the founder bonus.
CREATE OR REPLACE FUNCTION kip_game.player_scores(p_now timestamptz)
RETURNS TABLE (account_id uuid, handle text, flag_seed text, created_at timestamptz, score integer, parks_held integer)
LANGUAGE sql STABLE AS $$
  SELECT p.account_id, p.handle, p.flag_seed, p.created_at,
    (coalesce(h.points, 0) + coalesce(v.points, 0) + kip_founders.founder_points(p.account_id, p_now))::integer,
    coalesce(h.parks_held, 0)::integer
  FROM kip_game.players p
  JOIN kip_account.accounts a ON a.id = p.account_id AND a.deletion_state = 'active'
  LEFT JOIN (
    SELECT h.account_id,
      sum(kip_game.holding_points(h.held_from, h.last_visit_at, h.ended_at, p_now)) AS points,
      count(*) FILTER (WHERE kip_game.flag_up(h.last_visit_at, h.ended_at, p_now)) AS parks_held
    FROM kip_game.holdings(p_now) h
    GROUP BY h.account_id
  ) h ON h.account_id = p.account_id
  LEFT JOIN (
    SELECT v.account_id, sum(v.points_earned) AS points
    FROM kip_game.visits v
    WHERE v.visited_at <= p_now
    GROUP BY v.account_id
  ) v ON v.account_id = p.account_id
$$;

-- The stored result of one visit, shared by first recording and idempotent replay.
-- Adds pointsBreakdown to game_001's shape: base points, plus the day bonus of a take.
CREATE OR REPLACE FUNCTION kip_game.visit_json(p_account_id uuid, p_visit_id uuid)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'visitId', v.visit_id,
    'parkId', v.park_id,
    'outcome', v.outcome,
    'pointsEarned', v.points_earned,
    'pointsBreakdown', jsonb_build_object('base', v.points_earned - v.day_bonus, 'days', v.day_bonus),
    'previousHolder', CASE WHEN pp.account_id IS NULL THEN NULL
      ELSE jsonb_build_object('handle', pp.handle, 'flagSeed', pp.flag_seed) END,
    'flagSince', t.started_at,
    'visitedAt', v.visited_at,
    'fell', v.closed_fallen
  )
  FROM kip_game.visits v
  LEFT JOIN kip_game.tenures t ON t.tenure_id = v.tenure_id
  LEFT JOIN kip_game.tenures pt ON pt.tenure_id = v.previous_tenure_id
  LEFT JOIN kip_game.players pp ON pp.account_id = pt.holder_account_id
  WHERE v.account_id = p_account_id AND v.visit_id = p_visit_id
$$;

-- game_001's visit, with the new bonuses: planting +6, holding +1, taking +4 plus the taken
-- flag's whole days. Returns {status, visit?}; status is one of recorded, replayed,
-- already_today, park_not_found, handle_required, account_unavailable, conflict.
CREATE OR REPLACE FUNCTION kip_game.record_visit(
  p_visit_id uuid, p_account_id uuid, p_park_id text, p_visited_at timestamptz
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_day date := kip_game.local_day(p_visited_at);
  v_open kip_game.tenures%ROWTYPE;
  v_has_open boolean;
  v_stored_park text;
  v_fell boolean := false;
  v_outcome text;
  v_day_bonus integer := 0;
  v_points integer;
  v_tenure_id uuid;
  v_previous_tenure_id uuid;
BEGIN
  -- Serialise every visit to one park, so plant, hold and take decisions never race.
  PERFORM pg_advisory_xact_lock(hashtextextended('kip_game.park:' || p_park_id, 0));

  SELECT park_id INTO v_stored_park FROM kip_game.visits WHERE account_id = p_account_id AND visit_id = p_visit_id;
  IF FOUND THEN
    IF v_stored_park <> p_park_id THEN RETURN jsonb_build_object('status', 'conflict'); END IF;
    RETURN jsonb_build_object('status', 'replayed', 'visit', kip_game.visit_json(p_account_id, p_visit_id));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM kip_account.accounts WHERE id = p_account_id AND deletion_state = 'active') THEN
    RETURN jsonb_build_object('status', 'account_unavailable');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM kip_game.players WHERE account_id = p_account_id) THEN
    RETURN jsonb_build_object('status', 'handle_required');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.parks WHERE id = p_park_id) THEN
    RETURN jsonb_build_object('status', 'park_not_found');
  END IF;

  SELECT * INTO v_open FROM kip_game.tenures WHERE park_id = p_park_id AND ended_at IS NULL FOR UPDATE;
  v_has_open := FOUND;

  IF EXISTS (
    SELECT 1 FROM kip_game.visits
    WHERE account_id = p_account_id AND park_id = p_park_id AND local_day = v_day AND source = 'visit'
  ) THEN
    RETURN jsonb_build_object('status', 'already_today', 'visit', jsonb_build_object(
      'visitId', p_visit_id, 'parkId', p_park_id, 'outcome', 'already_today', 'pointsEarned', 0,
      'pointsBreakdown', jsonb_build_object('base', 0, 'days', 0),
      'previousHolder', NULL,
      'flagSince', CASE WHEN v_has_open AND v_open.holder_account_id = p_account_id
        AND kip_game.flag_up(v_open.last_visit_at, v_open.ended_at, p_visited_at) THEN to_jsonb(v_open.started_at) ELSE NULL END,
      'visitedAt', p_visited_at, 'fell', false));
  END IF;

  BEGIN
    IF v_has_open AND kip_game.fall_at(v_open.last_visit_at) <= p_visited_at THEN
      UPDATE kip_game.tenures SET ended_at = kip_game.fall_at(v_open.last_visit_at), end_reason = 'fell'
      WHERE tenure_id = v_open.tenure_id;
      v_fell := true;
      v_has_open := false;
    END IF;

    IF NOT v_has_open THEN
      v_outcome := 'planted';
      v_tenure_id := gen_random_uuid();
      INSERT INTO kip_game.tenures (tenure_id, park_id, holder_account_id, started_at, last_visit_at)
      VALUES (v_tenure_id, p_park_id, p_account_id, p_visited_at, p_visited_at);
    ELSIF v_open.holder_account_id = p_account_id THEN
      v_outcome := 'held';
      v_tenure_id := v_open.tenure_id;
      UPDATE kip_game.tenures SET last_visit_at = greatest(last_visit_at, p_visited_at)
      WHERE tenure_id = v_open.tenure_id;
    ELSE
      v_outcome := 'took';
      v_day_bonus := kip_game.whole_days(v_open.started_at, p_visited_at);
      v_previous_tenure_id := v_open.tenure_id;
      UPDATE kip_game.tenures SET ended_at = p_visited_at, end_reason = 'taken', ended_by_account_id = p_account_id
      WHERE tenure_id = v_open.tenure_id;
      v_tenure_id := gen_random_uuid();
      -- bounty_points keeps recording what the take paid; scores read visits.points_earned.
      INSERT INTO kip_game.tenures (tenure_id, park_id, holder_account_id, started_at, last_visit_at, bounty_points)
      VALUES (v_tenure_id, p_park_id, p_account_id, p_visited_at, p_visited_at,
        kip_game.visit_base_points('took') + v_day_bonus);
    END IF;

    v_points := kip_game.visit_base_points(v_outcome) + v_day_bonus;
    INSERT INTO kip_game.visits
      (account_id, visit_id, park_id, visited_at, local_day, source, outcome, points_earned, day_bonus, tenure_id, previous_tenure_id, closed_fallen)
    VALUES
      (p_account_id, p_visit_id, p_park_id, p_visited_at, v_day, 'visit', v_outcome, v_points, v_day_bonus, v_tenure_id, v_previous_tenure_id, v_fell);
  EXCEPTION WHEN unique_violation THEN
    -- The same visit ID raced in for another park; the subtransaction undoes the flag changes.
    RETURN jsonb_build_object('status', 'conflict');
  END;

  RETURN jsonb_build_object('status', 'recorded', 'visit', kip_game.visit_json(p_account_id, p_visit_id));
END
$$;

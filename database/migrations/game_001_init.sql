-- Flag game (V1): players with handles, park tenures (flags) and visits.
-- Additive and idempotent: runs on every deploy after the account and progress migrations.
-- Scores are computed on read from tenures, so there are no scheduled jobs.
CREATE SCHEMA IF NOT EXISTS kip_game;

CREATE TABLE IF NOT EXISTS kip_game.players (
  account_id uuid PRIMARY KEY REFERENCES kip_account.accounts(id) ON DELETE CASCADE,
  handle text NOT NULL UNIQUE CHECK (handle ~ '^[a-z0-9_]{3,20}$'),
  flag_seed text NOT NULL CHECK (flag_seed ~ '^[0-9a-f]{16}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  takeovers_seen_at timestamptz
);

CREATE TABLE IF NOT EXISTS kip_game.tenures (
  tenure_id uuid PRIMARY KEY,
  park_id text NOT NULL CHECK (length(park_id) BETWEEN 1 AND 160),
  holder_account_id uuid NOT NULL REFERENCES kip_account.accounts(id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL,
  last_visit_at timestamptz NOT NULL,
  ended_at timestamptz,
  end_reason text CHECK (end_reason IN ('taken', 'fell')),
  ended_by_account_id uuid REFERENCES kip_account.accounts(id) ON DELETE SET NULL,
  bounty_points integer NOT NULL DEFAULT 0 CHECK (bounty_points >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (last_visit_at >= started_at),
  CHECK ((ended_at IS NULL) = (end_reason IS NULL)),
  CHECK (ended_by_account_id IS NULL OR end_reason = 'taken')
);

CREATE UNIQUE INDEX IF NOT EXISTS tenures_one_open_per_park_idx
  ON kip_game.tenures (park_id) WHERE ended_at IS NULL;

CREATE INDEX IF NOT EXISTS tenures_holder_idx
  ON kip_game.tenures (holder_account_id, ended_at);

CREATE INDEX IF NOT EXISTS tenures_holder_taken_idx
  ON kip_game.tenures (holder_account_id, ended_at DESC) WHERE end_reason = 'taken';

CREATE TABLE IF NOT EXISTS kip_game.visits (
  account_id uuid NOT NULL REFERENCES kip_account.accounts(id) ON DELETE CASCADE,
  visit_id uuid NOT NULL,
  park_id text NOT NULL CHECK (length(park_id) BETWEEN 1 AND 160),
  visited_at timestamptz NOT NULL,
  local_day date NOT NULL,
  source text NOT NULL CHECK (source IN ('visit', 'claim_import')),
  outcome text NOT NULL CHECK (outcome IN ('planted', 'took', 'held', 'imported')),
  points_earned integer NOT NULL DEFAULT 0 CHECK (points_earned >= 0),
  tenure_id uuid REFERENCES kip_game.tenures(tenure_id) ON DELETE SET NULL,
  -- The tenure this visit replaced, so a replay can still name the previous holder.
  previous_tenure_id uuid REFERENCES kip_game.tenures(tenure_id) ON DELETE SET NULL,
  -- True when this visit closed a fallen flag before planting (analytics `flag_fell`).
  closed_fallen boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, visit_id),
  CHECK ((source = 'claim_import') = (outcome = 'imported'))
);

CREATE UNIQUE INDEX IF NOT EXISTS visits_one_per_park_per_day_idx
  ON kip_game.visits (account_id, park_id, local_day) WHERE source = 'visit';

CREATE INDEX IF NOT EXISTS visits_park_idx
  ON kip_game.visits (park_id, visited_at);

-- Public, stable flag seed. Derived from the account ID so it never changes and never reveals the ID.
CREATE OR REPLACE FUNCTION kip_game.flag_seed(p_account_id uuid)
RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT left(encode(sha256(convert_to('kip-flag:' || p_account_id::text, 'UTF8')), 'hex'), 16)
$$;

-- Visits are grouped by the Victoria calendar day, whatever the database session time zone is.
CREATE OR REPLACE FUNCTION kip_game.local_day(p_at timestamptz)
RETURNS date LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT (p_at AT TIME ZONE 'America/Vancouver')::date
$$;

-- A flag stays up for 30 days of 24 hours after its holder's last visit. Fixed hours, not
-- calendar days, so daylight saving changes never move a fall.
CREATE OR REPLACE FUNCTION kip_game.fall_at(p_last_visit_at timestamptz)
RETURNS timestamptz LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT p_last_visit_at + interval '720 hours'
$$;

CREATE OR REPLACE FUNCTION kip_game.whole_days(p_from timestamptz, p_to timestamptz)
RETURNS integer LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT greatest(0, floor(extract(epoch FROM (p_to - p_from)) / 86400))::integer
$$;

-- Holding points of one tenure at p_now: whole days from planting to the earliest of its end,
-- its fall and now.
CREATE OR REPLACE FUNCTION kip_game.holding_points(
  p_started_at timestamptz, p_last_visit_at timestamptz, p_ended_at timestamptz, p_now timestamptz
) RETURNS integer LANGUAGE sql IMMUTABLE AS $$
  SELECT kip_game.whole_days(
    p_started_at,
    least(coalesce(p_ended_at, 'infinity'::timestamptz), kip_game.fall_at(p_last_visit_at), p_now)
  )
$$;

CREATE OR REPLACE FUNCTION kip_game.flag_up(p_last_visit_at timestamptz, p_ended_at timestamptz, p_now timestamptz)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT p_ended_at IS NULL AND kip_game.fall_at(p_last_visit_at) > p_now
$$;

-- Every player with a handle and an active account, with score and flags held at p_now.
CREATE OR REPLACE FUNCTION kip_game.player_scores(p_now timestamptz)
RETURNS TABLE (account_id uuid, handle text, flag_seed text, created_at timestamptz, score integer, parks_held integer)
LANGUAGE sql STABLE AS $$
  SELECT p.account_id, p.handle, p.flag_seed, p.created_at,
    coalesce(sum(kip_game.holding_points(t.started_at, t.last_visit_at, t.ended_at, p_now) + t.bounty_points), 0)::integer,
    (count(*) FILTER (WHERE kip_game.flag_up(t.last_visit_at, t.ended_at, p_now)))::integer
  FROM kip_game.players p
  JOIN kip_account.accounts a ON a.id = p.account_id AND a.deletion_state = 'active'
  LEFT JOIN kip_game.tenures t ON t.holder_account_id = p.account_id AND t.started_at <= p_now
  GROUP BY p.account_id, p.handle, p.flag_seed, p.created_at
$$;

CREATE OR REPLACE FUNCTION kip_game.leaderboard(p_now timestamptz, p_limit integer DEFAULT 500)
RETURNS TABLE (rank integer, handle text, flag_seed text, score integer, parks_held integer)
LANGUAGE sql STABLE AS $$
  SELECT (row_number() OVER (ORDER BY s.score DESC, s.created_at ASC, s.handle ASC))::integer,
    s.handle, s.flag_seed, s.score, s.parks_held
  FROM kip_game.player_scores(p_now) s
  ORDER BY s.score DESC, s.created_at ASC, s.handle ASC
  LIMIT p_limit
$$;

CREATE OR REPLACE FUNCTION kip_game.flags_up(p_now timestamptz)
RETURNS TABLE (park_id text, handle text, flag_seed text, since timestamptz, last_visit_at timestamptz)
LANGUAGE sql STABLE AS $$
  SELECT t.park_id, p.handle, p.flag_seed, t.started_at, t.last_visit_at
  FROM kip_game.tenures t
  JOIN kip_game.players p ON p.account_id = t.holder_account_id
  JOIN kip_account.accounts a ON a.id = t.holder_account_id AND a.deletion_state = 'active'
  WHERE kip_game.flag_up(t.last_visit_at, t.ended_at, p_now) AND t.started_at <= p_now
  ORDER BY t.park_id
$$;

-- The stored result of one visit, shared by first recording and idempotent replay.
CREATE OR REPLACE FUNCTION kip_game.visit_json(p_account_id uuid, p_visit_id uuid)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'visitId', v.visit_id,
    'parkId', v.park_id,
    'outcome', v.outcome,
    'pointsEarned', v.points_earned,
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

-- Applies one visit under the park lock. Returns {status, visit?}; status is one of
-- recorded, replayed, already_today, park_not_found, handle_required, account_unavailable, conflict.
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
  v_points integer := 0;
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
      v_points := kip_game.whole_days(v_open.started_at, p_visited_at);
      v_previous_tenure_id := v_open.tenure_id;
      UPDATE kip_game.tenures SET ended_at = p_visited_at, end_reason = 'taken', ended_by_account_id = p_account_id
      WHERE tenure_id = v_open.tenure_id;
      v_tenure_id := gen_random_uuid();
      INSERT INTO kip_game.tenures (tenure_id, park_id, holder_account_id, started_at, last_visit_at, bounty_points)
      VALUES (v_tenure_id, p_park_id, p_account_id, p_visited_at, p_visited_at, v_points);
    END IF;

    INSERT INTO kip_game.visits
      (account_id, visit_id, park_id, visited_at, local_day, source, outcome, points_earned, tenure_id, previous_tenure_id, closed_fallen)
    VALUES
      (p_account_id, p_visit_id, p_park_id, p_visited_at, v_day, 'visit', v_outcome, v_points, v_tenure_id, v_previous_tenure_id, v_fell);
  EXCEPTION WHEN unique_violation THEN
    -- The same visit ID raced in for another park; the subtransaction undoes the flag changes.
    RETURN jsonb_build_object('status', 'conflict');
  END;

  RETURN jsonb_build_object('status', 'recorded', 'visit', kip_game.visit_json(p_account_id, p_visit_id));
END
$$;

-- Clean start: existing claims become visit history. They never plant flags and never use the
-- one-visit-per-day slot. The visit ID is derived from the claim so it cannot collide with a
-- client visit ID that reuses the claim ID.
INSERT INTO kip_game.visits (account_id, visit_id, park_id, visited_at, local_day, source, outcome, points_earned)
SELECT c.account_id,
  md5('kip-claim-import:' || c.account_id::text || ':' || c.claim_id::text)::uuid,
  c.park_id, c.claimed_at, kip_game.local_day(c.claimed_at), 'claim_import', 'imported', 0
FROM kip_account.claims c
ON CONFLICT (account_id, visit_id) DO NOTHING;

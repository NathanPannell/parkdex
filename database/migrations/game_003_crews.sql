-- Crew flags (#170): a protected hour, a crew code, crew joins and outsider visits.
--
--   Planting or taking a flag starts a 60-minute protected hour from the tenure's started_at.
--   During it nobody outside the crew can take the flag. An outsider's visit is `logged` (+1):
--   it leaves the flag alone and does not use up their flag action for the day.
--   The planter or taker leads the crew. Friends join with the hour's 6-character crew code
--   (`joined`, +2), up to 8 people including the leader, and hold the park together from their
--   joined_at. After the hour the flag works as before: any member's visit is `held` (+1) and
--   restarts the 30-day fall, and a take ends the flag for every member.
--
-- Additive and idempotent: runs on every deploy after game_002_points.sql, whose holdings,
-- visit_base_points, visit_json and record_visit it redefines. game_001 and game_002 replay
-- first and briefly restore their own versions; see the PR (#170) for that window.

-- Crew members of a tenure. The planter or taker is inserted as the first member, so the leader
-- is also the earliest joined_at. Tenures from before this migration have no rows; their holder
-- is still the leader, because every reader takes the leader from tenures.holder_account_id.
CREATE TABLE IF NOT EXISTS kip_game.crew_members (
  tenure_id uuid NOT NULL REFERENCES kip_game.tenures(tenure_id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES kip_account.accounts(id) ON DELETE CASCADE,
  joined_at timestamptz NOT NULL,
  -- The plant, take or join visit that made this account a member.
  visit_id uuid NOT NULL,
  PRIMARY KEY (tenure_id, account_id),
  FOREIGN KEY (account_id, visit_id) REFERENCES kip_game.visits(account_id, visit_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS crew_members_account_idx ON kip_game.crew_members (account_id, tenure_id);

-- One crew code per protected hour. A code is open until a later code with the same value
-- releases it, which only happens after it expired, so codes are unique among open windows.
CREATE TABLE IF NOT EXISTS kip_game.crew_codes (
  tenure_id uuid PRIMARY KEY REFERENCES kip_game.tenures(tenure_id) ON DELETE CASCADE,
  -- 6 characters from the friend code alphabet: no 0, 1, I, L or O.
  code text NOT NULL CHECK (code ~ '^[2-9A-HJKMNP-Z]{6}$'),
  expires_at timestamptz NOT NULL,
  released boolean NOT NULL DEFAULT false
);

CREATE UNIQUE INDEX IF NOT EXISTS crew_codes_open_code_idx ON kip_game.crew_codes (code) WHERE NOT released;
CREATE INDEX IF NOT EXISTS crew_codes_code_idx ON kip_game.crew_codes (code, expires_at DESC);

-- visits.outcome gains `joined` and `logged`. game_001 declares the check inline in CREATE TABLE
-- IF NOT EXISTS, so its replay never narrows it again. NOT VALID: existing rows met the old list.
DO $$
DECLARE
  v_name text;
BEGIN
  SELECT conname INTO v_name FROM pg_constraint
  WHERE conrelid = 'kip_game.visits'::regclass AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%outcome%' AND pg_get_constraintdef(oid) LIKE '%imported%'
    AND pg_get_constraintdef(oid) NOT LIKE '%source%';
  IF v_name IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'kip_game.visits'::regclass AND conname = v_name
      AND pg_get_constraintdef(oid) LIKE '%logged%'
  ) THEN
    EXECUTE format('ALTER TABLE kip_game.visits DROP CONSTRAINT %I', v_name);
    ALTER TABLE kip_game.visits ADD CONSTRAINT visits_outcome_check
      CHECK (outcome IN ('planted', 'took', 'held', 'joined', 'logged', 'imported')) NOT VALID;
  END IF;
END
$$;

-- Daily uniqueness: one flag action (planted, took, held, joined) per account, park and Victoria
-- day, plus at most one logged visit. game_001 creates visits_one_per_park_per_day_idx with IF NOT
-- EXISTS on every replay, so the flag action index takes over that name: game_001's replay then
-- finds it and leaves it alone. Swapped once, while the name still has game_001's predicate.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = 'kip_game' AND indexname = 'visits_one_per_park_per_day_idx'
      AND indexdef NOT LIKE '%logged%'
  ) THEN
    CREATE UNIQUE INDEX visits_one_flag_action_per_park_per_day_idx
      ON kip_game.visits (account_id, park_id, local_day) WHERE source = 'visit' AND outcome <> 'logged';
    DROP INDEX kip_game.visits_one_per_park_per_day_idx;
    ALTER INDEX kip_game.visits_one_flag_action_per_park_per_day_idx RENAME TO visits_one_per_park_per_day_idx;
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS visits_one_logged_per_park_per_day_idx
  ON kip_game.visits (account_id, park_id, local_day) WHERE source = 'visit' AND outcome = 'logged';

CREATE OR REPLACE FUNCTION kip_game.crew_cap()
RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 8 $$;

-- The end of a tenure's protected hour.
CREATE OR REPLACE FUNCTION kip_game.protected_until(p_started_at timestamptz)
RETURNS timestamptz LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT p_started_at + interval '60 minutes'
$$;

-- The holder, plus every member who joined. Holder rows in crew_members are not counted twice.
CREATE OR REPLACE FUNCTION kip_game.crew_size(p_tenure_id uuid)
RETURNS integer LANGUAGE sql STABLE AS $$
  SELECT (1 + count(m.account_id))::integer
  FROM kip_game.tenures t
  LEFT JOIN kip_game.crew_members m ON m.tenure_id = t.tenure_id AND m.account_id <> t.holder_account_id
  WHERE t.tenure_id = p_tenure_id
$$;

CREATE OR REPLACE FUNCTION kip_game.is_crew_member(p_tenure_id uuid, p_account_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM kip_game.tenures WHERE tenure_id = p_tenure_id AND holder_account_id = p_account_id)
    OR EXISTS (SELECT 1 FROM kip_game.crew_members WHERE tenure_id = p_tenure_id AND account_id = p_account_id)
$$;

-- Six characters from the friend code alphabet (#64 and #65). Mirrors kip_social.random_code(6)
-- from social_001_friends.sql, which has not merged yet; one of the two goes once both have.
CREATE OR REPLACE FUNCTION kip_game.random_crew_code()
RETURNS text LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  v_alphabet constant text := '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  v_code text := '';
  v_bytes bytea;
  v_byte integer;
BEGIN
  WHILE length(v_code) < 6 LOOP
    -- gen_random_uuid() reads the strong random source. Skip its version and variant bytes.
    v_bytes := uuid_send(gen_random_uuid());
    FOR i IN 0..15 LOOP
      CONTINUE WHEN i IN (6, 8);
      v_byte := get_byte(v_bytes, i);
      -- 248 is 8 * 31: rejecting the rest keeps every character equally likely.
      CONTINUE WHEN v_byte >= 248;
      v_code := v_code || substr(v_alphabet, v_byte % 31 + 1, 1);
      EXIT WHEN length(v_code) = 6;
    END LOOP;
  END LOOP;
  RETURN v_code;
END
$$;

-- Issues the crew code for a new tenure's protected hour. Called under the park lock by
-- record_visit; a code still open at another park is drawn again.
CREATE OR REPLACE FUNCTION kip_game.issue_crew_code(p_tenure_id uuid, p_started_at timestamptz)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  v_code text;
BEGIN
  FOR attempt IN 1..20 LOOP
    v_code := kip_game.random_crew_code();
    -- An expired code with the same value gives its value up.
    UPDATE kip_game.crew_codes SET released = true
    WHERE code = v_code AND NOT released AND expires_at <= p_started_at;
    BEGIN
      INSERT INTO kip_game.crew_codes (tenure_id, code, expires_at)
      VALUES (p_tenure_id, v_code, kip_game.protected_until(p_started_at));
      RETURN v_code;
    EXCEPTION WHEN unique_violation THEN
      IF attempt = 20 THEN RAISE; END IF;
    END;
  END LOOP;
  RETURN NULL;
END
$$;

-- game_002's base points, plus crew outcomes: joining a crew +2, a visit logged during someone
-- else's protected hour +1.
CREATE OR REPLACE FUNCTION kip_game.visit_base_points(p_outcome text)
RETURNS integer LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT CASE p_outcome WHEN 'planted' THEN 6 WHEN 'took' THEN 4 WHEN 'held' THEN 1
    WHEN 'joined' THEN 2 WHEN 'logged' THEN 1 ELSE 0 END
$$;

-- game_002's holdings, plus every crew member from their joined_at. player_scores, parks held,
-- the leaderboard and /api/game/me read this, so members hold the park for all of them, and
-- holding stops for everyone when the tenure is taken or falls.
CREATE OR REPLACE FUNCTION kip_game.holdings(p_now timestamptz)
RETURNS TABLE (
  account_id uuid, tenure_id uuid, park_id text, held_from timestamptz,
  flag_since timestamptz, last_visit_at timestamptz, ended_at timestamptz
)
LANGUAGE sql STABLE AS $$
  SELECT t.holder_account_id, t.tenure_id, t.park_id, t.started_at, t.started_at, t.last_visit_at, t.ended_at
  FROM kip_game.tenures t
  WHERE t.started_at <= p_now
  UNION ALL
  SELECT m.account_id, t.tenure_id, t.park_id, m.joined_at, t.started_at, t.last_visit_at, t.ended_at
  FROM kip_game.crew_members m
  JOIN kip_game.tenures t ON t.tenure_id = m.tenure_id
  WHERE m.account_id <> t.holder_account_id AND m.joined_at <= p_now AND t.started_at <= p_now
$$;

-- The crew of every flag that is up at p_now, for map pins: size, up to 3 member seeds after the
-- leader (earliest first) and the end of the protected hour while it lasts. The leader is
-- flags_up's handle and seed. flags_up keeps game_001's columns, because a replay of game_001
-- could not change them back.
CREATE OR REPLACE FUNCTION kip_game.flag_crews(p_now timestamptz)
RETURNS TABLE (park_id text, crew_size integer, member_seeds text[], protected_until timestamptz)
LANGUAGE sql STABLE AS $$
  SELECT t.park_id,
    (1 + count(m.account_id))::integer,
    coalesce((array_agg(p.flag_seed ORDER BY m.joined_at, p.handle) FILTER (WHERE m.account_id IS NOT NULL))[1:3], '{}'::text[]),
    CASE WHEN p_now < kip_game.protected_until(t.started_at) THEN kip_game.protected_until(t.started_at) END
  FROM kip_game.tenures t
  LEFT JOIN kip_game.crew_members m ON m.tenure_id = t.tenure_id AND m.account_id <> t.holder_account_id AND m.joined_at <= p_now
  LEFT JOIN kip_game.players p ON p.account_id = m.account_id
  WHERE kip_game.flag_up(t.last_visit_at, t.ended_at, p_now) AND t.started_at <= p_now
  GROUP BY t.park_id, t.tenure_id, t.started_at
$$;

-- What a logged visit shows: when the hour ends, who leads the crew and how big it is.
CREATE OR REPLACE FUNCTION kip_game.protected_json(p_tenure_id uuid)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'until', kip_game.protected_until(t.started_at),
    'leader', jsonb_build_object('handle', p.handle, 'flagSeed', p.flag_seed),
    'crewSize', kip_game.crew_size(t.tenure_id)
  )
  FROM kip_game.tenures t
  JOIN kip_game.players p ON p.account_id = t.holder_account_id
  WHERE t.tenure_id = p_tenure_id
$$;

-- One tenure's crew as p_account_id sees it. The code is only for members, and only during the hour.
CREATE OR REPLACE FUNCTION kip_game.crew_json(p_tenure_id uuid, p_account_id uuid, p_now timestamptz)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  WITH t AS (
    SELECT * FROM kip_game.tenures WHERE tenure_id = p_tenure_id
  ), crew AS (
    SELECT t.holder_account_id AS account_id, t.started_at AS joined_at, true AS leader FROM t
    UNION ALL
    SELECT m.account_id, m.joined_at, false
    FROM kip_game.crew_members m, t
    WHERE m.tenure_id = t.tenure_id AND m.account_id <> t.holder_account_id
  ), v AS (
    SELECT t.*, EXISTS (SELECT 1 FROM crew WHERE crew.account_id = p_account_id) AS member,
      p_now < kip_game.protected_until(t.started_at) AS protected
    FROM t
  )
  SELECT jsonb_build_object(
    'parkId', v.park_id,
    'leader', (SELECT jsonb_build_object('handle', p.handle, 'flagSeed', p.flag_seed) FROM kip_game.players p WHERE p.account_id = v.holder_account_id),
    'members', coalesce((
      SELECT jsonb_agg(jsonb_build_object('handle', p.handle, 'flagSeed', p.flag_seed, 'joinedAt', crew.joined_at, 'leader', crew.leader)
        ORDER BY crew.leader DESC, crew.joined_at, p.handle)
      FROM crew JOIN kip_game.players p ON p.account_id = crew.account_id
    ), '[]'::jsonb),
    'size', (SELECT count(*) FROM crew),
    'cap', kip_game.crew_cap(),
    'flagSince', v.started_at,
    'protectedUntil', CASE WHEN v.protected THEN kip_game.protected_until(v.started_at) END,
    'member', v.member,
    'code', CASE WHEN v.member AND v.protected AND v.ended_at IS NULL THEN c.code END,
    'codeExpiresAt', CASE WHEN v.member AND v.protected AND v.ended_at IS NULL AND c.code IS NOT NULL THEN c.expires_at END
  )
  FROM v
  LEFT JOIN kip_game.crew_codes c ON c.tenure_id = v.tenure_id AND NOT c.released AND c.expires_at > p_now
$$;

-- The crew of the flag that is up at a park, or null.
CREATE OR REPLACE FUNCTION kip_game.park_crew(p_park_id text, p_account_id uuid, p_now timestamptz)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT kip_game.crew_json(t.tenure_id, p_account_id, p_now)
  FROM kip_game.tenures t
  WHERE t.park_id = p_park_id AND t.started_at <= p_now AND kip_game.flag_up(t.last_visit_at, t.ended_at, p_now)
  ORDER BY t.started_at DESC
  LIMIT 1
$$;

-- game_002's visit result, plus `protected` for a logged visit. A logged visit holds no flag,
-- so its flagSince is null.
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
    'flagSince', CASE WHEN v.outcome = 'logged' THEN NULL ELSE t.started_at END,
    'visitedAt', v.visited_at,
    'fell', v.closed_fallen,
    'protected', CASE WHEN v.outcome = 'logged' THEN kip_game.protected_json(v.tenure_id) END
  )
  FROM kip_game.visits v
  LEFT JOIN kip_game.tenures t ON t.tenure_id = v.tenure_id
  LEFT JOIN kip_game.tenures pt ON pt.tenure_id = v.previous_tenure_id
  LEFT JOIN kip_game.players pp ON pp.account_id = pt.holder_account_id
  WHERE v.account_id = p_account_id AND v.visit_id = p_visit_id
$$;

-- game_002's visit, with crews. Returns {status, visit?}; status is one of recorded, protected,
-- replayed, already_today, park_not_found, handle_required, account_unavailable, conflict.
--   - During someone else's protected hour an outsider's visit is logged (status protected):
--     +1, the flag is unchanged, and their flag action for the day is still unused.
--   - A crew member's visit is held (+1) and restarts the fall, like the holder's.
--   - A plant or a take adds the visitor as the crew's first member and issues the crew code.
CREATE OR REPLACE FUNCTION kip_game.record_visit(
  p_visit_id uuid, p_account_id uuid, p_park_id text, p_visited_at timestamptz
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_day date := kip_game.local_day(p_visited_at);
  v_open kip_game.tenures%ROWTYPE;
  v_has_open boolean;
  v_up boolean := false;
  v_member boolean := false;
  v_protected boolean := false;
  v_stored_park text;
  v_fell boolean := false;
  v_outcome text;
  v_day_bonus integer := 0;
  v_points integer;
  v_tenure_id uuid;
  v_previous_tenure_id uuid;
BEGIN
  -- Serialise every visit and crew join at one park, so plant, hold, take and join never race.
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
  IF v_has_open AND kip_game.fall_at(v_open.last_visit_at) > p_visited_at THEN
    v_up := true;
    v_member := kip_game.is_crew_member(v_open.tenure_id, p_account_id);
    v_protected := NOT v_member AND p_visited_at < kip_game.protected_until(v_open.started_at);
  END IF;

  -- One flag action a day; a logged visit does not use it, but there is at most one of those too.
  IF EXISTS (
    SELECT 1 FROM kip_game.visits
    WHERE account_id = p_account_id AND park_id = p_park_id AND local_day = v_day AND source = 'visit'
      AND (outcome <> 'logged' OR v_protected)
  ) THEN
    RETURN jsonb_build_object('status', 'already_today', 'visit', jsonb_build_object(
      'visitId', p_visit_id, 'parkId', p_park_id, 'outcome', 'already_today', 'pointsEarned', 0,
      'pointsBreakdown', jsonb_build_object('base', 0, 'days', 0),
      'previousHolder', NULL,
      'flagSince', CASE WHEN v_member THEN to_jsonb(v_open.started_at) ELSE NULL END,
      'visitedAt', p_visited_at, 'fell', false,
      'protected', CASE WHEN v_protected THEN kip_game.protected_json(v_open.tenure_id) END));
  END IF;

  IF v_protected THEN
    BEGIN
      INSERT INTO kip_game.visits
        (account_id, visit_id, park_id, visited_at, local_day, source, outcome, points_earned, day_bonus, tenure_id)
      VALUES
        (p_account_id, p_visit_id, p_park_id, p_visited_at, v_day, 'visit', 'logged', kip_game.visit_base_points('logged'), 0, v_open.tenure_id);
    EXCEPTION WHEN unique_violation THEN
      RETURN jsonb_build_object('status', 'conflict');
    END;
    RETURN jsonb_build_object('status', 'protected', 'visit', kip_game.visit_json(p_account_id, p_visit_id));
  END IF;

  BEGIN
    IF v_has_open AND NOT v_up THEN
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
    ELSIF v_member THEN
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

    IF v_outcome IN ('planted', 'took') THEN
      INSERT INTO kip_game.crew_members (tenure_id, account_id, joined_at, visit_id)
      VALUES (v_tenure_id, p_account_id, p_visited_at, p_visit_id);
      PERFORM kip_game.issue_crew_code(v_tenure_id, p_visited_at);
    END IF;
  EXCEPTION WHEN unique_violation THEN
    -- The same visit ID raced in for another park; the subtransaction undoes the flag changes.
    RETURN jsonb_build_object('status', 'conflict');
  END;

  RETURN jsonb_build_object('status', 'recorded', 'visit', kip_game.visit_json(p_account_id, p_visit_id));
END
$$;

-- Joins the crew whose protected hour has p_code, as a visit with outcome `joined` (+2). Takes
-- the same park lock as record_visit and is replay-safe on p_visit_id. Returns {status, visit?,
-- crew?}; status is one of joined, replayed, code_not_found, code_expired, crew_full,
-- already_today, already_member, handle_required, account_unavailable, conflict.
CREATE OR REPLACE FUNCTION kip_game.join_crew(
  p_account_id uuid, p_code text, p_visit_id uuid, p_now timestamptz
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_day date := kip_game.local_day(p_now);
  v_code kip_game.crew_codes%ROWTYPE;
  v_tenure kip_game.tenures%ROWTYPE;
  v_stored kip_game.visits%ROWTYPE;
BEGIN
  -- The newest window with this code: an open one, else the last that expired.
  SELECT c.* INTO v_code FROM kip_game.crew_codes c
  WHERE c.code = p_code ORDER BY c.released ASC, c.expires_at DESC LIMIT 1;
  IF FOUND THEN
    SELECT * INTO v_tenure FROM kip_game.tenures WHERE tenure_id = v_code.tenure_id;
    PERFORM pg_advisory_xact_lock(hashtextextended('kip_game.park:' || v_tenure.park_id, 0));
  END IF;

  SELECT * INTO v_stored FROM kip_game.visits WHERE account_id = p_account_id AND visit_id = p_visit_id;
  IF FOUND THEN
    -- A replay answers even after the code expired, as long as it names the same crew.
    IF v_stored.outcome <> 'joined' OR NOT EXISTS (
      SELECT 1 FROM kip_game.crew_codes WHERE tenure_id = v_stored.tenure_id AND code = p_code
    ) THEN
      RETURN jsonb_build_object('status', 'conflict');
    END IF;
    RETURN jsonb_build_object('status', 'replayed', 'visit', kip_game.visit_json(p_account_id, p_visit_id),
      'crew', kip_game.crew_json(v_stored.tenure_id, p_account_id, p_now));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM kip_account.accounts WHERE id = p_account_id AND deletion_state = 'active') THEN
    RETURN jsonb_build_object('status', 'account_unavailable');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM kip_game.players WHERE account_id = p_account_id) THEN
    RETURN jsonb_build_object('status', 'handle_required');
  END IF;
  IF v_code.tenure_id IS NULL THEN
    RETURN jsonb_build_object('status', 'code_not_found');
  END IF;

  SELECT * INTO v_tenure FROM kip_game.tenures WHERE tenure_id = v_code.tenure_id FOR UPDATE;
  IF v_code.released OR v_code.expires_at <= p_now OR v_tenure.ended_at IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'code_expired');
  END IF;
  IF kip_game.is_crew_member(v_tenure.tenure_id, p_account_id) THEN
    RETURN jsonb_build_object('status', 'already_member', 'crew', kip_game.crew_json(v_tenure.tenure_id, p_account_id, p_now));
  END IF;
  IF EXISTS (
    SELECT 1 FROM kip_game.visits
    WHERE account_id = p_account_id AND park_id = v_tenure.park_id AND local_day = v_day AND source = 'visit'
      AND outcome <> 'logged'
  ) THEN
    RETURN jsonb_build_object('status', 'already_today');
  END IF;
  IF kip_game.crew_size(v_tenure.tenure_id) >= kip_game.crew_cap() THEN
    RETURN jsonb_build_object('status', 'crew_full');
  END IF;

  BEGIN
    INSERT INTO kip_game.visits
      (account_id, visit_id, park_id, visited_at, local_day, source, outcome, points_earned, day_bonus, tenure_id)
    VALUES
      (p_account_id, p_visit_id, v_tenure.park_id, p_now, v_day, 'visit', 'joined', kip_game.visit_base_points('joined'), 0, v_tenure.tenure_id);
    INSERT INTO kip_game.crew_members (tenure_id, account_id, joined_at, visit_id)
    VALUES (v_tenure.tenure_id, p_account_id, p_now, p_visit_id);
    -- A member's visit restarts the fall, and joining is one.
    UPDATE kip_game.tenures SET last_visit_at = greatest(last_visit_at, p_now) WHERE tenure_id = v_tenure.tenure_id;
  EXCEPTION WHEN unique_violation THEN
    -- The same visit ID raced in for a visit elsewhere.
    RETURN jsonb_build_object('status', 'conflict');
  END;

  RETURN jsonb_build_object('status', 'joined', 'visit', kip_game.visit_json(p_account_id, p_visit_id),
    'crew', kip_game.crew_json(v_tenure.tenure_id, p_account_id, p_now));
END
$$;

-- Analytics event types for crews, added without rewriting anyone else's list. Other migrations
-- (game_002, social_001, badges) may widen the same two checks, in any order on replay. Instead
-- of re-adding a full list, this reads the live definitions and only adds what is missing:
--   - events_event_type_v2_check is rebuilt from the types it already has plus the crew types.
--   - events_shape_v2_check keeps its whole expression and gains one OR branch for crew types.
-- Both run only while a crew type is missing, so a replay changes nothing, and the earlier
-- founders_00x migrations keep finding their own markers and stay no-ops. NOT VALID: existing
-- rows met the narrower checks.
DO $$
DECLARE
  events regclass := to_regclass('kip_analytics.events');
  crew_types constant text[] := ARRAY['crew_joined', 'crew_code_shown', 'visit_logged_protected'];
  def text;
  existing text[];
  missing text[];
BEGIN
  IF events IS NULL THEN RETURN; END IF;

  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
  WHERE conrelid = events AND conname = 'events_event_type_v2_check';
  IF def IS NOT NULL THEN
    -- Every list so far is written as IN ('a', 'b'), which PostgreSQL shows as ARRAY['a'::text, ...].
    existing := ARRAY(SELECT DISTINCT m[1] FROM regexp_matches(def, '''([a-z0-9_]+)''::text', 'g') AS m);
    missing := ARRAY(SELECT t FROM unnest(crew_types) AS t WHERE NOT t = ANY (existing));
    IF cardinality(existing) < 5 THEN
      -- Never rebuild from a definition this could not read; crew events would only fail to record.
      RAISE WARNING 'events_event_type_v2_check has an unexpected definition; crew event types not added';
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
    missing := ARRAY(SELECT t FROM unnest(crew_types) AS t WHERE position('''' || t || '''' IN def) = 0);
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

-- Friends (#64): friend codes, mutual friendships and the weekly friends leaderboard.
-- Additive and idempotent: runs on every deploy after game_001_init.sql, because friends are flag
-- game players and the weekly board counts kip_game.visits.
CREATE SCHEMA IF NOT EXISTS kip_social;

-- Short codes people read aloud or type: 31 characters without 0, 1, I, L or O. Crew codes (#170)
-- use the same alphabet, so this generator takes a length and is not tied to friends.
CREATE OR REPLACE FUNCTION kip_social.random_code(p_length integer)
RETURNS text LANGUAGE plpgsql VOLATILE STRICT AS $$
DECLARE
  v_alphabet constant text := '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  v_code text := '';
  v_bytes bytea;
  v_byte integer;
BEGIN
  IF p_length NOT BETWEEN 4 AND 16 THEN RAISE EXCEPTION 'code length % is out of range', p_length; END IF;
  WHILE length(v_code) < p_length LOOP
    -- gen_random_uuid() reads the strong random source. Skip its version and variant bytes.
    v_bytes := uuid_send(gen_random_uuid());
    FOR i IN 0..15 LOOP
      CONTINUE WHEN i IN (6, 8);
      v_byte := get_byte(v_bytes, i);
      -- 248 is 8 * 31: rejecting the rest keeps every character equally likely.
      CONTINUE WHEN v_byte >= 248;
      v_code := v_code || substr(v_alphabet, v_byte % 31 + 1, 1);
      EXIT WHEN length(v_code) = p_length;
    END LOOP;
  END LOOP;
  RETURN v_code;
END
$$;

-- One permanent friend code per player. 8 characters (31^8, about 8.5e11) so codes cannot be guessed.
CREATE TABLE IF NOT EXISTS kip_social.friend_codes (
  account_id uuid PRIMARY KEY REFERENCES kip_account.accounts(id) ON DELETE CASCADE,
  code text NOT NULL UNIQUE CHECK (code ~ '^[2-9A-HJKMNP-Z]{8}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Friendships are mutual and stored in both directions, so every read is one indexed lookup.
CREATE TABLE IF NOT EXISTS kip_social.friendships (
  account_id uuid NOT NULL REFERENCES kip_account.accounts(id) ON DELETE CASCADE,
  friend_account_id uuid NOT NULL REFERENCES kip_account.accounts(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, friend_account_id),
  CHECK (account_id <> friend_account_id)
);

CREATE INDEX IF NOT EXISTS friendships_friend_idx
  ON kip_social.friendships (friend_account_id);

CREATE OR REPLACE FUNCTION kip_social.is_active_player(p_account_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM kip_game.players p
    JOIN kip_account.accounts a ON a.id = p.account_id AND a.deletion_state = 'active'
    WHERE p.account_id = p_account_id
  )
$$;

-- The player's friend code, created on first use. NULL without an active account and a handle.
CREATE OR REPLACE FUNCTION kip_social.ensure_friend_code(p_account_id uuid)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  v_code text;
BEGIN
  SELECT code INTO v_code FROM kip_social.friend_codes WHERE account_id = p_account_id;
  IF FOUND THEN RETURN v_code; END IF;
  IF NOT kip_social.is_active_player(p_account_id) THEN RETURN NULL; END IF;
  FOR attempt IN 1..8 LOOP
    BEGIN
      INSERT INTO kip_social.friend_codes (account_id, code) VALUES (p_account_id, kip_social.random_code(8))
      ON CONFLICT (account_id) DO NOTHING;
      SELECT code INTO v_code FROM kip_social.friend_codes WHERE account_id = p_account_id;
      RETURN v_code;
    EXCEPTION WHEN unique_violation THEN
      -- Another player already has this code; draw again.
    END;
  END LOOP;
  RAISE EXCEPTION 'could not allocate a friend code';
END
$$;

-- A new code for the player. The old code, its QR and its links stop working; friends stay.
CREATE OR REPLACE FUNCTION kip_social.reset_friend_code(p_account_id uuid)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  v_code text;
BEGIN
  IF NOT kip_social.is_active_player(p_account_id) THEN RETURN NULL; END IF;
  FOR attempt IN 1..8 LOOP
    BEGIN
      INSERT INTO kip_social.friend_codes (account_id, code) VALUES (p_account_id, kip_social.random_code(8))
      ON CONFLICT (account_id) DO UPDATE SET code = EXCLUDED.code, created_at = now()
      RETURNING code INTO v_code;
      RETURN v_code;
    EXCEPTION WHEN unique_violation THEN
    END;
  END LOOP;
  RAISE EXCEPTION 'could not allocate a friend code';
END
$$;

-- Adds a mutual friendship from a friend code. Returns {status, friend?}; status is one of
-- added, already_friends, own_code, code_not_found, handle_required, account_unavailable,
-- too_many_friends. Safe to replay: a second add of the same code answers already_friends.
CREATE OR REPLACE FUNCTION kip_social.add_friend(p_account_id uuid, p_code text, p_limit integer DEFAULT 200)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_friend uuid;
  v_handle text;
  v_seed text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM kip_account.accounts WHERE id = p_account_id AND deletion_state = 'active') THEN
    RETURN jsonb_build_object('status', 'account_unavailable');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM kip_game.players WHERE account_id = p_account_id) THEN
    RETURN jsonb_build_object('status', 'handle_required');
  END IF;

  SELECT c.account_id, p.handle, p.flag_seed INTO v_friend, v_handle, v_seed
  FROM kip_social.friend_codes c
  JOIN kip_game.players p ON p.account_id = c.account_id
  JOIN kip_account.accounts a ON a.id = c.account_id AND a.deletion_state = 'active'
  WHERE c.code = upper(p_code);
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'code_not_found'); END IF;
  IF v_friend = p_account_id THEN RETURN jsonb_build_object('status', 'own_code'); END IF;

  -- Lock both players in a fixed order so the friend limit holds when adds race.
  PERFORM pg_advisory_xact_lock(hashtextextended('kip_social.friends:' || least(p_account_id, v_friend)::text, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('kip_social.friends:' || greatest(p_account_id, v_friend)::text, 0));

  IF EXISTS (SELECT 1 FROM kip_social.friendships WHERE account_id = p_account_id AND friend_account_id = v_friend) THEN
    RETURN jsonb_build_object('status', 'already_friends', 'friend', jsonb_build_object('handle', v_handle, 'flagSeed', v_seed));
  END IF;
  IF (SELECT count(*) FROM kip_social.friendships WHERE account_id = p_account_id) >= p_limit
    OR (SELECT count(*) FROM kip_social.friendships WHERE account_id = v_friend) >= p_limit THEN
    RETURN jsonb_build_object('status', 'too_many_friends');
  END IF;

  INSERT INTO kip_social.friendships (account_id, friend_account_id) VALUES (p_account_id, v_friend), (v_friend, p_account_id)
  ON CONFLICT DO NOTHING;
  RETURN jsonb_build_object('status', 'added', 'friend', jsonb_build_object('handle', v_handle, 'flagSeed', v_seed));
END
$$;

-- Ends a friendship for both players. True when there was one.
CREATE OR REPLACE FUNCTION kip_social.remove_friend(p_account_id uuid, p_handle text)
RETURNS boolean LANGUAGE sql AS $$
  WITH friend AS (
    SELECT account_id FROM kip_game.players WHERE handle = lower(p_handle)
  ), removed AS (
    DELETE FROM kip_social.friendships f USING friend
    WHERE (f.account_id = p_account_id AND f.friend_account_id = friend.account_id)
       OR (f.account_id = friend.account_id AND f.friend_account_id = p_account_id)
    RETURNING 1
  )
  SELECT count(*) > 0 FROM removed
$$;

-- The game week: Monday to Sunday by the Victoria calendar, the same local day visits use.
CREATE OR REPLACE FUNCTION kip_social.week_start(p_now timestamptz)
RETURNS date LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT date_trunc('week', kip_game.local_day(p_now)::timestamp)::date
$$;

-- The player and their friends with the distinct parks each visited this week, best first.
-- Ties share a rank. Only active accounts with a handle appear.
CREATE OR REPLACE FUNCTION kip_social.friends_week(p_account_id uuid, p_now timestamptz)
RETURNS TABLE (rank integer, handle text, flag_seed text, unique_parks integer, is_me boolean)
LANGUAGE sql STABLE AS $$
  WITH members AS (
    SELECT p_account_id AS account_id
    UNION
    SELECT f.friend_account_id FROM kip_social.friendships f WHERE f.account_id = p_account_id
  ), scored AS (
    SELECT p.handle, p.flag_seed, m.account_id = p_account_id AS is_me,
      (SELECT count(DISTINCT v.park_id) FROM kip_game.visits v
        WHERE v.account_id = m.account_id AND v.source = 'visit'
          AND v.local_day BETWEEN kip_social.week_start(p_now) AND kip_social.week_start(p_now) + 6
          AND v.visited_at <= p_now)::integer AS unique_parks
    FROM members m
    JOIN kip_game.players p ON p.account_id = m.account_id
    JOIN kip_account.accounts a ON a.id = m.account_id AND a.deletion_state = 'active'
  )
  SELECT (rank() OVER (ORDER BY s.unique_parks DESC))::integer, s.handle, s.flag_seed, s.unique_parks, s.is_me
  FROM scored s
  ORDER BY s.unique_parks DESC, s.handle ASC
$$;

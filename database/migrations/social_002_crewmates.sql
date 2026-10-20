-- Crewmates become friends in one tap: players who held a park together as a crew (#170) can add
-- each other by handle, without scanning a friend code.
-- Additive and idempotent: runs on every deploy after social_001_friends.sql, whose friendships
-- and friend limit it shares, and game_003_crews.sql, whose crew members it reads.

-- True when both players were in the same crew: the leader (the tenure's holder) or a member who
-- joined. Any crew counts, during the protected hour or after the flag fell or was taken.
CREATE OR REPLACE FUNCTION kip_social.were_crewmates(p_account_id uuid, p_other_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1
    FROM (
      SELECT m.tenure_id FROM kip_game.crew_members m WHERE m.account_id = p_account_id
      UNION
      SELECT t.tenure_id FROM kip_game.tenures t WHERE t.holder_account_id = p_account_id
    ) mine
    WHERE kip_game.is_crew_member(mine.tenure_id, p_other_id)
  )
$$;

-- Adds a mutual friendship with a crewmate by handle. Returns {status, friend?}; status is one of
-- added, already_friends, own_handle, not_crewmates, handle_required, account_unavailable,
-- too_many_friends. An unknown handle answers not_crewmates too. Safe to replay like add_friend.
CREATE OR REPLACE FUNCTION kip_social.add_crewmate(p_account_id uuid, p_handle text, p_limit integer DEFAULT 200)
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

  SELECT p.account_id, p.handle, p.flag_seed INTO v_friend, v_handle, v_seed
  FROM kip_game.players p
  JOIN kip_account.accounts a ON a.id = p.account_id AND a.deletion_state = 'active'
  WHERE p.handle = lower(p_handle);
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'not_crewmates'); END IF;
  IF v_friend = p_account_id THEN RETURN jsonb_build_object('status', 'own_handle'); END IF;
  IF NOT kip_social.were_crewmates(p_account_id, v_friend) THEN
    RETURN jsonb_build_object('status', 'not_crewmates');
  END IF;

  -- The same locks as add_friend, in the same order, so the friend limit holds across both.
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

-- Crewmates can add each other by handle for a day only: a crew counts for 24 hours after its
-- flag went up (the tenure's started_at), which covers the protected hour and the rest of the
-- outing. After that, players add each other with a friend code like anyone else.
-- Additive and idempotent: runs on every deploy after social_002_crewmates.sql, whose
-- were_crewmates it redefines. add_crewmate calls were_crewmates, so it needs no change.

-- True when both players were in the same crew whose flag went up at or after p_since: the leader
-- (the tenure's holder) or a member who joined.
CREATE OR REPLACE FUNCTION kip_social.were_crewmates_since(p_account_id uuid, p_other_id uuid, p_since timestamptz)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1
    FROM (
      SELECT m.tenure_id FROM kip_game.crew_members m WHERE m.account_id = p_account_id
      UNION
      SELECT t.tenure_id FROM kip_game.tenures t WHERE t.holder_account_id = p_account_id
    ) mine
    JOIN kip_game.tenures t ON t.tenure_id = mine.tenure_id
    WHERE t.started_at >= p_since AND kip_game.is_crew_member(t.tenure_id, p_other_id)
  )
$$;

CREATE OR REPLACE FUNCTION kip_social.were_crewmates(p_account_id uuid, p_other_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT kip_social.were_crewmates_since(p_account_id, p_other_id, now() - interval '24 hours')
$$;

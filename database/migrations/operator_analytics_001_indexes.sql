-- Time indexes for the operator dashboard's analytics pages (operator/server/analytics/store.ts).
-- The game and founder tables are only indexed by account or park, so the daily charts and the
-- period tiles would otherwise scan them whole. Additive and idempotent: runs on every deploy
-- after game_001_init.sql and founders_001_init.sql. Each index is created only when missing,
-- so a replay takes no lock on these tables, and the founder indexes wait for their tables, so
-- the file also applies to a database that does not have founders_001 yet.
DO $$
BEGIN
  IF to_regclass('kip_game.visits_visited_at_idx') IS NULL THEN
    CREATE INDEX visits_visited_at_idx ON kip_game.visits (visited_at);
  END IF;
  IF to_regclass('kip_founders.photo_checks') IS NOT NULL AND to_regclass('kip_founders.photo_checks_created_idx') IS NULL THEN
    CREATE INDEX photo_checks_created_idx ON kip_founders.photo_checks (created_at);
  END IF;
  IF to_regclass('kip_founders.parks') IS NOT NULL AND to_regclass('kip_founders.parks_founded_at_idx') IS NULL THEN
    CREATE INDEX parks_founded_at_idx ON kip_founders.parks (founded_at);
  END IF;
  -- The accounts table pages newest first.
  IF to_regclass('kip_account.accounts_created_idx') IS NULL THEN
    CREATE INDEX accounts_created_idx ON kip_account.accounts (created_at DESC, id DESC);
  END IF;
END
$$;

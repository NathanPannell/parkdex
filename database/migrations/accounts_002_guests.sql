-- Guest accounts: a device-held account for a player who picked a @handle but hasn't signed in.
-- A guest has no email and no password until Google sign-in upgrades it in place and fills the email.
-- UNIQUE still holds for real emails; Postgres treats each NULL as distinct.
-- Migrations replay on every deploy, so the ALTER (an exclusive lock on a hot table) runs only once.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'kip_account.accounts'::regclass AND attname = 'normalized_email' AND attnotnull
  ) THEN
    ALTER TABLE kip_account.accounts ALTER COLUMN normalized_email DROP NOT NULL;
  END IF;
END
$$;

-- Sign in with Apple (iOS). Apple identities live beside Google ones, keyed by Apple's stable `sub`.
-- A signed-in account can link the other provider, the same way it links Google today.
-- The refresh token is kept only so deleting the account can revoke Sign in with Apple (App Store
-- guideline 5.1.1(v)). It is AES-GCM encrypted by the API before it reaches the database.
CREATE TABLE IF NOT EXISTS kip_account.apple_identities (
  provider text NOT NULL DEFAULT 'apple' CHECK (provider = 'apple'),
  subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 255),
  account_id uuid NOT NULL REFERENCES kip_account.accounts(id) ON DELETE CASCADE,
  linked_at timestamptz NOT NULL DEFAULT now(),
  refresh_token_ciphertext text
    CHECK (refresh_token_ciphertext IS NULL OR length(refresh_token_ciphertext) BETWEEN 1 AND 4096),
  refresh_token_updated_at timestamptz,
  PRIMARY KEY (provider, subject),
  CHECK ((refresh_token_ciphertext IS NULL) = (refresh_token_updated_at IS NULL))
);

CREATE INDEX IF NOT EXISTS apple_identities_account_idx
  ON kip_account.apple_identities (account_id, provider);

-- Sign-in nonces are shared by both providers; each one is bound to the provider that asked for it.
-- Migrations replay on every deploy, so the ALTER (an exclusive lock) runs only once.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'kip_account.google_challenges'::regclass AND attname = 'provider' AND NOT attisdropped
  ) THEN
    ALTER TABLE kip_account.google_challenges
      ADD COLUMN provider text NOT NULL DEFAULT 'google' CHECK (provider IN ('google', 'apple'));
  END IF;
END
$$;

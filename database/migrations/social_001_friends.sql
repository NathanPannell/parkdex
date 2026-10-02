-- Friends and the weekly friends leaderboard. Social features need an account;
-- rows go with the account through ON DELETE CASCADE.
CREATE SCHEMA IF NOT EXISTS kip_social;

-- A friend code is what the QR shows. Rotating it stops old codes from adding you.
CREATE TABLE IF NOT EXISTS kip_social.profiles (
  account_id uuid PRIMARY KEY REFERENCES kip_account.accounts(id) ON DELETE CASCADE,
  friend_code text NOT NULL UNIQUE CHECK (friend_code ~ '^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One row per pair, smaller id first, so a friendship is mutual by construction.
CREATE TABLE IF NOT EXISTS kip_social.friendships (
  account_low uuid NOT NULL REFERENCES kip_account.accounts(id) ON DELETE CASCADE,
  account_high uuid NOT NULL REFERENCES kip_account.accounts(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_low, account_high),
  CHECK (account_low < account_high)
);

CREATE INDEX IF NOT EXISTS friendships_high_idx ON kip_social.friendships (account_high);

-- The leaderboard counts distinct parks per account within a time window.
CREATE INDEX IF NOT EXISTS claims_account_claimed_at_idx
  ON kip_account.claims (account_id, claimed_at);

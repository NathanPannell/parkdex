CREATE SCHEMA IF NOT EXISTS kip_account;
CREATE SEQUENCE IF NOT EXISTS kip_account.progress_change_seq AS bigint;

CREATE TABLE IF NOT EXISTS kip_account.claims (
  account_id uuid NOT NULL REFERENCES kip_account.accounts(id) ON DELETE CASCADE,
  claim_id uuid NOT NULL,
  park_id text NOT NULL CHECK (length(park_id) BETWEEN 1 AND 160),
  claimed_at timestamptz NOT NULL,
  park_snapshot jsonb NOT NULL CHECK (jsonb_typeof(park_snapshot) = 'object' AND octet_length(park_snapshot::text) <= 8192),
  content_release_id text CHECK (content_release_id IS NULL OR length(content_release_id) <= 128),
  sync_revision bigint NOT NULL,
  payload_hash char(64) NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, claim_id),
  CHECK (park_snapshot->>'id' = park_id)
);

CREATE INDEX IF NOT EXISTS claims_account_revision_idx
  ON kip_account.claims (account_id, sync_revision, claim_id);

CREATE TABLE IF NOT EXISTS kip_account.claim_photos (
  account_id uuid NOT NULL,
  claim_id uuid NOT NULL,
  object_key text NOT NULL,
  content_type text NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  sha256 char(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 2621440),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready')),
  sync_revision bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, claim_id),
  UNIQUE (object_key),
  FOREIGN KEY (account_id, claim_id) REFERENCES kip_account.claims(account_id, claim_id) ON DELETE CASCADE,
  CHECK (object_key = 'accounts/' || account_id::text || '/claims/' || claim_id::text)
);

CREATE TABLE IF NOT EXISTS kip_account.account_deletion_photo_objects (
  receipt_id uuid NOT NULL,
  account_id uuid NOT NULL,
  claim_id uuid NOT NULL,
  object_key text NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (receipt_id, object_key),
  CHECK (object_key = 'accounts/' || account_id::text || '/claims/' || claim_id::text)
);

CREATE INDEX IF NOT EXISTS account_deletion_photo_objects_account_idx
  ON kip_account.account_deletion_photo_objects (account_id, created_at);

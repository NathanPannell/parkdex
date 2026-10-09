-- Publish history for over-the-air web bundles. Every move of an
-- app-bundles/channels/<channel>/current.json pointer gets one row: from the operator dashboard
-- (roll back, promote) and from scripts/publish-app-bundle.mjs --apply --record.
--
-- The pointer itself lives in R2; this table is the record of who moved it and why. It also lets
-- the dashboard repoint a channel at an older bundle, because a zip in R2 does not say which
-- native builds it needs. Both channels are recorded in production (Neon main), like build config.
CREATE TABLE IF NOT EXISTS kip_app_config.ota_publishes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel text NOT NULL CHECK (channel IN ('staging', 'production')),
  generation integer NOT NULL CHECK (generation >= 1),
  previous_generation integer CHECK (previous_generation IS NULL OR previous_generation >= 0),
  -- publish: a new bundle from the script. rollback: a bundle this channel ran before.
  -- promote: the other channel's current bundle. repoint: any other bundle already in R2.
  action text NOT NULL CHECK (action IN ('publish', 'rollback', 'promote', 'repoint')),
  source text NOT NULL CHECK (source IN ('dashboard', 'script')),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  previous_sha256 text CHECK (previous_sha256 IS NULL OR previous_sha256 ~ '^[a-f0-9]{64}$'),
  version text NOT NULL CHECK (length(version) BETWEEN 1 AND 64),
  byte_size bigint NOT NULL CHECK (byte_size > 0),
  minimum_native_build integer NOT NULL CHECK (minimum_native_build >= 1),
  maximum_native_build integer NOT NULL CHECK (maximum_native_build >= minimum_native_build),
  source_commit text NOT NULL CHECK (length(source_commit) BETWEEN 1 AND 64),
  -- confirmed: R2 and the CDN both returned the new pointer. cdn_pending: R2 has it but the CDN
  -- did not return it yet. conflict: the readback found another writer's pointer.
  outcome text NOT NULL CHECK (outcome IN ('confirmed', 'cdn_pending', 'conflict')),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 300),
  published_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

-- A retried --record run, or a retried dashboard request, must not add a second row.
CREATE UNIQUE INDEX IF NOT EXISTS ota_publishes_move_idx
  ON kip_app_config.ota_publishes (channel, generation, sha256);

CREATE INDEX IF NOT EXISTS ota_publishes_recent_idx
  ON kip_app_config.ota_publishes (recorded_at DESC, id DESC);

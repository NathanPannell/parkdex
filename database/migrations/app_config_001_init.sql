-- Per-build remote configuration. Production (Neon main) is the source of truth:
-- every app build checks in with web.parkdex.app to learn which content database
-- it should read and which feature flags are on. Build 0 holds each platform's defaults.
CREATE SCHEMA IF NOT EXISTS kip_app_config;

CREATE TABLE IF NOT EXISTS kip_app_config.builds (
  platform text NOT NULL CHECK (platform IN ('android', 'web')),
  build integer NOT NULL CHECK (build >= 0 AND build <= 2100000000),
  label text NOT NULL DEFAULT '' CHECK (length(label) <= 80),
  content_channel text CHECK (content_channel IS NULL OR content_channel IN ('staging', 'main')),
  flags jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(flags) = 'object'),
  notes text NOT NULL DEFAULT '' CHECK (length(notes) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (platform, build)
);

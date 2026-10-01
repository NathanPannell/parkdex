-- Update rules become global per environment, and each build gets an API pointer.
-- Builds 8 and earlier keep reading content_channel, which stays in step with api_pointer.
ALTER TABLE kip_app_config.builds ADD COLUMN IF NOT EXISTS api_pointer text
  CHECK (api_pointer IS NULL OR api_pointer IN ('production', 'staging'));

UPDATE kip_app_config.builds
   SET api_pointer = CASE content_channel WHEN 'main' THEN 'production' WHEN 'staging' THEN 'staging' END
 WHERE api_pointer IS NULL AND content_channel IS NOT NULL;

CREATE TABLE IF NOT EXISTS kip_app_config.update_rules (
  environment text PRIMARY KEY CHECK (environment IN ('production', 'staging')),
  -- Builds below the minimum must update; builds below the latest are nudged to.
  minimum_build integer CHECK (minimum_build IS NULL OR minimum_build >= 0),
  latest_build integer CHECK (latest_build IS NULL OR latest_build >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (minimum_build IS NULL OR latest_build IS NULL OR minimum_build <= latest_build)
);

-- Carry forward the Android default row's rules, which every build used to inherit.
INSERT INTO kip_app_config.update_rules (environment, minimum_build, latest_build)
SELECT 'production', minimum_build, latest_build FROM kip_app_config.builds
 WHERE platform = 'android' AND build = 0 AND (minimum_build IS NOT NULL OR latest_build IS NOT NULL)
ON CONFLICT (environment) DO NOTHING;

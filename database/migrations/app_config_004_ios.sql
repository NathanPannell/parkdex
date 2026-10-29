-- iOS builds check in as platform=ios. Their build is the TestFlight run number (the part of
-- CFBundleVersion before the dot), which has nothing to do with Android version codes.
-- Migrations replay on every deploy, so the constraint swap runs only once.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'kip_app_config.builds'::regclass AND conname = 'builds_platform_check'
      AND pg_get_constraintdef(oid) NOT LIKE '%ios%'
  ) THEN
    ALTER TABLE kip_app_config.builds DROP CONSTRAINT builds_platform_check;
    ALTER TABLE kip_app_config.builds
      ADD CONSTRAINT builds_platform_check CHECK (platform IN ('android', 'ios', 'web'));
  END IF;
END
$$;

-- One default row covers every iOS build, so a new TestFlight build never checks in to `flags: {}`.
-- It matches Android 19: friends on, crews and badges off. A null pointer keeps each build on the
-- server it was built for. Operators change it (or add per-build rows) on the Builds page; a replay
-- never overwrites their edits.
INSERT INTO kip_app_config.builds (platform, build, label, api_pointer, content_channel, flags, notes)
VALUES (
  'ios',
  0,
  'iOS default',
  NULL,
  NULL,
  '{"friends": true, "crews": false, "badges": false}'::jsonb,
  'Default for every iOS build. Seeded by app_config_004_ios.sql.'
)
ON CONFLICT (platform, build) DO NOTHING;

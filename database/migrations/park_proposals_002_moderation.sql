-- Park proposals can name an OpenStreetMap outline, and the moderation model's answers and the
-- resulting decision are kept with the proposal for the operator. Additive and repeat-safe.
ALTER TABLE kip_proposals.parks ADD COLUMN IF NOT EXISTS osm_type text CHECK (osm_type IS NULL OR osm_type IN ('way', 'relation'));
ALTER TABLE kip_proposals.parks ADD COLUMN IF NOT EXISTS osm_id bigint CHECK (osm_id IS NULL OR osm_id > 0);
-- approved: the model approved it (published_park_id says whether it went live).
-- rejected and unsure: the model's answer; the proposal waits for the operator.
-- skipped: no model check ran (no key, no outline, or the model or OpenStreetMap was unavailable).
ALTER TABLE kip_proposals.parks ADD COLUMN IF NOT EXISTS decision text CHECK (decision IS NULL OR decision IN ('approved', 'rejected', 'unsure', 'skipped'));
ALTER TABLE kip_proposals.parks ADD COLUMN IF NOT EXISTS moderation jsonb CHECK (moderation IS NULL OR jsonb_typeof(moderation) = 'object');
ALTER TABLE kip_proposals.parks ADD COLUMN IF NOT EXISTS decided_at timestamptz;
ALTER TABLE kip_proposals.parks ADD COLUMN IF NOT EXISTS published_park_id text CHECK (published_park_id IS NULL OR published_park_id ~ '^[a-z0-9][a-z0-9-]*$');

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'kip_proposals.parks'::regclass AND conname = 'parks_osm_pair_check') THEN
    ALTER TABLE kip_proposals.parks ADD CONSTRAINT parks_osm_pair_check CHECK ((osm_type IS NULL) = (osm_id IS NULL));
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS parks_osm_idx ON kip_proposals.parks (osm_type, osm_id) WHERE osm_id IS NOT NULL;

-- Park drafts imported from the legacy map app (map.parkdex.app) in the operator dashboard.
-- Drafts are never part of synchronized content: phones only see a park once publication
-- inserts it into public.parks in one transaction.
CREATE SCHEMA IF NOT EXISTS kip_park_drafts;

CREATE TABLE IF NOT EXISTS kip_park_drafts.drafts (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9-]*$' AND length(id) <= 160),
  -- The legacy places record and boundary properties exactly as fetched, for provenance and AI briefs.
  source jsonb NOT NULL CHECK (jsonb_typeof(source) = 'object'),
  source_sha256 char(64) NOT NULL,
  geometry jsonb NOT NULL CHECK (jsonb_typeof(geometry) = 'object'),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 140),
  short text NOT NULL DEFAULT '' CHECK (length(short) <= 140),
  category text CHECK (category IS NULL OR category IN ('national', 'provincial', 'regional', 'municipal', 'community')),
  region text NOT NULL CHECK (length(region) <= 140),
  lat double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng double precision NOT NULL CHECK (lng BETWEEN -180 AND 180),
  biome text NOT NULL DEFAULT 'forest' CHECK (biome IN ('coast', 'forest', 'mountain', 'lake', 'waterfall', 'river', 'cave', 'marsh', 'heritage')),
  shape text NOT NULL DEFAULT 'circle' CHECK (shape IN ('circle', 'hex', 'shield', 'arch', 'seal')),
  rarity text CHECK (rarity IS NULL OR rarity IN ('common', 'uncommon', 'rare', 'epic', 'legendary')),
  seed integer NOT NULL CHECK (seed BETWEEN 0 AND 1000000),
  blurb text NOT NULL DEFAULT '' CHECK (length(blurb) <= 800),
  scene text CHECK (scene IS NULL OR scene ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  badge_webp bytea CHECK (badge_webp IS NULL OR octet_length(badge_webp) BETWEEN 1 AND 4194304),
  reference_photo bytea CHECK (reference_photo IS NULL OR octet_length(reference_photo) BETWEEN 1 AND 4194304),
  reference_photo_type text CHECK (reference_photo_type IS NULL OR reference_photo_type IN ('image/jpeg', 'image/png', 'image/webp')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  published_at timestamptz,
  published_revision bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((badge_webp IS NULL) = (scene IS NULL)),
  CHECK ((reference_photo IS NULL) = (reference_photo_type IS NULL)),
  CHECK ((status = 'published') = (published_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS drafts_updated_at_idx ON kip_park_drafts.drafts (updated_at DESC);

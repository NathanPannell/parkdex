-- Parks that players propose from the app: a pin, a name and an optional rough outline.
-- Operators review them in the operator area; accepted parks are authored separately.
CREATE SCHEMA IF NOT EXISTS kip_proposals;

CREATE TABLE IF NOT EXISTS kip_proposals.parks (
  id uuid PRIMARY KEY,
  submission_id uuid NOT NULL UNIQUE,
  payload_hash char(64) NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 1000),
  longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  outline jsonb CHECK (outline IS NULL OR jsonb_typeof(outline) = 'array'),
  context jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(context) = 'object'),
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'reviewing', 'accepted', 'declined')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS parks_created_at_idx ON kip_proposals.parks (created_at DESC);

CREATE TABLE IF NOT EXISTS kip_proposals.rate_limits (
  subject_hash char(64) PRIMARY KEY,
  window_started_at timestamptz NOT NULL,
  hit_count integer NOT NULL CHECK (hit_count > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

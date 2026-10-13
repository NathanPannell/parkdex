-- Several OpenStreetMap extracts side by side (British Columbia, Nova Scotia, ...). Every outline
-- names the extract it came from, and kip_osm.source holds one row per extract, so loading one
-- province replaces only that province's outlines. Outlines loaded before this migration came
-- from the British Columbia extract, so they become source 'bc'.
--
-- Additive and repeat-safe: every change is guarded by a catalogue check, so a replay on deploy
-- takes no lock on kip_osm.parks, which the founding search reads. The singleton column of
-- kip_osm.source is dropped on purpose: a loader from before this migration would otherwise
-- empty the whole table when it loads one province.
DO $$
BEGIN
  IF to_regclass('kip_osm.parks') IS NULL OR to_regclass('kip_osm.source') IS NULL THEN
    RAISE EXCEPTION 'osm_parks_001_init.sql must run before osm_parks_002_sources.sql';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute WHERE attrelid = 'kip_osm.parks'::regclass AND attname = 'source_id' AND NOT attisdropped
  ) THEN
    -- A constant default is kept in the catalogue, so existing rows read 'bc' without a rewrite.
    -- Tools that insert outlines without naming a source keep working and mean British Columbia.
    ALTER TABLE kip_osm.parks
      ADD COLUMN source_id text NOT NULL DEFAULT 'bc'
      CONSTRAINT parks_source_id_check CHECK (source_id ~ '^[a-z0-9][a-z0-9-]{0,39}$');
  END IF;

  -- The loader deletes and counts one source's outlines at a time.
  IF to_regclass('kip_osm.parks_source_idx') IS NULL THEN
    CREATE INDEX parks_source_idx ON kip_osm.parks (source_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute WHERE attrelid = 'kip_osm.source'::regclass AND attname = 'source_id' AND NOT attisdropped
  ) THEN
    ALTER TABLE kip_osm.source ADD COLUMN source_id text;
    UPDATE kip_osm.source SET source_id = 'bc';
    -- Dropping the column drops its primary key and its CHECK (singleton) with it.
    ALTER TABLE kip_osm.source DROP COLUMN IF EXISTS singleton;
    ALTER TABLE kip_osm.source
      ALTER COLUMN source_id SET NOT NULL,
      ADD CONSTRAINT source_pkey PRIMARY KEY (source_id),
      ADD CONSTRAINT source_source_id_check CHECK (source_id ~ '^[a-z0-9][a-z0-9-]{0,39}$');
  END IF;
END
$$;

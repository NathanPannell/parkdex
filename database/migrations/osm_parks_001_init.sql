-- Our own copy of OpenStreetMap park outlines, so "propose a park" can find the park around a
-- pin without live Overpass or Nominatim. Loaded by scripts/osm_park_index.py from a Geofabrik
-- extract; never part of synchronized content. Additive and repeat-safe. No PostGIS: the API
-- narrows by bounding box here and does the exact containment and distance test itself.
CREATE SCHEMA IF NOT EXISTS kip_osm;

CREATE TABLE IF NOT EXISTS kip_osm.parks (
  osm_type text NOT NULL CHECK (osm_type IN ('way', 'relation')),
  osm_id bigint NOT NULL CHECK (osm_id > 0),
  name text CHECK (name IS NULL OR length(name) BETWEEN 1 AND 300),
  -- The tag that made it park-like, such as leisure=park.
  kind text NOT NULL CHECK (kind ~ '^(leisure|boundary|landuse)=[a-z_]+$'),
  tags jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(tags) = 'object'),
  min_lat double precision NOT NULL CHECK (min_lat BETWEEN -90 AND 90),
  max_lat double precision NOT NULL CHECK (max_lat BETWEEN -90 AND 90),
  min_lng double precision NOT NULL CHECK (min_lng BETWEEN -180 AND 180),
  max_lng double precision NOT NULL CHECK (max_lng BETWEEN -180 AND 180),
  area_m2 double precision NOT NULL CHECK (area_m2 >= 0),
  -- A GeoJSON MultiPolygon, simplified to about 5 m with every part and hole kept.
  geometry jsonb NOT NULL CHECK (jsonb_typeof(geometry) = 'object' AND geometry->>'type' = 'MultiPolygon'),
  source_date timestamptz NOT NULL,
  PRIMARY KEY (osm_type, osm_id),
  CHECK (min_lat <= max_lat AND min_lng <= max_lng)
);

-- Searches ask for outlines whose box overlaps a box around the pin.
CREATE INDEX IF NOT EXISTS parks_bbox_idx ON kip_osm.parks (min_lat, max_lat, min_lng, max_lng);

-- Which extract the table holds, so a reload of the same extract is a no-op.
CREATE TABLE IF NOT EXISTS kip_osm.source (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  source_date timestamptz NOT NULL,
  source_sha256 char(64) NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  source_name text NOT NULL CHECK (length(source_name) BETWEEN 1 AND 200),
  row_count integer NOT NULL CHECK (row_count >= 0),
  loaded_at timestamptz NOT NULL DEFAULT now()
);

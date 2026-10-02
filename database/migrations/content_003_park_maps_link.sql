-- Optional access details per park, filled in by research after import.
-- google_maps_url: where external directions go, usually the parking lot.
-- trailhead_lat/lng: where the in-app approach line ends.
-- When they are null the app keeps using the park's lat/lng and boundary.
-- Builds installed before 2026-10-01 reject unknown park fields, so the API
-- serves these only to readers that ask for them (see content-sync-contract.md).

ALTER TABLE public.parks ADD COLUMN IF NOT EXISTS google_maps_url text;
ALTER TABLE public.parks ADD COLUMN IF NOT EXISTS trailhead_lat double precision;
ALTER TABLE public.parks ADD COLUMN IF NOT EXISTS trailhead_lng double precision;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.parks'::regclass AND conname = 'content_parks_google_maps_url_check') THEN
        -- Only Google Maps hosts, because the app opens this link outside itself.
        ALTER TABLE public.parks ADD CONSTRAINT content_parks_google_maps_url_check CHECK (
            google_maps_url IS NULL OR (
                length(google_maps_url) <= 2048
                AND google_maps_url ~ '^https://(?:(?:www\.)?google\.[a-z]{2,3}(?:\.[a-z]{2})?/maps(?:[/?#]\S*)?|maps\.google\.[a-z]{2,3}(?:\.[a-z]{2})?(?:[/?#]\S*)?|maps\.app\.goo\.gl/\S+|goo\.gl/maps/\S+)$'
            )
        );
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.parks'::regclass AND conname = 'content_parks_trailhead_check') THEN
        ALTER TABLE public.parks ADD CONSTRAINT content_parks_trailhead_check CHECK (
            (trailhead_lat IS NULL AND trailhead_lng IS NULL)
            OR (trailhead_lat BETWEEN -90 AND 90 AND trailhead_lng BETWEEN -180 AND 180)
        );
    END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.content_park_json(p_row public.parks)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT jsonb_build_object(
        'id', p_row.id,
        'name', p_row.name,
        'short', p_row.short,
        'category', p_row.category,
        'region', p_row.region,
        'lat', p_row.lat,
        'lng', p_row.lng,
        'biome', p_row.biome,
        'shape', p_row.shape,
        'rarity', p_row.rarity,
        'scene', p_row.scene,
        'seed', p_row.seed,
        'blurb', p_row.blurb,
        'googleMapsUrl', p_row.google_maps_url,
        'trailheadLat', p_row.trailhead_lat,
        'trailheadLng', p_row.trailhead_lng
    )
$$;

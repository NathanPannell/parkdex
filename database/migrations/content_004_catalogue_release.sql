-- Large catalogues for newer readers. This migration is additive and repeat-safe.
--
-- Installed builds and the content API reject responses over 4 MiB. Parks that
-- only newer readers may see get a row in content_park_reader_floor; the
-- snapshot and changes API leave them out for older readers. Newer readers load
-- the whole catalogue from an immutable CDN release named by content_catalogue,
-- then apply /api/content/changes after that release's revision.
--
-- Neither table has content triggers: changing them emits no content revision.

CREATE TABLE IF NOT EXISTS public.content_park_reader_floor (
    park_id text PRIMARY KEY REFERENCES public.parks(id) ON DELETE CASCADE,
    minimum_reader integer NOT NULL CHECK (minimum_reader BETWEEN 2 AND 9999),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS content_park_reader_floor_reader_idx
    ON public.content_park_reader_floor (minimum_reader, park_id);

CREATE TABLE IF NOT EXISTS public.content_catalogue (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    version text NOT NULL CHECK (version ~ '^[a-f0-9]{64}$'),
    revision bigint NOT NULL CHECK (revision >= 0),
    minimum_reader integer NOT NULL CHECK (minimum_reader BETWEEN 2 AND 9999),
    index_url text NOT NULL,
    index_sha256 text NOT NULL CHECK (index_sha256 ~ '^[a-f0-9]{64}$'),
    index_bytes integer NOT NULL CHECK (index_bytes BETWEEN 1 AND 4194304),
    park_count integer NOT NULL CHECK (park_count >= 0),
    published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (index_url = 'https://kip-assets.parkdex.app/releases/' || version || '/catalogue/index.json')
);

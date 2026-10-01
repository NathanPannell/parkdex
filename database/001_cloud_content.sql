CREATE TABLE IF NOT EXISTS public.parks (
    id text PRIMARY KEY,
    name text NOT NULL,
    short text NOT NULL,
    category text NOT NULL,
    region text NOT NULL,
    lat double precision NOT NULL,
    lng double precision NOT NULL,
    biome text NOT NULL,
    shape text NOT NULL,
    rarity text NOT NULL,
    scene text,
    seed integer NOT NULL,
    blurb text NOT NULL
);

CREATE TABLE IF NOT EXISTS public.boundaries (
    park_id text PRIMARY KEY REFERENCES public.parks(id),
    feature jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS public.r2_objects (
    logical_path text PRIMARY KEY,
    object_key text NOT NULL UNIQUE,
    url text NOT NULL,
    sha256 text NOT NULL,
    byte_size bigint NOT NULL,
    content_type text NOT NULL
);

CREATE TABLE IF NOT EXISTS public.version_manifests (
    version text PRIMARY KEY,
    manifest jsonb NOT NULL
);

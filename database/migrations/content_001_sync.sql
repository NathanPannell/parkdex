-- Public catalogue sync. This migration is additive and repeat-safe.
-- Existing parks, boundaries, R2 objects and immutable release manifests stay in place.

CREATE TABLE IF NOT EXISTS public.content_clock (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
    retention_floor bigint NOT NULL DEFAULT 0 CHECK (retention_floor >= 0 AND retention_floor <= revision),
    last_transaction_id bigint
);

CREATE TABLE IF NOT EXISTS public.content_bootstrap_receipt (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    manifest_version text NOT NULL CHECK (manifest_version ~ '^[a-f0-9]{64}$'),
    manifest_url text NOT NULL CHECK (manifest_url = 'https://kip-assets.parkdex.app/releases/' || manifest_version || '/manifest.json'),
    manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^[a-f0-9]{64}$'),
    applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

ALTER TABLE public.content_bootstrap_receipt ADD COLUMN IF NOT EXISTS manifest_url text NOT NULL DEFAULT '';
ALTER TABLE public.content_bootstrap_receipt ADD COLUMN IF NOT EXISTS manifest_sha256 text NOT NULL DEFAULT repeat('0', 64);
ALTER TABLE public.content_bootstrap_receipt DROP CONSTRAINT IF EXISTS content_bootstrap_receipt_manifest_url_check;
ALTER TABLE public.content_bootstrap_receipt ADD CONSTRAINT content_bootstrap_receipt_manifest_url_check
    CHECK (manifest_url = 'https://kip-assets.parkdex.app/releases/' || manifest_version || '/manifest.json');
ALTER TABLE public.content_bootstrap_receipt DROP CONSTRAINT IF EXISTS content_bootstrap_receipt_manifest_sha256_check;
ALTER TABLE public.content_bootstrap_receipt ADD CONSTRAINT content_bootstrap_receipt_manifest_sha256_check
    CHECK (manifest_sha256 ~ '^[a-f0-9]{64}$');

INSERT INTO public.content_clock (singleton, revision, retention_floor, last_transaction_id)
VALUES (true, 0, 0, NULL)
ON CONFLICT (singleton) DO NOTHING;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conrelid = 'public.boundaries'::regclass
           AND conname = 'boundaries_park_id_fkey'
           AND confdeltype <> 'c'
    ) THEN
        ALTER TABLE public.boundaries DROP CONSTRAINT boundaries_park_id_fkey;
    END IF;
    IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conrelid = 'public.boundaries'::regclass
           AND conname = 'boundaries_park_id_fkey'
    ) THEN
        ALTER TABLE public.boundaries
            ADD CONSTRAINT boundaries_park_id_fkey
            FOREIGN KEY (park_id) REFERENCES public.parks(id) ON DELETE CASCADE;
    END IF;
END
$$;

CREATE TABLE IF NOT EXISTS public.content_change_batches (
    revision bigint PRIMARY KEY CHECK (revision > 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS public.content_changes (
    revision bigint NOT NULL REFERENCES public.content_change_batches(revision) ON DELETE CASCADE,
    entity text NOT NULL CHECK (entity IN ('park', 'boundary', 'drive', 'asset', 'hubs', 'map')),
    entity_id text NOT NULL,
    operation text NOT NULL CHECK (operation IN ('upsert', 'delete')),
    value jsonb,
    PRIMARY KEY (revision, entity, entity_id),
    CHECK ((operation = 'upsert' AND value IS NOT NULL) OR (operation = 'delete' AND value IS NULL))
);

CREATE INDEX IF NOT EXISTS content_changes_revision_idx
    ON public.content_changes (revision, entity, entity_id);

CREATE TABLE IF NOT EXISTS public.drive_hubs (
    position integer PRIMARY KEY CHECK (position >= 0),
    name text NOT NULL CHECK (length(btrim(name)) > 0),
    lng double precision NOT NULL CHECK (lng BETWEEN -180 AND 180),
    lat double precision NOT NULL CHECK (lat BETWEEN -90 AND 90)
);

CREATE TABLE IF NOT EXISTS public.park_drive_settings (
    park_id text PRIMARY KEY REFERENCES public.parks(id) ON DELETE CASCADE,
    walk_m double precision NOT NULL CHECK (walk_m >= 0 AND walk_m < 'Infinity'::double precision)
);

CREATE TABLE IF NOT EXISTS public.park_drive (
    park_id text NOT NULL REFERENCES public.parks(id) ON DELETE CASCADE,
    hub_position integer NOT NULL REFERENCES public.drive_hubs(position) ON DELETE CASCADE,
    distance_km double precision CHECK (distance_km IS NULL OR (distance_km >= 0 AND distance_km < 'Infinity'::double precision)),
    duration_min double precision CHECK (duration_min IS NULL OR (duration_min >= 0 AND duration_min < 'Infinity'::double precision)),
    PRIMARY KEY (park_id, hub_position),
    CHECK ((distance_km IS NULL) = (duration_min IS NULL))
);

CREATE TABLE IF NOT EXISTS public.content_map (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    version text NOT NULL CHECK (version ~ '^[a-f0-9]{64}$'),
    manifest_url text NOT NULL,
    manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^[a-f0-9]{64}$')
);

ALTER TABLE public.content_map DROP CONSTRAINT IF EXISTS content_map_manifest_url_check;
ALTER TABLE public.content_map ADD CONSTRAINT content_map_manifest_url_check
    CHECK (manifest_url = 'https://kip-assets.parkdex.app/releases/' || version || '/map/manifest.json');

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.parks'::regclass AND conname = 'content_parks_category_check') THEN
        ALTER TABLE public.parks ADD CONSTRAINT content_parks_category_check
            CHECK (category IN ('national', 'provincial', 'regional', 'municipal', 'community')) NOT VALID;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.parks'::regclass AND conname = 'content_parks_id_check') THEN
        ALTER TABLE public.parks ADD CONSTRAINT content_parks_id_check
            CHECK (id ~ '^[a-z0-9][a-z0-9-]*$') NOT VALID;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.parks'::regclass AND conname = 'content_parks_name_check') THEN
        ALTER TABLE public.parks ADD CONSTRAINT content_parks_name_check
            CHECK (name <> '') NOT VALID;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.parks'::regclass AND conname = 'content_parks_short_check') THEN
        ALTER TABLE public.parks ADD CONSTRAINT content_parks_short_check
            CHECK (short <> '') NOT VALID;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.parks'::regclass AND conname = 'content_parks_biome_check') THEN
        ALTER TABLE public.parks ADD CONSTRAINT content_parks_biome_check
            CHECK (biome IN ('coast', 'forest', 'mountain', 'lake', 'waterfall', 'river', 'cave', 'marsh', 'heritage')) NOT VALID;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.parks'::regclass AND conname = 'content_parks_shape_check') THEN
        ALTER TABLE public.parks ADD CONSTRAINT content_parks_shape_check
            CHECK (shape IN ('circle', 'hex', 'shield', 'arch', 'seal')) NOT VALID;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.parks'::regclass AND conname = 'content_parks_rarity_check') THEN
        ALTER TABLE public.parks ADD CONSTRAINT content_parks_rarity_check
            CHECK (rarity IN ('common', 'uncommon', 'rare', 'epic', 'legendary')) NOT VALID;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.parks'::regclass AND conname = 'content_parks_coordinates_check') THEN
        ALTER TABLE public.parks ADD CONSTRAINT content_parks_coordinates_check
            CHECK (lat BETWEEN -90 AND 90 AND lng BETWEEN -180 AND 180) NOT VALID;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.parks'::regclass AND conname = 'content_parks_scene_slug_check') THEN
        ALTER TABLE public.parks ADD CONSTRAINT content_parks_scene_slug_check
            CHECK (scene IS NULL OR scene ~ '^[a-z0-9]+(-[a-z0-9]+)*$') NOT VALID;
    END IF;
    ALTER TABLE public.parks VALIDATE CONSTRAINT content_parks_category_check;
    ALTER TABLE public.parks VALIDATE CONSTRAINT content_parks_id_check;
    ALTER TABLE public.parks VALIDATE CONSTRAINT content_parks_name_check;
    ALTER TABLE public.parks VALIDATE CONSTRAINT content_parks_short_check;
    ALTER TABLE public.parks VALIDATE CONSTRAINT content_parks_biome_check;
    ALTER TABLE public.parks VALIDATE CONSTRAINT content_parks_shape_check;
    ALTER TABLE public.parks VALIDATE CONSTRAINT content_parks_rarity_check;
    ALTER TABLE public.parks VALIDATE CONSTRAINT content_parks_coordinates_check;
    ALTER TABLE public.parks VALIDATE CONSTRAINT content_parks_scene_slug_check;
END
$$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.drive_hubs'::regclass AND conname = 'content_drive_hubs_name_check') THEN
        ALTER TABLE public.drive_hubs ADD CONSTRAINT content_drive_hubs_name_check
            CHECK (name ~ '[^[:space:]]') NOT VALID;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.park_drive_settings'::regclass AND conname = 'content_park_drive_settings_walk_m_check') THEN
        ALTER TABLE public.park_drive_settings ADD CONSTRAINT content_park_drive_settings_walk_m_check
            CHECK (walk_m BETWEEN 0 AND 9007199254740991::double precision) NOT VALID;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.park_drive'::regclass AND conname = 'content_park_drive_values_check') THEN
        ALTER TABLE public.park_drive ADD CONSTRAINT content_park_drive_values_check
            CHECK (
                (distance_km IS NULL OR distance_km BETWEEN 0 AND 9007199254740991::double precision)
                AND (duration_min IS NULL OR duration_min BETWEEN 0 AND 9007199254740991::double precision)
            ) NOT VALID;
    END IF;
    ALTER TABLE public.drive_hubs VALIDATE CONSTRAINT content_drive_hubs_name_check;
    ALTER TABLE public.park_drive_settings VALIDATE CONSTRAINT content_park_drive_settings_walk_m_check;
    ALTER TABLE public.park_drive VALIDATE CONSTRAINT content_park_drive_values_check;
END
$$;

CREATE OR REPLACE FUNCTION public.content_next_revision()
RETURNS bigint
LANGUAGE sql
AS $$
    -- The clock row is both the revision allocator and the per-transaction cache.
    -- Its row lock lasts through commit, so revisions cannot become visible out of order.
    UPDATE public.content_clock
       SET revision = revision + CASE
             WHEN last_transaction_id = txid_current() THEN 0
             ELSE 1
           END,
           last_transaction_id = txid_current()
     WHERE singleton = true
     RETURNING revision
$$;

CREATE OR REPLACE FUNCTION public.content_record_change(
    p_entity text,
    p_id text,
    p_operation text,
    p_value jsonb
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    v_revision bigint;
BEGIN
    v_revision := public.content_next_revision();
    INSERT INTO public.content_change_batches (revision)
    VALUES (v_revision)
    ON CONFLICT (revision) DO NOTHING;

    INSERT INTO public.content_changes (revision, entity, entity_id, operation, value)
    VALUES (v_revision, p_entity, p_id, p_operation, p_value)
    ON CONFLICT (revision, entity, entity_id) DO UPDATE
       SET operation = EXCLUDED.operation,
           value = EXCLUDED.value;
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
        'blurb', p_row.blurb
    )
$$;

CREATE OR REPLACE FUNCTION public.content_guard_park_scene()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.scene IS NOT NULL AND NOT EXISTS (
        SELECT 1
          FROM public.r2_objects AS asset
         WHERE asset.logical_path = 'art/badges/scenes/' || NEW.scene || '.webp'
    ) THEN
        RAISE EXCEPTION 'park % scene % has no registered immutable badge asset', NEW.id, NEW.scene
            USING ERRCODE = '23503';
    END IF;
    RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.content_guard_park_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id THEN
        RAISE EXCEPTION 'park ids are immutable content identities' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.content_guard_boundary_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.park_id IS DISTINCT FROM OLD.park_id THEN
        RAISE EXCEPTION 'boundary park ids are immutable content identities' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.content_guard_scene_asset()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF OLD.logical_path LIKE 'art/badges/scenes/%' AND NEW IS DISTINCT FROM OLD THEN
            RAISE EXCEPTION 'badge asset descriptors are immutable; register a new scene path'
                USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;

    IF TG_OP = 'DELETE' AND OLD.logical_path LIKE 'art/badges/scenes/%' THEN
        RAISE EXCEPTION 'badge asset descriptors are retained for earned artwork'
            USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
END
$$;

CREATE OR REPLACE FUNCTION public.content_validate_scene_asset()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_release_id text;
    v_legacy_descriptor_matches boolean := false;
BEGIN
    IF NEW.logical_path LIKE 'art/badges/scenes/%' THEN
        IF NEW.logical_path !~ '^art/badges/scenes/[a-z0-9]+(-[a-z0-9]+)*[.]webp$'
           OR NEW.object_key !~ '^releases/[a-f0-9]{64}/art/badges/scenes/[a-z0-9]+(-[a-z0-9]+)*[.]webp$'
           OR NEW.object_key !~ ('^releases/[a-f0-9]{64}/' || regexp_replace(NEW.logical_path, '[.]', '[.]', 'g') || '$')
           OR NEW.url IS DISTINCT FROM 'https://kip-assets.parkdex.app/' || NEW.object_key
           OR NEW.sha256 !~ '^[a-f0-9]{64}$'
           OR NEW.byte_size <= 0
           OR NEW.byte_size > 4194304
           OR NEW.content_type IS DISTINCT FROM 'image/webp' THEN
            RAISE EXCEPTION 'badge descriptor is invalid or not on the approved immutable CDN'
                USING ERRCODE = '23514';
        END IF;
        v_release_id := substring(NEW.object_key FROM '^releases/([a-f0-9]{64})/');
        IF v_release_id IS DISTINCT FROM NEW.sha256 THEN
            SELECT EXISTS (
                SELECT 1
                  FROM public.version_manifests AS release,
                       LATERAL jsonb_array_elements(
                           CASE WHEN jsonb_typeof(release.manifest->'files') = 'array'
                                THEN release.manifest->'files' ELSE '[]'::jsonb END
                       ) AS file(value)
                 WHERE release.version = v_release_id
                   AND release.manifest->>'version' = release.version
                   AND file.value->>'path' = NEW.logical_path
                   AND file.value->>'key' = NEW.object_key
                   AND file.value->>'url' = NEW.url
                   AND file.value->>'sha256' = NEW.sha256
                   AND file.value->>'byte_size' = NEW.byte_size::text
                   AND file.value->>'content_type' = NEW.content_type
            ) INTO v_legacy_descriptor_matches;
            IF NOT v_legacy_descriptor_matches THEN
                RAISE EXCEPTION 'legacy badge key is not listed in a pinned immutable release manifest'
                    USING ERRCODE = '23514';
            END IF;
        END IF;
    END IF;
    RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.content_drive_json(p_park_id text)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
    SELECT jsonb_build_object(
        'drive', COALESCE(
            jsonb_agg(
                CASE
                    WHEN route.distance_km IS NULL THEN 'null'::jsonb
                    ELSE jsonb_build_array(route.distance_km, route.duration_min)
                END
                ORDER BY hub.position
            ),
            '[]'::jsonb
        ),
        'walkM', settings.walk_m
    )
      FROM public.park_drive_settings AS settings
      LEFT JOIN public.drive_hubs AS hub ON true
      LEFT JOIN public.park_drive AS route
        ON route.park_id = settings.park_id
       AND route.hub_position = hub.position
     WHERE settings.park_id = p_park_id
     GROUP BY settings.walk_m
$$;

CREATE OR REPLACE FUNCTION public.content_hubs_json()
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
    SELECT COALESCE(
        jsonb_agg(jsonb_build_object('name', name, 'lng', lng, 'lat', lat) ORDER BY position),
        '[]'::jsonb
    )
      FROM public.drive_hubs
$$;

CREATE OR REPLACE FUNCTION public.content_valid_boundary(p_feature jsonb, p_park_id text, p_biome text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    v_polygon jsonb;
    v_ring jsonb;
    v_point jsonb;
    v_first jsonb;
    v_last jsonb;
    v_lng double precision;
    v_lat double precision;
BEGIN
    IF jsonb_typeof(p_feature) IS DISTINCT FROM 'object'
       OR (SELECT count(*) FROM jsonb_object_keys(p_feature)) <> 3
       OR NOT (p_feature ?& ARRAY['type', 'properties', 'geometry'])
       OR p_feature->>'type' IS DISTINCT FROM 'Feature' THEN RETURN false; END IF;

    IF jsonb_typeof(p_feature->'properties') IS DISTINCT FROM 'object'
       OR (SELECT count(*) FROM jsonb_object_keys(p_feature->'properties')) <> 2
       OR NOT (p_feature->'properties' ?& ARRAY['id', 'biome'])
       OR p_feature->'properties'->>'id' IS DISTINCT FROM p_park_id
       OR p_feature->'properties'->>'biome' IS DISTINCT FROM p_biome THEN RETURN false; END IF;

    IF jsonb_typeof(p_feature->'geometry') IS DISTINCT FROM 'object'
       OR (SELECT count(*) FROM jsonb_object_keys(p_feature->'geometry')) <> 2
       OR NOT (p_feature->'geometry' ?& ARRAY['type', 'coordinates'])
       OR p_feature->'geometry'->>'type' IS DISTINCT FROM 'MultiPolygon'
       OR jsonb_typeof(p_feature->'geometry'->'coordinates') IS DISTINCT FROM 'array'
       OR jsonb_array_length(p_feature->'geometry'->'coordinates') < 1 THEN RETURN false; END IF;

    FOR v_polygon IN SELECT value FROM jsonb_array_elements(p_feature->'geometry'->'coordinates') AS polygons(value) LOOP
        IF jsonb_typeof(v_polygon) IS DISTINCT FROM 'array' OR jsonb_array_length(v_polygon) < 1 THEN RETURN false; END IF;
        FOR v_ring IN SELECT value FROM jsonb_array_elements(v_polygon) AS rings(value) LOOP
            IF jsonb_typeof(v_ring) IS DISTINCT FROM 'array' OR jsonb_array_length(v_ring) < 4 THEN RETURN false; END IF;
            v_first := v_ring->0;
            v_last := v_ring->(jsonb_array_length(v_ring) - 1);
            IF v_first IS DISTINCT FROM v_last THEN RETURN false; END IF;
            FOR v_point IN SELECT value FROM jsonb_array_elements(v_ring) AS points(value) LOOP
                IF jsonb_typeof(v_point) IS DISTINCT FROM 'array'
                   OR jsonb_array_length(v_point) <> 2
                   OR jsonb_typeof(v_point->0) IS DISTINCT FROM 'number'
                   OR jsonb_typeof(v_point->1) IS DISTINCT FROM 'number' THEN RETURN false; END IF;
                v_lng := (v_point->>0)::double precision;
                v_lat := (v_point->>1)::double precision;
                IF v_lng NOT BETWEEN -180 AND 180 OR v_lat NOT BETWEEN -90 AND 90 THEN RETURN false; END IF;
            END LOOP;
        END LOOP;
    END LOOP;
    RETURN true;
EXCEPTION WHEN others THEN
    RETURN false;
END
$$;

CREATE OR REPLACE FUNCTION public.content_log_park_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_asset_path text;
    v_asset_value jsonb;
BEGIN
    IF TG_OP = 'DELETE' THEN
        PERFORM public.content_record_change('park', OLD.id, 'delete', NULL);
        RETURN OLD;
    END IF;
    IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
    PERFORM public.content_record_change('park', NEW.id, 'upsert', public.content_park_json(NEW));
    IF NEW.scene IS NOT NULL THEN
        v_asset_path := 'art/badges/scenes/' || NEW.scene || '.webp';
        SELECT jsonb_build_object(
                   'path', logical_path,
                   'key', object_key,
                   'url', url,
                   'sha256', sha256,
                   'byte_size', byte_size,
                   'content_type', content_type
               )
          INTO v_asset_value
          FROM public.r2_objects
         WHERE logical_path = v_asset_path;
        IF v_asset_value IS NULL THEN
            RAISE EXCEPTION 'park % scene % has no registered immutable badge asset', NEW.id, NEW.scene
                USING ERRCODE = '23503';
        END IF;
        -- Repeat the descriptor in every scene-bearing park upsert. A client
        -- may have advanced past its registration batch while the scene was
        -- inactive, or may be reusing an older retained scene.
        PERFORM public.content_record_change('asset', v_asset_path, 'upsert', v_asset_value);
    END IF;
    RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.content_log_boundary_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        PERFORM public.content_record_change('boundary', OLD.park_id, 'delete', NULL);
        RETURN OLD;
    END IF;
    IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
    PERFORM public.content_record_change('boundary', NEW.park_id, 'upsert', NEW.feature);
    RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.content_log_asset_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_path text;
    v_value jsonb;
BEGIN
    IF TG_OP = 'DELETE' THEN
        v_path := OLD.logical_path;
        v_value := NULL;
    ELSE
        IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
        v_path := NEW.logical_path;
        v_value := jsonb_build_object(
            'path', NEW.logical_path,
            'key', NEW.object_key,
            'url', NEW.url,
            'sha256', NEW.sha256,
            'byte_size', NEW.byte_size,
            'content_type', NEW.content_type
        );
    END IF;
    IF v_path LIKE 'art/badges/scenes/%' THEN
        PERFORM public.content_record_change(
            'asset', v_path, CASE WHEN TG_OP = 'DELETE' THEN 'delete' ELSE 'upsert' END, v_value
        );
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.content_log_drive_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_park_id text;
    v_value jsonb;
BEGIN
    IF TG_OP = 'DELETE' THEN v_park_id := OLD.park_id; ELSE v_park_id := NEW.park_id; END IF;
    IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;

    IF EXISTS (SELECT 1 FROM public.parks WHERE id = v_park_id) THEN
        v_value := public.content_drive_json(v_park_id);
        IF v_value IS NULL THEN
            PERFORM public.content_record_change('drive', v_park_id, 'delete', NULL);
        ELSE
            PERFORM public.content_record_change('drive', v_park_id, 'upsert', v_value);
        END IF;
    ELSE
        PERFORM public.content_record_change('drive', v_park_id, 'delete', NULL);
    END IF;

    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.content_log_hubs_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
    PERFORM public.content_record_change('hubs', 'default', 'upsert', public.content_hubs_json());
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.content_log_map_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_value jsonb;
BEGIN
    IF TG_OP = 'DELETE' THEN
        PERFORM public.content_record_change('map', 'default', 'upsert', 'null'::jsonb);
        RETURN OLD;
    END IF;
    IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
    v_value := jsonb_build_object(
        'version', NEW.version,
        'manifestUrl', NEW.manifest_url,
        'manifestSha256', NEW.manifest_sha256
    );
    PERFORM public.content_record_change('map', 'default', 'upsert', v_value);
    RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.content_assert_park_consistency(p_park_id text)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    v_hub_count bigint;
    v_route_count bigint;
    v_min_position integer;
    v_max_position integer;
    v_feature jsonb;
    v_biome text;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.parks WHERE id = p_park_id) THEN RETURN; END IF;

    SELECT biome INTO v_biome FROM public.parks WHERE id = p_park_id;
    SELECT feature INTO v_feature FROM public.boundaries WHERE park_id = p_park_id;
    IF v_feature IS NULL OR NOT public.content_valid_boundary(v_feature, p_park_id, v_biome) THEN
        RAISE EXCEPTION 'park % must have a matching MultiPolygon boundary', p_park_id
            USING ERRCODE = '23514';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM public.park_drive_settings WHERE park_id = p_park_id) THEN
        RAISE EXCEPTION 'park % must have a drive settings row', p_park_id USING ERRCODE = '23514';
    END IF;

    SELECT count(*) INTO v_hub_count FROM public.drive_hubs;
    SELECT count(*), min(hub_position), max(hub_position)
      INTO v_route_count, v_min_position, v_max_position
      FROM public.park_drive WHERE park_id = p_park_id;
    IF v_hub_count < 1 OR v_route_count <> v_hub_count
       OR v_min_position <> 0 OR v_max_position <> v_hub_count - 1 THEN
        RAISE EXCEPTION 'park % must have one ordered drive row for each hub', p_park_id
            USING ERRCODE = '23514';
    END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.content_assert_park_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_TABLE_NAME = 'boundaries' THEN
        IF TG_OP = 'DELETE' THEN
            PERFORM public.content_assert_park_consistency(OLD.park_id);
            RETURN OLD;
        END IF;
        PERFORM public.content_assert_park_consistency(NEW.park_id);
        RETURN NEW;
    END IF;
    IF TG_OP = 'DELETE' THEN
        PERFORM public.content_assert_park_consistency(OLD.id);
        RETURN OLD;
    END IF;
    PERFORM public.content_assert_park_consistency(NEW.id);
    RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.content_assert_boundary_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        PERFORM public.content_assert_park_consistency(OLD.park_id);
        RETURN OLD;
    END IF;
    PERFORM public.content_assert_park_consistency(NEW.park_id);
    RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.content_assert_drive_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_park_id text;
BEGIN
    IF TG_OP = 'DELETE' THEN v_park_id := OLD.park_id; ELSE v_park_id := NEW.park_id; END IF;
    PERFORM public.content_assert_park_consistency(v_park_id);
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.content_assert_hubs_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_park_id text;
BEGIN
    FOR v_park_id IN SELECT id FROM public.parks LOOP
        PERFORM public.content_assert_park_consistency(v_park_id);
    END LOOP;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS content_parks_scene_guard ON public.parks;
CREATE TRIGGER content_parks_scene_guard
    BEFORE INSERT OR UPDATE ON public.parks
    FOR EACH ROW EXECUTE FUNCTION public.content_guard_park_scene();

DROP TRIGGER IF EXISTS content_parks_identity_guard ON public.parks;
CREATE TRIGGER content_parks_identity_guard
    BEFORE UPDATE ON public.parks
    FOR EACH ROW EXECUTE FUNCTION public.content_guard_park_identity();

DROP TRIGGER IF EXISTS content_boundaries_identity_guard ON public.boundaries;
CREATE TRIGGER content_boundaries_identity_guard
    BEFORE UPDATE ON public.boundaries
    FOR EACH ROW EXECUTE FUNCTION public.content_guard_boundary_identity();

DROP TRIGGER IF EXISTS content_scene_asset_guard ON public.r2_objects;
CREATE TRIGGER content_scene_asset_guard
    BEFORE UPDATE OR DELETE ON public.r2_objects
    FOR EACH ROW EXECUTE FUNCTION public.content_guard_scene_asset();

DROP TRIGGER IF EXISTS content_scene_asset_validate ON public.r2_objects;
CREATE TRIGGER content_scene_asset_validate
    BEFORE INSERT OR UPDATE ON public.r2_objects
    FOR EACH ROW EXECUTE FUNCTION public.content_validate_scene_asset();

DROP TRIGGER IF EXISTS content_parks_log ON public.parks;
CREATE TRIGGER content_parks_log
    AFTER INSERT OR UPDATE OR DELETE ON public.parks
    FOR EACH ROW EXECUTE FUNCTION public.content_log_park_change();

DROP TRIGGER IF EXISTS content_boundaries_log ON public.boundaries;
CREATE TRIGGER content_boundaries_log
    AFTER INSERT OR UPDATE OR DELETE ON public.boundaries
    FOR EACH ROW EXECUTE FUNCTION public.content_log_boundary_change();

DROP TRIGGER IF EXISTS content_assets_log ON public.r2_objects;
CREATE TRIGGER content_assets_log
    AFTER INSERT OR UPDATE OR DELETE ON public.r2_objects
    FOR EACH ROW EXECUTE FUNCTION public.content_log_asset_change();

DROP TRIGGER IF EXISTS content_park_drive_log ON public.park_drive;
CREATE TRIGGER content_park_drive_log
    AFTER INSERT OR UPDATE OR DELETE ON public.park_drive
    FOR EACH ROW EXECUTE FUNCTION public.content_log_drive_change();

DROP TRIGGER IF EXISTS content_park_drive_settings_log ON public.park_drive_settings;
CREATE TRIGGER content_park_drive_settings_log
    AFTER INSERT OR UPDATE OR DELETE ON public.park_drive_settings
    FOR EACH ROW EXECUTE FUNCTION public.content_log_drive_change();

DROP TRIGGER IF EXISTS content_drive_hubs_log ON public.drive_hubs;
CREATE TRIGGER content_drive_hubs_log
    AFTER INSERT OR UPDATE OR DELETE ON public.drive_hubs
    FOR EACH ROW EXECUTE FUNCTION public.content_log_hubs_change();

DROP TRIGGER IF EXISTS content_map_log ON public.content_map;
CREATE TRIGGER content_map_log
    AFTER INSERT OR UPDATE OR DELETE ON public.content_map
    FOR EACH ROW EXECUTE FUNCTION public.content_log_map_change();

-- Cross-table checks are deferred to transaction commit so bootstrap and park
-- enrichment can make related edits atomically in any statement order.
DROP TRIGGER IF EXISTS content_parks_consistent ON public.parks;
CREATE CONSTRAINT TRIGGER content_parks_consistent
    AFTER INSERT OR UPDATE OR DELETE ON public.parks
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION public.content_assert_park_trigger();

DROP TRIGGER IF EXISTS content_boundaries_consistent ON public.boundaries;
CREATE CONSTRAINT TRIGGER content_boundaries_consistent
    AFTER INSERT OR UPDATE OR DELETE ON public.boundaries
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION public.content_assert_boundary_trigger();

DROP TRIGGER IF EXISTS content_park_drive_consistent ON public.park_drive;
CREATE CONSTRAINT TRIGGER content_park_drive_consistent
    AFTER INSERT OR UPDATE OR DELETE ON public.park_drive
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION public.content_assert_drive_trigger();

DROP TRIGGER IF EXISTS content_park_drive_settings_consistent ON public.park_drive_settings;
CREATE CONSTRAINT TRIGGER content_park_drive_settings_consistent
    AFTER INSERT OR UPDATE OR DELETE ON public.park_drive_settings
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION public.content_assert_drive_trigger();

DROP TRIGGER IF EXISTS content_drive_hubs_consistent ON public.drive_hubs;
CREATE CONSTRAINT TRIGGER content_drive_hubs_consistent
    AFTER INSERT OR UPDATE OR DELETE ON public.drive_hubs
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION public.content_assert_hubs_trigger();

CREATE OR REPLACE FUNCTION public.content_reject_truncate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'TRUNCATE is not permitted for synchronized content; use tracked DELETE statements'
        USING ERRCODE = '0A000';
END
$$;

DO $$
DECLARE
    v_table text;
BEGIN
    FOREACH v_table IN ARRAY ARRAY[
        'parks', 'boundaries', 'r2_objects', 'content_clock', 'content_change_batches',
        'content_changes', 'drive_hubs', 'park_drive_settings', 'park_drive', 'content_map'
    ] LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS content_reject_truncate ON public.%I', v_table);
        EXECUTE format(
            'CREATE TRIGGER content_reject_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.content_reject_truncate()',
            v_table
        );
    END LOOP;
END
$$;

CREATE OR REPLACE FUNCTION public.prune_content_changes(
    p_retention interval DEFAULT interval '90 days'
)
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
    v_floor bigint;
    v_candidate_floor bigint;
    v_cutoff timestamptz;
BEGIN
    IF p_retention IS NULL
       OR p_retention <= interval '0 seconds'
       OR p_retention > interval '3650 days' THEN
        RAISE EXCEPTION 'content change retention must be greater than zero and no more than 3650 days'
            USING ERRCODE = '22023';
    END IF;

    -- Take the same first lock as content_next_revision(). This waits for any
    -- in-flight writer and prevents a writer from adding an older batch while
    -- the replay floor and deletions are being committed.
    SELECT retention_floor
      INTO v_floor
      FROM public.content_clock
     WHERE singleton = true
     FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'content clock singleton is missing';
    END IF;

    v_cutoff := clock_timestamp() - p_retention;
    SELECT COALESCE(max(revision), v_floor)
      INTO v_candidate_floor
      FROM public.content_change_batches
     WHERE created_at < v_cutoff;
    v_floor := GREATEST(v_floor, v_candidate_floor);

    DELETE FROM public.content_change_batches
     WHERE revision <= v_floor;

    UPDATE public.content_clock
       SET retention_floor = v_floor
     WHERE singleton = true;

    RETURN v_floor;
END
$$;

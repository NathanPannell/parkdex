-- Run only against the explicit disposable kip_qa_content_sync database.
-- The entire test is rolled back, including its clock revision and changelog.
\set ON_ERROR_STOP on
BEGIN;
SET CONSTRAINTS ALL DEFERRED;

-- psql's HOST is the client-selected endpoint. The server address can be a Docker
-- bridge address in CI even when this client connected through loopback.
SELECT set_config('parkdex_qa.client_host', :'HOST', true);
SELECT set_config('parkdex_qa.database_name', :'DBNAME', true);

DO $$
DECLARE
    v_id text := 'sync-qa-' || txid_current()::text;
    v_scene text := 'sync-qa-scene-' || txid_current()::text;
    v_asset_key text;
    v_sha text := repeat('a', 64);
    v_release text := repeat('a', 64);
    v_revision_before bigint;
    v_revision_after bigint;
    v_hub record;
    v_route_count integer := 0;
    v_ring jsonb;
    v_coordinates jsonb;
    v_feature jsonb;
    v_event_count integer;
    v_final_blurb text;
    v_pruned_floor bigint;
BEGIN
    IF current_database() !~ '^kip_qa_content_sync_[a-f0-9]{32}$'
       OR current_database() IS DISTINCT FROM current_setting('parkdex_qa.database_name', true)
       OR COALESCE(current_setting('parkdex_qa.client_host', true), '') NOT IN ('127.0.0.1', 'localhost', '::1') THEN
        RAISE EXCEPTION 'content sync SQL QA requires the owned loopback database';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.parks LIMIT 1)
       OR NOT EXISTS (SELECT 1 FROM public.drive_hubs LIMIT 1) THEN
        RAISE EXCEPTION 'content sync SQL QA requires the public-only bootstrap to have completed';
    END IF;
    IF EXISTS (SELECT 1 FROM public.parks WHERE id = v_id) THEN
        RAISE EXCEPTION 'content sync QA fixture id already exists';
    END IF;

    BEGIN
        INSERT INTO public.parks (id, name, short, category, region, lat, lng, biome, shape, rarity, scene, seed, blurb)
        VALUES ('bad id', 'Invalid id', 'Bad', 'municipal', '', 48.4, -123.3, 'coast', 'circle', 'rare', NULL, 1, 'Invalid id fixture');
        RAISE EXCEPTION 'invalid park id unexpectedly passed the database gate';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;
    BEGIN
        INSERT INTO public.parks (id, name, short, category, region, lat, lng, biome, shape, rarity, scene, seed, blurb)
        VALUES ('invalid-name-qa', '', 'QA', 'municipal', '', 48.4, -123.3, 'coast', 'circle', 'rare', NULL, 1, 'Invalid name fixture');
        RAISE EXCEPTION 'empty park name unexpectedly passed the database gate';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;
    BEGIN
        INSERT INTO public.parks (id, name, short, category, region, lat, lng, biome, shape, rarity, scene, seed, blurb)
        VALUES ('invalid-short-qa', 'Invalid short', '', 'municipal', '', 48.4, -123.3, 'coast', 'circle', 'rare', NULL, 1, 'Invalid short fixture');
        RAISE EXCEPTION 'empty park short label unexpectedly passed the database gate';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    SELECT revision INTO v_revision_before FROM public.content_clock WHERE singleton = true;
    v_asset_key := 'releases/' || v_release || '/art/badges/scenes/' || v_scene || '.webp';
    v_ring := jsonb_build_array(
        jsonb_build_array(-123.31, 48.39),
        jsonb_build_array(-123.29, 48.39),
        jsonb_build_array(-123.29, 48.41),
        jsonb_build_array(-123.31, 48.39)
    );
    v_coordinates := jsonb_build_array(jsonb_build_array(v_ring));
    v_feature := jsonb_build_object(
        'type', 'Feature',
        'properties', jsonb_build_object('id', v_id, 'biome', 'coast'),
        'geometry', jsonb_build_object('type', 'MultiPolygon', 'coordinates', v_coordinates)
    );

    -- Insert and verify a descriptor before setting the park scene.
    INSERT INTO public.r2_objects (logical_path, object_key, url, sha256, byte_size, content_type)
    VALUES (
        'art/badges/scenes/' || v_scene || '.webp', v_asset_key,
        'https://kip-assets.parkdex.app/' || v_asset_key, v_sha, 10, 'image/webp'
    );
    INSERT INTO public.parks (id, name, short, category, region, lat, lng, biome, shape, rarity, scene, seed, blurb)
    VALUES (v_id, 'QA Park', 'QA', 'municipal', 'South Island', 48.4, -123.3, 'coast', 'circle', 'rare', NULL, 1, 'Initial');
    INSERT INTO public.boundaries (park_id, feature) VALUES (v_id, v_feature);
    INSERT INTO public.park_drive_settings (park_id, walk_m) VALUES (v_id, 15);
    FOR v_hub IN SELECT position FROM public.drive_hubs ORDER BY position LOOP
        INSERT INTO public.park_drive (park_id, hub_position, distance_km, duration_min)
        VALUES (v_id, v_hub.position, 12.5, 20);
        v_route_count := v_route_count + 1;
    END LOOP;
    IF v_route_count < 1 THEN RAISE EXCEPTION 'fixture needs at least one drive hub'; END IF;

    BEGIN
        UPDATE public.park_drive_settings SET walk_m = 1e20 WHERE park_id = v_id;
        RAISE EXCEPTION 'out-of-range walk distance unexpectedly passed the database gate';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;
    BEGIN
        UPDATE public.park_drive SET distance_km = 1e20, duration_min = 1 WHERE park_id = v_id;
        RAISE EXCEPTION 'out-of-range route distance unexpectedly passed the database gate';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;
    BEGIN
        INSERT INTO public.drive_hubs (position, name, lng, lat)
        SELECT COALESCE(max(position), -1) + 1, E'\t', -123.3, 48.4 FROM public.drive_hubs;
        RAISE EXCEPTION 'blank drive hub name unexpectedly passed the database gate';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    -- Simulate a client whose cursor passed the asset-registration revision
    -- while the scene was inactive. The later park upsert must repeat it.
    DELETE FROM public.content_changes
     WHERE revision = (SELECT revision FROM public.content_clock WHERE singleton = true)
       AND entity = 'asset'
       AND entity_id = 'art/badges/scenes/' || v_scene || '.webp';
    UPDATE public.parks SET scene = v_scene, blurb = 'First update' WHERE id = v_id;
    UPDATE public.parks SET blurb = 'Final update' WHERE id = v_id;
    UPDATE public.parks SET blurb = blurb WHERE id = v_id;
    SELECT revision INTO v_revision_after FROM public.content_clock WHERE singleton = true;
    IF v_revision_after <> v_revision_before + 1 THEN
        RAISE EXCEPTION 'one SQL transaction must allocate exactly one revision';
    END IF;
    SELECT count(*) INTO v_event_count FROM public.content_change_batches WHERE revision = v_revision_after;
    IF v_event_count <> 1 THEN RAISE EXCEPTION 'one committed transaction must create one batch'; END IF;
    SELECT count(*), max(value->>'blurb') INTO v_event_count, v_final_blurb
      FROM public.content_changes
     WHERE revision = v_revision_after AND entity = 'park' AND entity_id = v_id AND operation = 'upsert';
    IF v_event_count <> 1 OR v_final_blurb <> 'Final update' THEN
        RAISE EXCEPTION 'repeated SQL updates must collapse to the final park value';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.content_changes WHERE revision = v_revision_after AND entity = 'asset' AND entity_id = 'art/badges/scenes/' || v_scene || '.webp')
       OR NOT EXISTS (SELECT 1 FROM public.content_changes WHERE revision = v_revision_after AND entity = 'boundary' AND entity_id = v_id)
       OR NOT EXISTS (SELECT 1 FROM public.content_changes WHERE revision = v_revision_after AND entity = 'drive' AND entity_id = v_id) THEN
        RAISE EXCEPTION 'asset, boundary, drive, and park changes must be captured in the same revision';
    END IF;

    BEGIN
        UPDATE public.parks SET scene = 'unregistered-scene' WHERE id = v_id;
        RAISE EXCEPTION 'unknown badge scene unexpectedly committed';
    EXCEPTION WHEN foreign_key_violation THEN
        NULL;
    END;

    BEGIN
        INSERT INTO public.r2_objects (logical_path, object_key, url, sha256, byte_size, content_type)
        VALUES ('art/badges/scenes/invalid-qa-scene.webp', 'releases/' || v_release || '/art/badges/scenes/invalid-qa-scene.webp',
                'https://wrong.example/scene.webp', v_sha, 10, 'image/webp');
        RAISE EXCEPTION 'invalid badge descriptor unexpectedly committed';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    BEGIN
        DELETE FROM public.r2_objects WHERE logical_path = 'art/badges/scenes/' || v_scene || '.webp';
        RAISE EXCEPTION 'retained badge descriptor unexpectedly deleted';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    BEGIN
        UPDATE public.boundaries SET feature = jsonb_build_object('type', 'Feature', 'properties', jsonb_build_object('id', v_id, 'biome', 'coast'), 'geometry', jsonb_build_object('type', 'MultiPolygon', 'coordinates', '[]'::jsonb))
         WHERE park_id = v_id;
        SET CONSTRAINTS content_boundaries_consistent IMMEDIATE;
        RAISE EXCEPTION 'invalid boundary unexpectedly committed';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;
    SET CONSTRAINTS ALL DEFERRED;

    -- Flush deferred row checks before testing statement-level TRUNCATE
    -- rejection; PostgreSQL blocks TRUNCATE when deferred events are pending.
    SET CONSTRAINTS ALL IMMEDIATE;
    SET CONSTRAINTS ALL DEFERRED;

    BEGIN
        EXECUTE 'TRUNCATE public.parks';
        RAISE EXCEPTION 'TRUNCATE unexpectedly succeeded';
    EXCEPTION WHEN feature_not_supported THEN
        NULL;
    END;

    DELETE FROM public.parks WHERE id = v_id;
    IF NOT EXISTS (SELECT 1 FROM public.content_changes WHERE revision = v_revision_after AND entity = 'park' AND entity_id = v_id AND operation = 'delete' AND value IS NULL)
       OR NOT EXISTS (SELECT 1 FROM public.content_changes WHERE revision = v_revision_after AND entity = 'boundary' AND entity_id = v_id AND operation = 'delete' AND value IS NULL)
       OR NOT EXISTS (SELECT 1 FROM public.content_changes WHERE revision = v_revision_after AND entity = 'drive' AND entity_id = v_id AND operation = 'delete' AND value IS NULL) THEN
        RAISE EXCEPTION 'deleting a park must write final tombstones for park, boundary, and drive';
    END IF;

    UPDATE public.content_change_batches
       SET created_at = clock_timestamp() - interval '2 days'
     WHERE revision = v_revision_after;
    v_pruned_floor := public.prune_content_changes(interval '1 day');
    IF v_pruned_floor <> v_revision_after
       OR EXISTS (SELECT 1 FROM public.content_change_batches WHERE revision = v_revision_after)
       OR (SELECT retention_floor FROM public.content_clock WHERE singleton = true) <> v_revision_after THEN
        RAISE EXCEPTION 'manual pruning must remove whole old batches and advance the floor atomically';
    END IF;
END
$$;

ROLLBACK;
SELECT 'content sync SQL QA passed; fixture transaction rolled back' AS result;

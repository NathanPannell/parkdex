-- Durable, operator-driven queue for the 100-park enrichment rollout.
-- Rows are seeded with the park reset and remain available for audit after publication.

CREATE TABLE IF NOT EXISTS public.park_enrichment_rollout (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    source_bundle_sha256 text NOT NULL CHECK (source_bundle_sha256 ~ '^[a-f0-9]{64}$'),
    ranked_list_sha256 text NOT NULL CHECK (ranked_list_sha256 ~ '^[a-f0-9]{64}$'),
    expected_count integer NOT NULL CHECK (expected_count = 100),
    target_environment text NOT NULL CHECK (target_environment IN ('staging', 'owned-preview')),
    target_id text,
    database_host text NOT NULL CHECK (length(btrim(database_host)) > 0),
    applied_content_revision bigint NOT NULL CHECK (applied_content_revision >= 0),
    applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (
        (target_environment = 'staging' AND target_id IS NULL)
        OR (target_environment = 'owned-preview' AND target_id IS NOT NULL AND target_id ~ '^[0-9]+$')
    )
);

CREATE TABLE IF NOT EXISTS public.park_enrichment_jobs (
    rank integer PRIMARY KEY CHECK (rank BETWEEN 1 AND 100),
    park_id text NOT NULL UNIQUE REFERENCES public.parks(id) ON DELETE RESTRICT,
    state text NOT NULL DEFAULT 'queued'
        CHECK (state IN ('queued', 'leased', 'ready', 'publishing', 'published', 'needs_attention')),
    lease_token uuid,
    lease_expires_at timestamptz,
    attempt_count smallint NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 3),
    frozen_research jsonb,
    render_calls_started smallint NOT NULL DEFAULT 0 CHECK (render_calls_started BETWEEN 0 AND 5),
    run_manifest_path text,
    run_manifest_sha256 text,
    render_call_log jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(render_call_log) = 'array'),
    selected_art jsonb,
    publication_result jsonb,
    published_at timestamptz,
    last_error text,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL)),
    CHECK (state NOT IN ('leased', 'publishing') OR lease_token IS NOT NULL),
    CHECK (state NOT IN ('queued', 'needs_attention', 'published') OR lease_token IS NULL),
    CHECK (
        (render_calls_started = 0 AND run_manifest_path IS NULL AND run_manifest_sha256 IS NULL)
        OR (
            render_calls_started BETWEEN 1 AND 5
            AND run_manifest_path IS NOT NULL
            AND length(btrim(run_manifest_path)) > 0
            AND run_manifest_sha256 IS NOT NULL
            AND run_manifest_sha256 ~ '^[a-f0-9]{64}$'
        )
    ),
    CHECK (jsonb_array_length(render_call_log) = render_calls_started),
    CHECK (render_calls_started = 0 OR frozen_research IS NOT NULL),
    CHECK (selected_art IS NULL OR frozen_research IS NOT NULL),
    CHECK (state NOT IN ('ready', 'publishing', 'published') OR (frozen_research IS NOT NULL AND selected_art IS NOT NULL)),
    CHECK (
        frozen_research IS NULL
        OR (
            jsonb_typeof(frozen_research) = 'object'
            AND frozen_research ?& ARRAY['google_image_refs', 'fact_urls', 'dossier_path', 'dossier_sha256', 'prompts']
            AND jsonb_typeof(frozen_research->'google_image_refs') = 'array'
            AND jsonb_array_length(
                CASE WHEN jsonb_typeof(frozen_research->'google_image_refs') = 'array'
                     THEN frozen_research->'google_image_refs' ELSE '[]'::jsonb END
            ) >= 5
            AND jsonb_typeof(frozen_research->'fact_urls') = 'array'
            AND jsonb_array_length(
                CASE WHEN jsonb_typeof(frozen_research->'fact_urls') = 'array'
                     THEN frozen_research->'fact_urls' ELSE '[]'::jsonb END
            ) >= 1
            AND jsonb_typeof(frozen_research->'dossier_path') = 'string'
            AND length(btrim(frozen_research->>'dossier_path')) > 0
            AND jsonb_typeof(frozen_research->'dossier_sha256') = 'string'
            AND frozen_research->>'dossier_sha256' ~ '^[a-f0-9]{64}$'
            AND jsonb_typeof(frozen_research->'prompts') = 'object'
        )
    ),
    CHECK (
        selected_art IS NULL
        OR (
            jsonb_typeof(selected_art) = 'object'
            AND selected_art ?& ARRAY['local_path', 'sha256', 'scene_slug', 'expected', 'desired']
            AND jsonb_typeof(selected_art->'local_path') = 'string'
            AND length(btrim(selected_art->>'local_path')) > 0
            AND jsonb_typeof(selected_art->'sha256') = 'string'
            AND selected_art->>'sha256' ~ '^[a-f0-9]{64}$'
            AND jsonb_typeof(selected_art->'byte_size') = 'number'
            AND (selected_art->>'byte_size')::integer BETWEEN 1 AND 4194304
            AND jsonb_typeof(selected_art->'scene_slug') = 'string'
            AND selected_art->>'scene_slug' ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
            AND jsonb_typeof(selected_art->'expected') = 'object'
            AND selected_art->'expected' ?& ARRAY['blurb', 'rarity', 'scene']
            AND jsonb_typeof(selected_art->'expected'->'blurb') = 'string'
            AND selected_art->'expected'->>'rarity' IN ('common', 'uncommon', 'rare', 'epic', 'legendary')
            AND (jsonb_typeof(selected_art->'expected'->'scene') = 'string'
                 OR selected_art->'expected'->'scene' = 'null'::jsonb)
            AND jsonb_typeof(selected_art->'desired') = 'object'
            AND selected_art->'desired' ?& ARRAY['blurb', 'rarity', 'scene']
            AND jsonb_typeof(selected_art->'desired'->'blurb') = 'string'
            AND length(btrim(selected_art->'desired'->>'blurb')) > 0
            AND selected_art->'desired'->>'rarity' IN ('common', 'uncommon', 'rare', 'epic', 'legendary')
            AND jsonb_typeof(selected_art->'desired'->'scene') = 'string'
            AND selected_art->'desired'->>'scene' = selected_art->>'scene_slug'
        )
    ),
    CHECK (
        (state = 'published' AND publication_result IS NOT NULL AND jsonb_typeof(publication_result) = 'object' AND published_at IS NOT NULL)
        OR (state <> 'published' AND publication_result IS NULL AND published_at IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS park_enrichment_jobs_claim_idx
    ON public.park_enrichment_jobs (rank)
    WHERE state IN ('queued', 'ready') AND attempt_count < 3;

CREATE INDEX IF NOT EXISTS park_enrichment_jobs_expired_lease_idx
    ON public.park_enrichment_jobs (lease_expires_at, rank)
    WHERE state IN ('leased', 'ready', 'publishing');

CREATE UNIQUE INDEX IF NOT EXISTS park_enrichment_jobs_scene_slug_idx
    ON public.park_enrichment_jobs ((selected_art->>'scene_slug'))
    WHERE selected_art IS NOT NULL;

CREATE OR REPLACE FUNCTION public.park_enrichment_guard_immutable_inputs()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_prepared_adoption boolean := false;
BEGIN
    IF OLD.frozen_research IS NOT NULL AND NEW.frozen_research IS DISTINCT FROM OLD.frozen_research THEN
        RAISE EXCEPTION 'frozen enrichment research is immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD.selected_art IS NOT NULL AND NEW.selected_art IS DISTINCT FROM OLD.selected_art THEN
        RAISE EXCEPTION 'selected enrichment art is immutable' USING ERRCODE = '23514';
    END IF;
    IF NEW.frozen_research IS DISTINCT FROM OLD.frozen_research
       AND (OLD.frozen_research IS NOT NULL OR NEW.frozen_research IS NULL) THEN
        RAISE EXCEPTION 'frozen enrichment research can only be set once' USING ERRCODE = '23514';
    END IF;
    IF NEW.rank IS DISTINCT FROM OLD.rank OR NEW.park_id IS DISTINCT FROM OLD.park_id THEN
        RAISE EXCEPTION 'enrichment job rank and park id are immutable' USING ERRCODE = '23514';
    END IF;
    IF NEW.selected_art IS DISTINCT FROM OLD.selected_art
       AND (OLD.selected_art IS NOT NULL OR NEW.selected_art IS NULL) THEN
        RAISE EXCEPTION 'selected enrichment art can only be set once' USING ERRCODE = '23514';
    END IF;
    IF NEW.selected_art IS DISTINCT FROM OLD.selected_art AND NEW.render_calls_started < 3 THEN
        RAISE EXCEPTION 'selected enrichment art requires all three initial image generation calls' USING ERRCODE = '23514';
    END IF;
    IF NEW.render_calls_started > OLD.render_calls_started + 1 THEN
        v_prepared_adoption :=
            OLD.rank = 1
            AND OLD.park_id = 'municipal-city-of-victoria-1442'
            AND OLD.state = 'leased'
            AND NEW.state = 'ready'
            AND OLD.attempt_count >= 1
            AND OLD.render_calls_started = 0
            AND OLD.run_manifest_path IS NULL
            AND OLD.run_manifest_sha256 IS NULL
            AND OLD.render_call_log = '[]'::jsonb
            AND OLD.frozen_research IS NULL
            AND OLD.selected_art IS NULL
            AND OLD.attempt_count = 1
            AND NEW.attempt_count = OLD.attempt_count
            AND OLD.lease_token IS NOT NULL
            AND NEW.lease_token IS NOT DISTINCT FROM OLD.lease_token
            AND OLD.lease_expires_at > clock_timestamp()
            AND NEW.lease_expires_at > clock_timestamp()
            AND NEW.render_calls_started = 5
            AND jsonb_array_length(NEW.render_call_log) = 5
            AND NEW.run_manifest_path = NEW.render_call_log->4->>'manifest_path'
            AND NEW.run_manifest_sha256 = NEW.render_call_log->4->>'manifest_sha256'
            AND NEW.frozen_research IS NOT NULL
            AND NEW.selected_art IS NOT NULL
            AND NOT EXISTS (
                SELECT 1
                  FROM jsonb_array_elements(NEW.render_call_log) AS item(value)
                 WHERE item.value->>'origin' IS DISTINCT FROM 'prequeue-prepared'
            )
            ;
        IF NOT v_prepared_adoption THEN
            RAISE EXCEPTION 'render progress must advance one call at a time except for the rank 1 prepared adoption' USING ERRCODE = '23514';
        END IF;
    END IF;
    IF NEW.render_calls_started < OLD.render_calls_started THEN
        RAISE EXCEPTION 'image generation progress must advance one call at a time' USING ERRCODE = '23514';
    END IF;
    IF NEW.render_calls_started = OLD.render_calls_started
       AND NEW.render_call_log IS DISTINCT FROM OLD.render_call_log THEN
        RAISE EXCEPTION 'recorded image generation calls are immutable' USING ERRCODE = '23514';
    END IF;
    IF NEW.render_calls_started = OLD.render_calls_started + 1
       AND NEW.render_call_log IS DISTINCT FROM
           OLD.render_call_log || jsonb_build_array(NEW.render_call_log->OLD.render_calls_started) THEN
        RAISE EXCEPTION 'image generation call history is append-only' USING ERRCODE = '23514';
    END IF;
    IF v_prepared_adoption AND (
        NEW.render_call_log->0->>'call_index' IS DISTINCT FROM '1'
        OR NEW.render_call_log->1->>'call_index' IS DISTINCT FROM '2'
        OR NEW.render_call_log->2->>'call_index' IS DISTINCT FROM '3'
        OR NEW.render_call_log->3->>'call_index' IS DISTINCT FROM '4'
        OR NEW.render_call_log->4->>'call_index' IS DISTINCT FROM '5'
    ) THEN
        RAISE EXCEPTION 'prepared adoption call records must be numbered 1 through 5' USING ERRCODE = '23514';
    END IF;
    IF NEW.render_calls_started = OLD.render_calls_started + 1
       AND (
           NEW.state <> 'leased'
           OR NEW.lease_token IS DISTINCT FROM OLD.lease_token
           OR OLD.lease_token IS NULL
           OR OLD.lease_expires_at <= clock_timestamp()
       ) THEN
        RAISE EXCEPTION 'image generation checkpoint requires the current unexpired lease' USING ERRCODE = '23514';
    END IF;
    IF OLD.run_manifest_path IS NOT NULL
       AND NEW.run_manifest_path IS DISTINCT FROM OLD.run_manifest_path
       AND NEW.render_calls_started <> OLD.render_calls_started + 1 THEN
        RAISE EXCEPTION 'image generation manifest path is immutable' USING ERRCODE = '23514';
    END IF;
    IF NEW.render_calls_started = OLD.render_calls_started + 1
       AND (
           NEW.run_manifest_path IS DISTINCT FROM NEW.render_call_log->(NEW.render_calls_started - 1)->>'manifest_path'
           OR NEW.run_manifest_sha256 IS DISTINCT FROM NEW.render_call_log->(NEW.render_calls_started - 1)->>'manifest_sha256'
       ) THEN
        RAISE EXCEPTION 'current render manifest fields must match the last immutable log entry' USING ERRCODE = '23514';
    END IF;
    IF NEW.render_calls_started = OLD.render_calls_started
       AND NEW.run_manifest_sha256 IS DISTINCT FROM OLD.run_manifest_sha256 THEN
        RAISE EXCEPTION 'image generation manifest hash changes only with a recorded call' USING ERRCODE = '23514';
    END IF;
    NEW.updated_at := clock_timestamp();
    RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS park_enrichment_jobs_immutable_inputs ON public.park_enrichment_jobs;
CREATE TRIGGER park_enrichment_jobs_immutable_inputs
BEFORE UPDATE ON public.park_enrichment_jobs
FOR EACH ROW EXECUTE FUNCTION public.park_enrichment_guard_immutable_inputs();

CREATE OR REPLACE FUNCTION public.park_enrichment_guard_rollout_receipt()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'park enrichment rollout receipt is immutable' USING ERRCODE = '23514';
END
$$;

DROP TRIGGER IF EXISTS park_enrichment_rollout_immutable ON public.park_enrichment_rollout;
CREATE TRIGGER park_enrichment_rollout_immutable
BEFORE UPDATE OR DELETE ON public.park_enrichment_rollout
FOR EACH ROW EXECUTE FUNCTION public.park_enrichment_guard_rollout_receipt();

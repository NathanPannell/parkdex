-- Reversible park hiding. This migration is additive and repeat-safe.
--
-- A hidden park keeps its row, boundary, drive data, claims, visits and flags.
-- It leaves the content snapshot for every reader and the CDN catalogue, and
-- new flag game visits to it are refused. Hiding writes park, boundary and
-- drive tombstones into the change feed, which every installed build already
-- applies; unhiding writes the current values back as upserts. The content API
-- also drops upserts for parks that are hidden now, so an edit to a hidden park
-- cannot bring it back.
--
-- content_hidden_categories is a standing rule: a park inserted later in that
-- category (an import, the operator dashboard) is hidden on insert, unless a
-- player proposed it. The rule never touches parks that already exist; hiding
-- existing parks is a separate reviewed plan. See docs/park-visibility.md.

CREATE TABLE IF NOT EXISTS public.content_hidden_categories (
    category text PRIMARY KEY CHECK (category IN ('national', 'provincial', 'regional', 'municipal', 'community')),
    reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS public.content_park_hidden (
    park_id text PRIMARY KEY REFERENCES public.parks(id) ON DELETE CASCADE,
    reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
    source text NOT NULL CHECK (source IN ('category', 'operator')),
    hidden_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS content_park_hidden_source_idx
    ON public.content_park_hidden (source, park_id);

CREATE OR REPLACE FUNCTION public.content_log_park_visibility()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_park public.parks;
    v_feature jsonb;
    v_drive jsonb;
    v_asset_path text;
    v_asset_value jsonb;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF EXISTS (SELECT 1 FROM public.parks WHERE id = NEW.park_id) THEN
            -- The same tombstones a real delete writes, so installed builds drop the park.
            PERFORM public.content_record_change('park', NEW.park_id, 'delete', NULL);
            PERFORM public.content_record_change('boundary', NEW.park_id, 'delete', NULL);
            PERFORM public.content_record_change('drive', NEW.park_id, 'delete', NULL);
        END IF;
        RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE' THEN
        IF NEW.park_id IS DISTINCT FROM OLD.park_id THEN
            RAISE EXCEPTION 'a hidden park row cannot move to another park' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;

    -- Unhide: send the park back with its current values. A park deleted outright
    -- removes this row by cascade and already wrote its own tombstones.
    SELECT * INTO v_park FROM public.parks WHERE id = OLD.park_id;
    IF NOT FOUND THEN RETURN OLD; END IF;
    PERFORM public.content_record_change('park', v_park.id, 'upsert', public.content_park_json(v_park));
    IF v_park.scene IS NOT NULL THEN
        v_asset_path := 'art/badges/scenes/' || v_park.scene || '.webp';
        SELECT jsonb_build_object('path', logical_path, 'key', object_key, 'url', url, 'sha256', sha256,
                                  'byte_size', byte_size, 'content_type', content_type)
          INTO v_asset_value
          FROM public.r2_objects
         WHERE logical_path = v_asset_path;
        IF v_asset_value IS NOT NULL THEN
            PERFORM public.content_record_change('asset', v_asset_path, 'upsert', v_asset_value);
        END IF;
    END IF;
    SELECT feature INTO v_feature FROM public.boundaries WHERE park_id = v_park.id;
    IF v_feature IS NOT NULL THEN
        PERFORM public.content_record_change('boundary', v_park.id, 'upsert', v_feature);
    END IF;
    v_drive := public.content_drive_json(v_park.id);
    IF v_drive IS NOT NULL THEN
        PERFORM public.content_record_change('drive', v_park.id, 'upsert', v_drive);
    END IF;
    RETURN OLD;
END
$$;

-- Parks players proposed on purpose stay visible whatever their category: the
-- operator flow and the OpenStreetMap flow both keep the proposal in the draft
-- source, the OpenStreetMap flow also marks the proposal accepted with the park
-- id, and their ids start with proposed- or osm-. The drafts schema is an
-- independent migration, so it is looked up only when it exists.
CREATE OR REPLACE FUNCTION public.content_park_is_player_proposal(p_park_id text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_found boolean := false;
BEGIN
    IF p_park_id LIKE 'proposed-%' OR p_park_id LIKE 'osm-%' THEN
        RETURN true;
    END IF;
    IF to_regclass('kip_park_drafts.drafts') IS NOT NULL THEN
        EXECUTE 'SELECT EXISTS (SELECT 1 FROM kip_park_drafts.drafts WHERE id = $1 AND source ? ''proposal'')'
           INTO v_found USING p_park_id;
    END IF;
    -- The OpenStreetMap flow accepts the proposal in the same transaction, before the park insert.
    IF NOT v_found AND to_regclass('kip_proposals.parks') IS NOT NULL THEN
        EXECUTE 'SELECT EXISTS (SELECT 1 FROM kip_proposals.parks WHERE published_park_id = $1)'
           INTO v_found USING p_park_id;
    END IF;
    RETURN v_found;
END
$$;

CREATE OR REPLACE FUNCTION public.content_hide_park_by_category()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_reason text;
BEGIN
    SELECT reason INTO v_reason FROM public.content_hidden_categories WHERE category = NEW.category;
    IF FOUND AND NOT public.content_park_is_player_proposal(NEW.id) THEN
        INSERT INTO public.content_park_hidden (park_id, reason, source)
        VALUES (NEW.id, v_reason, 'category')
        ON CONFLICT (park_id) DO NOTHING;
    END IF;
    RETURN NEW;
END
$$;

-- Replays must not take exclusive locks on public.parks (docs/learnings/migration-replay-lock-conflicts.md),
-- so the triggers are created only when missing.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'content_park_hidden_log' AND tgrelid = 'public.content_park_hidden'::regclass) THEN
        CREATE TRIGGER content_park_hidden_log
            AFTER INSERT OR UPDATE OR DELETE ON public.content_park_hidden
            FOR EACH ROW EXECUTE FUNCTION public.content_log_park_visibility();
    END IF;
    -- Named to sort after content_parks_log, so a park inserted into a hidden
    -- category ends its batch as a tombstone.
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'content_parks_zz_hidden_category' AND tgrelid = 'public.parks'::regclass) THEN
        -- Insert only: recategorising an existing park never hides it.
        CREATE TRIGGER content_parks_zz_hidden_category
            AFTER INSERT ON public.parks
            FOR EACH ROW EXECUTE FUNCTION public.content_hide_park_by_category();
    END IF;
END
$$;

-- A spatial index on catalogue park boundaries, so the founding search and POST /api/parks/found
-- can find every catalogue park whose outline reaches the player, not only parks whose pin is
-- within a few kilometres (worker/proposalReview.ts nearbyParks). Big parks have parts far from
-- their pin: Kejimkujik Seaside is about 72 km from Kejimkujik's pin, and its OpenStreetMap
-- outlines were offered as new parks (#182).
--
-- No PostGIS: public.park_boundary_box(feature) is the bounding box of a boundary's outer rings
-- in degrees (x = lng, y = lat), and a GiST index on it answers "boxes near this point" with the
-- built-in box operators. The API does the exact containment test on the boundaries it gets.
--
-- Additive and repeat-safe: the function and the index are created only when missing, so a
-- replay on deploy takes no lock on public.boundaries. The function never raises for a strange
-- feature (silent jsonpath, numbers in range only), so it cannot block a content write; a
-- boundary without usable positions gets a NULL box and is simply not found by box.
DO $$
BEGIN
  IF to_regclass('public.boundaries') IS NULL THEN
    RAISE EXCEPTION 'The content tables must exist before founders_004_boundary_boxes.sql';
  END IF;

  IF to_regprocedure('public.park_boundary_box(jsonb)') IS NULL THEN
    CREATE FUNCTION public.park_boundary_box(p_feature jsonb)
    RETURNS box
    LANGUAGE sql
    IMMUTABLE STRICT PARALLEL SAFE
    SET search_path = pg_catalog, pg_temp
    AS $fn$
      SELECT box(point(min(x), min(y)), point(max(x), max(y)))
      FROM (
        SELECT (item->0)::double precision AS x, (item->1)::double precision AS y
        FROM jsonb_path_query(
          p_feature,
          'strict $.geometry.coordinates[*][0][*] ? (@.type() == "array" && @.size() >= 2 && @[0].type() == "number" && @[1].type() == "number" && @[0] >= -180 && @[0] <= 180 && @[1] >= -90 && @[1] <= 90)',
          '{}',
          true
        ) AS item
      ) positions
    $fn$;
    COMMENT ON FUNCTION public.park_boundary_box(jsonb) IS
      'Bounding box (x = lng, y = lat) of a GeoJSON MultiPolygon feature''s outer rings, for the boundaries_box_idx search.';
  END IF;

  IF to_regclass('public.boundaries_box_idx') IS NULL THEN
    CREATE INDEX boundaries_box_idx ON public.boundaries USING gist (public.park_boundary_box(feature));
  END IF;
END
$$;

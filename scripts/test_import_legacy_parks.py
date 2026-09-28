from __future__ import annotations

import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import import_legacy_parks as importer


def square(x: float, width: float = 1) -> dict:
    ring = [[x, 0], [x + width, 0], [x + width, width], [x, width], [x, 0]]
    return {"type": "MultiPolygon", "coordinates": [[ring]]}


def source_feature(park_id: str, geometry: dict | None = None, object_ids: list[int] | None = None) -> dict:
    return {
        "type": "Feature",
        "properties": {
            "id": park_id,
            "name": "Source name",
            "sourceId": str(object_ids[0]) if object_ids else "9",
            "sourceObjectIds": object_ids or [9],
            "sourceName": "District GIS",
            "sourceUrl": "https://example.test/parks",
        },
        "geometry": geometry or square(2),
    }


def review_item(scene: str | None = None) -> dict:
    presentation = {
        "short": "New Park",
        "biome": "coast",
        "shape": "hex",
        "rarity": "common",
        "seed": 77,
        "blurb": "A reviewed importer test park.",
    }
    if scene is not None:
        presentation["scene"] = scene
    return {"presentation": presentation, "walkM": 27, "drive": [[8.5, 9], None]}


class ImportPlanTests(unittest.TestCase):
    def test_polygon_is_wrapped_without_reordering_positions_or_holes(self):
        outer = [[0, 0], [5, 0], [5, 5], [0, 5], [0, 0]]
        hole = [[1, 1], [1, 2], [2, 2], [2, 1], [1, 1]]
        source = {"type": "Polygon", "coordinates": [outer, hole]}

        normalized, summary = importer.normalize_geometry(source, "fixture")

        self.assertEqual(normalized, {"type": "MultiPolygon", "coordinates": [[outer, hole]]})
        self.assertEqual(summary["polygonCount"], 1)
        self.assertEqual(summary["holeCount"], 1)
        self.assertEqual(summary["positionCount"], 10)

    def test_invalid_or_three_dimensional_geometry_is_rejected(self):
        crossing = {"type": "Polygon", "coordinates": [[[0, 0], [2, 2], [0, 2], [2, 0], [0, 0]]]}
        elevated = {"type": "Polygon", "coordinates": [[[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1], [0, 0, 1]]]}

        with self.assertRaisesRegex(importer.ParkImportError, "invalid"):
            importer.normalize_geometry(crossing, "crossing")
        with self.assertRaisesRegex(importer.ParkImportError, "exactly longitude and latitude"):
            importer.normalize_geometry(elevated, "elevated")

    def test_duplicate_source_ids_are_rejected_and_grouped_ids_are_preserved(self):
        collection = {"type": "FeatureCollection", "features": [source_feature("park-one", object_ids=[244, 347, 549])]}
        parsed = importer.parse_boundary_source(collection)
        self.assertEqual(parsed["park-one"]["sourceFeatureIds"], [244, 347, 549])
        self.assertEqual(parsed["park-one"]["provenance"]["sourceName"], "District GIS")
        spoofed = source_feature("park-two", object_ids=[31, 32])
        spoofed["properties"]["stableId"] = "wrong-id"
        spoofed["properties"]["sourceFeatureIds"] = ["wrong-source"]
        spoofed_record = importer.parse_boundary_source({"type": "FeatureCollection", "features": [spoofed]})["park-two"]
        provenance = importer._source_provenance(spoofed_record)
        self.assertEqual(provenance["stableId"], "park-two")
        self.assertEqual(provenance["sourceFeatureIds"], [31, 32])
        self.assertEqual(provenance["sourceProperties"]["stableId"], "wrong-id")

        collection["features"].append(source_feature("park-one"))
        with self.assertRaisesRegex(importer.ParkImportError, "duplicate park id"):
            importer.parse_boundary_source(collection)

        missing_ids = source_feature("missing-source-id")
        missing_ids["properties"].pop("sourceId")
        missing_ids["properties"].pop("sourceObjectIds")
        with self.assertRaisesRegex(importer.ParkImportError, "no GIS source feature ID"):
            importer.parse_boundary_source({"type": "FeatureCollection", "features": [missing_ids]})

        inconsistent_ids = source_feature("inconsistent-source-id", object_ids=[244, 347])
        inconsistent_ids["properties"]["sourceId"] = "347"
        with self.assertRaisesRegex(importer.ParkImportError, "does not match"):
            importer.parse_boundary_source({"type": "FeatureCollection", "features": [inconsistent_ids]})

    def test_windows_source_path_and_selected_only_topology_validation(self):
        with tempfile.TemporaryDirectory() as directory:
            source_path = Path(directory) / "legacy.geojson"
            source_path.write_text("{\"type\":\"FeatureCollection\",\"features\":[]}", encoding="utf-8")
            raw, reference = importer.read_source(str(source_path.resolve()), "boundary")
            self.assertEqual(reference["kind"], "file")
            self.assertEqual(reference["sha256"], importer.sha256(raw))
            if os.name == "nt":
                self.assertRegex(reference["locator"], r"^[A-Za-z]:\\")

        invalid_other = source_feature("other-park", {"type": "Polygon", "coordinates": [[[0, 0], [2, 2], [0, 2], [2, 0], [0, 0]]]})
        collection = {"type": "FeatureCollection", "features": [source_feature("park-one"), invalid_other]}
        self.assertEqual(set(importer.parse_boundary_source(collection, {"park-one"})), {"park-one"})
        with self.assertRaisesRegex(importer.ParkImportError, "invalid"):
            importer.parse_boundary_source(collection)

    def test_new_park_requires_complete_reviewed_walk_and_route_input(self):
        place = {
            "id": "park-new",
            "name": "New Park",
            "category": "regional",
            "region": "Island",
            "latitude": 48.4,
            "longitude": -123.3,
        }
        hubs = [
            {"position": 0, "name": "One", "lng": -123.3, "lat": 48.4},
            {"position": 1, "name": "Two", "lng": -123.4, "lat": 48.5},
        ]

        with self.assertRaisesRegex(importer.ParkImportError, "at least one verified route"):
            importer.validate_new_park("park-new", "park-new", place, {"presentation": review_item()["presentation"], "walkM": 0, "drive": [None, None]}, hubs)

    def test_new_park_matches_account_snapshot_limits(self):
        place = {
            "id": "park-new",
            "name": "New Park",
            "category": "regional",
            "region": "Island",
            "latitude": 48.4,
            "longitude": -123.3,
        }
        hubs = [
            {"position": 0, "name": "One", "lng": -123.3, "lat": 48.4},
            {"position": 1, "name": "Two", "lng": -123.4, "lat": 48.5},
        ]
        cases = [
            ("seed", 1_000_001, "seed"),
            ("blurb", "x" * 801, "blurb"),
            ("name", "🦊" * 71, "name"),
            ("short", "Park\u0001Name", "control characters"),
        ]
        for key, value, message in cases:
            with self.subTest(key=key), self.assertRaisesRegex(importer.ParkImportError, message):
                item = review_item()
                if key in {"name", "region"}:
                    changed_place = {**place, key: value}
                    importer.validate_new_park("park-new", "park-new", changed_place, item, hubs)
                else:
                    changed = {**item["presentation"], key: value}
                    importer.validate_new_park("park-new", "park-new", place, {**item, "presentation": changed}, hubs)

    def test_missing_new_park_inputs_make_a_blocked_review_plan(self):
        features = importer.parse_boundary_source({"type": "FeatureCollection", "features": [source_feature("park-new")]})
        plan = importer.build_plan(
            features,
            {"kind": "file", "locator": "fixture.geojson", "sha256": "0" * 64},
            ["park-new"],
            {},
            {"host": "127.0.0.1", "port": 55438, "database": "test", "environment": "local-qa", "revision": 0, "declaredHost": "127.0.0.1"},
            {},
            {},
        )

        self.assertEqual(plan["status"], "blocked")
        self.assertIn("reviewed new-park input", plan["blockers"][0])
        self.assertEqual(plan["changes"][0]["targetBeforeHash"], None)
        self.assertEqual(plan["planSha256"], importer.plan_digest(plan))

    def test_mapped_target_ids_match_the_account_id_pattern(self):
        features = importer.parse_boundary_source({"type": "FeatureCollection", "features": [source_feature("park-one")]})
        target = {"host": "127.0.0.1", "port": 55438, "database": "test", "environment": "local-qa", "revision": 0, "declaredHost": "127.0.0.1"}
        for invalid_id in ("park--new", "park-new-"):
            with self.subTest(target_id=invalid_id), self.assertRaisesRegex(importer.ParkImportError, "target park ID is invalid"):
                importer.build_plan(features, {"kind": "file", "locator": "fixture.geojson", "sha256": "0" * 64}, ["park-one"], {"park-one": invalid_id}, target, {}, {})


TEST_DSN = os.environ.get("LEGACY_IMPORT_TEST_DATABASE_URL") or os.environ.get("PARKDEX_LEGACY_IMPORT_TEST_DATABASE_URL")


@unittest.skipUnless(TEST_DSN, "requires an isolated issue20 loopback PostgreSQL database")
class PostgreSQLImportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import psycopg
        from psycopg.conninfo import conninfo_to_dict

        cls.dsn = TEST_DSN
        info = conninfo_to_dict(cls.dsn)
        allowed_databases = ("kip_qa_issue20_", "kip_qa_legacy_import_")
        if info.get("host") not in {"127.0.0.1", "localhost", "::1"} or not info.get("dbname", "").startswith(allowed_databases):
            raise RuntimeError("Integration tests require a unique issue20 database on loopback")
        cls.root = Path(__file__).resolve().parents[1]
        with psycopg.connect(cls.dsn) as conn:
            with conn.cursor() as cursor:
                for migration in (cls.root / "database/001_cloud_content.sql", cls.root / "database/migrations/content_001_sync.sql"):
                    cursor.execute(migration.read_text(encoding="utf-8"), prepare=False)
                cursor.execute("INSERT INTO public.drive_hubs (position, name, lng, lat) VALUES (0, 'One', -123.3, 48.4), (1, 'Two', -123.4, 48.5)")
                cursor.execute(
                    "INSERT INTO public.parks (id, name, short, category, region, lat, lng, biome, shape, rarity, scene, seed, blurb) "
                    "VALUES ('regional-existing-1', 'Existing Park', 'Existing', 'regional', 'Island', 48.4, -123.3, 'coast', 'circle', 'rare', NULL, 12, 'Keep this metadata.')"
                )
                cursor.execute(
                    "INSERT INTO public.boundaries (park_id, feature) VALUES ('regional-existing-1', %s::jsonb)",
                    (json.dumps(importer._public_feature("regional-existing-1", "coast", square(-2))),),
                )
                cursor.execute("INSERT INTO public.park_drive_settings (park_id, walk_m) VALUES ('regional-existing-1', 11)")
                cursor.execute("INSERT INTO public.park_drive (park_id, hub_position, distance_km, duration_min) VALUES ('regional-existing-1', 0, 1, 2), ('regional-existing-1', 1, 3, 4)")

    def _plan(self, temp: Path, features: list[dict], ids: list[str], catalogue: dict | None = None, review: dict | None = None) -> tuple[dict, Path]:
        boundary_file = temp / "legacy.geojson"
        boundary_file.write_text(json.dumps({"type": "FeatureCollection", "features": features}), encoding="utf-8")
        catalogue_file = None
        review_file = None
        if catalogue is not None:
            catalogue_file = temp / "places.json"
            catalogue_file.write_text(json.dumps(catalogue), encoding="utf-8")
        if review is not None:
            review_file = temp / "review.json"
            review_file.write_text(json.dumps(review), encoding="utf-8")
        output_file = temp / "plan.json"
        import psycopg
        with psycopg.connect(self.dsn) as conn:
            host = conn.info.host
        args = type("Args", (), {
            "source": str(boundary_file),
            "park_id": ids,
            "id_map": [],
            "catalogue_source": str(catalogue_file) if catalogue_file else None,
            "new_park_review": review_file,
            "target_host": host,
            "target_environment": "local-qa",
            "out": output_file,
        })()
        with patch.dict(os.environ, {"DATABASE_URL": self.dsn}):
            importer.run_plan(args)
        return json.loads(output_file.read_text(encoding="utf-8")), output_file

    def _apply(self, plan: dict, path: Path) -> dict:
        args = type("Args", (), {
            "plan": path,
            "reviewed_plan_sha": plan["planSha256"],
            "expected_target_host": plan["target"]["declaredHost"],
            "target_environment": plan["target"]["environment"],
        })()
        with patch.dict(os.environ, {"DATABASE_URL": self.dsn}):
            return importer.run_apply(args)

    def test_real_update_insert_replay_drift_and_rollback(self):
        import psycopg

        new_id = "regional-new-1"
        new_place = {"places": [{"id": new_id, "name": "New Park", "category": "regional", "region": "Island", "latitude": 48.42, "longitude": -123.32}]}
        with tempfile.TemporaryDirectory() as directory:
            temp = Path(directory)
            before_park = None
            with psycopg.connect(self.dsn) as conn:
                with conn.cursor() as cursor:
                    cursor.execute("SELECT id, name, short, category, region, lat, lng, biome, shape, rarity, scene, seed, blurb FROM public.parks WHERE id = 'regional-existing-1'")
                    before_park = cursor.fetchone()
                    cursor.execute("SELECT revision FROM public.content_clock WHERE singleton = true")
                    before_revision = cursor.fetchone()[0]
            existing_plan, existing_file = self._plan(temp, [source_feature("regional-existing-1", square(4), [244, 347, 549])], ["regional-existing-1"])
            result = self._apply(existing_plan, existing_file)
            self.assertEqual(result["result"], "applied")
            self.assertEqual(result["revision"], before_revision + 1)
            with psycopg.connect(self.dsn) as conn:
                with conn.cursor() as cursor:
                    cursor.execute("SELECT id, name, short, category, region, lat, lng, biome, shape, rarity, scene, seed, blurb FROM public.parks WHERE id = 'regional-existing-1'")
                    self.assertEqual(cursor.fetchone(), before_park)
                    cursor.execute("SELECT feature FROM public.boundaries WHERE park_id = 'regional-existing-1'")
                    updated_boundary = importer._jsonb(cursor.fetchone()[0])
                    self.assertEqual(updated_boundary["geometry"], square(4))

            new_plan, new_file = self._plan(temp, [source_feature(new_id, square(8))], [new_id], new_place, {"parks": {new_id: review_item()}})
            before_new_revision = result["revision"]
            result_new = self._apply(new_plan, new_file)
            self.assertEqual(result_new["result"], "applied")
            self.assertEqual(result_new["revision"], before_new_revision + 1)
            with psycopg.connect(self.dsn) as conn:
                with conn.cursor() as cursor:
                    cursor.execute("SELECT short, biome, scene, seed FROM public.parks WHERE id = %s", (new_id,))
                    self.assertEqual(cursor.fetchone(), ("New Park", "coast", None, 77))
                    cursor.execute("SELECT walk_m FROM public.park_drive_settings WHERE park_id = %s", (new_id,))
                    self.assertEqual(cursor.fetchone(), (27,))
                    cursor.execute("SELECT hub_position, distance_km, duration_min FROM public.park_drive WHERE park_id = %s ORDER BY hub_position", (new_id,))
                    self.assertEqual(cursor.fetchall(), [(0, 8.5, 9.0), (1, None, None)])
                    cursor.execute("SELECT DISTINCT entity FROM public.content_changes WHERE revision = %s", (result_new["revision"],))
                    self.assertTrue({"park", "boundary", "drive"} <= {row[0] for row in cursor.fetchall()})

            with psycopg.connect(self.dsn) as conn:
                with conn.cursor() as cursor:
                    cursor.execute("UPDATE public.parks SET blurb = 'A later unrelated edit.' WHERE id = 'regional-existing-1'")
                    cursor.execute("SELECT revision FROM public.content_clock WHERE singleton = true")
                    newer_revision = cursor.fetchone()[0]
            replay = self._apply(new_plan, new_file)
            self.assertEqual(replay["result"], "already-current")
            self.assertEqual(replay["revision"], newer_revision)

            drift_plan, drift_file = self._plan(temp, [source_feature("regional-existing-1", square(12))], ["regional-existing-1"])
            drift_feature = importer._public_feature("regional-existing-1", "coast", square(15))
            with psycopg.connect(self.dsn) as conn:
                with conn.cursor() as cursor:
                    cursor.execute("UPDATE public.boundaries SET feature = %s::jsonb WHERE park_id = 'regional-existing-1'", (json.dumps(drift_feature),))
                    cursor.execute("SELECT revision FROM public.content_clock WHERE singleton = true")
                    drift_revision = cursor.fetchone()[0]
            with self.assertRaisesRegex(importer.ParkImportError, "boundary .* changed after planning"):
                self._apply(drift_plan, drift_file)
            with psycopg.connect(self.dsn) as conn:
                with conn.cursor() as cursor:
                    cursor.execute("SELECT feature FROM public.boundaries WHERE park_id = 'regional-existing-1'")
                    self.assertEqual(importer._jsonb(cursor.fetchone()[0]), drift_feature)
                    cursor.execute("SELECT revision FROM public.content_clock WHERE singleton = true")
                    self.assertEqual(cursor.fetchone()[0], drift_revision)

            failing_id = "regional-fail-1"
            rollback_plan, rollback_file = self._plan(
                temp,
                [source_feature("regional-existing-1", square(20)), source_feature(failing_id, square(30))],
                ["regional-existing-1", failing_id],
                {"places": [{"id": failing_id, "name": "Fail Park", "category": "regional", "region": "Island", "latitude": 48.43, "longitude": -123.33}]},
                {"parks": {failing_id: review_item("unregistered-scene")}},
            )
            with psycopg.connect(self.dsn) as conn:
                with conn.cursor() as cursor:
                    cursor.execute("SELECT feature FROM public.boundaries WHERE park_id = 'regional-existing-1'")
                    before_rollback_boundary = importer._jsonb(cursor.fetchone()[0])
                    cursor.execute("SELECT revision FROM public.content_clock WHERE singleton = true")
                    before_rollback_revision = cursor.fetchone()[0]
            with self.assertRaisesRegex(importer.ParkImportError, "all changes were rolled back"):
                self._apply(rollback_plan, rollback_file)
            with psycopg.connect(self.dsn) as conn:
                with conn.cursor() as cursor:
                    cursor.execute("SELECT feature FROM public.boundaries WHERE park_id = 'regional-existing-1'")
                    self.assertEqual(importer._jsonb(cursor.fetchone()[0]), before_rollback_boundary)
                    cursor.execute("SELECT count(*) FROM public.parks WHERE id = %s", (failing_id,))
                    self.assertEqual(cursor.fetchone()[0], 0)
                    cursor.execute("SELECT revision FROM public.content_clock WHERE singleton = true")
                    self.assertEqual(cursor.fetchone()[0], before_rollback_revision)


if __name__ == "__main__":
    unittest.main(verbosity=2)

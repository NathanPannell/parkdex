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
            source_path.write_text('{"type":"FeatureCollection","features":[]}', encoding="utf-8")
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

        with self.assertRaisesRegex(importer.ParkImportError, "all-null drive requires explicit accessUnknown"):
            importer.validate_new_park("park-new", "park-new", place, {"presentation": review_item()["presentation"], "walkM": 0, "drive": [None, None]}, hubs)

    def test_unknown_access_requires_and_records_the_composite_sentinel(self):
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
        review = {"presentation": review_item()["presentation"], "walkM": 0, "drive": [None, None], "accessUnknown": True}

        _, drive = importer.validate_new_park("park-new", "park-new", place, review, hubs)

        self.assertEqual(drive, {"walkM": 0, "drive": [None, None], "hubs": hubs})
        self.assertNotIn("accessUnknown", drive)
        features = importer.parse_boundary_source({"type": "FeatureCollection", "features": [source_feature("park-new")]})
        plan = importer.build_plan(
            features,
            {"kind": "file", "locator": "fixture.geojson", "sha256": "0" * 64},
            ["park-new"],
            {},
            {"host": "127.0.0.1", "port": 55438, "database": "test", "environment": "local-qa", "revision": 0, "declaredHost": "127.0.0.1"},
            {},
            {},
            {"park-new": place},
            {"kind": "file", "locator": "places.json", "sha256": "1" * 64},
            {"park-new": review},
            {"kind": "file", "locator": "review.json", "sha256": "2" * 64},
            hubs,
        )
        self.assertTrue(plan["changes"][0]["accessUnknown"])
        self.assertNotIn("accessUnknown", plan["changes"][0]["desiredDrive"])

    def test_unknown_access_rejects_nullable_negative_and_mixed_values(self):
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
        base = {"presentation": review_item()["presentation"], "walkM": 0, "drive": [None, None]}
        invalid = [
            ({**base, "walkM": None}, "walkM must be a finite non-negative number"),
            ({**base, "walkM": -1}, "walkM must be a finite non-negative number"),
            ({**base, "accessUnknown": True, "walkM": 4}, "accessUnknown requires walkM 0"),
            ({**base, "accessUnknown": True, "drive": [[1, 2], None]}, "accessUnknown requires walkM 0 and null for every drive hub"),
            ({**base, "accessUnknown": False}, "accessUnknown must be true"),
        ]
        for candidate, message in invalid:
            with self.subTest(candidate=candidate), self.assertRaisesRegex(importer.ParkImportError, message):
                importer.validate_new_park("park-new", "park-new", place, candidate, hubs)

    def test_existing_park_rarity_review_pins_expected_and_desired_values(self):
        features = importer.parse_boundary_source({"type": "FeatureCollection", "features": [source_feature("park-one")]})
        current_feature = importer._public_feature("park-one", "coast", square(-2))
        rarity_source = {"kind": "file", "locator": "rarity-review.json", "sha256": "1" * 64}
        rarity_review = importer.parse_rarity_review({"parks": {"park-one": {"rarity": "uncommon", "rationale": "Matches the reviewed regional scale."}}})
        plan = importer.build_plan(
            features,
            {"kind": "file", "locator": "fixture.geojson", "sha256": "0" * 64},
            ["park-one"],
            {},
            {"host": "127.0.0.1", "port": 55438, "database": "test", "environment": "local-qa", "revision": 4, "declaredHost": "127.0.0.1"},
            {"park-one": {"biome": "coast", "rarity": "rare"}},
            {"park-one": current_feature},
            rarity_review=rarity_review,
            rarity_review_source=rarity_source,
        )

        change = plan["changes"][0]
        self.assertEqual(change["expectedRarity"], "rare")
        self.assertEqual(change["desiredRarity"], "uncommon")
        self.assertEqual(change["rarityReviewRationale"], "Matches the reviewed regional scale.")
        self.assertEqual(plan["sources"]["rarityReview"], rarity_source)
        self.assertEqual(plan["planSha256"], importer.plan_digest(plan))
        boundary_only = importer.build_plan(
            features,
            {"kind": "file", "locator": "fixture.geojson", "sha256": "0" * 64},
            ["park-one"],
            {},
            {"host": "127.0.0.1", "port": 55438, "database": "test", "environment": "local-qa", "revision": 4, "declaredHost": "127.0.0.1"},
            {"park-one": {"biome": "coast", "rarity": "rare"}},
            {"park-one": current_feature},
        )
        self.assertNotIn("expectedRarity", boundary_only["changes"][0])
        self.assertNotIn("desiredRarity", boundary_only["changes"][0])

    def test_rarity_review_source_hash_is_rechecked(self):
        with tempfile.TemporaryDirectory() as directory:
            source_path = Path(directory) / "rarity-review.json"
            source_path.write_text('{"parks":{"park-one":"uncommon"}}', encoding="utf-8")
            _, source = importer.read_source(str(source_path), "rarity review")
            plan = {"sources": {"rarityReview": source}}

            importer.verify_plan_sources(plan)
            source_path.write_text('{"parks":{"park-one":"common"}}', encoding="utf-8")
            with self.assertRaisesRegex(importer.ParkImportError, "rarityReview source changed after plan review"):
                importer.verify_plan_sources(plan)

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

    def test_gzipped_source_files_are_read_and_pinned_as_stored(self):
        import gzip

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "boundaries.geojson.gz"
            stored = gzip.compress(b'{"type":"FeatureCollection","features":[]}', mtime=0)
            path.write_bytes(stored)
            raw, reference = importer.read_source(str(path), "boundary")
            self.assertEqual(raw, b'{"type":"FeatureCollection","features":[]}')
            self.assertEqual(reference["sha256"], importer.sha256(stored))

    def test_park_id_file_lists_ids_in_order_and_rejects_bad_lines(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "ids.txt"
            path.write_text("# phase 1\nregional-a-1\n\n  municipal-b-2  \n", encoding="utf-8")
            self.assertEqual(importer.read_park_id_file(path), ["regional-a-1", "municipal-b-2"])
            path.write_text("regional-a-1\nNot An Id\n", encoding="utf-8")
            with self.assertRaisesRegex(importer.ParkImportError, "invalid stable ID"):
                importer.read_park_id_file(path)
            path.write_text("# nothing\n", encoding="utf-8")
            with self.assertRaisesRegex(importer.ParkImportError, "no park IDs"):
                importer.read_park_id_file(path)
        self.assertEqual(importer.read_park_id_file(None), [])

    def test_minimum_reader_is_recorded_on_new_parks_only(self):
        features = importer.parse_boundary_source(
            {"type": "FeatureCollection", "features": [source_feature("regional-new-1"), source_feature("regional-old-1")]}
        )
        target = {"host": "127.0.0.1", "port": 55438, "database": "test", "environment": "local-qa", "revision": 0, "declaredHost": "127.0.0.1"}
        place = {"id": "regional-new-1", "name": "New Park", "category": "regional", "region": "Island", "latitude": 48.42, "longitude": -123.32}
        existing = {"regional-old-1": {"id": "regional-old-1", "biome": "coast", "rarity": "common"}}
        hubs = [{"position": 0, "name": "One", "lng": -123.3, "lat": 48.4}, {"position": 1, "name": "Two", "lng": -123.4, "lat": 48.5}]
        source = {"kind": "file", "locator": "fixture.geojson", "sha256": "0" * 64}
        plan = importer.build_plan(
            features,
            source,
            ["regional-new-1", "regional-old-1"],
            {},
            target,
            existing,
            {},
            {"regional-new-1": place},
            source,
            {"regional-new-1": review_item()},
            source,
            hubs,
            minimum_reader=3,
        )
        self.assertEqual(plan["minimumReader"], 3)
        self.assertEqual([change.get("minimumReader") for change in plan["changes"]], [3, None])
        without = importer.build_plan(
            features,
            source,
            ["regional-new-1"],
            {},
            target,
            {},
            {},
            {"regional-new-1": place},
            source,
            {"regional-new-1": review_item()},
            source,
            hubs,
        )
        self.assertNotIn("minimumReader", without)
        with self.assertRaisesRegex(importer.ParkImportError, "minimum-reader"):
            importer.build_plan(features, source, ["regional-new-1"], {}, target, {}, {}, minimum_reader=1)

    def test_mapped_target_ids_match_the_account_id_pattern(self):
        features = importer.parse_boundary_source({"type": "FeatureCollection", "features": [source_feature("park-one")]})
        target = {"host": "127.0.0.1", "port": 55438, "database": "test", "environment": "local-qa", "revision": 0, "declaredHost": "127.0.0.1"}
        for invalid_id in ("park--new", "park-new-"):
            with self.subTest(target_id=invalid_id), self.assertRaisesRegex(importer.ParkImportError, "target park ID is invalid"):
                importer.build_plan(
                    features, {"kind": "file", "locator": "fixture.geojson", "sha256": "0" * 64}, ["park-one"], {"park-one": invalid_id}, target, {}, {}
                )


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
                for migration in (
                    cls.root / "database/001_cloud_content.sql",
                    cls.root / "database/migrations/content_001_sync.sql",
                    cls.root / "database/migrations/content_002_authoring.sql",
                    cls.root / "database/migrations/content_003_park_maps_link.sql",
                    cls.root / "database/migrations/content_004_catalogue_release.sql",
                ):
                    cursor.execute(migration.read_text(encoding="utf-8"), prepare=False)
                cursor.execute("INSERT INTO public.drive_hubs (position, name, lng, lat) VALUES (0, 'One', -123.3, 48.4), (1, 'Two', -123.4, 48.5)")
                cursor.execute(
                    "INSERT INTO public.r2_objects (logical_path, object_key, url, sha256, byte_size, content_type) "
                    "VALUES ('art/badges/scenes/existing-scene.webp', %s, %s, %s, 1, 'image/webp')",
                    (
                        f"releases/{'a' * 64}/art/badges/scenes/existing-scene.webp",
                        f"https://kip-assets.parkdex.app/releases/{'a' * 64}/art/badges/scenes/existing-scene.webp",
                        "a" * 64,
                    ),
                )
                cursor.execute(
                    "INSERT INTO public.parks (id, name, short, category, region, lat, lng, biome, shape, rarity, scene, seed, blurb) "
                    "VALUES ('regional-existing-1', 'Existing Park', 'Existing', 'regional', 'Island', 48.4, -123.3, 'coast', 'circle', 'rare', 'existing-scene', 12, 'Keep this metadata.'), "
                    "('regional-existing-2', 'Queued Park', 'Queued', 'regional', 'Island', 48.41, -123.31, 'coast', 'circle', 'rare', NULL, 13, 'Keep queued metadata.')"
                )
                cursor.execute(
                    "INSERT INTO public.boundaries (park_id, feature) VALUES ('regional-existing-1', %s::jsonb), ('regional-existing-2', %s::jsonb)",
                    (
                        json.dumps(importer._public_feature("regional-existing-1", "coast", square(-2))),
                        json.dumps(importer._public_feature("regional-existing-2", "coast", square(-4))),
                    ),
                )
                cursor.execute("INSERT INTO public.park_drive_settings (park_id, walk_m) VALUES ('regional-existing-1', 11), ('regional-existing-2', 12)")
                cursor.execute(
                    "INSERT INTO public.park_drive (park_id, hub_position, distance_km, duration_min) VALUES "
                    "('regional-existing-1', 0, 1, 2), ('regional-existing-1', 1, 3, 4), "
                    "('regional-existing-2', 0, 5, 6), ('regional-existing-2', 1, 7, 8)"
                )
                cursor.execute("SELECT revision FROM public.content_clock WHERE singleton = true")
                revision = cursor.fetchone()[0]
                cursor.execute(
                    "INSERT INTO public.park_enrichment_rollout "
                    "(singleton, source_bundle_sha256, ranked_list_sha256, expected_count, target_environment, target_id, database_host, applied_content_revision) "
                    "VALUES (true, %s, %s, 100, 'staging', NULL, %s, %s)",
                    ("b" * 64, "c" * 64, conn.info.host or "127.0.0.1", revision),
                )
                frozen_research = {
                    "google_image_refs": [f"https://images.example.test/{index}" for index in range(5)],
                    "fact_urls": ["https://facts.example.test/park"],
                    "dossier_path": "dossier.md",
                    "dossier_sha256": "d" * 64,
                    "prompts": {},
                }
                selected_art = {
                    "local_path": "C:/qa/queue-scene.webp",
                    "sha256": "e" * 64,
                    "byte_size": 1,
                    "scene_slug": "queue-scene",
                    "expected": {"blurb": "Keep queued metadata.", "rarity": "rare", "scene": None},
                    "desired": {"blurb": "Keep queued metadata.", "rarity": "uncommon", "scene": "queue-scene"},
                }
                cursor.execute(
                    "INSERT INTO public.park_enrichment_jobs "
                    "(rank, park_id, state, frozen_research, selected_art) VALUES (2, 'regional-existing-2', 'needs_attention', %s::jsonb, %s::jsonb)",
                    (json.dumps(frozen_research), json.dumps(selected_art)),
                )

    def _plan(
        self,
        temp: Path,
        features: list[dict],
        ids: list[str],
        catalogue: dict | None = None,
        review: dict | None = None,
        rarity: dict | None = None,
        minimum_reader: int | None = None,
    ) -> tuple[dict, Path]:
        boundary_file = temp / "legacy.geojson"
        boundary_file.write_text(json.dumps({"type": "FeatureCollection", "features": features}), encoding="utf-8")
        catalogue_file = None
        review_file = None
        rarity_file = None
        if catalogue is not None:
            catalogue_file = temp / "places.json"
            catalogue_file.write_text(json.dumps(catalogue), encoding="utf-8")
        if review is not None:
            review_file = temp / "review.json"
            review_file.write_text(json.dumps(review), encoding="utf-8")
        if rarity is not None:
            rarity_file = temp / "rarity.json"
            rarity_file.write_text(json.dumps(rarity), encoding="utf-8")
        output_file = temp / "plan.json"
        import psycopg

        with psycopg.connect(self.dsn) as conn:
            host = conn.info.host
        args = type(
            "Args",
            (),
            {
                "source": str(boundary_file),
                "park_id": ids,
                "id_map": [],
                "catalogue_source": str(catalogue_file) if catalogue_file else None,
                "new_park_review": review_file,
                "rarity_review": rarity_file,
                "target_host": host,
                "target_environment": "local-qa",
                "out": output_file,
                "minimum_reader": minimum_reader,
            },
        )()
        with patch.dict(os.environ, {"DATABASE_URL": self.dsn}):
            importer.run_plan(args)
        return json.loads(output_file.read_text(encoding="utf-8")), output_file

    def _apply(self, plan: dict, path: Path) -> dict:
        args = type(
            "Args",
            (),
            {
                "plan": path,
                "reviewed_plan_sha": plan["planSha256"],
                "expected_target_host": plan["target"]["declaredHost"],
                "target_environment": plan["target"]["environment"],
            },
        )()
        with patch.dict(os.environ, {"DATABASE_URL": self.dsn}):
            return importer.run_apply(args)

    def test_rarity_change_is_atomic_preserves_other_fields_and_guards_frozen_art(self):
        import psycopg

        park_id = "regional-existing-1"
        with tempfile.TemporaryDirectory() as directory:
            temp = Path(directory)
            with psycopg.connect(self.dsn) as conn:
                with conn.cursor() as cursor:
                    cursor.execute(
                        "SELECT id, name, short, category, region, lat, lng, biome, shape, rarity, scene, seed, blurb FROM public.parks WHERE id = %s",
                        (park_id,),
                    )
                    before_park = list(cursor.fetchone())
                    cursor.execute(
                        "SELECT logical_path, object_key, url, sha256, byte_size, content_type FROM public.r2_objects WHERE logical_path = %s",
                        ("art/badges/scenes/existing-scene.webp",),
                    )
                    before_asset = cursor.fetchone()
                    cursor.execute(
                        "SELECT park_id, hub_position, distance_km, duration_min FROM public.park_drive WHERE park_id = %s ORDER BY hub_position", (park_id,)
                    )
                    before_drive = cursor.fetchall()
                    cursor.execute("SELECT revision FROM public.content_clock WHERE singleton = true")
                    before_revision = cursor.fetchone()[0]

            plan, path = self._plan(
                temp,
                [source_feature(park_id, square(4))],
                [park_id],
                rarity={"parks": {park_id: {"rarity": "uncommon", "rationale": "Reviewed to match the regional scale."}}},
            )
            result = self._apply(plan, path)
            self.assertEqual(result["result"], "applied")
            self.assertEqual(result["revision"], before_revision + 1)
            with psycopg.connect(self.dsn) as conn:
                with conn.cursor() as cursor:
                    cursor.execute(
                        "SELECT id, name, short, category, region, lat, lng, biome, shape, rarity, scene, seed, blurb FROM public.parks WHERE id = %s",
                        (park_id,),
                    )
                    after_park = list(cursor.fetchone())
                    cursor.execute(
                        "SELECT logical_path, object_key, url, sha256, byte_size, content_type FROM public.r2_objects WHERE logical_path = %s",
                        ("art/badges/scenes/existing-scene.webp",),
                    )
                    self.assertEqual(cursor.fetchone(), before_asset)
                    cursor.execute(
                        "SELECT park_id, hub_position, distance_km, duration_min FROM public.park_drive WHERE park_id = %s ORDER BY hub_position", (park_id,)
                    )
                    self.assertEqual(cursor.fetchall(), before_drive)
                    cursor.execute("SELECT entity, entity_id FROM public.content_changes WHERE revision = %s ORDER BY entity, entity_id", (result["revision"],))
                    self.assertEqual(
                        cursor.fetchall(),
                        [("asset", "art/badges/scenes/existing-scene.webp"), ("boundary", park_id), ("park", park_id)],
                    )
            before_park[9] = "uncommon"
            self.assertEqual(after_park, before_park)

            replay = self._apply(plan, path)
            self.assertEqual(replay["result"], "already-current")
            self.assertEqual(replay["revision"], result["revision"])

            stale_plan, stale_path = self._plan(
                temp,
                [source_feature(park_id, square(7))],
                [park_id],
                rarity={"parks": {park_id: "common"}},
            )
            with psycopg.connect(self.dsn) as conn:
                with conn.cursor() as cursor:
                    cursor.execute("UPDATE public.parks SET rarity = 'epic' WHERE id = %s", (park_id,))
            with self.assertRaisesRegex(importer.ParkImportError, "rarity changed after planning"):
                self._apply(stale_plan, stale_path)
            with psycopg.connect(self.dsn) as conn:
                with conn.cursor() as cursor:
                    cursor.execute("UPDATE public.parks SET rarity = 'uncommon' WHERE id = %s", (park_id,))

            queued_id = "regional-existing-2"
            queued_plan, queued_path = self._plan(
                temp,
                [source_feature(queued_id, square(9))],
                [queued_id],
                rarity={"parks": {queued_id: "uncommon"}},
            )
            with self.assertRaisesRegex(importer.ParkImportError, "Unpublished frozen authoring art exists"):
                self._apply(queued_plan, queued_path)
            with psycopg.connect(self.dsn) as conn:
                with conn.cursor() as cursor:
                    cursor.execute("SELECT rarity FROM public.parks WHERE id = %s", (queued_id,))
                    self.assertEqual(cursor.fetchone()[0], "rare")
                    cursor.execute("SELECT feature FROM public.boundaries WHERE park_id = %s", (queued_id,))
                    self.assertEqual(importer._jsonb(cursor.fetchone()[0]), importer._public_feature(queued_id, "coast", square(-4)))
                    cursor.execute("UPDATE public.parks SET rarity = 'rare' WHERE id = %s", (park_id,))
                    cursor.execute(
                        "UPDATE public.boundaries SET feature = %s::jsonb WHERE park_id = %s",
                        (json.dumps(importer._public_feature(park_id, "coast", square(-2))), park_id),
                    )

    def test_new_park_reader_floor_is_written_in_the_same_transaction_and_replays(self):
        import psycopg

        park_id = "regional-floor-1"
        place = {"places": [{"id": park_id, "name": "Floor Park", "category": "regional", "region": "Island", "latitude": 48.44, "longitude": -123.34}]}
        with tempfile.TemporaryDirectory() as directory:
            temp = Path(directory)
            plan, path = self._plan(temp, [source_feature(park_id, square(40))], [park_id], place, {"parks": {park_id: review_item()}}, minimum_reader=3)
            result = self._apply(plan, path)
            self.assertEqual(result["result"], "applied")
            with psycopg.connect(self.dsn) as conn:
                with conn.cursor() as cursor:
                    cursor.execute("SELECT minimum_reader FROM public.content_park_reader_floor WHERE park_id = %s", (park_id,))
                    self.assertEqual(cursor.fetchone(), (3,))
            self.assertEqual(self._apply(plan, path)["result"], "already-current")
            with psycopg.connect(self.dsn) as conn:
                with conn.cursor() as cursor:
                    cursor.execute("DELETE FROM public.parks WHERE id = %s", (park_id,))
                    cursor.execute("SELECT count(*) FROM public.content_park_reader_floor WHERE park_id = %s", (park_id,))
                    self.assertEqual(cursor.fetchone(), (0,))

    def test_real_update_insert_replay_drift_and_rollback(self):
        import psycopg

        new_id = "regional-new-1"
        new_place = {"places": [{"id": new_id, "name": "New Park", "category": "regional", "region": "Island", "latitude": 48.42, "longitude": -123.32}]}
        with tempfile.TemporaryDirectory() as directory:
            temp = Path(directory)
            before_park = None
            with psycopg.connect(self.dsn) as conn:
                with conn.cursor() as cursor:
                    cursor.execute(
                        "SELECT id, name, short, category, region, lat, lng, biome, shape, rarity, scene, seed, blurb FROM public.parks WHERE id = 'regional-existing-1'"
                    )
                    before_park = cursor.fetchone()
                    cursor.execute("SELECT revision FROM public.content_clock WHERE singleton = true")
                    before_revision = cursor.fetchone()[0]
            existing_plan, existing_file = self._plan(temp, [source_feature("regional-existing-1", square(4), [244, 347, 549])], ["regional-existing-1"])
            result = self._apply(existing_plan, existing_file)
            self.assertEqual(result["result"], "applied")
            self.assertEqual(result["revision"], before_revision + 1)
            with psycopg.connect(self.dsn) as conn:
                with conn.cursor() as cursor:
                    cursor.execute(
                        "SELECT id, name, short, category, region, lat, lng, biome, shape, rarity, scene, seed, blurb FROM public.parks WHERE id = 'regional-existing-1'"
                    )
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

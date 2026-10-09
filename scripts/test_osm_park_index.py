#!/usr/bin/env python3
"""Tests for scripts/osm_park_index.py.

The extract test needs pyosmium and is skipped without it (CI does not install it). The
PostgreSQL tests need OSM_PARKS_TEST_DATABASE_URL pointing at a loopback kip_qa_* database.
"""
from __future__ import annotations

import contextlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))
import osm_park_index as index  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = Path(__file__).resolve().parent / "fixtures" / "osm-parks-mini.osm"
MIGRATION = ROOT / "database" / "migrations" / "osm_parks_001_init.sql"


def square(west: float, south: float, east: float, north: float) -> list[list[float]]:
    return [[west, south], [east, south], [east, north], [west, north], [west, south]]


PATERSON = {"type": "way", "id": 23938892, "kind": "leisure=park", "tags": {"name": "Paterson Park", "leisure": "park"},
            "geometry": {"type": "Polygon", "coordinates": [square(-123.062, 49.088, -123.058, 49.090)]}}
WATERSHED = {"type": "relation", "id": 200, "kind": "leisure=nature_reserve", "tags": {"name": "Watershed Park", "leisure": "nature_reserve"},
             "geometry": {"type": "MultiPolygon", "coordinates": [[square(-122.9, 49.11, -122.88, 49.118), square(-122.895, 49.112, -122.89, 49.115)]]}}
UNNAMED = {"type": "way", "id": 400, "kind": "landuse=recreation_ground", "tags": {"landuse": "recreation_ground"},
           "geometry": {"type": "Polygon", "coordinates": [square(-123.07, 49.096, -123.068, 49.097)]}}


def write_slim(directory: Path, records: list[dict], source_date: str = "2026-10-07T20:20:00Z", name: str = "parks.geojsonl") -> Path:
    path = directory / name
    body = "".join(json.dumps(record) + "\n" for record in records).encode("utf-8")
    path.write_bytes(body)
    rows, sha, size = index.read_slim(path)
    index.manifest_path(path).write_text(json.dumps({
        "schema": index.MANIFEST_SCHEMA, "sourceName": "british-columbia-latest.osm.pbf", "sourceDate": source_date,
        "sha256": sha, "bytes": size, "rows": len(rows),
    }), encoding="utf-8")
    return path


class TagTests(unittest.TestCase):
    def test_park_like_kinds_and_private_areas(self):
        self.assertEqual(index.kind_of({"leisure": "park"}), "leisure=park")
        self.assertEqual(index.kind_of({"leisure": "dog_park"}), "leisure=dog_park")
        self.assertEqual(index.kind_of({"boundary": "protected_area"}), "boundary=protected_area")
        self.assertEqual(index.kind_of({"landuse": "recreation_ground"}), "landuse=recreation_ground")
        self.assertIsNone(index.kind_of({"leisure": "pitch"}))
        self.assertIsNone(index.kind_of({"building": "yes"}))
        self.assertFalse(index.is_public({"access": "private"}))
        self.assertFalse(index.is_public({"access": "no"}))
        self.assertTrue(index.is_public({"access": "permissive"}))


class SlimFileTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_records_become_multipolygons_with_box_and_area(self):
        rows, sha, size = index.read_slim(write_slim(self.dir, [PATERSON, WATERSHED, UNNAMED]))
        self.assertEqual(len(rows), 3)
        self.assertEqual(len(sha), 64)
        self.assertGreater(size, 0)
        paterson = rows[0]
        self.assertEqual(paterson["geometry"]["type"], "MultiPolygon")
        self.assertEqual((paterson["min_lat"], paterson["max_lat"], paterson["min_lng"], paterson["max_lng"]), (49.088, 49.09, -123.062, -123.058))
        self.assertAlmostEqual(paterson["area_m2"], 290 * 221, delta=2_000)
        watershed = rows[1]
        self.assertEqual(len(watershed["geometry"]["coordinates"][0]), 2, "the hole is kept")
        self.assertLess(watershed["area_m2"], 1460 * 884)
        self.assertIsNone(rows[2]["name"])

    def test_bad_records_are_refused(self):
        cases = {
            "repeats": [PATERSON, PATERSON],
            "private": [{**PATERSON, "tags": {**PATERSON["tags"], "access": "private"}}],
            "not closed": [{**PATERSON, "geometry": {"type": "Polygon", "coordinates": [[[-123.06, 49.08], [-123.05, 49.08], [-123.05, 49.09], [-123.06, 49.09]]]}}],
            "kind does not match": [{**PATERSON, "kind": "leisure=garden"}],
            "point": [{**PATERSON, "geometry": {"type": "Point", "coordinates": [-123.06, 49.08]}}],
            "node": [{**PATERSON, "type": "node"}],
        }
        for label, records in cases.items():
            with self.subTest(label):
                path = self.dir / "bad.geojsonl"
                path.write_text("".join(json.dumps(record) + "\n" for record in records), encoding="utf-8")
                with self.assertRaises(index.OsmIndexError):
                    index.read_slim(path)

    def test_manifest_must_match_the_file(self):
        path = write_slim(self.dir, [PATERSON])
        _, sha, _ = index.read_slim(path)
        self.assertEqual(index.read_manifest(path, sha)["sourceDate"], "2026-10-07T20:20:00Z")
        with self.assertRaises(index.OsmIndexError):
            index.read_manifest(path, "0" * 64)


class PlanTests(unittest.TestCase):
    def test_replace_noop_and_older_extract(self):
        current = {"sourceDate": "2026-10-07T20:20:00Z", "sourceSha256": "a" * 64, "sourceName": "x", "rows": 5}
        self.assertEqual(index.decide("2026-10-07T20:20:00Z", "a" * 64, None)[0], "replace")
        self.assertEqual(index.decide("2026-10-07T20:20:00Z", "a" * 64, current)[0], "noop")
        self.assertEqual(index.decide("2026-10-07T20:20:00Z", "b" * 64, current)[0], "replace")
        self.assertEqual(index.decide("2026-11-01T00:00:00Z", "b" * 64, current)[0], "replace")
        action, blockers = index.decide("2026-09-01T00:00:00Z", "b" * 64, current)
        self.assertEqual(action, "blocked")
        self.assertIn("newer extract", blockers[0])

    def test_the_reviewed_sha_pins_the_plan(self):
        with tempfile.TemporaryDirectory() as tmp:
            slim = write_slim(Path(tmp), [PATERSON])
            rows, sha, size = index.read_slim(slim)
            target = {"host": "127.0.0.1", "port": 5432, "database": "kip_qa_x", "environment": "local-qa", "declaredHost": "127.0.0.1", "current": None}
            plan = index.build_plan(slim, rows, sha, size, index.read_manifest(slim, sha), target)
            self.assertEqual(plan["action"], "replace")
            self.assertEqual(plan["source"]["byKind"], {"leisure=park": 1})
            path = Path(tmp) / "plan.json"
            path.write_text(json.dumps(plan), encoding="utf-8")
            self.assertEqual(index.load_reviewed_plan(path, plan["planSha256"])["planSha256"], plan["planSha256"])
            with self.assertRaises(index.OsmIndexError):
                index.load_reviewed_plan(path, "f" * 64)
            path.write_text(json.dumps({**plan, "action": "noop"}), encoding="utf-8")
            with self.assertRaises(index.OsmIndexError):
                index.load_reviewed_plan(path, plan["planSha256"])


def _has_osmium() -> bool:
    try:
        import osmium  # noqa: F401
        import shapely  # noqa: F401
    except ImportError:
        return False
    return True


@unittest.skipUnless(_has_osmium(), "pyosmium is only needed by operators running extract")
class ExtractTests(unittest.TestCase):
    def test_extract_keeps_public_park_areas_with_holes_and_is_reproducible(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "parks.geojsonl"
            manifest = index.extract(FIXTURE, out, "2026-10-07T20:20:00Z")
            self.assertEqual(manifest["rows"], 3)
            self.assertEqual(manifest["named"], 2)
            self.assertEqual(manifest["skippedPrivate"], 1)
            self.assertEqual(manifest["byKind"], {"landuse=recreation_ground": 1, "leisure=nature_reserve": 1, "leisure=park": 1})
            rows, sha, _ = index.read_slim(out)
            self.assertEqual(sha, manifest["sha256"])
            self.assertEqual([(row["osm_type"], row["osm_id"]) for row in rows], [("relation", 200), ("way", 100), ("way", 400)])
            self.assertEqual(len(rows[0]["geometry"]["coordinates"][0]), 2, "the pond is a hole")
            self.assertEqual(rows[1]["tags"], {"name": "Paterson Park", "leisure": "park", "operator": "City of Delta"})
            again = index.extract(FIXTURE, Path(tmp) / "again.geojsonl", "2026-10-07T20:20:00Z")
            self.assertEqual(again["sha256"], manifest["sha256"])


TEST_URL = os.environ.get("OSM_PARKS_TEST_DATABASE_URL")


@unittest.skipUnless(TEST_URL, "set OSM_PARKS_TEST_DATABASE_URL for loopback PostgreSQL QA")
class PostgresTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        parts = urlsplit(TEST_URL)
        if parts.hostname not in ("127.0.0.1", "localhost", "::1") or not parts.path.lstrip("/").startswith("kip_qa_"):
            raise RuntimeError("OSM_PARKS_TEST_DATABASE_URL must point to a loopback kip_qa_ database")
        import psycopg
        with psycopg.connect(TEST_URL, autocommit=True) as conn:
            # Repeat-safe: it runs on every deploy.
            conn.execute(MIGRATION.read_text(encoding="utf-8"))
            conn.execute(MIGRATION.read_text(encoding="utf-8"))
            conn.execute("DELETE FROM kip_osm.parks")
            conn.execute("DELETE FROM kip_osm.source")

    def run_cli(self, *argv: str) -> tuple[int, dict]:
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.dict(os.environ, {"DATABASE_URL": TEST_URL}), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = index.main(list(argv))
        return code, (json.loads(out.getvalue()) if code == 0 else {"error": err.getvalue()})

    def plan(self, slim: Path, tmp: Path) -> dict:
        code, result = self.run_cli("plan", "--source", str(slim), "--target-host", "127.0.0.1", "--target-environment", "local-qa", "--out", str(tmp / "plan.json"))
        self.assertEqual(code, 0, result)
        return result

    def apply(self, tmp: Path, sha: str) -> tuple[int, dict]:
        return self.run_cli("apply", "--plan", str(tmp / "plan.json"), "--reviewed-plan-sha", sha, "--expected-target-host", "127.0.0.1", "--target-environment", "local-qa")

    def test_load_replace_noop_and_refusals(self):
        import psycopg
        with tempfile.TemporaryDirectory() as raw:
            tmp = Path(raw)
            first = write_slim(tmp, [PATERSON, WATERSHED])
            plan = self.plan(first, tmp)
            self.assertEqual(plan["action"], "replace")
            code, result = self.apply(tmp, plan["planSha256"])
            self.assertEqual(code, 0, result)
            self.assertEqual(result["result"], "replaced")
            self.assertEqual(result["rows"], 2)
            with psycopg.connect(TEST_URL) as conn:
                row = conn.execute("SELECT name, kind, min_lat, max_lng, geometry->>'type', jsonb_array_length(geometry->'coordinates'->0), source_date "
                                   "FROM kip_osm.parks WHERE osm_type = 'relation' AND osm_id = 200").fetchone()
                self.assertEqual(row[:6], ("Watershed Park", "leisure=nature_reserve", 49.11, -122.88, "MultiPolygon", 2))
                self.assertEqual(index.iso(row[6]), "2026-10-07T20:20:00Z")

            # Applying the same plan again changes nothing, and so does a fresh plan of the same extract.
            code, again = self.apply(tmp, plan["planSha256"])
            self.assertEqual((code, again["result"]), (0, "unchanged"))
            self.assertEqual(self.plan(first, tmp)["action"], "noop")

            # A stale plan is refused once something else loaded in between.
            newer = write_slim(tmp, [PATERSON, WATERSHED, UNNAMED], "2026-11-01T00:00:00Z", "newer.geojsonl")
            stale = self.plan(newer, tmp)
            (tmp / "stale.json").write_text((tmp / "plan.json").read_text(encoding="utf-8"), encoding="utf-8")
            with psycopg.connect(TEST_URL) as conn:
                conn.execute("UPDATE kip_osm.source SET source_sha256 = %s", ("c" * 64,))
            code, refused = self.run_cli("apply", "--plan", str(tmp / "stale.json"), "--reviewed-plan-sha", stale["planSha256"], "--expected-target-host", "127.0.0.1", "--target-environment", "local-qa")
            self.assertEqual(code, 1)
            self.assertIn("changed since the plan", refused["error"])

            # A newer extract replaces every row.
            replace = self.plan(newer, tmp)
            code, result = self.apply(tmp, replace["planSha256"])
            self.assertEqual((code, result["result"], result["rows"]), (0, "replaced", 3))

            # An older extract than the one loaded is blocked at plan time.
            older = write_slim(tmp, [PATERSON], "2026-09-01T00:00:00Z", "older.geojsonl")
            blocked = self.plan(older, tmp)
            self.assertEqual(blocked["action"], "blocked")
            code, refused = self.apply(tmp, blocked["planSha256"])
            self.assertEqual(code, 1)

            # The host in the plan must be the host connected to.
            code, wrong = self.run_cli("plan", "--source", str(older), "--target-host", "db.example.test", "--target-environment", "local-qa", "--out", str(tmp / "x.json"))
            self.assertEqual(code, 1)
            self.assertIn("does not match", wrong["error"])


if __name__ == "__main__":
    unittest.main()

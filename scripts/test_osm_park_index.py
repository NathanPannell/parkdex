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
MIGRATIONS = [ROOT / "database" / "migrations" / name for name in ("osm_parks_001_init.sql", "osm_parks_002_sources.sql")]


def square(west: float, south: float, east: float, north: float) -> list[list[float]]:
    return [[west, south], [east, south], [east, north], [west, north], [west, south]]


PATERSON = {"type": "way", "id": 23938892, "kind": "leisure=park", "tags": {"name": "Paterson Park", "leisure": "park"},
            "geometry": {"type": "Polygon", "coordinates": [square(-123.062, 49.088, -123.058, 49.090)]}}
WATERSHED = {"type": "relation", "id": 200, "kind": "leisure=nature_reserve", "tags": {"name": "Watershed Park", "leisure": "nature_reserve"},
             "geometry": {"type": "MultiPolygon", "coordinates": [[square(-122.9, 49.11, -122.88, 49.118), square(-122.895, 49.112, -122.89, 49.115)]]}}
UNNAMED = {"type": "way", "id": 400, "kind": "landuse=recreation_ground", "tags": {"landuse": "recreation_ground"},
           "geometry": {"type": "Polygon", "coordinates": [square(-123.07, 49.096, -123.068, 49.097)]}}
# Nova Scotia: Point Pleasant Park and the Public Gardens in Halifax.
POINT_PLEASANT = {"type": "way", "id": 4593271, "kind": "leisure=park", "tags": {"name": "Point Pleasant Park", "leisure": "park"},
                  "geometry": {"type": "Polygon", "coordinates": [square(-63.575, 44.617, -63.562, 44.628)]}}
PUBLIC_GARDENS = {"type": "way", "id": 23180040, "kind": "leisure=garden", "tags": {"name": "Halifax Public Gardens", "leisure": "garden"},
                  "geometry": {"type": "Polygon", "coordinates": [square(-63.5835, 44.6418, -63.58, 44.6436)]}}
SOURCE_NAMES = {"bc": "british-columbia-latest.osm.pbf", "nova-scotia": "nova-scotia-latest.osm.pbf"}


def write_slim(directory: Path, records: list[dict], source_date: str = "2026-10-07T20:20:00Z", name: str = "parks.geojsonl",
               source_id: str = "bc") -> Path:
    path = directory / name
    body = "".join(json.dumps(record) + "\n" for record in records).encode("utf-8")
    path.write_bytes(body)
    rows, sha, size = index.read_slim(path)
    index.manifest_path(path).write_text(json.dumps({
        "schema": index.MANIFEST_SCHEMA, "sourceId": source_id, "sourceName": SOURCE_NAMES.get(source_id, f"{source_id}-latest.osm.pbf"),
        "sourceDate": source_date, "sha256": sha, "bytes": size, "rows": len(rows),
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

    def test_manifest_names_a_valid_source(self):
        path = write_slim(self.dir, [PATERSON], source_id="nova-scotia")
        _, sha, _ = index.read_slim(path)
        self.assertEqual(index.read_manifest(path, sha)["sourceId"], "nova-scotia")
        manifest = json.loads(index.manifest_path(path).read_text(encoding="utf-8"))
        # A manifest from before several sources (v1, no source ID) has to be extracted again.
        cases = {
            "v1": {**manifest, "schema": "parkdex.osm-park-extract.v1"},
            "no source": {key: value for key, value in manifest.items() if key != "sourceId"},
            "bad source": {**manifest, "sourceId": "Nova Scotia"},
        }
        for label, changed in cases.items():
            with self.subTest(label):
                index.manifest_path(path).write_text(json.dumps(changed), encoding="utf-8")
                with self.assertRaises(index.OsmIndexError):
                    index.read_manifest(path, sha)

    def test_source_ids(self):
        for good in ("bc", "nova-scotia", "new-brunswick", "on2"):
            self.assertEqual(index.source_id_of(good), good)
        for bad in ("", "BC", "-bc", "nova_scotia", "nova scotia", "x" * 41, None, 7):
            with self.subTest(bad), self.assertRaises(index.OsmIndexError):
                index.source_id_of(bad)


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

    def test_outlines_another_source_holds_are_counted_by_source(self):
        rows = [{"osm_type": "way", "osm_id": 1}, {"osm_type": "relation", "osm_id": 1}, {"osm_type": "way", "osm_id": 2}]
        self.assertEqual(index.shared_outlines(rows, {}), {})
        owners = {("way", 1): "new-brunswick", ("way", 2): "bc", ("way", 9): "bc"}
        self.assertEqual(index.shared_outlines(rows, owners), {"bc": 1, "new-brunswick": 1})

    def test_the_reviewed_sha_pins_the_plan(self):
        with tempfile.TemporaryDirectory() as tmp:
            slim = write_slim(Path(tmp), [PATERSON])
            rows, sha, size = index.read_slim(slim)
            target = {"host": "127.0.0.1", "port": 5432, "database": "kip_qa_x", "environment": "local-qa", "declaredHost": "127.0.0.1",
                      "sourceId": "bc", "current": None, "otherSources": []}
            plan = index.build_plan(slim, rows, sha, size, index.read_manifest(slim, sha), target)
            self.assertEqual(plan["action"], "replace")
            self.assertEqual((plan["source"]["id"], plan["source"]["sharedWithOtherSources"]), ("bc", {}))
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
            manifest = index.extract(FIXTURE, out, "bc", "2026-10-07T20:20:00Z")
            self.assertEqual(manifest["sourceId"], "bc")
            self.assertEqual(manifest["rows"], 3)
            self.assertEqual(manifest["named"], 2)
            self.assertEqual(manifest["skippedPrivate"], 1)
            self.assertEqual(manifest["byKind"], {"landuse=recreation_ground": 1, "leisure=nature_reserve": 1, "leisure=park": 1})
            rows, sha, _ = index.read_slim(out)
            self.assertEqual(sha, manifest["sha256"])
            self.assertEqual([(row["osm_type"], row["osm_id"]) for row in rows], [("relation", 200), ("way", 100), ("way", 400)])
            self.assertEqual(len(rows[0]["geometry"]["coordinates"][0]), 2, "the pond is a hole")
            self.assertEqual(rows[1]["tags"], {"name": "Paterson Park", "leisure": "park", "operator": "City of Delta"})
            again = index.extract(FIXTURE, Path(tmp) / "again.geojsonl", "bc", "2026-10-07T20:20:00Z")
            self.assertEqual(again["sha256"], manifest["sha256"])
            # The same filters and simplification for every source: only the manifest differs.
            other = index.extract(FIXTURE, Path(tmp) / "other.geojsonl", "nova-scotia", "2026-10-07T20:20:00Z")
            self.assertEqual((other["sourceId"], other["sha256"]), ("nova-scotia", manifest["sha256"]))
            with self.assertRaises(index.OsmIndexError):
                index.extract(FIXTURE, Path(tmp) / "bad.geojsonl", "Nova Scotia", "2026-10-07T20:20:00Z")


TEST_URL = os.environ.get("OSM_PARKS_TEST_DATABASE_URL")


@unittest.skipUnless(TEST_URL, "set OSM_PARKS_TEST_DATABASE_URL for loopback PostgreSQL QA")
class PostgresTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        parts = urlsplit(TEST_URL)
        if parts.hostname not in ("127.0.0.1", "localhost", "::1") or not parts.path.lstrip("/").startswith("kip_qa_"):
            raise RuntimeError("OSM_PARKS_TEST_DATABASE_URL must point to a loopback kip_qa_ database")
        import psycopg
        first, second = (path.read_text(encoding="utf-8") for path in MIGRATIONS)
        with psycopg.connect(TEST_URL, autocommit=True) as conn:
            conn.execute("DROP SCHEMA IF EXISTS kip_osm CASCADE")
            # A table loaded before several sources: BC outlines and the singleton source row.
            conn.execute(first)
            conn.execute(
                "INSERT INTO kip_osm.parks (osm_type, osm_id, name, kind, min_lat, max_lat, min_lng, max_lng, area_m2, geometry, source_date) "
                "VALUES ('way', 1, 'Old Park', 'leisure=park', 49, 49.1, -123.1, -123, 10, '{\"type\":\"MultiPolygon\",\"coordinates\":[]}', now())"
            )
            conn.execute("INSERT INTO kip_osm.source (source_date, source_sha256, source_name, row_count) VALUES (now(), %s, 'british-columbia-latest.osm.pbf', 1)", ("a" * 64,))
            # Every deploy replays the whole inventory, so 002 runs twice and 001 runs again after it.
            for sql in (second, second, first, second):
                with conn.transaction():
                    conn.execute(sql)
            cls.backfill = (
                conn.execute("SELECT source_id, count(*) FROM kip_osm.parks GROUP BY 1").fetchall(),
                conn.execute("SELECT source_id, row_count FROM kip_osm.source").fetchall(),
                conn.execute("SELECT count(*) FROM information_schema.columns WHERE table_schema = 'kip_osm' AND column_name = 'singleton'").fetchone()[0],
                conn.execute("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'kip_osm.source'::regclass AND contype = 'p'").fetchone()[0],
            )

    def setUp(self):
        import psycopg
        with psycopg.connect(TEST_URL, autocommit=True) as conn:
            conn.execute("DELETE FROM kip_osm.parks")
            conn.execute("DELETE FROM kip_osm.source")

    def run_cli(self, *argv: str) -> tuple[int, dict]:
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.dict(os.environ, {"DATABASE_URL": TEST_URL}), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = index.main(list(argv))
        return code, (json.loads(out.getvalue()) if code == 0 else {"error": err.getvalue()})

    def plan(self, slim: Path, tmp: Path, source_id: str = "bc", out: str = "plan.json") -> dict:
        code, result = self.run_cli("plan", "--source", str(slim), "--source-id", source_id, "--target-host", "127.0.0.1",
                                    "--target-environment", "local-qa", "--out", str(tmp / out))
        self.assertEqual(code, 0, result)
        return result

    def apply(self, tmp: Path, sha: str, source_id: str = "bc", out: str = "plan.json") -> tuple[int, dict]:
        return self.run_cli("apply", "--plan", str(tmp / out), "--reviewed-plan-sha", sha, "--source-id", source_id,
                            "--expected-target-host", "127.0.0.1", "--target-environment", "local-qa")

    def load(self, slim: Path, tmp: Path, source_id: str) -> dict:
        plan = self.plan(slim, tmp, source_id)
        self.assertEqual(plan["action"], "replace", plan)
        code, result = self.apply(tmp, plan["planSha256"], source_id)
        self.assertEqual((code, result.get("result")), (0, "replaced"), result)
        return result

    def source_state(self) -> dict:
        import psycopg
        with psycopg.connect(TEST_URL) as conn:
            counts = dict(conn.execute("SELECT source_id, count(*) FROM kip_osm.parks GROUP BY 1").fetchall())
            sources = {row[0]: (index.iso(row[1]), row[2], row[3]) for row in conn.execute("SELECT source_id, source_date, source_sha256, row_count FROM kip_osm.source")}
        return {"counts": counts, "sources": sources}

    def test_the_migration_backfills_bc_and_replays(self):
        parks, sources, singleton, primary_key = self.backfill
        self.assertEqual(parks, [("bc", 1)])
        self.assertEqual(sources, [("bc", 1)])
        self.assertEqual(singleton, 0, "the singleton column is gone, so an older loader cannot empty the table")
        self.assertEqual(primary_key, "PRIMARY KEY (source_id)")

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
                row = conn.execute("SELECT name, kind, min_lat, max_lng, geometry->>'type', jsonb_array_length(geometry->'coordinates'->0), source_date, source_id "
                                   "FROM kip_osm.parks WHERE osm_type = 'relation' AND osm_id = 200").fetchone()
                self.assertEqual(row[:6], ("Watershed Park", "leisure=nature_reserve", 49.11, -122.88, "MultiPolygon", 2))
                self.assertEqual((index.iso(row[6]), row[7]), ("2026-10-07T20:20:00Z", "bc"))

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
            code, refused = self.apply(tmp, stale["planSha256"], out="stale.json")
            self.assertEqual(code, 1)
            self.assertIn("changed in the table since the plan", refused["error"])

            # A newer extract replaces every row of the source.
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
            code, wrong = self.run_cli("plan", "--source", str(older), "--source-id", "bc", "--target-host", "db.example.test",
                                       "--target-environment", "local-qa", "--out", str(tmp / "x.json"))
            self.assertEqual(code, 1)
            self.assertIn("does not match", wrong["error"])

    def test_each_source_replaces_only_its_own_outlines(self):
        with tempfile.TemporaryDirectory() as raw:
            tmp = Path(raw)
            bc = write_slim(tmp, [PATERSON, WATERSHED], name="bc.geojsonl")
            self.load(bc, tmp, "bc")
            loaded_bc = self.source_state()
            self.assertEqual(loaded_bc["counts"], {"bc": 2})

            # Nova Scotia's extract is older than BC's; the older-extract guard is per source, so it loads.
            ns = write_slim(tmp, [POINT_PLEASANT, PUBLIC_GARDENS], "2026-10-01T00:00:00Z", "ns.geojsonl", "nova-scotia")
            result = self.load(ns, tmp, "nova-scotia")
            self.assertEqual((result["rows"], result["otherSources"]), (2, {"bc": 2}))
            state = self.source_state()
            self.assertEqual(state["counts"], {"bc": 2, "nova-scotia": 2})
            self.assertEqual(state["sources"]["bc"], loaded_bc["sources"]["bc"], "BC is untouched by the Nova Scotia load")

            # A newer BC extract replaces BC's outlines and leaves Nova Scotia's alone.
            bc_newer = write_slim(tmp, [PATERSON, WATERSHED, UNNAMED], "2026-10-12T00:00:00Z", "bc-newer.geojsonl")
            result = self.load(bc_newer, tmp, "bc")
            self.assertEqual((result["rows"], result["otherSources"]), (3, {"nova-scotia": 2}))
            reloaded = self.source_state()
            self.assertEqual(reloaded["counts"], {"bc": 3, "nova-scotia": 2})
            self.assertEqual(reloaded["sources"]["nova-scotia"], state["sources"]["nova-scotia"], "Nova Scotia is untouched by the BC load")

            # Each source is guarded against its own loaded extract: an older one is blocked for both.
            ns_older = write_slim(tmp, [POINT_PLEASANT], "2026-09-01T00:00:00Z", "ns-older.geojsonl", "nova-scotia")
            self.assertEqual(self.plan(ns_older, tmp, "nova-scotia")["action"], "blocked")
            bc_older = write_slim(tmp, [PATERSON], "2026-10-07T20:20:00Z", "bc-older.geojsonl")
            self.assertEqual(self.plan(bc_older, tmp, "bc")["action"], "blocked")
            # A Nova Scotia extract dated between the two loads is still newer than Nova Scotia's own.
            ns_newer = write_slim(tmp, [POINT_PLEASANT, PUBLIC_GARDENS], "2026-10-05T00:00:00Z", "ns-newer.geojsonl", "nova-scotia")
            self.assertEqual(self.plan(ns_newer, tmp, "nova-scotia")["action"], "replace")
            self.assertEqual(self.source_state()["counts"], {"bc": 3, "nova-scotia": 2})

    def test_an_outline_another_source_holds_stays_with_it(self):
        import psycopg
        with tempfile.TemporaryDirectory() as raw:
            tmp = Path(raw)
            self.load(write_slim(tmp, [PATERSON, WATERSHED], name="bc.geojsonl"), tmp, "bc")
            before = self.source_state()
            # Extracts overlap at provincial borders, so a second source can carry an outline the first already holds.
            border = write_slim(tmp, [POINT_PLEASANT, PATERSON], "2026-10-12T00:00:00Z", "ns.geojsonl", "nova-scotia")
            plan = self.plan(border, tmp, "nova-scotia")
            self.assertEqual(plan["source"]["sharedWithOtherSources"], {"bc": 1})
            self.assertEqual(plan["target"]["otherSources"], [{"id": "bc", "sourceDate": "2026-10-07T20:20:00Z", "rows": 2}])
            code, result = self.apply(tmp, plan["planSha256"], "nova-scotia")
            self.assertEqual((code, result["rows"], result["sharedWithOtherSources"]), (0, 1, {"bc": 1}), result)
            after = self.source_state()
            self.assertEqual(after["counts"], {"bc": 2, "nova-scotia": 1})
            self.assertEqual(after["sources"]["bc"], before["sources"]["bc"])
            self.assertEqual(after["sources"]["nova-scotia"][2], 1)
            with psycopg.connect(TEST_URL) as conn:
                self.assertEqual(conn.execute("SELECT source_id FROM kip_osm.parks WHERE osm_type = 'way' AND osm_id = %s", (PATERSON["id"],)).fetchone()[0], "bc")

            code, status = self.run_cli("status", "--target-host", "127.0.0.1")
            self.assertEqual(code, 0, status)
            self.assertEqual([(source["id"], source["rows"], source["recordedRows"]) for source in status["sources"]], [("bc", 2, 2), ("nova-scotia", 1, 1)])
            self.assertEqual(status["rows"], 3)

    def test_the_source_id_must_match_everywhere(self):
        with tempfile.TemporaryDirectory() as raw:
            tmp = Path(raw)
            ns = write_slim(tmp, [POINT_PLEASANT], name="ns.geojsonl", source_id="nova-scotia")
            code, refused = self.run_cli("plan", "--source", str(ns), "--source-id", "bc", "--target-host", "127.0.0.1",
                                         "--target-environment", "local-qa", "--out", str(tmp / "plan.json"))
            self.assertEqual(code, 1)
            self.assertIn("not 'bc'", refused["error"])
            plan = self.plan(ns, tmp, "nova-scotia")
            code, refused = self.apply(tmp, plan["planSha256"], "bc")
            self.assertEqual(code, 1)
            self.assertIn("loads source 'nova-scotia'", refused["error"])
            self.assertEqual(self.source_state()["counts"], {})


if __name__ == "__main__":
    unittest.main()

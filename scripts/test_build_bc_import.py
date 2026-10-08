from __future__ import annotations

import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_bc_import as builder
import import_legacy_parks as importer


REPO_ROOT = Path(__file__).resolve().parents[1]
BUNDLE = REPO_ROOT / "database" / "imports" / "legacy-bc-20261007"
ISLAND = REPO_ROOT / "database" / "imports" / "provincial-regional-20260929"
COMMITTED = (
    "selection.json",
    "catalogue.json",
    "comparison-report.json",
    "normalization.json",
    "overlaps.json",
    "manifest.json",
    "phase-1/park-ids.txt",
    "phase-1/new-park-review.json",
    "phase-1/boundaries.geojson",
    "phase-2/park-ids.txt",
    "phase-2/new-park-review.json",
)


def load(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


class LegacyBcBundleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="parkdex-bc-bundle-")
        root = Path(cls.temporary.name)
        cls.bundle = root / "legacy-bc-20261007"
        shutil.copytree(BUNDLE / "sources", cls.bundle / "sources")
        island = root / "provincial-regional-20260929"
        (island / "sources").mkdir(parents=True)
        shutil.copy2(ISLAND / "sources" / "baseline-snapshot.json", island / "sources" / "baseline-snapshot.json")
        for name in builder.ISLAND_OUTPUTS:
            shutil.copy2(ISLAND / name, island / name)
        cls.result = builder.build_bundle(cls.bundle)
        cls.selection = load(cls.bundle / "selection.json")
        cls.manifest = load(cls.bundle / "manifest.json")
        cls.rows = {row["id"]: row for row in load(cls.bundle / "comparison-report.json")["parks"]}

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def test_rebuild_matches_the_committed_bundle_byte_for_byte(self):
        for name in COMMITTED:
            with self.subTest(name=name):
                self.assertEqual((self.bundle / name).read_bytes(), (BUNDLE / name).read_bytes())

    def test_selection_adds_every_legacy_park_once_and_never_an_existing_or_removed_one(self):
        phase_1 = (self.bundle / "phase-1" / "park-ids.txt").read_text(encoding="utf-8").split()
        phase_2 = (self.bundle / "phase-2" / "park-ids.txt").read_text(encoding="utf-8").split()
        self.assertEqual((len(phase_1), len(phase_2)), (552, 721))
        self.assertFalse(set(phase_1) & set(phase_2))
        staging = load_snapshot(self.bundle / "sources" / "staging-rev158-snapshot.json.gz")
        production = load(ISLAND / "sources" / "baseline-snapshot.json")
        existing = {park["id"] for park in staging["parks"]} | {park["id"] for park in production["parks"]}
        selected = set(phase_1) | set(phase_2)
        self.assertFalse(selected & existing)
        excluded = self.selection["excluded"]
        self.assertEqual(len(excluded["islands"]["ids"]), 37)
        self.assertEqual(len(excluded["operatorRemovals"]["ids"]), 14)
        self.assertFalse(selected & set(excluded["operatorRemovals"]["ids"]))
        places = importer.parse_catalogue(load(self.bundle / "sources" / "legacy-places.json"))
        parks = [park_id for park_id, place in places.items() if place["category"] != "island"]
        self.assertEqual(set(parks) - existing, selected)
        for park_id in selected:
            self.assertRegex(park_id, importer.ID_RE.pattern)
            self.assertLessEqual(len(park_id), 160)

    def test_new_park_reviews_pass_the_importer_and_account_contract(self):
        catalogue = importer.parse_catalogue(load(self.bundle / "catalogue.json"))
        hubs = [{"position": index} for index in range(8)]
        for phase in ("phase-1", "phase-2"):
            review = importer.parse_review(load(self.bundle / phase / "new-park-review.json"))
            for park_id, item in review.items():
                park, drive = importer.validate_new_park(park_id, park_id, catalogue[park_id], item, hubs)
                self.assertIsNone(park["scene"])
                self.assertEqual(park["rarity"], "common")
                self.assertEqual(drive["drive"], [None] * 8)
                self.assertTrue(item["accessUnknown"])

    def test_every_new_park_keeps_its_source_features_and_full_legacy_coverage(self):
        boundaries = builder.importer.parse_json(gzip_bytes(self.bundle / "sources" / "legacy-boundaries.geojson.gz"), "legacy")
        legacy = {feature["properties"]["id"]: feature for feature in boundaries["features"]}
        phase_1 = importer.parse_boundary_source(load(self.bundle / "phase-1" / "boundaries.geojson"))
        new_rows = [row for row in self.rows.values() if row["status"].startswith("new-")]
        self.assertEqual(len(new_rows), 1273)
        for row in new_rows:
            with self.subTest(park=row["id"]):
                self.assertEqual(row["sourceFeatureIds"], row["outputSourceFeatureIds"])
                self.assertGreaterEqual(row["coverage"]["sourceAreaKept"], 0.999999)
                if row["sourceValid"]:
                    self.assertTrue(row["polygonsMatch"] and row["holesMatch"])
                    self.assertEqual(row["coverage"]["areaAdded"], 0)
                else:
                    self.assertEqual(row["evenOddAgreement"]["disagreements"], 0)
        for park_id, record in phase_1.items():
            source = legacy[park_id]["geometry"]
            if self.rows[park_id]["sourceValid"]:
                wrapped = [source["coordinates"]] if source["type"] == "Polygon" else source["coordinates"]
                self.assertEqual(record["geometry"]["coordinates"], wrapped)

    def test_probes_land_inside_secondary_regions_and_outside_holes(self):
        multipart = holes = 0
        for row in self.rows.values():
            probes = row.get("probes", {})
            if "secondaryRegion" in probes:
                multipart += 1
            if "hole" in probes:
                holes += 1
        self.assertGreater(multipart, 100)
        self.assertGreater(holes, 20)
        phase_1 = importer.parse_boundary_source(load(self.bundle / "phase-1" / "boundaries.geojson"))
        for park_id, record in phase_1.items():
            probes = self.rows[park_id]["probes"]
            if "secondaryRegion" in probes:
                self.assertTrue(builder.legacy_inside(tuple(probes["secondaryRegion"]), record["geometry"]))
            if "hole" in probes:
                self.assertFalse(builder.legacy_inside(tuple(probes["hole"]), record["geometry"]))

    def test_phase_1_fits_the_content_sync_limit_and_phase_2_does_not(self):
        projection = self.manifest["contentSyncProjection"]
        self.assertEqual(projection["limitBytes"], 4 * 1024 * 1024)
        self.assertGreaterEqual(projection["staging"]["phase1"]["headroomBytes"], builder.MIN_SNAPSHOT_HEADROOM_BYTES)
        self.assertGreaterEqual(projection["production"]["islandThenPhase1"]["headroomBytes"], builder.MIN_SNAPSHOT_HEADROOM_BYTES)
        self.assertLess(projection["staging"]["phase1And2"]["headroomBytes"], 0)
        self.assertLess(projection["phase1ChangeBatchBytes"], projection["limitBytes"])
        self.assertEqual(self.selection["phases"]["2"]["status"], "blocked-by-content-sync-size")

    def test_presentation_rules_are_plain_and_deterministic(self):
        self.assertEqual(builder.short_name("Gonzales Hill Regional Park"), "Gonzales Hill")
        self.assertEqual(builder.short_name("Park"), "Park")
        self.assertEqual(builder.biome_for("Cowichan River Park")[0], "river")
        self.assertEqual(builder.biome_for("Thetis Lake Falls")[0], "waterfall")
        self.assertEqual(builder.biome_for("Topaz Park")[0], "forest")
        self.assertEqual(builder.seed_for("regional-a"), builder.seed_for("regional-a"))
        self.assertTrue(0 <= builder.seed_for("regional-a") <= 1_000_000)
        place = {"category": "municipal", "region": "Southern Vancouver Island"}
        self.assertEqual(builder.blurb_for(place, {"jurisdiction": "District of Saanich"}), "A municipal park in the District of Saanich.")


def gzip_bytes(path: Path) -> bytes:
    import gzip

    return gzip.decompress(path.read_bytes())


def load_snapshot(path: Path):
    return json.loads(gzip_bytes(path))


if __name__ == "__main__":
    unittest.main()

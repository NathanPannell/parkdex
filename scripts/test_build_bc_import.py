from __future__ import annotations

import gzip
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
    "park-ids.txt",
    "new-park-review.json",
)


def load(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def gzip_json(path: Path):
    return json.loads(gzip.decompress(path.read_bytes()))


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
        cls.boundaries = importer.parse_boundary_source(gzip_json(cls.bundle / builder.BOUNDARIES_FILE))

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def test_rebuild_matches_the_committed_bundle(self):
        for name in COMMITTED:
            with self.subTest(name=name):
                self.assertEqual((self.bundle / name).read_bytes(), (BUNDLE / name).read_bytes())
        committed = gzip.decompress((BUNDLE / builder.BOUNDARIES_FILE).read_bytes())
        self.assertEqual(gzip.decompress((self.bundle / builder.BOUNDARIES_FILE).read_bytes()), committed)
        self.assertEqual(builder.sha256(committed), self.manifest["boundaries"]["decompressedSha256"])

    def test_selection_adds_every_legacy_park_once_and_never_an_existing_or_removed_one(self):
        selected_ids = (self.bundle / "park-ids.txt").read_text(encoding="utf-8").split()
        self.assertEqual(len(selected_ids), 1273)
        selected = set(selected_ids)
        staging = json.loads(gzip.decompress((self.bundle / "sources" / "staging-rev158-snapshot.json.gz").read_bytes()))
        production = load(ISLAND / "sources" / "baseline-snapshot.json")
        existing = {park["id"] for park in staging["parks"]} | {park["id"] for park in production["parks"]}
        self.assertFalse(selected & existing)
        excluded = self.selection["excluded"]
        self.assertEqual(len(excluded["islands"]["ids"]), 37)
        self.assertEqual(len(excluded["operatorRemovals"]["ids"]), 14)
        self.assertFalse(selected & set(excluded["operatorRemovals"]["ids"]))
        places = importer.parse_catalogue(load(self.bundle / "sources" / "legacy-places.json"))
        parks = [park_id for park_id, place in places.items() if place["category"] != "island"]
        self.assertEqual(set(parks) - existing, selected)
        self.assertEqual(set(self.boundaries), selected)
        self.assertEqual(self.selection["minimumReader"], 3)
        for park_id in selected:
            self.assertRegex(park_id, importer.ID_RE.pattern)
            self.assertLessEqual(len(park_id), 160)

    def test_new_park_reviews_pass_the_importer_and_account_contract(self):
        catalogue = importer.parse_catalogue(load(self.bundle / "catalogue.json"))
        hubs = [{"position": index} for index in range(8)]
        review = importer.parse_review(load(self.bundle / "new-park-review.json"))
        self.assertEqual(len(review), 1273)
        for park_id, item in review.items():
            park, drive = importer.validate_new_park(park_id, park_id, catalogue[park_id], item, hubs)
            self.assertIsNone(park["scene"])
            self.assertEqual(park["rarity"], "common")
            self.assertEqual(drive["drive"], [None] * 8)
            self.assertTrue(item["accessUnknown"])

    def test_every_new_park_keeps_its_source_features_and_full_legacy_coverage(self):
        legacy = {feature["properties"]["id"]: feature for feature in gzip_json(self.bundle / "sources" / "legacy-boundaries.geojson.gz")["features"]}
        new_rows = [row for row in self.rows.values() if row["status"] == "new"]
        self.assertEqual(len(new_rows), 1273)
        for row in new_rows:
            with self.subTest(park=row["id"]):
                self.assertEqual(row["sourceFeatureIds"], row["outputSourceFeatureIds"])
                self.assertGreaterEqual(row["coverage"]["sourceAreaKept"], 0.999999)
                if row["sourceValid"]:
                    self.assertTrue(row["polygonsMatch"] and row["holesMatch"])
                    self.assertEqual(row["coverage"]["areaAdded"], 0)
                    source = legacy[row["id"]]["geometry"]
                    wrapped = [source["coordinates"]] if source["type"] == "Polygon" else source["coordinates"]
                    self.assertEqual(self.boundaries[row["id"]]["geometry"]["coordinates"], wrapped)
                else:
                    self.assertEqual(row["evenOddAgreement"]["disagreements"], 0)

    def test_probes_land_inside_secondary_regions_and_outside_holes(self):
        multipart = holes = 0
        for park_id, record in self.boundaries.items():
            probes = self.rows[park_id]["probes"]
            if "secondaryRegion" in probes:
                multipart += 1
                self.assertTrue(builder.legacy_inside(tuple(probes["secondaryRegion"]), record["geometry"]))
            if "hole" in probes:
                holes += 1
                self.assertFalse(builder.legacy_inside(tuple(probes["hole"]), record["geometry"]))
        self.assertGreater(multipart, 100)
        self.assertGreater(holes, 20)

    def test_older_snapshots_stay_small_and_the_cdn_release_has_small_files(self):
        projection = self.manifest["contentSyncProjection"]
        limit = projection["limitBytes"]
        self.assertEqual(limit, 4 * 1024 * 1024)
        for entry in projection["legacySnapshot"].values():
            self.assertGreaterEqual(entry["headroomBytes"], builder.MIN_SNAPSHOT_HEADROOM_BYTES)
        for entry in projection["catalogueRelease"].values():
            self.assertGreater(entry["parks"], 1600)
            self.assertLess(entry["indexBytes"], limit - builder.MIN_SNAPSHOT_HEADROOM_BYTES)
            self.assertLessEqual(entry["largestChunkBytes"], builder.MAX_CHUNK_BYTES)
        # One batch with every new park is far over the limit, so newer readers take the CDN release.
        self.assertGreater(projection["importChangeBatchBytes"], limit)

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


if __name__ == "__main__":
    unittest.main()

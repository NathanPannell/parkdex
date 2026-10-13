from __future__ import annotations

import gzip
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_bc_import as bc
import build_ns_import as builder
import import_legacy_parks as importer


REPO_ROOT = Path(__file__).resolve().parents[1]
BUNDLE = REPO_ROOT / "database" / "imports" / "ns-20261013"
BC_BUNDLE = REPO_ROOT / "database" / "imports" / "legacy-bc-20261007"
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
# The raw downloads stay outside the repository. Point this at them to check a
# rebuild byte for byte: NS_IMPORT_RAW_DIR=<folder> python scripts/test_build_ns_import.py
RAW_DIR = os.environ.get("NS_IMPORT_RAW_DIR")


def load(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


class NovaScotiaBundleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.manifest = load(BUNDLE / "manifest.json")
        cls.selection = load(BUNDLE / "selection.json")
        cls.ids = (BUNDLE / "park-ids.txt").read_text(encoding="utf-8").split()
        cls.catalogue = importer.parse_catalogue(load(BUNDLE / "catalogue.json"))
        cls.review = importer.parse_review(load(BUNDLE / "new-park-review.json"))
        cls.boundaries_raw = gzip.decompress((BUNDLE / builder.BOUNDARIES_FILE).read_bytes())
        cls.boundaries = importer.parse_boundary_source(json.loads(cls.boundaries_raw))
        cls.rows = {row["id"]: row for row in load(BUNDLE / "comparison-report.json")["parks"]}

    def test_manifest_pins_every_committed_file(self):
        for name in (name for name in COMMITTED if name != "manifest.json"):
            with self.subTest(name=name):
                self.assertEqual(builder.sha256((BUNDLE / name).read_bytes()), self.manifest["outputs"][name]["sha256"])
        self.assertEqual(builder.sha256(self.boundaries_raw), self.manifest["boundaries"]["decompressedSha256"])
        record_raw = (BUNDLE / "sources" / "fetch-record.json").read_bytes()
        self.assertEqual(builder.sha256(record_raw), self.manifest["fetchRecord"]["sha256"])
        record = json.loads(record_raw)
        for name, entry in record["sources"].items():
            with self.subTest(source=name):
                self.assertRegex(entry["sha256"], r"^[0-9a-f]{64}$")
                self.assertTrue(entry["url"].startswith("https://"))
                self.assertIn("retrievedAt", entry)
        self.assertEqual(self.manifest["publication"], {"providerActions": False, "databaseWrites": False, "badgeArtworkIncluded": False})

    def test_selection_counts_ids_and_regions(self):
        self.assertEqual(len(self.ids), 112)
        self.assertEqual(self.ids, sorted(set(self.ids)))
        self.assertEqual(self.manifest["counts"]["categories"], {"provincial": 109, "national": 3})
        self.assertEqual(set(self.ids), set(self.catalogue))
        self.assertEqual(set(self.ids), set(self.review))
        self.assertEqual(set(self.ids), set(self.boundaries))
        self.assertEqual(self.selection["minimumReader"], 3)
        for park_id, place in self.catalogue.items():
            with self.subTest(park=park_id):
                self.assertRegex(park_id, importer.ID_RE.pattern)
                self.assertLessEqual(len(park_id), 160)
                self.assertTrue(park_id.startswith(f"{place['category']}-"))
                self.assertIn(place["region"], builder.REGIONS)
        # Every one of the seven regions is used, exactly as spelled for My Dex.
        self.assertEqual({place["region"] for place in self.catalogue.values()}, set(builder.REGIONS))

    def test_no_id_clashes_with_any_known_catalogue_park(self):
        known = set()
        for name in builder.KNOWN_ID_SOURCES:
            data = (REPO_ROOT / name).read_bytes()
            if name.endswith(".gz"):
                data = gzip.decompress(data)
            if name.endswith(".txt"):
                known |= set(data.decode("utf-8").split())
                continue
            value = json.loads(data)
            if "selectedIds" in value:
                known |= set(value["selectedIds"])
            elif "parks" in value:
                known |= {park["id"] for park in value["parks"]}
            else:
                known |= {feature["properties"]["id"] for feature in value["features"]}
        self.assertGreater(len(known), 1500)
        self.assertFalse(known & set(self.ids))
        # The build also checked both live catalogue releases.
        self.assertEqual(set(self.selection["idClashCheck"]), {"live staging catalogue", "live production catalogue", *builder.KNOWN_ID_SOURCES})

    def test_regions_do_not_reuse_british_columbia_names(self):
        bc_regions = {place["region"] for place in load(BC_BUNDLE / "catalogue.json")}
        staging = json.loads(gzip.decompress((BC_BUNDLE / "sources" / "staging-rev158-snapshot.json.gz").read_bytes()))
        bc_regions |= {park["region"] for park in staging["parks"]}
        self.assertFalse(bc_regions & set(builder.REGIONS))

    def test_new_park_reviews_pass_the_importer_and_account_contract(self):
        hubs = [{"position": index} for index in range(8)]
        for park_id, item in self.review.items():
            with self.subTest(park=park_id):
                park, drive = importer.validate_new_park(park_id, park_id, self.catalogue[park_id], item, hubs)
                self.assertIsNone(park["scene"])
                self.assertEqual((park["rarity"], park["shape"]), ("common", "circle"))
                self.assertEqual(drive["drive"], [None] * 8)
                self.assertTrue(item["accessUnknown"])
                self.assertEqual(item["walkM"], 0)
                self.assertEqual(park["seed"], bc.seed_for(park_id))
                self.assertEqual(park["blurb"], builder.blurb_for(park["category"], park["name"], park["region"]))

    def test_every_park_keeps_its_source_parts_holes_and_area(self):
        from shapely.geometry import shape

        for park_id, record in self.boundaries.items():
            row = self.rows[park_id]
            with self.subTest(park=park_id):
                self.assertTrue(shape(record["geometry"]).is_valid)
                self.assertEqual([str(item) for item in record["sourceFeatureIds"]], row["sourceFeatureIds"])
                self.assertGreaterEqual(row["coverage"]["sourceAreaKept"], builder.MIN_AREA_KEPT)
                self.assertLessEqual(row["coverage"]["areaAdded"], 1 - builder.MIN_AREA_KEPT)
                self.assertEqual(bc.counts(record["geometry"]), row["outputCounts"])
                if row["assembly"] == "parts":
                    # Nothing joined: every repaired part and hole is in the output.
                    self.assertEqual(row["outputCounts"]["polygons"], row["normalizedSourceCounts"]["polygons"])
                    self.assertEqual(row["outputCounts"]["holes"], row["normalizedSourceCounts"]["holes"])
                if all(feature["sourceValid"] for feature in row["sourceFeatures"]) and row["assembly"] == "parts":
                    self.assertTrue(row["polygonsMatch"] and row["holesMatch"])
                for agreement in row.get("evenOddAgreement", []):
                    self.assertEqual(agreement["disagreements"], 0)
                if row["officialHectares"]:
                    self.assertLess(abs(row["hectares"] / row["officialHectares"] - 1), builder.OFFICIAL_AREA_TOLERANCE)

    def test_national_parks_keep_every_part(self):
        parts = {park_id: row["outputCounts"] for park_id, row in self.rows.items() if row["category"] == "national"}
        self.assertEqual(parts["national-kejimkujik-national-park-and-national-historic-site"]["polygons"], 2)
        self.assertEqual(parts["national-cape-breton-highlands-national-park"]["holes"], 1)
        self.assertGreaterEqual(parts["national-sable-island-national-park-reserve"]["polygons"], 2)
        for park_id in parts:
            self.assertEqual(self.rows[park_id]["pin"]["method"], "parks-canada-finder")

    def test_probes_land_inside_secondary_regions_and_outside_holes(self):
        multipart = holes = 0
        for park_id, record in self.boundaries.items():
            probes = self.rows[park_id]["probes"]
            if "secondaryRegion" in probes:
                multipart += 1
                self.assertTrue(bc.legacy_inside(tuple(probes["secondaryRegion"]), record["geometry"]), park_id)
            if "hole" in probes:
                holes += 1
                self.assertFalse(bc.legacy_inside(tuple(probes["hole"]), record["geometry"]), park_id)
        self.assertGreater(multipart, 40)
        self.assertGreater(holes, 20)
        self.assertIn("secondaryRegion", self.rows["national-kejimkujik-national-park-and-national-historic-site"]["probes"])

    def test_provincial_pins_are_inside_their_outlines(self):
        for park_id, place in self.catalogue.items():
            if place["category"] != "provincial":
                continue
            with self.subTest(park=park_id):
                self.assertTrue(bc.legacy_inside((place["longitude"], place["latitude"]), self.boundaries[park_id]["geometry"]))

    def test_no_duplicates_and_no_overlap_with_live_parks(self):
        overlaps = load(BUNDLE / "overlaps.json")
        self.assertEqual(overlaps["duplicateThreshold"], 0.5)
        self.assertFalse([row for row in overlaps["overlaps"] if row["duplicate"]])
        self.assertEqual(self.selection["excluded"]["duplicates"]["ids"], [])

    def test_older_readers_keep_headroom_and_the_cdn_release_has_small_files(self):
        projection = self.manifest["contentSyncProjection"]
        limit = projection["limitBytes"]
        self.assertEqual(limit, 4 * 1024 * 1024)
        for environment, entry in projection["environments"].items():
            with self.subTest(environment=environment):
                for reader in ("reader1", "reader2"):
                    self.assertGreaterEqual(entry[reader]["headroomBytes"], builder.MIN_SNAPSHOT_HEADROOM_BYTES)
                    self.assertEqual(entry[reader]["projectedBytes"], entry[reader]["measuredBytes"])
                    # Without the reader floor the older snapshot would break, so the floor is required.
                    self.assertGreater(entry[reader]["bytesWithoutReaderFloor"], limit)
                self.assertTrue(entry["reader3CatalogueNow"]["rebuildMatchesLive"])
                release = entry["reader3CatalogueWithNovaScotia"]
                self.assertEqual(release["parks"], entry["reader3CatalogueNow"]["parks"] + 112)
                self.assertLess(release["indexBytes"], limit - builder.MIN_SNAPSHOT_HEADROOM_BYTES)
                self.assertLessEqual(release["largestChunkBytes"], builder.MAX_CHUNK_BYTES)
        # A reader 3 install that is behind gets the import as one change batch.
        self.assertLess(projection["importChangeBatchBytes"], limit - builder.MIN_SNAPSHOT_HEADROOM_BYTES)


class NovaScotiaRuleTests(unittest.TestCase):
    def test_regions_follow_the_pinned_county_table_and_splits(self):
        self.assertEqual(builder.region_of("Kings", "Kings", [-64.3, 45.2])[0], "Bay of Fundy and Annapolis Valley")
        self.assertEqual(builder.region_of("Halifax", "Halifax", [-63.6, 44.6])[0], "Halifax Metro")
        self.assertEqual(builder.region_of("Halifax", "Halifax", [-62.6, 44.8])[0], "Eastern Shore")
        self.assertEqual(builder.region_of("Cumberland", "Cumberland", [-63.8, 45.9])[0], "Northumberland Shore")
        self.assertEqual(builder.region_of("Cumberland", "Cumberland", [-64.9, 45.4])[0], "Bay of Fundy and Annapolis Valley")
        self.assertEqual(builder.region_of("Digby", "Clare", [-66.2, 44.1])[0], "Yarmouth and Acadian Shores")
        self.assertEqual(builder.region_of("Digby", "Digby", [-65.9, 44.5])[0], "Bay of Fundy and Annapolis Valley")
        self.assertEqual(builder.region_of("Shelburne", "Barrington", [-65.5, 43.5])[0], "Yarmouth and Acadian Shores")
        self.assertEqual(builder.region_of("Victoria", "Victoria", [-60.6, 46.7])[0], "Cape Breton Island")
        self.assertEqual(set(builder.COUNTY_REGIONS.values()) - {builder.SPLIT}, set(builder.REGIONS) - {"Halifax Metro"})
        with self.assertRaises(importer.ParkImportError):
            builder.region_of("Nowhere", "Nowhere", [0, 0])

    def test_presentation_is_plain_and_factual(self):
        self.assertEqual(builder.short_for("Kejimkujik National Park and National Historic Site"), "Kejimkujik")
        self.assertEqual(builder.short_for("Sable Island National Park Reserve"), "Sable Island")
        self.assertEqual(builder.short_for("Rissers Beach Provincial Park"), "Rissers Beach")
        self.assertEqual(builder.blurb_for("provincial", "Rissers Beach Provincial Park", "South Shore"),
                         "A provincial park on Nova Scotia's South Shore.")
        self.assertEqual(builder.blurb_for("national", "Sable Island National Park Reserve", "Halifax Metro"),
                         "A national park reserve in the Halifax Metro region of Nova Scotia.")
        self.assertEqual(builder.slugify("McNabs & Lawlor Island Provincial Park"), "mcnabs-and-lawlor-island-provincial-park")
        self.assertEqual(builder.slugify("St. Anns Provincial Park"), "st-anns-provincial-park")

    def test_nested_shells_become_holes_by_the_even_odd_rule(self):
        outer = [[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]]
        inner = [[1, 1], [3, 1], [3, 3], [1, 3], [1, 1]]
        island = [[1.5, 1.5], [2.5, 1.5], [2.5, 2.5], [1.5, 2.5], [1.5, 1.5]]
        parts, report = builder.normalize_feature({"type": "MultiPolygon", "coordinates": [[outer], [inner], [island]]}, "test")
        self.assertEqual(report["method"], "planar-face-even-odd-all-rings")
        geometry = builder.multipolygon(parts)
        self.assertEqual(bc.counts(geometry)["holes"], 1)
        self.assertTrue(bc.legacy_inside((0.5, 0.5), geometry))
        self.assertFalse(bc.legacy_inside((1.2, 1.2), geometry))
        self.assertTrue(bc.legacy_inside((2, 2), geometry))
        valid, none = builder.normalize_feature({"type": "Polygon", "coordinates": [outer, inner]}, "test")
        self.assertIsNone(none)
        self.assertEqual(valid, [[outer, inner]])

    def test_touching_features_of_one_park_are_joined_and_separate_ones_kept(self):
        left = {"sourceFeatureId": "a", "objectId": 1, "officialHectares": None,
                "geometry": {"type": "Polygon", "coordinates": [[[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01], [0, 0]]]}}
        right = {"sourceFeatureId": "b", "objectId": 2, "officialHectares": None,
                 "geometry": {"type": "Polygon", "coordinates": [[[0.01, 0], [0.02, 0], [0.02, 0.01], [0.01, 0.01], [0.01, 0]]]}}
        apart = {**right, "sourceFeatureId": "c",
                 "geometry": {"type": "Polygon", "coordinates": [[[0.05, 0], [0.06, 0], [0.06, 0.01], [0.05, 0.01], [0.05, 0]]]}}
        joined, report = builder.assemble("provincial-test", [left, right])
        self.assertEqual(report["evidence"]["assembly"], "source-feature-union")
        self.assertEqual(bc.counts(joined)["polygons"], 1)
        kept, report = builder.assemble("provincial-test", [left, apart])
        self.assertEqual(report["evidence"]["assembly"], "parts")
        self.assertEqual(bc.counts(kept)["polygons"], 2)
        self.assertGreaterEqual(report["evidence"]["coverage"]["sourceAreaKept"], builder.MIN_AREA_KEPT)

    def test_finder_rows_parse_to_points(self):
        html = ('<tr locationTarget="SableIslandNationalParkReserve" data-geometry="POINT (-59.91591 43.92788)" data-type="wkt">\n'
                '    <td>1</td>\n    <td>Sable Island National Park Reserve</td>')
        self.assertEqual(builder.parse_finder(html), {"Sable Island National Park Reserve": [-59.91591, 43.92788]})


@unittest.skipUnless(RAW_DIR, "Set NS_IMPORT_RAW_DIR to the raw downloads to check a byte-for-byte rebuild")
class NovaScotiaRebuildTests(unittest.TestCase):
    def test_rebuild_matches_the_committed_bundle(self):
        with tempfile.TemporaryDirectory(prefix="parkdex-ns-bundle-") as temporary:
            bundle = Path(temporary) / "ns-20261013"
            shutil.copytree(BUNDLE / "sources", bundle / "sources")
            builder.build_bundle(bundle, Path(RAW_DIR))
            for name in COMMITTED:
                with self.subTest(name=name):
                    self.assertEqual((bundle / name).read_bytes(), (BUNDLE / name).read_bytes())
            self.assertEqual(gzip.decompress((bundle / builder.BOUNDARIES_FILE).read_bytes()),
                             gzip.decompress((BUNDLE / builder.BOUNDARIES_FILE).read_bytes()))


if __name__ == "__main__":
    unittest.main()

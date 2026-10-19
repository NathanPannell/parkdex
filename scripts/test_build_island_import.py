from __future__ import annotations

import hashlib
import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_island_import as builder
import import_legacy_parks as importer


REPO_ROOT = Path(__file__).resolve().parents[1]
BUNDLE = REPO_ROOT / "database" / "imports" / "provincial-regional-20260929"
EAST_SOOKE_ID = "regional-east-sooke-regional-park"


def load(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


class IslandImportBundleTests(unittest.TestCase):
    def test_rebuild_is_deterministic_and_preserves_the_reviewed_contract(self):
        with tempfile.TemporaryDirectory(prefix="parkdex-island-bundle-") as temporary:
            bundle = Path(temporary) / "bundle"
            shutil.copytree(BUNDLE / "sources", bundle / "sources")

            first_result = builder.build_bundle(bundle)
            generated_names = (
                "selection.json",
                "boundaries.geojson",
                "catalogue.json",
                "rarity-review.json",
                "new-park-review.json",
                "manifest.json",
            )
            first_bytes = {name: (bundle / name).read_bytes() for name in generated_names}
            second_result = builder.build_bundle(bundle)
            second_bytes = {name: (bundle / name).read_bytes() for name in generated_names}
            self.assertEqual(first_bytes, second_bytes)
            self.assertEqual(first_result["outputs"], second_result["outputs"])

            selection = load(bundle / "selection.json")
            selected_ids = selection["selectedIds"]
            selected_set = set(selected_ids)
            self.assertEqual(len(selected_ids), 270)
            self.assertEqual(selection["excluded"]["id"], builder.EXCLUDED_ID)
            self.assertIn("mainland", selection["excluded"]["reason"].lower())
            self.assertEqual(selection["categoryCounts"], {"provincial": 134, "regional": 136})

            snapshot = load(bundle / "sources" / "baseline-snapshot.json")
            existing_ids = selected_set & {park["id"] for park in snapshot["parks"]}
            new_ids = selected_set - existing_ids
            self.assertEqual((len(existing_ids), len(new_ids)), (26, 244))
            catalogue = load(bundle / "catalogue.json")
            rarity = importer.parse_rarity_review(load(bundle / "rarity-review.json"))
            new_review = importer.parse_review(load(bundle / "new-park-review.json"))
            bundled_metadata = {park["id"] for park in load(bundle / "sources" / "parks.json")}
            biome_review = load(bundle / "sources" / "biome-review.json")
            reviewed_biome_ids = new_ids - bundled_metadata
            uncertain_biome_count = sum(item.get("uncertain") is True for item in biome_review.values())
            self.assertEqual({park["id"] for park in catalogue}, selected_set)
            self.assertEqual(set(rarity), existing_ids)
            self.assertEqual(set(new_review), new_ids)
            self.assertEqual(set(biome_review), reviewed_biome_ids)
            for park_id, review in new_review.items():
                presentation = review["presentation"]
                self.assertIsNone(presentation["scene"], park_id)
                self.assertIn(presentation["biome"], importer.BIOMES)
                if park_id in reviewed_biome_ids:
                    self.assertEqual(presentation["biome"], biome_review[park_id]["biome"], park_id)
                self.assertIsInstance(presentation["seed"], int)
                self.assertGreaterEqual(presentation["seed"], 0)
                self.assertLessEqual(presentation["seed"], 1_000_000)
                all_null = all(route is None for route in review["drive"])
                if review.get("accessUnknown") is True:
                    self.assertEqual(review["walkM"], 0)
                    self.assertTrue(all_null)
                else:
                    self.assertFalse(all_null, park_id)
            self.assertEqual(sum(item.get("accessUnknown") is True for item in new_review.values()), 117)

            normalized = load(bundle / "sources" / "island-boundaries.normalized.geojson")
            normalized_by_id = {feature["properties"]["id"]: feature for feature in normalized["features"]}
            baseline_by_id = {feature["properties"]["id"]: feature for feature in snapshot["boundaries"]["features"]}
            actual = load(bundle / "boundaries.geojson")["features"]
            actual_ids = [feature["properties"]["id"] for feature in actual]
            self.assertEqual(set(actual_ids), selected_set)
            self.assertEqual(len(actual_ids), 270)
            self.assertEqual(
                actual_ids,
                [feature["properties"]["id"] for feature in normalized["features"] if feature["properties"]["id"] in selected_set],
            )
            for feature in actual:
                park_id = feature["properties"]["id"]
                self.assertEqual(feature["properties"], normalized_by_id[park_id]["properties"])
                expected_geometry = baseline_by_id[park_id]["geometry"] if park_id == EAST_SOOKE_ID else normalized_by_id[park_id]["geometry"]
                self.assertEqual(feature["geometry"], expected_geometry, park_id)
                record = importer.parse_boundary_source({"type": "FeatureCollection", "features": [feature]})[park_id]
                self.assertTrue(record["sourceFeatureIds"], park_id)

            manifest = load(bundle / "manifest.json")
            self.assertEqual(manifest["target"]["existingRarityReviews"], 26)
            self.assertEqual(manifest["target"]["existingRarityChanges"], 7)
            self.assertEqual(manifest["target"]["existingRarityChangedSceneCount"], 4)
            self.assertEqual(manifest["counts"]["newUnknownAccessTotal"], 117)
            self.assertEqual(manifest["counts"]["biomeSources"]["explicitReview"], 149)
            self.assertEqual(manifest["counts"]["biomeSources"]["explicitReviewUncertain"], uncertain_biome_count)
            self.assertEqual(manifest["geometry"]["legacySourceGeometryCount"], 269)
            overrides = manifest["geometry"]["explicitTargetPreservationOverrides"]
            self.assertEqual([item["parkId"] for item in overrides], [EAST_SOOKE_ID])
            self.assertEqual(overrides[0]["preservedTargetGeometrySummary"]["polygonCount"], 3)
            self.assertEqual(overrides[0]["preservedTargetGeometrySummary"]["holeCount"], 0)
            for name, record in manifest["outputs"].items():
                output = (bundle / name).read_bytes()
                self.assertEqual(len(output), record["bytes"])
                self.assertEqual(hashlib.sha256(output).hexdigest(), record["sha256"])


if __name__ == "__main__":
    unittest.main()

"""Contract tests for the long-running photo discovery audit."""

import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from photo_source_audit import (  # noqa: E402
    enrich,
    license_status,
    name_in_metadata,
    point_in_geometry,
    read_checkpoint,
    save_checkpoint,
    usable_lead,
    write_reports,
)


class PhotoSourceAuditTests(unittest.TestCase):
    def test_boundary_hole_and_multipart_location(self):
        geometry = {
            "type": "MultiPolygon",
            "coordinates": [
                [[[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]], [[1, 1], [3, 1], [3, 3], [1, 3], [1, 1]]],
                [[[6, 6], [8, 6], [8, 8], [6, 8], [6, 6]]],
            ],
        }
        self.assertTrue(point_in_geometry(0.5, 0.5, geometry))
        self.assertFalse(point_in_geometry(2, 2, geometry))
        self.assertTrue(point_in_geometry(7, 7, geometry))
        self.assertFalse(point_in_geometry(5, 5, geometry))

    def test_license_claims_are_not_all_publishable(self):
        self.assertEqual(license_status({"source": "commons", "license": "CC BY-SA 4.0"}), "compatible_claim")
        self.assertEqual(license_status({"source": "flickr", "license": "CC BY-NC 2.0"}), "incompatible")
        self.assertEqual(license_status({"source": "commons", "license": "Public domain"}), "public_domain_review")
        self.assertEqual(license_status({"source": "pexels", "license": "Pexels License"}), "platform_terms_review")

    def test_ambiguous_island_needs_bc_context_or_geotag(self):
        place = {"id": "island-banks-island", "name": "Banks Island", "category": "island"}
        self.assertFalse(name_in_metadata(place, {"title": "Banks Island in the Arctic"}))
        self.assertTrue(name_in_metadata(place, {"title": "Banks Island, British Columbia"}))

    def test_matching_park_name_without_bc_or_boundary_is_a_weak_lead(self):
        place = {"id": "provincial-example-mountain-park", "name": "Example Mountain Park", "category": "provincial"}
        candidate = enrich(place, {
            "source": "commons", "source_id": "1", "title": "Example Mountain Park",
            "landing_url": "https://commons.wikimedia.org/wiki/File:Example.jpg",
            "image_url": "https://upload.wikimedia.org/example.jpg", "creator": "A photographer",
            "license": "CC BY 4.0", "license_url": "https://creativecommons.org/licenses/by/4.0/",
        }, None)
        self.assertEqual(candidate["location_status"], "name_only")
        self.assertFalse(usable_lead(candidate))

    def test_reports_keep_unreviewed_leads_separate_from_verified(self):
        place = {"id": "provincial-tuya-mountains-park", "name": "Tuya Mountains Park", "category": "provincial"}
        candidate = enrich(place, {
            "source": "commons", "source_id": "1", "title": "Tuya Mountains Park in British Columbia",
            "landing_url": "https://commons.wikimedia.org/wiki/File:Tuya.jpg", "license": "CC BY 4.0",
            "license_url": "https://creativecommons.org/licenses/by/4.0/", "creator": "A photographer",
            "image_url": "https://upload.wikimedia.org/tuya.jpg",
            "latitude": None, "longitude": None,
        }, None)
        self.assertTrue(usable_lead(candidate))
        with tempfile.TemporaryDirectory() as directory:
            summary = write_reports(Path(directory), {(place["id"], "commons"): {"place_id": place["id"], "source": "commons", "candidates": [candidate]}}, [place], set(), ["commons"], {})
            self.assertEqual(summary["existing_verified_places"], 0)
            self.assertEqual(summary["additional_human_verified_places"], 0)
            self.assertEqual(summary["additional_compatible_named_place_leads"], 1)
            self.assertEqual(summary["potential_coverage_after_review"], 1)

    def test_checkpoint_recovers_from_truncated_last_line(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "queries.jsonl"
            row = {"place_id": "place-one", "source": "commons", "candidates": []}
            save_checkpoint(path, row)
            with path.open("a", encoding="utf-8") as stream:
                stream.write('{"place_id":')
            self.assertEqual(read_checkpoint(path), {("place-one", "commons"): row})


if __name__ == "__main__":
    unittest.main()

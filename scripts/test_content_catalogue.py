from __future__ import annotations

import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import content_catalogue as catalogue


def square(x: float, y: float, size: float = 0.01) -> dict:
    ring = [[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]]
    return {"type": "MultiPolygon", "coordinates": [[ring]]}


def snapshot(count: int, positions: int = 5) -> dict:
    parks, features, drive = [], [], {}
    for index in range(count):
        park_id = f"regional-park-{index:04d}"
        lng, lat = -128 + (index % 12), 48 + (index // 12) % 10
        parks.append({"id": park_id, "name": f"Park {index}", "short": f"P{index}", "category": "regional", "region": "BC",
                      "lat": lat + 0.005, "lng": lng + 0.005, "biome": "forest", "shape": "circle", "rarity": "common",
                      "scene": None, "seed": index, "blurb": "A park.", "googleMapsUrl": None, "trailheadLat": None, "trailheadLng": None})
        geometry = square(lng, lat)
        if positions > 5:
            ring = [[lng + 0.001 * i, lat + 0.0001 * (i % 2)] for i in range(positions - 1)]
            geometry = {"type": "MultiPolygon", "coordinates": [[[*ring, ring[0]]]]}
        features.append({"type": "Feature", "properties": {"id": park_id, "biome": "forest"}, "geometry": geometry})
        drive[park_id] = {"drive": [None], "walkM": 0}
    return {"schema": "parkdex.content-sync/v1", "revision": 42, "parks": parks,
            "boundaries": {"type": "FeatureCollection", "features": features},
            "drive": {"hubs": [{"name": "Downtown", "lng": -123.36, "lat": 48.42}], "parks": drive},
            "assets": [], "map": None}


class ContentCatalogueTests(unittest.TestCase):
    def test_release_is_deterministic_and_content_addressed(self):
        first = catalogue.build_release(snapshot(30))
        second = catalogue.build_release(snapshot(30))
        self.assertEqual(first["manifest"], second["manifest"])
        index_raw = dict(first["files"])[catalogue.INDEX_PATH]
        self.assertEqual(first["pointer"]["version"], catalogue.sha256(index_raw))
        self.assertEqual(first["pointer"]["indexUrl"], f"https://kip-assets.parkdex.app/releases/{first['pointer']['version']}/catalogue/index.json")
        for item in first["manifest"]["files"]:
            self.assertEqual(item["key"], f"releases/{first['pointer']['version']}/{item['path']}")
        changed = snapshot(30)
        changed["parks"][0]["name"] = "Renamed"
        self.assertNotEqual(catalogue.build_release(changed)["pointer"]["version"], first["pointer"]["version"])

    def test_every_boundary_is_in_exactly_one_chunk_and_chunks_stay_small(self):
        source = snapshot(400, positions=900)
        release = catalogue.build_release(source)
        index = json.loads(dict(release["files"])[catalogue.INDEX_PATH])
        ids = [park_id for chunk in index["boundaryChunks"] for park_id in chunk["parkIds"]]
        self.assertEqual(sorted(ids), sorted(park["id"] for park in source["parks"]))
        self.assertGreater(len(index["boundaryChunks"]), 1)
        files = dict(release["files"])
        for chunk in index["boundaryChunks"]:
            raw = files[chunk["path"]]
            self.assertEqual(len(raw), chunk["byte_size"])
            self.assertEqual(catalogue.sha256(raw), chunk["sha256"])
            self.assertLessEqual(len(raw), catalogue.TARGET_CHUNK_BYTES + 64 * 1024)
            body = json.loads(raw)
            self.assertEqual(body["schema"], catalogue.CHUNK_SCHEMA)
            self.assertEqual([feature["properties"]["id"] for feature in body["features"]], chunk["parkIds"])
        self.assertNotIn("boundaries", index)
        self.assertEqual(index["revision"], 42)

    def test_mismatched_boundaries_are_rejected(self):
        source = snapshot(3)
        source["boundaries"]["features"].pop()
        with self.assertRaisesRegex(catalogue.CatalogueError, "Boundary ids"):
            catalogue.build_release(source)

    def test_written_release_reloads_and_detects_tampering(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory) / "release"
            summary = catalogue.write_release(catalogue.build_release(snapshot(20)), out, {"host": "127.0.0.1", "port": 5432, "database": "kip_qa_x", "environment": "local-qa"})
            self.assertEqual(summary["parkCount"], 20)
            manifest, pointer = catalogue.load_release(out)
            self.assertEqual(manifest["version"], pointer["version"])
            chunk = next(item for item in manifest["files"] if item["path"] != catalogue.INDEX_PATH)
            path = out / "content" / chunk["path"]
            path.write_bytes(path.read_bytes() + b" ")
            with self.assertRaisesRegex(catalogue.CatalogueError, "changed after build"):
                catalogue.load_release(out)

    def test_release_matches_the_publish_content_uploader_contract(self):
        import publish_content

        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory) / "release"
            catalogue.write_release(catalogue.build_release(snapshot(10)), out, {"host": "h", "port": 1, "database": "d", "environment": "e"})
            manifest, objects = publish_content.snapshot_objects(out)
            self.assertEqual(len(objects), len(manifest["files"]) + 1)
            self.assertEqual(objects[-1][0]["key"], f"releases/{manifest['version']}/manifest.json")


if __name__ == "__main__":
    unittest.main()

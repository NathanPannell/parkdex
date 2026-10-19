from __future__ import annotations

import json
import importlib.util
import tempfile
import unittest
from pathlib import Path

_MODULE_SPEC = importlib.util.spec_from_file_location("map_only_manifest", Path(__file__).with_name("build-map-only-manifest.py"))
assert _MODULE_SPEC and _MODULE_SPEC.loader
_MODULE = importlib.util.module_from_spec(_MODULE_SPEC)
_MODULE_SPEC.loader.exec_module(_MODULE)
MapManifestError = _MODULE.MapManifestError
build_manifest = _MODULE.build_manifest


class MapOnlyManifestTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.source = Path(self.temp.name) / "source.json"
        self.version = "a" * 64
        self.file = {
            "path": "map/island/manifest.json",
            "key": f"releases/{self.version}/map/island/manifest.json",
            "url": f"https://kip-assets.parkdex.app/releases/{self.version}/map/island/manifest.json",
            "sha256": "b" * 64,
            "byte_size": 25,
            "content_type": "application/json",
        }
        self.glyph = {
            "path": "map/fonts/basic/0-255.pbf",
            "key": f"releases/{self.version}/map/fonts/basic/0-255.pbf",
            "url": f"https://kip-assets.parkdex.app/releases/{self.version}/map/fonts/basic/0-255.pbf",
            "sha256": "c" * 64,
            "byte_size": 31,
            "content_type": "application/x-protobuf",
        }
        self.source.write_text(
            json.dumps(
                {
                    "version": self.version,
                    "mapManifest": {"size": 4, "chunkBytes": 4, "count": 1},
                    "files": [
                        self.file,
                        self.glyph,
                        {
                            "path": "map/island/000.bin",
                            "key": f"releases/{self.version}/map/island/000.bin",
                            "url": f"https://kip-assets.parkdex.app/releases/{self.version}/map/island/000.bin",
                            "sha256": "d" * 64,
                            "byte_size": 4,
                            "content_type": "application/octet-stream",
                        },
                    ],
                }
            ),
            encoding="utf-8",
        )

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_builds_deterministic_map_only_manifest_with_file_and_body_hashes(self) -> None:
        first, first_bytes, report = build_manifest(self.source)
        second, second_bytes, second_report = build_manifest(self.source)
        self.assertEqual(first, second)
        self.assertEqual(first_bytes, second_bytes)
        self.assertEqual(report, second_report)
        self.assertEqual(first["schema"], "parkdex.content-map/v1")
        self.assertEqual(len(first["files"]), 3)
        self.assertEqual(report["manifestSha256"], __import__("hashlib").sha256(first_bytes).hexdigest())
        self.assertEqual(report["manifestUrl"], f"https://kip-assets.parkdex.app/releases/{report['version']}/map/manifest.json")

    def test_rejects_missing_chunks_before_publishing_a_pointer(self) -> None:
        raw = json.loads(self.source.read_text(encoding="utf-8"))
        raw["files"] = [entry for entry in raw["files"] if entry["path"] != "map/island/000.bin"]
        self.source.write_text(json.dumps(raw), encoding="utf-8")
        with self.assertRaisesRegex(MapManifestError, "map chunks"):
            build_manifest(self.source)


if __name__ == "__main__":
    unittest.main()

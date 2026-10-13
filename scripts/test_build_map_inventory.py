from __future__ import annotations

import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

_MODULE_SPEC = importlib.util.spec_from_file_location("build_map_inventory", Path(__file__).with_name("build-map-inventory.py"))
assert _MODULE_SPEC and _MODULE_SPEC.loader
_MODULE = importlib.util.module_from_spec(_MODULE_SPEC)
_MODULE_SPEC.loader.exec_module(_MODULE)
build = _MODULE.build

FONT = {
    "byte_size": 3,
    "content_type": "application/x-protobuf",
    "key": f"releases/{'5' * 64}/map/fonts/Noto Sans Regular/0-255.pbf",
    "path": "map/fonts/Noto Sans Regular/0-255.pbf",
    "sha256": "a" * 64,
    "url": f"https://kip-assets.parkdex.app/releases/{'5' * 64}/map/fonts/Noto%20Sans%20Regular/0-255.pbf",
}


class BuildMapInventoryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.archive = root / "map.pmtiles"
        self.archive.write_bytes(b"0123456789")
        self.glyphs = root / "glyphs.json"
        self.glyphs.write_text(json.dumps({"schema": "parkdex.content-map/v1", "files": [FONT]}), encoding="utf-8")
        self.output = root / "out"

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_writes_chunks_and_layout_in_the_detail_folder(self) -> None:
        report = build(self.archive, 4, self.glyphs, self.output)
        version = report["version"]
        self.assertEqual(report["mapManifest"], {"size": 10, "chunkBytes": 4, "count": 3})
        release = self.output / "releases" / version
        self.assertEqual((release / "map" / "detail" / "002.bin").read_bytes(), b"89")
        inventory_bytes = (release / "map" / "manifest.json").read_bytes()
        self.assertEqual(hashlib.sha256(inventory_bytes).hexdigest(), report["manifestSha256"])
        inventory = json.loads(inventory_bytes)
        self.assertEqual(
            [item["path"] for item in inventory["files"]],
            ["map/detail/000.bin", "map/detail/001.bin", "map/detail/002.bin", "map/detail/manifest.json", FONT["path"]],
        )
        self.assertEqual(inventory["files"][0]["key"], f"releases/{version}/map/detail/000.bin")
        self.assertEqual(inventory["files"][-1], FONT)

    def test_can_still_write_the_island_folder_and_versions_differ_by_folder(self) -> None:
        island = build(self.archive, 4, self.glyphs, self.output, "island")
        detail = build(self.archive, 4, self.glyphs, self.output, "detail")
        self.assertTrue((self.output / "releases" / island["version"] / "map" / "island" / "manifest.json").is_file())
        self.assertNotEqual(island["version"], detail["version"])

    def test_rejects_unsafe_folders(self) -> None:
        for folder in ("fonts", "", "Detail", "../x", "a/b"):
            with self.assertRaises(ValueError):
                build(self.archive, 4, self.glyphs, self.output, folder)


if __name__ == "__main__":
    unittest.main()

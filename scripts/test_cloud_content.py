import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from cloud_content import CloudContentError, build_snapshot, validate_snapshot


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, separators=(",", ":")), encoding="utf-8")


def fixture(root: Path, map_source: Path, boundary_id: str = "park-one") -> None:
    park = {
        "id": "park-one",
        "name": "Example Park",
        "short": "Example",
        "category": "regional",
        "region": "Island",
        "lat": 48.4,
        "lng": -123.3,
        "biome": "forest",
        "shape": "circle",
        "rarity": "common",
        "scene": None,
        "seed": 101,
        "blurb": "A small fixture park.",
    }
    write_json(root / "src/data/parks.json", [park])
    write_json(root / "src/data/drive.json", {"hubs": [], "parks": {"park-one": {"drive": [], "walkM": 0}}})
    write_json(
        root / "public/boundaries.geojson",
        {
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "properties": {"id": boundary_id, "biome": "forest"},
                    "geometry": {"type": "MultiPolygon", "coordinates": []},
                }
            ],
        },
    )
    art = root / "public/art/kip/test.webp"
    art.parent.mkdir(parents=True, exist_ok=True)
    art.write_bytes(b"fixture-webp")

    island = map_source / "island"
    island.mkdir(parents=True, exist_ok=True)
    write_json(island / "manifest.json", {"size": 3, "chunkBytes": 2, "count": 2})
    (island / "000.bin").write_bytes(b"ab")
    (island / "001.bin").write_bytes(b"c")
    glyph = map_source / "fonts/Noto Sans Regular/0-255.pbf"
    glyph.parent.mkdir(parents=True, exist_ok=True)
    glyph.write_bytes(b"glyph")

    subprocess.run(["git", "init", "-q", str(root)], check=True)
    subprocess.run(["git", "-C", str(root), "config", "user.name", "Cloud Content Test"], check=True)
    subprocess.run(["git", "-C", str(root), "config", "user.email", "cloud-content@example.invalid"], check=True)
    subprocess.run(["git", "-C", str(root), "add", "src", "public"], check=True)
    subprocess.run(["git", "-C", str(root), "commit", "-qm", "fixture source"], check=True)


class CloudContentTests(unittest.TestCase):
    def make_fixture(self, base: Path, boundary_id: str = "park-one") -> tuple[Path, Path]:
        root = base / "repo"
        map_source = base / "map"
        fixture(root, map_source, boundary_id)
        return root, map_source

    def test_snapshot_is_deterministic_and_roundtrips(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            root, map_source = self.make_fixture(base)
            first = build_snapshot(root, map_source, base / "first")
            second = build_snapshot(root, map_source, base / "second")
            self.assertEqual(first, second)
            self.assertEqual((base / "first/manifest.json").read_bytes(), (base / "second/manifest.json").read_bytes())
            verified, files, _ = validate_snapshot(base / "first", root)
            self.assertEqual(verified["version"], first["version"])
            self.assertEqual(set(files), {item["path"] for item in first["files"]})
            self.assertEqual(first["mapManifest"], {"size": 3, "chunkBytes": 2, "count": 2})
            self.assertEqual(first["parkIds"], ["park-one"])

    def test_missing_map_chunk_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            root, map_source = self.make_fixture(base)
            (map_source / "island/001.bin").unlink()
            with self.assertRaisesRegex(CloudContentError, "map chunks do not match"):
                build_snapshot(root, map_source, base / "snapshot")

    def test_malformed_map_manifest_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            root, map_source = self.make_fixture(base)
            (map_source / "island/manifest.json").write_text("{", encoding="utf-8")
            with self.assertRaisesRegex(CloudContentError, "not valid UTF-8 JSON"):
                build_snapshot(root, map_source, base / "snapshot")

    def test_park_boundary_id_mismatch_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            root, map_source = self.make_fixture(base, boundary_id="another-park")
            with self.assertRaisesRegex(CloudContentError, "boundary feature ids do not match"):
                build_snapshot(root, map_source, base / "snapshot")

    def test_stale_uncommitted_source_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            root, map_source = self.make_fixture(base)
            path = root / "src/data/parks.json"
            path.write_text(path.read_text(encoding="utf-8").replace("Example Park", "Changed Park"), encoding="utf-8")
            with self.assertRaisesRegex(CloudContentError, "uncommitted changes"):
                build_snapshot(root, map_source, base / "snapshot")


if __name__ == "__main__":
    unittest.main()

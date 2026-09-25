import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sys

import pytest


SCRIPT = Path(__file__).with_name("publish_visual_assets.py")
SPEC = importlib.util.spec_from_file_location("publish_visual_assets", SCRIPT)
assert SPEC and SPEC.loader
publisher = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = publisher
SPEC.loader.exec_module(publisher)


def _sha(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def make_fixture(root: Path) -> tuple[Path, Path, tuple[str, ...]]:
    root.mkdir(parents=True, exist_ok=True)
    catalogue_path = root / "places.json"
    generated = root / "generated"
    generated.mkdir()
    places = [
        {"id": "island-one", "name": "Island One", "category": "island"},
        {"id": "regional-two", "name": "Regional Two", "category": "regional"},
    ]
    catalogue_path.write_text(json.dumps(places), encoding="utf-8")

    for position, place in enumerate(places):
        place_root = generated / place["id"]
        place_root.mkdir()
        public_files = {
            "satellite.avif": f"satellite-{position}".encode(),
            "relief.avif": f"relief-{position}".encode(),
            f"{place['id']}-terrain.glb": f"glb-{position}".encode(),
        }
        files = {}
        for filename, content in public_files.items():
            (place_root / filename).write_bytes(content)
            files[filename] = {"bytes": len(content), "sha256": _sha(content)}

        sources = json.dumps({"locked": place["id"]}, sort_keys=True).encode()
        (place_root / "sources.json").write_bytes(sources)
        manifest = {
            "version": 4,
            "placeId": place["id"],
            "park": place["name"],
            "category": place["category"],
            "files": files,
            "sourceLockSha256": _sha(sources),
            "attribution": ["Contains modified Copernicus Sentinel data 2026"],
            "acquired": ["2026-09-16T19:20:43Z"],
            "needsReview": position == 0,
            "reviewFlags": ["satellite-fallback-filled-no-data"] if position == 0 else None,
        }
        (place_root / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
        # These source files must not make their way into the fixture or public index.
        (place_root / "texture.avif").write_bytes(b"private working output")

    return catalogue_path, generated, tuple(place["id"] for place in places)


class NotFound(Exception):
    def __init__(self):
        self.response = {
            "Error": {"Code": "404"},
            "ResponseMetadata": {"HTTPStatusCode": 404},
        }


class FakeS3:
    def __init__(self):
        self.values = {}
        self.events = []

    def head_object(self, *, Bucket, Key):
        self.events.append(("head", Key))
        if Key not in self.values:
            raise NotFound()
        content, metadata, content_type = self.values[Key]
        return {"Metadata": metadata, "ContentLength": len(content), "ContentType": content_type}

    def get_object(self, *, Bucket, Key):
        self.events.append(("get", Key))
        return {"Body": io.BytesIO(self.values[Key][0])}

    def put_object(self, *, Bucket, Key, Body, ContentLength, ContentType, CacheControl, Metadata):
        content = Body.read() if hasattr(Body, "read") else Body
        assert len(content) == ContentLength
        self.events.append(("put", Key))
        self.values[Key] = (content, Metadata, ContentType)


def test_validates_canonical_manifests_source_locks_and_builds_stable_index(tmp_path):
    catalogue, generated, ids = make_fixture(tmp_path)
    batch = publisher.validate_batch(generated, catalogue, require_exact_directories=True)
    repeated = publisher.validate_batch(generated, catalogue, require_exact_directories=True)

    assert batch.index_bytes == repeated.index_bytes
    assert batch.index_sha256 == _sha(batch.index_bytes)
    index = json.loads(batch.index_bytes)
    assert index["version"] == 1
    assert list(index["places"]) == sorted(ids)
    entry = index["places"][ids[0]]
    assert entry["satellite"] == f"{ids[0]}/satellite.avif"
    assert entry["relief"] == f"{ids[0]}/relief.avif"
    assert entry["model"] == f"{ids[0]}/{ids[0]}-terrain.glb"
    assert entry["needsReview"] is True
    assert entry["reviewFlags"] == ["satellite-fallback-filled-no-data"]
    assert index["places"][ids[1]]["reviewFlags"] == []
    assert publisher.summarize(batch)["categoryCounts"] == {"island": 1, "regional": 1}
    assert set(entry["assetSha256"]) == {
        "satellite.avif",
        "relief.avif",
        f"{ids[0]}-terrain.glb",
    }


def test_stage_copies_only_selected_public_files_and_index(tmp_path):
    catalogue, generated, ids = make_fixture(tmp_path)
    batch = publisher.validate_batch(generated, catalogue, requested_ids=(ids[1],))
    stage = tmp_path / "fixture"
    publisher.stage_subset(batch, stage, generated)

    paths = sorted(
        str(path.relative_to(stage)).replace("\\", "/")
        for path in stage.rglob("*")
        if path.is_file()
    )
    assert paths == [
        "index.json",
        f"{ids[1]}/{ids[1]}-terrain.glb",
        f"{ids[1]}/relief.avif",
        f"{ids[1]}/satellite.avif",
    ]
    index = json.loads((stage / "index.json").read_text(encoding="utf-8"))
    assert list(index["places"]) == [ids[1]]


def test_rejects_asset_integrity_or_source_lock_mismatch(tmp_path):
    catalogue, generated, ids = make_fixture(tmp_path)
    asset = generated / ids[0] / "satellite.avif"
    asset.write_bytes(b"Xatellite-0")
    with pytest.raises(publisher.PublishError, match="SHA-256 does not match"):
        publisher.validate_batch(generated, catalogue, requested_ids=(ids[0],))

    catalogue, generated, ids = make_fixture(tmp_path / "second")
    (generated / ids[0] / "sources.json").write_bytes(b"changed lock")
    with pytest.raises(publisher.PublishError, match="source-lock SHA-256"):
        publisher.validate_batch(generated, catalogue, requested_ids=(ids[0],))


def test_rejects_category_drift_and_unexpected_full_batch_directory(tmp_path):
    catalogue, generated, ids = make_fixture(tmp_path)
    manifest_path = generated / ids[0] / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["category"] = "provincial"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    with pytest.raises(publisher.PublishError, match="category does not match"):
        publisher.validate_batch(generated, catalogue)

    manifest["category"] = "island"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    (generated / "unknown-place").mkdir()
    with pytest.raises(publisher.PublishError, match="unexpected place directories"):
        publisher.validate_batch(generated, catalogue, require_exact_directories=True)


def test_legacy_needs_review_manifests_infer_reasons_and_keep_explicit_flags(tmp_path):
    catalogue, generated, ids = make_fixture(tmp_path)
    manifest_path = generated / ids[0] / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest.pop("reviewFlags")
    manifest.update({
        "boundaryGeometryValid": True,
        "demFilledFraction": 0.0,
        "sceneQuality": [
            {"status": "ok", "cloudShadowFraction": 0.0, "snowFraction": 0.0}
        ],
        "acquired": ["2026-09-16T19:20:43Z", "2025-08-25T19:31:00Z"],
        "fallbackSceneIds": [],
    })
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    batch = publisher.validate_batch(generated, catalogue, requested_ids=(ids[0],))
    flags = json.loads(batch.index_bytes)["places"][ids[0]]["reviewFlags"]
    assert flags == ["sentinel-scenes-mix-acquisition-dates"]

    manifest["acquired"] = ["2026-09-16T19:20:43Z"]
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    batch = publisher.validate_batch(generated, catalogue, requested_ids=(ids[0],))
    flags = json.loads(batch.index_bytes)["places"][ids[0]]["reviewFlags"]
    assert flags == ["batch-review-required"]

    manifest["reviewFlags"] = ["explicit-review-reason"]
    manifest["acquired"] = ["2026-09-16T19:20:43Z", "2025-08-25T19:31:00Z"]
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    batch = publisher.validate_batch(generated, catalogue, requested_ids=(ids[0],))
    flags = json.loads(batch.index_bytes)["places"][ids[0]]["reviewFlags"]
    assert flags == ["explicit-review-reason"]


def test_upload_is_full_only_and_publishes_index_last_then_skips_matching_objects(tmp_path):
    catalogue, generated, ids = make_fixture(tmp_path)
    batch = publisher.validate_batch(generated, catalogue, require_exact_directories=True)
    client = FakeS3()

    first = publisher.publish_to_s3(client, batch, bucket="public-assets", prefix="parkdex/visual-assets/v1")
    assert first["uploaded"] == 7
    assert first["skipped"] == 0
    assert client.events[-1] == ("put", f"{first['prefix']}/index.json")
    assert first["prefix"].endswith(batch.index_sha256)

    event_count = len(client.events)
    second = publisher.publish_to_s3(client, batch, bucket="public-assets", prefix="parkdex/visual-assets/v1")
    assert second["uploaded"] == 0
    assert second["skipped"] == 7
    assert not any(event[0] == "put" for event in client.events[event_count:])

    result = publisher.main([
        "--generated", str(generated), "--catalogue", str(catalogue), "--upload"
    ])
    assert result == 2


def test_upload_rejects_conflicting_immutable_key_hash(tmp_path):
    catalogue, generated, _ = make_fixture(tmp_path)
    batch = publisher.validate_batch(generated, catalogue)
    client = FakeS3()
    published = publisher.publish_to_s3(client, batch, bucket="public-assets", prefix="assets")
    key = f"{published['prefix']}/{batch.places[0].assets[0].key}"
    original, metadata, content_type = client.values[key]
    client.values[key] = (b"different", {"sha256": _sha(b"different")}, content_type)

    with pytest.raises(publisher.PublishError, match="conflicting bytes"):
        publisher.publish_to_s3(client, batch, bucket="public-assets", prefix="assets")

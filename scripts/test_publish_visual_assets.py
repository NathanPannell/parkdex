import hashlib
import importlib.util
import io
import json
from dataclasses import replace
from pathlib import Path
import subprocess
import sys
import struct
import threading

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

        sources = json.dumps({
            "boundary": {"features": [{"type": "Feature", "geometry": None, "properties": {
                **place,
                "sourceName": f"source-{place['id']}",
                "sourceUrl": f"https://example.test/{place['id']}",
                "sourceId": f"object-{position}",
            }}]},
        }, sort_keys=True).encode()
        (place_root / "sources.json").write_bytes(sources)
        manifest = {
            "version": 4,
            "placeId": place["id"],
            "park": place["name"],
            "category": place["category"],
            "boundarySource": f"source-{place['id']}",
            "boundarySourceUrl": f"https://example.test/{place['id']}",
            "boundarySourceId": f"object-{position}",
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


def make_rights_fixture(root: Path, catalogue: Path, *, held: tuple[str, ...] = ()) -> tuple[Path, Path]:
    places = json.loads(catalogue.read_text(encoding="utf-8"))
    features = []
    decisions = {}
    for position, place in enumerate(places):
        source = {
            "sourceName": f"source-{place['id']}",
            "sourceUrl": f"https://example.test/{place['id']}",
            "sourceId": f"object-{position}",
        }
        features.append({"type": "Feature", "properties": {**place, **source}, "geometry": None})
        decisions[place["id"]] = {
            **source,
            "decision": "hold" if place["id"] in held else "approved",
            **({"reason": "upstream permission unresolved"} if place["id"] in held else {
                "rightsAttribution": [f"Boundary data by source-{place['id']}"]
            }),
        }
    boundaries = root / "boundaries.geojson"
    boundaries.write_text(json.dumps({"type": "FeatureCollection", "features": features}), encoding="utf-8")
    rights = root / "rights.json"
    rights.write_text(json.dumps({
        "version": 1,
        "boundarySnapshotSha256": publisher.sha256_file(boundaries),
        "places": decisions,
    }), encoding="utf-8")
    return rights, boundaries


def gate_fixture_batch(batch, catalogue, root, monkeypatch, *, held=()):
    monkeypatch.setattr(publisher, "CANONICAL_PLACE_COUNT", len(batch.places))
    rights, boundaries = make_rights_fixture(root, catalogue, held=held)
    return publisher.apply_rights_gate(batch, rights, boundaries)


def make_glb(json_document: dict) -> bytes:
    chunk = json.dumps(json_document, separators=(",", ":")).encode("utf-8")
    chunk += b" " * ((4 - len(chunk) % 4) % 4)
    total_length = 12 + 8 + len(chunk)
    return b"glTF" + struct.pack("<II", 2, total_length) + struct.pack("<II", len(chunk), 0x4E4F534A) + chunk


def make_point_fixture(root: Path, catalogue: Path, ids: tuple[str, ...]) -> tuple[Path, Path]:
    point_root = root / "point-generated"
    point_root.mkdir()
    point_records = []
    catalogue_rows = {row["id"]: row for row in json.loads(catalogue.read_text(encoding="utf-8"))}
    for position, place_id in enumerate(ids):
        catalogue_row = catalogue_rows[place_id]
        point_records.append({
            **catalogue_row,
            "lon": -125.0 - position / 10,
            "lat": 52.0 + position / 10,
            "sourceName": f"open point source {place_id}",
            "sourceUrl": f"https://example.test/points/{place_id}",
            "sourceId": f"point-{position}",
            "licence": "Open Government Licence - Canada",
            "attribution": f"Coordinate record credited to provider for {place_id}",
        })
    point_manifest = root / "independent-points.json"
    point_manifest.write_text(json.dumps(point_records, separators=(",", ":")), encoding="utf-8")
    point_snapshot_sha256 = publisher.sha256_file(point_manifest)

    for record in point_records:
        place_id = record["id"]
        place_root = point_root / place_id
        place_root.mkdir()
        epsg, bounds = publisher._expected_point_utm_frame(record)
        public_files = {
            "satellite.avif": f"point-satellite-{place_id}".encode(),
            "relief.avif": f"point-relief-{place_id}".encode(),
            f"{place_id}-terrain.glb": make_glb({"asset": {"version": "2.0"}, "scenes": [{"nodes": []}], "scene": 0}),
        }
        files = {}
        for filename, content in public_files.items():
            (place_root / filename).write_bytes(content)
            files[filename] = {"bytes": len(content), "sha256": _sha(content)}
        source_lock = json.dumps({
            "version": 1,
            "config": {"pointSideM": publisher.POINT_FRAME_SIDE_M, "demResolutionM": 30},
            "renderMode": "point-centered-boundary-free",
            "inputSha256": point_snapshot_sha256,
            "inputRecord": record,
            "epsg": epsg,
            "boundsM": list(bounds),
            "scenes": [],
            "sceneQuality": [],
            "demUrl": "https://example.test/dem",
        }, sort_keys=True).encode()
        (place_root / "sources.json").write_bytes(source_lock)
        (place_root / "terrain.json").write_text(json.dumps({"surface": "terrain mesh", "sideKm": 8.0}), encoding="utf-8")
        manifest = {
            "version": 4,
            "placeId": place_id,
            "park": record["name"],
            "category": record["category"],
            "renderMode": "point-centered-boundary-free",
            "pointSnapshotSha256": point_snapshot_sha256,
            "pointSource": {key: record[key] for key in publisher.POINT_SOURCE_KEYS},
            "representativePin": [record["lon"], record["lat"]],
            "projectionEpsg": epsg,
            "boundsM": list(bounds),
            "files": files,
            "sourceLockSha256": _sha(source_lock),
            "attribution": ["Contains modified Copernicus Sentinel data 2026"],
            "acquired": ["2026-09-16T19:20:43Z"],
            "needsReview": False,
            "reviewFlags": [],
        }
        (place_root / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    return point_root, point_manifest


def make_point_rights_fixture(root: Path, point_manifest: Path) -> Path:
    records = json.loads(point_manifest.read_text(encoding="utf-8"))
    decisions = {}
    for record in records:
        decisions[record["id"]] = {
            "decision": "approved",
            **{key: record[key] for key in publisher.POINT_SOURCE_KEYS},
            "officialTermsUrl": "https://example.test/terms",
            "reviewEvidenceUrl": "https://example.test/review-evidence",
        }
    rights_path = root / "point-rights.json"
    rights_path.write_text(json.dumps({
        "version": 1,
        "pointManifestSha256": publisher.sha256_file(point_manifest),
        "places": decisions,
    }, separators=(",", ":")), encoding="utf-8")
    return rights_path


def apply_dual_fixture(generated, rights_path, boundaries_path, point_root, point_manifest, catalogue):
    point_rights = make_point_rights_fixture(point_manifest.parent, point_manifest)
    return publisher.apply_dual_source_gate(
        generated, rights_path, boundaries_path, point_root, point_manifest, point_rights, catalogue,
    )


def gate_dual_fixture(root: Path, catalogue: Path, ids: tuple[str, ...], monkeypatch, *, held: tuple[str, ...]):
    monkeypatch.setattr(publisher, "CANONICAL_PLACE_COUNT", len(ids))
    rights_path, boundaries_path = make_rights_fixture(root, catalogue, held=held)
    point_ids = tuple(sorted(held))
    point_root, point_manifest = make_point_fixture(root, catalogue, point_ids)
    point_rights = make_point_rights_fixture(root, point_manifest)
    batch = publisher.apply_dual_source_gate(
        root / "generated", rights_path, boundaries_path, point_root, point_manifest, point_rights, catalogue,
    )
    return batch, rights_path, boundaries_path, point_root, point_manifest, point_rights


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


class FakeWrangler:
    def __init__(self):
        self.values = {}
        self.events = []
        self.fail_put_key = None
        self._lock = threading.Lock()

    def __call__(self, *arguments):
        if arguments == ("--version",):
            return subprocess.CompletedProcess(arguments, 0, publisher.WRANGLER_VERSION, "")
        operation = arguments[2]
        object_path = arguments[3]
        key = object_path.split("/", 1)[1]
        file_path = Path(arguments[arguments.index("--file") + 1])
        with self._lock:
            self.events.append((operation, key))
            if operation == "get":
                if key not in self.values:
                    return subprocess.CompletedProcess(arguments, 1, "", publisher.WRANGLER_MISSING_MESSAGE)
                file_path.write_bytes(self.values[key][0])
                return subprocess.CompletedProcess(arguments, 0, "", "")
            assert operation == "put"
            if self.fail_put_key == key:
                self.fail_put_key = None
                return subprocess.CompletedProcess(arguments, 1, "", "secret should never be logged")
            assert "--remote" in arguments and "--force" in arguments
            content_type = arguments[arguments.index("--content-type") + 1]
            cache_control = arguments[arguments.index("--cache-control") + 1]
            self.values[key] = (file_path.read_bytes(), content_type, cache_control)
            return subprocess.CompletedProcess(arguments, 0, "", "")


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


def test_public_index_adds_exact_cdem_credit_to_legacy_batch_manifests(tmp_path):
    catalogue, generated, ids = make_fixture(tmp_path)
    manifest_path = generated / ids[0] / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["attribution"].append(publisher.CDEM_LEGACY_ATTRIBUTION)
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    batch = publisher.validate_batch(generated, catalogue)
    entries = json.loads(batch.index_bytes)["places"]
    assert publisher.CDEM_PUBLIC_ATTRIBUTION in entries[ids[0]]["attribution"]
    assert publisher.CDEM_LEGACY_ATTRIBUTION not in entries[ids[0]]["attribution"]
    assert "https://open.canada.ca/en/open-government-licence-canada" in publisher.CDEM_PUBLIC_ATTRIBUTION
    assert entries[ids[1]]["attribution"] == ["Contains modified Copernicus Sentinel data 2026"]


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


def test_upload_is_full_only_and_publishes_index_last_then_skips_matching_objects(tmp_path, monkeypatch):
    catalogue, generated, ids = make_fixture(tmp_path)
    batch = publisher.validate_batch(generated, catalogue, require_exact_directories=True)
    with pytest.raises(publisher.PublishError, match="rights gate"):
        publisher.publish_to_s3(FakeS3(), batch, bucket="public-assets", prefix="assets")
    batch = gate_fixture_batch(batch, catalogue, tmp_path, monkeypatch)
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


def test_upload_rejects_conflicting_immutable_key_hash(tmp_path, monkeypatch):
    catalogue, generated, _ = make_fixture(tmp_path)
    batch = publisher.validate_batch(generated, catalogue)
    batch = gate_fixture_batch(batch, catalogue, tmp_path, monkeypatch)
    client = FakeS3()
    published = publisher.publish_to_s3(client, batch, bucket="public-assets", prefix="assets")
    key = f"{published['prefix']}/{batch.places[0].assets[0].key}"
    original, metadata, content_type = client.values[key]
    client.values[key] = (b"different", {"sha256": _sha(b"different")}, content_type)

    with pytest.raises(publisher.PublishError, match="conflicting bytes"):
        publisher.publish_to_s3(client, batch, bucket="public-assets", prefix="assets")


def test_wrangler_upload_resumes_and_publishes_index_last(tmp_path, monkeypatch):
    catalogue, generated, _ = make_fixture(tmp_path)
    batch = publisher.validate_batch(generated, catalogue)
    batch = gate_fixture_batch(batch, catalogue, tmp_path, monkeypatch)
    runner = FakeWrangler()
    progress = []

    first = publisher.publish_to_wrangler(
        batch, bucket="public-assets", prefix="parkdex/visual-assets/v1",
        runner=runner, workers=2, progress=lambda done, total: progress.append((done, total)),
    )
    assert first["uploaded"] == 7
    assert first["skipped"] == 0
    assert runner.events[-1] == ("put", first["indexKey"])
    assert progress == [(6, 6)]
    assert first["prefix"].endswith(batch.index_sha256)
    for key, (content, content_type, cache_control) in runner.values.items():
        assert _sha(content) == (batch.index_sha256 if key.endswith("/index.json") else json.loads(batch.index_bytes)["places"][key.split("/")[-2]]["assetSha256"][key.split("/")[-1]])
        assert content_type == ("application/json; charset=utf-8" if key.endswith("/index.json") else "image/avif" if key.endswith(".avif") else "model/gltf-binary")
        assert cache_control == publisher.IMMUTABLE_CACHE_CONTROL

    runner.events.clear()
    second = publisher.publish_to_wrangler(
        batch, bucket="public-assets", prefix="parkdex/visual-assets/v1",
        runner=runner, workers=2,
    )
    assert second["uploaded"] == 0
    assert second["skipped"] == 7
    assert all(operation == "get" for operation, _ in runner.events)


def test_wrangler_rejects_conflicts_and_never_publishes_index_after_error(tmp_path, monkeypatch):
    catalogue, generated, _ = make_fixture(tmp_path)
    batch = publisher.validate_batch(generated, catalogue)
    batch = gate_fixture_batch(batch, catalogue, tmp_path, monkeypatch)
    runner = FakeWrangler()
    prefix = f"assets/{batch.index_sha256}"
    failing_key = f"{prefix}/{batch.places[0].assets[0].key}"
    runner.fail_put_key = failing_key

    with pytest.raises(publisher.PublishError, match="could not upload remote object") as error:
        publisher.publish_to_wrangler(batch, bucket="public-assets", prefix="assets", runner=runner, workers=1)
    assert "secret" not in str(error.value)
    assert f"{prefix}/index.json" not in runner.values

    published = publisher.publish_to_wrangler(batch, bucket="public-assets", prefix="assets", runner=runner, workers=1)
    assert published["indexKey"] in runner.values
    key = f"{prefix}/{batch.places[0].assets[1].key}"
    content, content_type, cache_control = runner.values[key]
    runner.values[key] = (b"tampered", content_type, cache_control)
    with pytest.raises(publisher.PublishError, match="conflicting bytes"):
        publisher.publish_to_wrangler(batch, bucket="public-assets", prefix="assets", runner=runner, workers=1)


def test_wrangler_cli_requires_full_catalogue_and_dedicated_bucket(tmp_path, monkeypatch):
    catalogue, generated, ids = make_fixture(tmp_path)
    monkeypatch.setenv("PARKDEX_VISUAL_ASSETS_WRANGLER_BUCKET", "parkdex-visual-assets")
    monkeypatch.setenv("R2_BUCKET", "parkdex-photos-production")

    assert publisher.main([
        "--generated", str(generated), "--catalogue", str(catalogue),
        "--upload-wrangler", "--ids", ids[0],
    ]) == 2
    assert publisher.main([
        "--generated", str(generated), "--catalogue", str(catalogue),
        "--upload-wrangler", "--wrangler-workers", "0",
    ]) == 2

    monkeypatch.setattr(publisher, "CANONICAL_PLACE_COUNT", 2)
    rights, boundaries = make_rights_fixture(tmp_path, catalogue)
    runner = FakeWrangler()
    monkeypatch.setattr(publisher, "WranglerRunner", lambda **kwargs: runner)
    assert publisher.main([
        "--generated", str(generated), "--catalogue", str(catalogue),
        "--upload-wrangler", "--rights-manifest", str(rights), "--boundaries", str(boundaries),
    ]) == 0
    assert len(runner.values) == 7

    monkeypatch.setenv("R2_BUCKET", "parkdex-visual-assets")
    with pytest.raises(publisher.PublishError, match="separate from the private postcard bucket"):
        publisher._wrangler_configuration()


def test_wrangler_stops_if_local_asset_changes_after_validation(tmp_path, monkeypatch):
    catalogue, generated, _ = make_fixture(tmp_path)
    batch = publisher.validate_batch(generated, catalogue)
    batch = gate_fixture_batch(batch, catalogue, tmp_path, monkeypatch)
    batch.places[0].assets[0].path.write_bytes(b"changed after validation")
    runner = FakeWrangler()
    with pytest.raises(publisher.PublishError, match="changed before upload"):
        publisher.publish_to_wrangler(batch, bucket="public-assets", prefix="assets", runner=runner, workers=1)
    assert not any(key.endswith("/index.json") for key in runner.values)


def test_wrangler_rejects_postcard_bucket_even_without_private_bucket_variable(monkeypatch):
    monkeypatch.delenv("R2_BUCKET", raising=False)
    monkeypatch.setenv("PARKDEX_VISUAL_ASSETS_WRANGLER_BUCKET", "parkdex-photos-production")
    with pytest.raises(publisher.PublishError, match="must be parkdex-visual-assets"):
        publisher._wrangler_configuration()


def test_rights_gate_validates_full_batch_then_omits_held_place_from_both_uploads(tmp_path, monkeypatch):
    catalogue, generated, ids = make_fixture(tmp_path)
    batch = publisher.validate_batch(generated, catalogue)
    gated = gate_fixture_batch(batch, catalogue, tmp_path, monkeypatch, held=(ids[1],))
    index = json.loads(gated.index_bytes)
    assert list(index["places"]) == [ids[0]]
    assert f"Boundary data by source-{ids[0]}" in index["places"][ids[0]]["attribution"]
    assert gated.validated_place_count == 2
    assert gated.held_place_ids == (ids[1],)
    assert publisher.summarize(gated)["heldPlaceCount"] == 1

    client = FakeS3()
    result = publisher.publish_to_s3(client, gated, bucket="public-assets", prefix="assets")
    assert result["uploaded"] == 4
    assert all(ids[1] not in key for _, key in client.events)

    runner = FakeWrangler()
    result = publisher.publish_to_wrangler(gated, bucket="public-assets", prefix="assets", runner=runner)
    assert result["uploaded"] == 4
    assert all(ids[1] not in key for key in runner.values)


def test_dual_source_gate_uses_812_boundary_and_218_point_partition_and_skips_held_polygons(tmp_path, monkeypatch):
    catalogue, generated, ids = make_fixture(tmp_path)
    held_id = ids[1]
    (generated / held_id / "relief.avif").unlink()

    batch, _, _, point_root, _, _ = gate_dual_fixture(
        tmp_path, catalogue, ids, monkeypatch, held=(held_id,),
    )
    index = json.loads(batch.index_bytes)
    assert set(index["places"]) == set(ids)
    assert batch.validated_place_count == len(ids)
    assert batch.held_place_ids == ()
    assert index["places"][held_id]["renderMode"] == "point-centered-boundary-free"
    point_entry = index["places"][held_id]
    assert point_entry["pointSource"]["licence"] == "Open Government Licence - Canada"
    assert any("Coordinate record credited" in credit for credit in point_entry["attribution"])
    assert any("Point source:" in credit for credit in point_entry["attribution"])
    assert set(index["publicationProvenance"]) == {
        "boundaryRightsManifestSha256", "boundarySnapshotSha256", "pointManifestSha256",
        "pointRightsManifestSha256",
    }
    assert len(batch.places) == len(ids)
    assert all((point_root / place_id).is_dir() for place_id in (held_id,))

    client = FakeS3()
    result = publisher.publish_to_s3(client, batch, bucket="public-assets", prefix="assets")
    assert result["uploaded"] == 7
    assert all(any(place_id in key for place_id in ids) or key.endswith("index.json") for _, key in client.events)
    point_satellite_key = f"{result['prefix']}/{held_id}/satellite.avif"
    assert client.values[point_satellite_key][0] == (point_root / held_id / "satellite.avif").read_bytes()

    runner = FakeWrangler()
    result = publisher.publish_to_wrangler(batch, bucket="public-assets", prefix="assets", runner=runner)
    assert result["uploaded"] == 7
    assert all(any(place_id in key for place_id in ids) or key.endswith("index.json") for key in runner.values)


@pytest.mark.parametrize("corruption", ["missing-provenance", "missing-place-evidence"])
def test_both_upload_backends_fail_closed_before_writes_for_point_rights_drift(tmp_path, monkeypatch, corruption):
    catalogue, _, ids = make_fixture(tmp_path)
    batch, *_ = gate_dual_fixture(tmp_path, catalogue, ids, monkeypatch, held=(ids[1],))
    if corruption == "missing-provenance":
        provenance = dict(batch.publication_provenance)
        del provenance["pointRightsManifestSha256"]
        batch = replace(batch, publication_provenance=provenance)
    else:
        places = list(batch.places)
        point_index = next(i for i, place in enumerate(places) if place.manifest.get("renderMode") == "point-centered-boundary-free")
        manifest = dict(places[point_index].manifest)
        manifest.pop("pointRights")
        places[point_index] = publisher.Place(
            places[point_index].place_id,
            places[point_index].category,
            places[point_index].name,
            manifest,
            places[point_index].assets,
        )
        batch = replace(batch, places=tuple(places))

    client = FakeS3()
    with pytest.raises(publisher.PublishError, match="point rights"):
        publisher.publish_to_s3(client, batch, bucket="public-assets", prefix="assets")
    assert client.events == []

    runner = FakeWrangler()
    with pytest.raises(publisher.PublishError, match="point rights"):
        publisher.publish_to_wrangler(batch, bucket="public-assets", prefix="assets", runner=runner)
    assert runner.events == []


@pytest.mark.parametrize("mutation,expected", [
    ("snapshot", "point snapshot SHA-256 differs"),
    ("boundary-file", "boundary-related file"),
    ("geometry-key", "forbidden boundary or geometry key"),
    ("polygon-key", "forbidden boundary or geometry key"),
    ("missing-public-hash", "SHA-256 does not match its manifest"),
    ("boundary-rings-in-glb", "forbidden boundary or geometry key"),
    ("bad-licence", "point source identity, licence, or attribution differs"),
    ("source-lock-hash", "source-lock SHA-256 does not match its manifest"),
    ("record-drift", "source lock input record differs"),
])
def test_dual_source_gate_rejects_point_snapshot_and_boundary_contamination(tmp_path, monkeypatch, mutation, expected):
    catalogue, generated, ids = make_fixture(tmp_path)
    held_id = ids[1]
    monkeypatch.setattr(publisher, "CANONICAL_PLACE_COUNT", len(ids))
    rights_path, boundaries_path = make_rights_fixture(tmp_path, catalogue, held=(held_id,))
    point_root, point_manifest = make_point_fixture(tmp_path, catalogue, (held_id,))
    place_root = point_root / held_id
    if mutation == "snapshot":
        point_manifest.write_bytes(point_manifest.read_bytes() + b" ")
    elif mutation == "boundary-file":
        (place_root / "boundary.geojson").write_text("{}", encoding="utf-8")
    elif mutation == "geometry-key":
        (place_root / "terrain.json").write_text(json.dumps({"geometry": {"type": "Polygon"}}), encoding="utf-8")
    elif mutation == "polygon-key":
        (place_root / "terrain.json").write_text(json.dumps({"polygon": []}), encoding="utf-8")
    elif mutation == "missing-public-hash":
        satellite_path = place_root / "satellite.avif"
        satellite_path.write_bytes(b"x" * satellite_path.stat().st_size)
    elif mutation == "boundary-rings-in-glb":
        model_path = place_root / f"{held_id}-terrain.glb"
        model_path.write_bytes(make_glb({
            "asset": {"version": "2.0"},
            "extras": {"boundaryRings": []},
        }))
        manifest_path = place_root / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        model_record = manifest["files"][f"{held_id}-terrain.glb"]
        model_content = model_path.read_bytes()
        model_record.update({"bytes": len(model_content), "sha256": _sha(model_content)})
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        source_lock = place_root / "sources.json"
        manifest["sourceLockSha256"] = publisher.sha256_file(source_lock)
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    elif mutation == "bad-licence":
        manifest_path = place_root / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["pointSource"]["licence"] = ""
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    elif mutation == "source-lock-hash":
        manifest_path = place_root / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["sourceLockSha256"] = "0" * 64
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    elif mutation == "record-drift":
        source_lock_path = place_root / "sources.json"
        sources = json.loads(source_lock_path.read_text(encoding="utf-8"))
        sources["inputRecord"]["sourceId"] = "wrong-record"
        source_bytes = json.dumps(sources, sort_keys=True).encode()
        source_lock_path.write_bytes(source_bytes)
        manifest_path = place_root / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["sourceLockSha256"] = _sha(source_bytes)
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    with pytest.raises(publisher.PublishError, match=expected):
        apply_dual_fixture(
            generated, rights_path, boundaries_path, point_root, point_manifest, catalogue,
        )


@pytest.mark.parametrize("mutation,expected", [
    ("source-epsg", "source lock or manifest UTM EPSG differs"),
    ("manifest-epsg", "source lock or manifest UTM EPSG differs"),
    ("source-bounds", "source lock boundsM are not centered"),
    ("manifest-bounds", "manifest boundsM are not centered"),
    ("wrong-side", "fixed 8 km point frame"),
])
def test_dual_source_gate_recomputes_point_utm_frame(tmp_path, monkeypatch, mutation, expected):
    catalogue, generated, ids = make_fixture(tmp_path)
    held_id = ids[1]
    monkeypatch.setattr(publisher, "CANONICAL_PLACE_COUNT", len(ids))
    rights_path, boundaries_path = make_rights_fixture(tmp_path, catalogue, held=(held_id,))
    point_root, point_manifest = make_point_fixture(tmp_path, catalogue, (held_id,))
    place_root = point_root / held_id
    if mutation in {"source-epsg", "source-bounds", "wrong-side"}:
        source_path = place_root / "sources.json"
        sources = json.loads(source_path.read_text(encoding="utf-8"))
        if mutation == "source-epsg":
            sources["epsg"] += 1
        elif mutation == "source-bounds":
            sources["boundsM"][0] += 10
        else:
            sources["config"]["pointSideM"] = 4000
        source_path.write_text(json.dumps(sources, sort_keys=True), encoding="utf-8")
        manifest_path = place_root / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["sourceLockSha256"] = publisher.sha256_file(source_path)
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    else:
        manifest_path = place_root / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["projectionEpsg"] += 1
        if mutation == "manifest-bounds":
            manifest["projectionEpsg"] -= 1
            manifest["boundsM"][2] -= 10
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    with pytest.raises(publisher.PublishError, match=expected):
        apply_dual_fixture(generated, rights_path, boundaries_path, point_root, point_manifest, catalogue)


@pytest.mark.parametrize("mutation,expected", [
    ("stale-snapshot", "exact point manifest SHA-256"),
    ("missing-id", "exact point-manifest IDs"),
    ("held", "not explicitly approved"),
    ("changed-attribution", "point rights attribution differs"),
    ("missing-terms", "no officialTermsUrl"),
    ("missing-evidence", "no reviewEvidenceUrl"),
    ("non-https", "absolute HTTPS URL"),
])
def test_dual_source_gate_requires_exact_point_rights_decisions(tmp_path, monkeypatch, mutation, expected):
    catalogue, generated, ids = make_fixture(tmp_path)
    held_id = ids[1]
    monkeypatch.setattr(publisher, "CANONICAL_PLACE_COUNT", len(ids))
    boundary_rights, boundaries = make_rights_fixture(tmp_path, catalogue, held=(held_id,))
    point_root, point_manifest = make_point_fixture(tmp_path, catalogue, (held_id,))
    point_rights = make_point_rights_fixture(tmp_path, point_manifest)
    document = json.loads(point_rights.read_text(encoding="utf-8"))
    row = document["places"][held_id]
    if mutation == "stale-snapshot":
        document["pointManifestSha256"] = "0" * 64
    elif mutation == "missing-id":
        del document["places"][held_id]
    elif mutation == "held":
        row["decision"] = "hold"
    elif mutation == "changed-attribution":
        row["attribution"] = "A different credit"
    elif mutation == "missing-terms":
        del row["officialTermsUrl"]
    elif mutation == "missing-evidence":
        del row["reviewEvidenceUrl"]
    elif mutation == "non-https":
        row["reviewEvidenceUrl"] = "http://example.test/evidence"
    point_rights.write_text(json.dumps(document), encoding="utf-8")
    with pytest.raises(publisher.PublishError, match=expected):
        publisher.apply_dual_source_gate(
            generated, boundary_rights, boundaries, point_root, point_manifest, point_rights, catalogue,
        )


def test_dual_source_gate_rejects_all_rights_reserved_point_source(tmp_path, monkeypatch):
    catalogue, generated, ids = make_fixture(tmp_path)
    held_id = ids[1]
    monkeypatch.setattr(publisher, "CANONICAL_PLACE_COUNT", len(ids))
    boundary_rights, boundaries = make_rights_fixture(tmp_path, catalogue, held=(held_id,))
    point_root, point_manifest = make_point_fixture(tmp_path, catalogue, (held_id,))
    records = json.loads(point_manifest.read_text(encoding="utf-8"))
    records[0]["licence"] = "All rights reserved"
    point_manifest.write_text(json.dumps(records), encoding="utf-8")
    point_rights = make_point_rights_fixture(tmp_path, point_manifest)
    with pytest.raises(publisher.PublishError, match="explicitly withholds public redistribution"):
        publisher.apply_dual_source_gate(
            generated, boundary_rights, boundaries, point_root, point_manifest, point_rights, catalogue,
        )


def test_dual_source_gate_rejects_overlapping_point_ids_and_directories(tmp_path, monkeypatch):
    catalogue, generated, ids = make_fixture(tmp_path)
    held_id = ids[1]
    monkeypatch.setattr(publisher, "CANONICAL_PLACE_COUNT", len(ids))
    rights_path, boundaries_path = make_rights_fixture(tmp_path, catalogue, held=(held_id,))
    point_root, point_manifest = make_point_fixture(tmp_path, catalogue, (held_id,))
    (point_root / ids[0]).mkdir()
    with pytest.raises(publisher.PublishError, match="directories must exactly match"):
        apply_dual_fixture(
            generated, rights_path, boundaries_path, point_root, point_manifest, catalogue,
        )


def test_dual_source_gate_requires_points_for_held_ids_only(tmp_path, monkeypatch):
    catalogue, generated, ids = make_fixture(tmp_path)
    held_id, approved_id = ids[1], ids[0]
    monkeypatch.setattr(publisher, "CANONICAL_PLACE_COUNT", len(ids))
    rights_path, boundaries_path = make_rights_fixture(tmp_path, catalogue, held=(held_id,))
    point_root, point_manifest = make_point_fixture(tmp_path, catalogue, (held_id,))
    record = json.loads(point_manifest.read_text(encoding="utf-8"))[0]
    approved = next(row for row in json.loads(catalogue.read_text(encoding="utf-8")) if row["id"] == approved_id)
    record.update({"id": approved_id, "name": approved["name"], "category": approved["category"]})
    point_manifest.write_text(json.dumps([record]), encoding="utf-8")
    with pytest.raises(publisher.PublishError, match="must exactly match held places"):
        apply_dual_fixture(
            generated, rights_path, boundaries_path, point_root, point_manifest, catalogue,
        )


def test_unapproved_polygon_output_is_never_opened_by_dual_source_cli(tmp_path, monkeypatch):
    catalogue, generated, ids = make_fixture(tmp_path)
    held_id = ids[1]
    (generated / held_id / "manifest.json").write_text("not json", encoding="utf-8")
    rights_path, boundaries_path = make_rights_fixture(tmp_path, catalogue, held=(held_id,))
    point_root, point_manifest = make_point_fixture(tmp_path, catalogue, (held_id,))
    point_rights = make_point_rights_fixture(tmp_path, point_manifest)
    monkeypatch.setattr(publisher, "CANONICAL_PLACE_COUNT", len(ids))
    result = publisher.main([
        "--generated", str(generated), "--catalogue", str(catalogue),
        "--rights-manifest", str(rights_path), "--boundaries", str(boundaries_path),
        "--point-generated", str(point_root), "--point-manifest", str(point_manifest),
        "--point-rights-manifest", str(point_rights), "--dry-run",
    ])
    assert result == 0
    assert publisher.main([
        "--generated", str(generated), "--catalogue", str(catalogue),
        "--rights-manifest", str(rights_path), "--boundaries", str(boundaries_path),
        "--point-generated", str(point_root), "--point-manifest", str(point_manifest), "--dry-run",
    ]) == 2


@pytest.mark.parametrize("mutation,expected", [
    ("snapshot", "snapshot SHA-256"),
    ("missing-decision", "decisions do not match"),
    ("changed-source", "boundary sourceId differs"),
    ("missing-reason", "held boundary has no reason"),
    ("missing-attribution", "approved boundary has no rights attribution"),
    ("unknown-status", "decision must be approved or hold"),
])
def test_rights_gate_fails_closed_on_snapshot_and_decision_drift(tmp_path, monkeypatch, mutation, expected):
    catalogue, generated, ids = make_fixture(tmp_path)
    batch = publisher.validate_batch(generated, catalogue)
    monkeypatch.setattr(publisher, "CANONICAL_PLACE_COUNT", 2)
    rights_path, boundaries_path = make_rights_fixture(tmp_path, catalogue, held=(ids[1],))
    rights = json.loads(rights_path.read_text(encoding="utf-8"))
    if mutation == "snapshot":
        boundaries_path.write_text(boundaries_path.read_text(encoding="utf-8") + "\n", encoding="utf-8")
    elif mutation == "missing-decision":
        del rights["places"][ids[0]]
    elif mutation == "changed-source":
        rights["places"][ids[0]]["sourceId"] = "new-object"
    elif mutation == "missing-reason":
        del rights["places"][ids[1]]["reason"]
    elif mutation == "missing-attribution":
        del rights["places"][ids[0]]["rightsAttribution"]
    elif mutation == "unknown-status":
        rights["places"][ids[0]]["decision"] = "allow"
    rights_path.write_text(json.dumps(rights), encoding="utf-8")
    with pytest.raises(publisher.PublishError, match=expected):
        publisher.apply_rights_gate(batch, rights_path, boundaries_path)


def test_rights_gate_rejects_generated_source_drift_before_upload(tmp_path, monkeypatch):
    catalogue, generated, ids = make_fixture(tmp_path)
    rights_path, boundaries_path = make_rights_fixture(tmp_path, catalogue)
    manifest_path = generated / ids[0] / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["boundarySourceId"] = "other-object"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    monkeypatch.setattr(publisher, "CANONICAL_PLACE_COUNT", 2)
    batch = publisher.validate_batch(generated, catalogue)
    with pytest.raises(publisher.PublishError, match="boundary sourceId differs"):
        publisher.apply_rights_gate(batch, rights_path, boundaries_path)


@pytest.mark.parametrize("gate", ["rights", "dual-source"])
def test_publication_gates_reject_locked_boundary_geometry_drift(tmp_path, monkeypatch, gate):
    catalogue, generated, ids = make_fixture(tmp_path)
    held = (ids[1],) if gate == "dual-source" else ()
    rights_path, boundaries_path = make_rights_fixture(tmp_path, catalogue, held=held)
    source_path = generated / ids[0] / "sources.json"
    sources = json.loads(source_path.read_text(encoding="utf-8"))
    sources["boundary"]["features"][0]["geometry"] = {
        "type": "Polygon",
        "coordinates": [[[0, 0], [1, 0], [0, 1], [0, 0]]],
    }
    source_path.write_text(json.dumps(sources), encoding="utf-8")
    manifest_path = generated / ids[0] / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["sourceLockSha256"] = publisher.sha256_file(source_path)
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    monkeypatch.setattr(publisher, "CANONICAL_PLACE_COUNT", len(ids))

    if gate == "rights":
        batch = publisher.validate_batch(generated, catalogue)
        with pytest.raises(publisher.PublishError, match="source lock boundary feature differs"):
            publisher.apply_rights_gate(batch, rights_path, boundaries_path)
    else:
        point_root, point_manifest = make_point_fixture(tmp_path, catalogue, held)
        with pytest.raises(publisher.PublishError, match="source lock boundary feature differs"):
            apply_dual_fixture(
                generated, rights_path, boundaries_path, point_root, point_manifest, catalogue,
            )


def test_rights_gate_rejects_source_lock_boundary_drift_even_with_valid_hash(tmp_path, monkeypatch):
    catalogue, generated, ids = make_fixture(tmp_path)
    rights_path, boundaries_path = make_rights_fixture(tmp_path, catalogue)
    sources_path = generated / ids[0] / "sources.json"
    sources = json.loads(sources_path.read_text(encoding="utf-8"))
    sources["boundary"]["features"][0]["properties"]["sourceId"] = "other-object"
    sources_path.write_text(json.dumps(sources), encoding="utf-8")
    manifest_path = generated / ids[0] / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["sourceLockSha256"] = publisher.sha256_file(sources_path)
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    monkeypatch.setattr(publisher, "CANONICAL_PLACE_COUNT", 2)
    batch = publisher.validate_batch(generated, catalogue)
    with pytest.raises(publisher.PublishError, match="source lock boundary feature differs"):
        publisher.apply_rights_gate(batch, rights_path, boundaries_path)


def test_rights_gate_rejects_duplicate_decision_keys(tmp_path, monkeypatch):
    catalogue, generated, ids = make_fixture(tmp_path)
    rights_path, boundaries_path = make_rights_fixture(tmp_path, catalogue)
    rights = json.loads(rights_path.read_text(encoding="utf-8"))
    duplicate = json.dumps(rights["places"][ids[0]])
    content = rights_path.read_text(encoding="utf-8")
    content = content.replace('"places": {', f'"places": {{"{ids[0]}": {duplicate}, ', 1)
    rights_path.write_text(content, encoding="utf-8")
    monkeypatch.setattr(publisher, "CANONICAL_PLACE_COUNT", 2)
    batch = publisher.validate_batch(generated, catalogue)
    with pytest.raises(publisher.PublishError, match="duplicate JSON keys"):
        publisher.apply_rights_gate(batch, rights_path, boundaries_path)


def test_held_place_asset_failure_still_stops_all_public_upload(tmp_path, monkeypatch):
    catalogue, generated, ids = make_fixture(tmp_path)
    rights_path, boundaries_path = make_rights_fixture(tmp_path, catalogue, held=(ids[1],))
    (generated / ids[1] / "relief.avif").unlink()
    monkeypatch.setattr(publisher, "CANONICAL_PLACE_COUNT", 2)
    monkeypatch.setenv("PARKDEX_VISUAL_ASSETS_WRANGLER_BUCKET", "parkdex-visual-assets")
    runner = FakeWrangler()
    monkeypatch.setattr(publisher, "WranglerRunner", lambda **kwargs: runner)

    assert publisher.main([
        "--generated", str(generated), "--catalogue", str(catalogue),
        "--rights-manifest", str(rights_path), "--boundaries", str(boundaries_path),
        "--upload-wrangler",
    ]) == 2
    assert runner.values == {}


def test_frozen_rights_manifest_tracks_audit_and_current_provider_credits():
    rights = json.loads((publisher.ROOT / "data/visual-boundary-rights-20260924.json").read_text(encoding="utf-8"))
    audit_path = publisher.ROOT / "data/visual-boundary-rights-audit-20260924.json"
    audit = json.loads(audit_path.read_text(encoding="utf-8"))
    decisions = rights["places"]
    assert rights["version"] == 1
    assert rights["rightsAuditSha256"] == publisher.sha256_file(audit_path)
    assert rights["boundarySnapshotSha256"] == audit["sourceSnapshot"]["sha256"]
    assert rights["regionalImportSha256"] == audit["sourceEvidenceSnapshot"]["sha256"]
    assert len(decisions) == 1030
    assert sum(row["decision"] == "approved" for row in decisions.values()) == 812
    assert sum(row["decision"] == "hold" for row in decisions.values()) == 218
    assert all(row.get("rightsAttribution") for row in decisions.values() if row["decision"] == "approved")
    for row in audit["provisionalApprovedAggregateOgl"]:
        decision = decisions[row["id"]]
        assert decision["decision"] == "approved"
        assert decision["rightsAttribution"] == [row["rightsAttribution"]]
        assert decision["frozenSourceLicenceComment"] == row["sourceRecordLicenceCommentsExact"]

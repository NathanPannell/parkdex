import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
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
            "boundary": {"features": [{"properties": {
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
    with pytest.raises(publisher.PublishError, match="boundary sourceId differs"):
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

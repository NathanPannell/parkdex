#!/usr/bin/env python3
"""Validate, stage, or publish the generated Parkdex visual asset batch."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import shutil
import sys
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path, PurePosixPath
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
CANONICAL_PLACE_COUNT = 1030
ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]*$")
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
PUBLIC_FILENAMES = ("satellite.avif", "relief.avif")
CONTENT_TYPES = {
    "satellite.avif": "image/avif",
    "relief.avif": "image/avif",
}


class PublishError(Exception):
    """A safe-to-display validation or publishing error."""


@dataclass(frozen=True)
class Place:
    place_id: str
    category: str
    name: str
    manifest: dict[str, Any]
    assets: tuple["Asset", ...]


@dataclass(frozen=True)
class Asset:
    place_id: str
    filename: str
    path: Path
    size: int
    sha256: str

    @property
    def key(self) -> str:
        return f"{self.place_id}/{self.filename}"

    @property
    def content_type(self) -> str:
        return CONTENT_TYPES.get(self.filename, "model/gltf-binary")


@dataclass(frozen=True)
class ValidatedBatch:
    places: tuple[Place, ...]
    index_bytes: bytes
    index_sha256: str
    asset_bytes: int


def sha256_bytes(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _load_json(path: Path, description: str) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise PublishError(f"Missing {description}: {path}") from exc
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise PublishError(f"Could not read {description}: {path}") from exc


def load_catalogue(path: Path) -> dict[str, dict[str, str]]:
    payload = _load_json(path, "place catalogue")
    if not isinstance(payload, list) or not payload:
        raise PublishError("The place catalogue must be a non-empty JSON array")

    catalogue: dict[str, dict[str, str]] = {}
    for position, record in enumerate(payload):
        if not isinstance(record, dict):
            raise PublishError(f"Catalogue row {position + 1} is not an object")
        place_id = record.get("id")
        category = record.get("category")
        name = record.get("name")
        if not isinstance(place_id, str) or not ID_PATTERN.fullmatch(place_id):
            raise PublishError(f"Catalogue row {position + 1} has an invalid place ID")
        if place_id in catalogue:
            raise PublishError(f"The place catalogue repeats ID {place_id}")
        if not isinstance(category, str) or not category:
            raise PublishError(f"Catalogue place {place_id} has no category")
        if not isinstance(name, str) or not name:
            raise PublishError(f"Catalogue place {place_id} has no name")
        catalogue[place_id] = {"category": category, "name": name}
    return catalogue


def _validate_manifest_asset(
    generated_root: Path,
    place_id: str,
    manifest: dict[str, Any],
    filename: str,
) -> Asset:
    files = manifest.get("files")
    if not isinstance(files, dict):
        raise PublishError("manifest has no files object")
    record = files.get(filename)
    if not isinstance(record, dict):
        raise PublishError(f"manifest has no integrity record for {filename}")

    size = record.get("bytes")
    expected_hash = record.get("sha256")
    if isinstance(size, bool) or not isinstance(size, int) or size < 1:
        raise PublishError(f"manifest has an invalid byte count for {filename}")
    if not isinstance(expected_hash, str) or not SHA256_PATTERN.fullmatch(expected_hash):
        raise PublishError(f"manifest has an invalid SHA-256 for {filename}")

    path = generated_root / place_id / filename
    try:
        resolved_root = generated_root.resolve(strict=True)
        resolved_path = path.resolve(strict=True)
        if not resolved_path.is_relative_to(resolved_root):
            raise PublishError(f"{filename} resolves outside the generated directory")
        if not resolved_path.is_file():
            raise PublishError(f"{filename} is not a regular file")
        actual_size = resolved_path.stat().st_size
    except FileNotFoundError as exc:
        raise PublishError(f"Missing public asset {filename}") from exc
    except OSError as exc:
        raise PublishError(f"Could not inspect public asset {filename}") from exc

    if actual_size != size:
        raise PublishError(f"{filename} size does not match its manifest")
    actual_hash = sha256_file(resolved_path)
    if actual_hash != expected_hash:
        raise PublishError(f"{filename} SHA-256 does not match its manifest")
    return Asset(place_id, filename, resolved_path, size, actual_hash)


def _validate_source_lock(place_id: str, place_root: Path, manifest: dict[str, Any]) -> None:
    if "sourceLockSha256" not in manifest:
        return
    expected_hash = manifest["sourceLockSha256"]
    if not isinstance(expected_hash, str) or not SHA256_PATTERN.fullmatch(expected_hash):
        raise PublishError(f"{place_id}: manifest has an invalid source-lock SHA-256")
    source_lock = place_root / "sources.json"
    try:
        if not source_lock.is_file():
            raise PublishError(f"{place_id}: source-lock file is missing")
        resolved = source_lock.resolve(strict=True)
        if not resolved.is_relative_to(place_root.resolve(strict=True)):
            raise PublishError(f"{place_id}: source-lock file resolves outside its place directory")
        actual_hash = sha256_file(resolved)
    except OSError as exc:
        raise PublishError(f"{place_id}: could not read source-lock file") from exc
    if actual_hash != expected_hash:
        raise PublishError(f"{place_id}: source-lock SHA-256 does not match its manifest")


def _manifest_text_list(manifest: dict[str, Any], field: str, place_id: str) -> list[str]:
    value = manifest.get(field)
    if not isinstance(value, list) or any(not isinstance(item, str) or not item.strip() for item in value):
        raise PublishError(f"{place_id}: manifest has an invalid {field} list")
    return list(value)


def _infer_review_flags(manifest: dict[str, Any]) -> list[str]:
    """Reconstruct review reasons for older manifests that stored only needsReview."""
    flags: list[str] = []

    if manifest.get("boundaryGeometryValid") is False:
        flags.append("boundary-topology-repaired-for-analysis")

    dem_fraction = manifest.get("demFilledFraction")
    if not isinstance(dem_fraction, bool) and isinstance(dem_fraction, (int, float)):
        if math.isfinite(dem_fraction) and dem_fraction > 0.05:
            flags.append("dem-no-data-fill-over-5-percent")

    quality = manifest.get("sceneQuality")
    if not isinstance(quality, list) or not quality:
        flags.append("sentinel-scl-quality-unavailable")
    else:
        if any(not isinstance(scene, dict) or scene.get("status") != "ok" for scene in quality):
            flags.append("sentinel-scl-quality-unavailable")
        if any(
            not isinstance(scene, dict)
            or not isinstance(scene.get("cloudShadowFraction", 1), (int, float))
            or scene.get("cloudShadowFraction", 1) > 0.1
            for scene in quality
        ):
            flags.append("sentinel-cloud-or-shadow-over-10-percent")
        if any(
            not isinstance(scene, dict)
            or not isinstance(scene.get("snowFraction", 1), (int, float))
            or scene.get("snowFraction", 1) > 0.2
            for scene in quality
        ):
            flags.append("sentinel-snow-over-20-percent")

    acquired = manifest.get("acquired")
    dates = {
        value[:10]
        for value in acquired
        if isinstance(value, str) and len(value) >= 10
    } if isinstance(acquired, list) else set()
    if len(dates) > 1:
        flags.append("sentinel-scenes-mix-acquisition-dates")

    fallback_ids = manifest.get("fallbackSceneIds")
    if isinstance(fallback_ids, list) and fallback_ids:
        flags.append("satellite-fallback-filled-no-data")

    return flags


def _normalize_review_flags(manifest: dict[str, Any], place_id: str) -> dict[str, Any]:
    needs_review = manifest.get("needsReview")
    raw_flags = manifest.get("reviewFlags")
    if raw_flags is not None:
        explicit_flags = _manifest_text_list(manifest, "reviewFlags", place_id)
    else:
        explicit_flags = []

    if needs_review is False:
        if explicit_flags:
            raise PublishError("manifest has review flags while needsReview is false")
        flags: list[str] = []
    elif explicit_flags:
        # Newer batch runs may have an explicit curated list. Keep it unchanged.
        flags = explicit_flags
    else:
        flags = _infer_review_flags(manifest)
        if not flags:
            flags = ["batch-review-required"]

    return {**manifest, "reviewFlags": flags}


def _build_index(places: tuple[Place, ...]) -> bytes:
    entries: dict[str, dict[str, Any]] = {}
    for place in places:
        asset_records = {asset.filename: asset for asset in place.assets}
        manifest = place.manifest
        entries[place.place_id] = {
            "satellite": f"{place.place_id}/satellite.avif",
            "relief": f"{place.place_id}/relief.avif",
            "model": f"{place.place_id}/{place.place_id}-terrain.glb",
            "attribution": _manifest_text_list(manifest, "attribution", place.place_id),
            "acquired": _manifest_text_list(manifest, "acquired", place.place_id),
            "needsReview": manifest.get("needsReview"),
            "reviewFlags": _manifest_text_list(manifest, "reviewFlags", place.place_id),
            # These extra integrity fields bind the versioned prefix to every public byte.
            "assetSha256": {name: asset_records[name].sha256 for name in sorted(asset_records)},
            "assetBytes": {name: asset_records[name].size for name in sorted(asset_records)},
        }
    index = {"version": 1, "places": entries}
    return (json.dumps(index, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")


def validate_batch(
    generated_root: Path,
    catalogue_path: Path,
    *,
    requested_ids: tuple[str, ...] | None = None,
    require_exact_directories: bool = False,
) -> ValidatedBatch:
    generated_root = generated_root.resolve()
    if not generated_root.is_dir():
        raise PublishError(f"Generated directory does not exist: {generated_root}")
    catalogue = load_catalogue(catalogue_path)

    if requested_ids is None:
        selected_ids = tuple(sorted(catalogue))
    else:
        if len(set(requested_ids)) != len(requested_ids):
            raise PublishError("The requested place IDs contain duplicates")
        unknown = sorted(set(requested_ids) - set(catalogue))
        if unknown:
            raise PublishError(f"Requested IDs are absent from the catalogue: {', '.join(unknown[:10])}")
        selected_ids = tuple(sorted(requested_ids))
        if not selected_ids:
            raise PublishError("At least one place ID must be selected")

    issues: list[str] = []
    if require_exact_directories:
        try:
            found_directories = {
                child.name for child in generated_root.iterdir() if child.is_dir()
            }
        except OSError as exc:
            raise PublishError("Could not list the generated directory") from exc
        unexpected = sorted(found_directories - set(catalogue))
        if unexpected:
            issues.append(f"unexpected place directories ({len(unexpected)}): {', '.join(unexpected[:8])}")

    validated: list[Place] = []
    for place_id in selected_ids:
        place_root = generated_root / place_id
        if not place_root.is_dir():
            issues.append(f"{place_id}: place directory is missing")
            continue
        manifest_path = place_root / "manifest.json"
        try:
            manifest = _load_json(manifest_path, "place manifest")
            if not isinstance(manifest, dict):
                raise PublishError("manifest root is not an object")
            if manifest.get("placeId") != place_id:
                raise PublishError("manifest placeId does not match the canonical catalogue ID")
            expected = catalogue[place_id]
            if manifest.get("category") != expected["category"]:
                raise PublishError("manifest category does not match the canonical catalogue category")
            if manifest.get("park") != expected["name"]:
                raise PublishError("manifest place name does not match the canonical catalogue name")
            if not isinstance(manifest.get("needsReview"), bool):
                raise PublishError("manifest needsReview must be a boolean")
            manifest = _normalize_review_flags(manifest, place_id)

            _manifest_text_list(manifest, "attribution", place_id)
            _manifest_text_list(manifest, "acquired", place_id)
            _validate_source_lock(place_id, place_root, manifest)

            filenames = (*PUBLIC_FILENAMES, f"{place_id}-terrain.glb")
            assets_found: list[Asset] = []
            asset_issues: list[str] = []
            for filename in filenames:
                try:
                    assets_found.append(
                        _validate_manifest_asset(generated_root, place_id, manifest, filename)
                    )
                except PublishError as exc:
                    asset_issues.append(str(exc))
            if asset_issues:
                raise PublishError(", ".join(asset_issues))
            assets = tuple(assets_found)
            validated.append(Place(place_id, expected["category"], expected["name"], manifest, assets))
        except PublishError as exc:
            issues.append(f"{place_id}: {exc}")

    if issues:
        details = "; ".join(issues[:20])
        if len(issues) > 20:
            details += f"; and {len(issues) - 20} more issue(s)"
        raise PublishError(details)

    places = tuple(validated)
    index_bytes = _build_index(places)
    assets_total = sum(asset.size for place in places for asset in place.assets)
    return ValidatedBatch(places, index_bytes, sha256_bytes(index_bytes), assets_total)


def summarize(batch: ValidatedBatch) -> dict[str, Any]:
    review_places = {
        place.place_id: list(place.manifest["reviewFlags"])
        for place in batch.places
        if place.manifest["needsReview"]
    }
    flag_counts: dict[str, int] = {}
    for flags in review_places.values():
        for flag in flags:
            flag_counts[flag] = flag_counts.get(flag, 0) + 1
    category_counts: dict[str, int] = {}
    for place in batch.places:
        category_counts[place.category] = category_counts.get(place.category, 0) + 1
    return {
        "placeCount": len(batch.places),
        "categoryCounts": dict(sorted(category_counts.items())),
        "assetCount": sum(len(place.assets) for place in batch.places),
        "assetBytes": batch.asset_bytes,
        "indexBytes": len(batch.index_bytes),
        "totalBytes": batch.asset_bytes + len(batch.index_bytes),
        "indexSha256": batch.index_sha256,
        "needsReviewCount": len(review_places),
        "reviewFlagCounts": dict(sorted(flag_counts.items())),
        "reviewPlaces": review_places,
    }


def stage_subset(batch: ValidatedBatch, stage_directory: Path, generated_root: Path) -> None:
    stage_directory = stage_directory.resolve()
    generated_root = generated_root.resolve()
    if stage_directory == generated_root or stage_directory in generated_root.parents or generated_root in stage_directory.parents:
        raise PublishError("The staging directory must be separate from the generated directory")
    if stage_directory.exists():
        if not stage_directory.is_dir() or any(stage_directory.iterdir()):
            raise PublishError("The staging directory must be absent or empty")
    else:
        stage_directory.mkdir(parents=True)

    for place in batch.places:
        target_directory = stage_directory / place.place_id
        target_directory.mkdir()
        for asset in place.assets:
            shutil.copyfile(asset.path, target_directory / asset.filename)
    (stage_directory / "index.json").write_bytes(batch.index_bytes)


def _is_missing_object(exc: Exception) -> bool:
    response = getattr(exc, "response", None)
    if not isinstance(response, dict):
        return False
    error = response.get("Error")
    status = response.get("ResponseMetadata")
    code = error.get("Code") if isinstance(error, dict) else None
    http_status = status.get("HTTPStatusCode") if isinstance(status, dict) else None
    return code in {"404", "NoSuchKey", "NotFound"} or http_status == 404


def _existing_object_hash(client: Any, bucket: str, key: str, expected_size: int) -> str | None:
    try:
        head = client.head_object(Bucket=bucket, Key=key)
    except Exception as exc:
        if _is_missing_object(exc):
            return None
        raise

    metadata = head.get("Metadata", {})
    recorded_hash = metadata.get("sha256") or metadata.get("SHA256")
    content_length = head.get("ContentLength")
    if isinstance(recorded_hash, str):
        if content_length != expected_size:
            return "<conflict>"
        return recorded_hash.lower()

    try:
        response = client.get_object(Bucket=bucket, Key=key)
        body = response["Body"]
        try:
            content = body.read()
        finally:
            close = getattr(body, "close", None)
            if callable(close):
                close()
    except Exception:
        raise
    return sha256_bytes(content)


def _ensure_s3_object(
    client: Any,
    bucket: str,
    key: str,
    *,
    expected_size: int,
    expected_sha256: str,
    content_type: str,
    body_factory,
) -> bool:
    existing_hash = _existing_object_hash(client, bucket, key, expected_size)
    if existing_hash is not None:
        if existing_hash != expected_sha256:
            raise PublishError(f"Immutable object key has conflicting bytes: {key}")
        return False

    body_context = body_factory()
    with body_context as body:
        client.put_object(
            Bucket=bucket,
            Key=key,
            Body=body,
            ContentLength=expected_size,
            ContentType=content_type,
            CacheControl="public, max-age=31536000, immutable",
            Metadata={"sha256": expected_sha256},
        )
    return True


def normalize_key_prefix(prefix: str) -> str:
    path = PurePosixPath(prefix.strip("/"))
    if not prefix or path.is_absolute() or not path.parts or any(
        part in {"", ".", ".."} or not re.fullmatch(r"[A-Za-z0-9._-]+", part)
        for part in path.parts
    ):
        raise PublishError("S3 key prefix must contain only safe path segments")
    return str(path)


def publish_to_s3(
    client: Any,
    batch: ValidatedBatch,
    *,
    bucket: str,
    prefix: str,
) -> dict[str, int | str]:
    prefix = normalize_key_prefix(prefix)
    versioned_prefix = f"{prefix}/{batch.index_sha256}"
    uploaded = 0
    skipped = 0

    for place in batch.places:
        for asset in place.assets:
            key = f"{versioned_prefix}/{asset.key}"
            did_upload = _ensure_s3_object(
                client,
                bucket,
                key,
                expected_size=asset.size,
                expected_sha256=asset.sha256,
                content_type=asset.content_type,
                body_factory=lambda asset=asset: asset.path.open("rb"),
            )
            uploaded += int(did_upload)
            skipped += int(not did_upload)

    index_key = f"{versioned_prefix}/index.json"
    did_upload_index = _ensure_s3_object(
        client,
        bucket,
        index_key,
        expected_size=len(batch.index_bytes),
        expected_sha256=batch.index_sha256,
        content_type="application/json; charset=utf-8",
        body_factory=lambda: BytesIO(batch.index_bytes),
    )
    uploaded += int(did_upload_index)
    skipped += int(not did_upload_index)
    return {
        "prefix": versioned_prefix,
        "indexKey": index_key,
        "uploaded": uploaded,
        "skipped": skipped,
    }


def _s3_client_from_environment() -> tuple[Any, str, str]:
    names = {
        "endpoint": "PARKDEX_VISUAL_ASSETS_S3_ENDPOINT",
        "bucket": "PARKDEX_VISUAL_ASSETS_S3_BUCKET",
        "access_key": "PARKDEX_VISUAL_ASSETS_S3_ACCESS_KEY_ID",
        "secret_key": "PARKDEX_VISUAL_ASSETS_S3_SECRET_ACCESS_KEY",
    }
    values = {key: os.environ.get(name, "").strip() for key, name in names.items()}
    missing = [name for key, name in names.items() if not values[key]]
    if missing:
        raise PublishError(f"Upload is missing required task-specific environment variables: {', '.join(missing)}")
    if values["bucket"] == os.environ.get("R2_BUCKET", "").strip():
        raise PublishError("The public visual-assets bucket must be separate from the private postcard bucket")
    prefix = os.environ.get("PARKDEX_VISUAL_ASSETS_S3_PREFIX", "parkdex/visual-assets/v1").strip()
    prefix = normalize_key_prefix(prefix)

    try:
        import boto3
        from botocore.config import Config
    except ImportError as exc:
        raise PublishError("Upload mode requires boto3; install it with `python -m pip install boto3`") from exc

    client = boto3.client(
        "s3",
        endpoint_url=values["endpoint"],
        aws_access_key_id=values["access_key"],
        aws_secret_access_key=values["secret_key"],
        region_name=os.environ.get("PARKDEX_VISUAL_ASSETS_S3_REGION", "auto").strip() or "auto",
        config=Config(signature_version="s3v4", s3={"addressing_style": "path"}),
    )
    return client, values["bucket"], prefix


def parse_ids(value: str | None) -> tuple[str, ...] | None:
    if value is None:
        return None
    ids = tuple(item.strip() for item in value.split(",") if item.strip())
    if not ids:
        raise PublishError("--ids must contain at least one comma-separated place ID")
    if len(set(ids)) != len(ids):
        raise PublishError("--ids contains duplicates")
    return ids


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--generated", type=Path, required=True, help="Directory written by batch_parks.py")
    parser.add_argument(
        "--catalogue",
        type=Path,
        default=ROOT / "data" / "places.json",
        help="Canonical Parkdex place catalogue (default: data/places.json)",
    )
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument("--dry-run", action="store_true", help="Validate and print a report without writing")
    modes.add_argument("--stage-dir", type=Path, help="Copy a selected subset into an empty local fixture directory")
    modes.add_argument("--upload", action="store_true", help="Upload all 1,030 validated places to the configured public bucket")
    parser.add_argument("--ids", help="Comma-separated IDs for dry-run or local staging only")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        requested_ids = parse_ids(args.ids)
        if args.upload and requested_ids is not None:
            raise PublishError("Upload mode always publishes the complete 1,030-place catalogue; --ids is not allowed")
        if args.stage_dir is not None and requested_ids is None:
            raise PublishError("Local staging requires an explicit --ids subset")

        batch = validate_batch(
            args.generated,
            args.catalogue,
            requested_ids=requested_ids,
            require_exact_directories=requested_ids is None,
        )
        report: dict[str, Any] = summarize(batch)

        if args.dry_run:
            report["status"] = "validated"
        elif args.stage_dir is not None:
            stage_subset(batch, args.stage_dir, args.generated)
            report["status"] = "staged"
            report["stageDirectory"] = str(args.stage_dir.resolve())
        else:
            catalogue = load_catalogue(args.catalogue)
            if len(catalogue) != CANONICAL_PLACE_COUNT or len(batch.places) != CANONICAL_PLACE_COUNT:
                raise PublishError(
                    f"Upload requires exactly {CANONICAL_PLACE_COUNT} canonical places; found {len(catalogue)}"
                )
            client, bucket, prefix = _s3_client_from_environment()
            report.update(publish_to_s3(client, batch, bucket=bucket, prefix=prefix))
            report["status"] = "uploaded"

        print(json.dumps(report, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
        return 0
    except PublishError as exc:
        print(json.dumps({"status": "error", "error": str(exc)}, ensure_ascii=False, separators=(",", ":")), file=sys.stderr)
        return 2
    except Exception as exc:
        # SDK exceptions can contain endpoint and request details. Keep logs secret-safe.
        print(json.dumps({"status": "error", "errorType": type(exc).__name__}, separators=(",", ":")), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

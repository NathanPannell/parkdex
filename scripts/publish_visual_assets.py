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
import subprocess
import sys
import struct
import tempfile
import threading
import time
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path, PurePosixPath
from typing import Any, Callable
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parents[1]
CANONICAL_PLACE_COUNT = 1030
ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]*$")
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
PUBLIC_FILENAMES = ("satellite.avif", "relief.avif")
CDEM_LEGACY_ATTRIBUTION = "Elevation: Natural Resources Canada CDEM, Open Government Licence, Canada"
CDEM_PUBLIC_ATTRIBUTION = (
    "Elevation: Natural Resources Canada CDEM. Contains information licensed under the "
    "Open Government Licence – Canada. https://open.canada.ca/en/open-government-licence-canada"
)
CONTENT_TYPES = {
    "satellite.avif": "image/avif",
    "relief.avif": "image/avif",
}
IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable"
WRANGLER_VERSION = "4.139.0"
WRANGLER_MISSING_MESSAGE = "The specified key does not exist."


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
    rights_manifest_sha256: str | None = None
    validated_place_count: int | None = None
    held_place_ids: tuple[str, ...] = ()
    publication_provenance: dict[str, str] | None = None


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


def _load_json_unique(path: Path, description: str) -> Any:
    def unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        value: dict[str, Any] = {}
        for key, item in pairs:
            if key in value:
                raise PublishError(f"{description} contains duplicate JSON keys")
            value[key] = item
        return value

    try:
        return json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=unique_object)
    except FileNotFoundError as exc:
        raise PublishError(f"Missing {description}: {path}") from exc
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise PublishError(f"Could not read {description}: {path}") from exc


def _load_rights_manifest(path: Path) -> Any:
    def unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        value: dict[str, Any] = {}
        for key, item in pairs:
            if key in value:
                raise PublishError("Boundary rights manifest contains duplicate JSON keys")
            value[key] = item
        return value

    try:
        return json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=unique_object)
    except FileNotFoundError as exc:
        raise PublishError(f"Missing boundary rights manifest: {path}") from exc
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise PublishError(f"Could not read boundary rights manifest: {path}") from exc


def _load_point_manifest(path: Path) -> tuple[Any, str]:
    try:
        content = path.read_bytes()
    except FileNotFoundError as exc:
        raise PublishError(f"Missing independent point manifest: {path}") from exc
    except OSError as exc:
        raise PublishError(f"Could not read independent point manifest: {path}") from exc

    def unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        value: dict[str, Any] = {}
        for key, item in pairs:
            if key in value:
                raise PublishError("Independent point manifest contains duplicate JSON keys")
            value[key] = item
        return value

    try:
        records = json.loads(content.decode("utf-8"), object_pairs_hook=unique_object)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise PublishError(f"Could not read independent point manifest: {path}") from exc
    return records, sha256_bytes(content)


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


def _build_index(
    places: tuple[Place, ...],
    publication_provenance: dict[str, str] | None = None,
) -> bytes:
    entries: dict[str, dict[str, Any]] = {}
    for place in places:
        asset_records = {asset.filename: asset for asset in place.assets}
        manifest = place.manifest
        attribution = _manifest_text_list(manifest, "attribution", place.place_id)
        if CDEM_LEGACY_ATTRIBUTION in attribution:
            attribution = [
                CDEM_PUBLIC_ATTRIBUTION if item == CDEM_LEGACY_ATTRIBUTION else item
                for item in attribution
            ]
        entries[place.place_id] = {
            "satellite": f"{place.place_id}/satellite.avif",
            "relief": f"{place.place_id}/relief.avif",
            "model": f"{place.place_id}/{place.place_id}-terrain.glb",
            "attribution": attribution,
            "acquired": _manifest_text_list(manifest, "acquired", place.place_id),
            "needsReview": manifest.get("needsReview"),
            "reviewFlags": _manifest_text_list(manifest, "reviewFlags", place.place_id),
            # These extra integrity fields bind the versioned prefix to every public byte.
            "assetSha256": {name: asset_records[name].sha256 for name in sorted(asset_records)},
            "assetBytes": {name: asset_records[name].size for name in sorted(asset_records)},
        }
        if manifest.get("renderMode") == "point-centered-boundary-free":
            entries[place.place_id]["renderMode"] = "point-centered-boundary-free"
            entries[place.place_id]["pointSource"] = manifest["pointSource"]
            if "pointRights" in manifest:
                entries[place.place_id]["pointRights"] = manifest["pointRights"]
    index = {"version": 1, "places": entries}
    if publication_provenance is not None:
        index["publicationProvenance"] = dict(sorted(publication_provenance.items()))
    return (json.dumps(index, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")


def _locked_boundary_properties(place: Place, frozen_feature: dict[str, Any]) -> dict[str, Any]:
    if not place.assets:
        raise PublishError(f"{place.place_id}: validated place has no public assets")
    sources = _load_json_unique(place.assets[0].path.parent / "sources.json", "Place source lock")
    boundary = sources.get("boundary") if isinstance(sources, dict) else None
    features = boundary.get("features") if isinstance(boundary, dict) else None
    if not isinstance(features, list) or len(features) != 1:
        raise PublishError(f"{place.place_id}: source lock has no single boundary feature")
    if features[0] != frozen_feature:
        raise PublishError(f"{place.place_id}: source lock boundary feature differs from the frozen snapshot")
    properties = features[0].get("properties") if isinstance(features[0], dict) else None
    if not isinstance(properties, dict) or properties.get("id") != place.place_id:
        raise PublishError(f"{place.place_id}: source lock boundary identity differs")
    return properties


def apply_rights_gate(
    batch: ValidatedBatch,
    rights_path: Path,
    boundaries_path: Path,
) -> ValidatedBatch:
    """Bind explicit publication decisions to the source snapshot and generated manifests."""
    if batch.rights_manifest_sha256 is not None:
        raise PublishError("The batch has already passed a rights gate")
    if len(batch.places) != CANONICAL_PLACE_COUNT:
        raise PublishError(f"Rights gate requires all {CANONICAL_PLACE_COUNT} validated places")

    rights = _load_rights_manifest(rights_path)
    boundaries = _load_json(boundaries_path, "boundary snapshot")
    if not isinstance(rights, dict) or rights.get("version") != 1:
        raise PublishError("Boundary rights manifest must have version 1")
    expected_snapshot_hash = rights.get("boundarySnapshotSha256")
    if not isinstance(expected_snapshot_hash, str) or not SHA256_PATTERN.fullmatch(expected_snapshot_hash):
        raise PublishError("Boundary rights manifest has no valid snapshot SHA-256")
    if sha256_file(boundaries_path) != expected_snapshot_hash:
        raise PublishError("Boundary snapshot SHA-256 differs from the rights manifest")
    if not isinstance(boundaries, dict) or boundaries.get("type") != "FeatureCollection":
        raise PublishError("Boundary snapshot is not a FeatureCollection")
    features = boundaries.get("features")
    if not isinstance(features, list):
        raise PublishError("Boundary snapshot has no features array")
    decisions = rights.get("places")
    if not isinstance(decisions, dict):
        raise PublishError("Boundary rights manifest has no places object")

    place_by_id = {place.place_id: place for place in batch.places}
    expected_ids = set(place_by_id)
    if set(decisions) != expected_ids:
        raise PublishError("Boundary rights decisions do not match the complete validated catalogue")
    features_by_id: dict[str, dict[str, Any]] = {}
    for feature in features:
        properties = feature.get("properties") if isinstance(feature, dict) else None
        place_id = properties.get("id") if isinstance(properties, dict) else None
        if not isinstance(place_id, str) or place_id in features_by_id:
            raise PublishError("Boundary snapshot has an invalid or repeated place ID")
        features_by_id[place_id] = feature
    if set(features_by_id) != expected_ids:
        raise PublishError("Boundary snapshot IDs do not match the complete validated catalogue")

    approved: list[Place] = []
    held: list[str] = []
    for place_id in sorted(expected_ids):
        decision = decisions[place_id]
        if not isinstance(decision, dict):
            raise PublishError(f"{place_id}: boundary rights decision is not an object")
        frozen_feature = features_by_id[place_id]
        feature = frozen_feature["properties"]
        place = place_by_id[place_id]
        if feature.get("name") != place.name or feature.get("category") != place.category:
            raise PublishError(f"{place_id}: boundary snapshot identity differs from the validated place")
        locked_feature = _locked_boundary_properties(place, frozen_feature)
        if locked_feature.get("name") != place.name or locked_feature.get("category") != place.category:
            raise PublishError(f"{place_id}: source lock boundary identity differs from the validated place")
        for field, manifest_field in (
            ("sourceName", "boundarySource"),
            ("sourceUrl", "boundarySourceUrl"),
            ("sourceId", "boundarySourceId"),
        ):
            source_value = decision.get(field)
            if not isinstance(source_value, str) or not source_value.strip():
                raise PublishError(f"{place_id}: rights decision has no {field}")
            if (source_value != feature.get(field) or source_value != place.manifest.get(manifest_field)
                    or source_value != locked_feature.get(field)):
                raise PublishError(f"{place_id}: boundary {field} differs from the rights decision")
        status = decision.get("decision")
        if status == "approved":
            rights_attribution = decision.get("rightsAttribution")
            if not isinstance(rights_attribution, list) or not rights_attribution or any(
                not isinstance(value, str) or not value.strip() for value in rights_attribution
            ):
                raise PublishError(f"{place_id}: approved boundary has no rights attribution")
            attribution = list(dict.fromkeys([
                *_manifest_text_list(place.manifest, "attribution", place_id),
                *rights_attribution,
            ]))
            approved.append(Place(
                place.place_id, place.category, place.name,
                {**place.manifest, "attribution": attribution}, place.assets,
            ))
        elif status == "hold":
            reason = decision.get("reason")
            if not isinstance(reason, str) or not reason.strip():
                raise PublishError(f"{place_id}: held boundary has no reason")
            held.append(place_id)
        else:
            raise PublishError(f"{place_id}: boundary rights decision must be approved or hold")

    if not approved:
        raise PublishError("Boundary rights manifest approves no places")
    places = tuple(approved)
    index_bytes = _build_index(places)
    return ValidatedBatch(
        places,
        index_bytes,
        sha256_bytes(index_bytes),
        sum(asset.size for place in places for asset in place.assets),
        sha256_file(rights_path),
        len(batch.places),
        tuple(held),
    )


POINT_RECORD_KEYS = frozenset({
    "id", "name", "category", "lon", "lat", "sourceName", "sourceUrl",
    "sourceId", "licence", "attribution",
})
POINT_SOURCE_KEYS = frozenset({"sourceName", "sourceUrl", "sourceId", "licence", "attribution"})
POINT_RIGHTS_ROW_KEYS = frozenset({
    "decision", "sourceName", "sourceUrl", "sourceId", "licence", "attribution",
    "officialTermsUrl", "reviewEvidenceUrl",
})
POINT_FRAME_SIDE_M = 8000.0
POINT_FRAME_TOLERANCE_M = 0.01


def _assert_no_boundary_or_geometry_keys(value: Any, *, place_id: str, source: str) -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            normalized = str(key).casefold()
            if "boundary" in normalized or "geometry" in normalized or "polygon" in normalized:
                raise PublishError(f"{place_id}: {source} contains forbidden boundary or geometry key {key}")
            _assert_no_boundary_or_geometry_keys(child, place_id=place_id, source=source)
    elif isinstance(value, list):
        for child in value:
            _assert_no_boundary_or_geometry_keys(child, place_id=place_id, source=source)


def _glb_json_chunk(path: Path, place_id: str) -> Any:
    try:
        content = path.read_bytes()
    except OSError as exc:
        raise PublishError(f"{place_id}: could not read terrain GLB") from exc
    if len(content) < 20 or content[:4] != b"glTF":
        raise PublishError(f"{place_id}: terrain model is not a valid GLB file")
    version, total_length = struct.unpack_from("<II", content, 4)
    if version != 2 or total_length != len(content):
        raise PublishError(f"{place_id}: terrain GLB header is invalid")

    offset = 12
    json_payload = None
    while offset < len(content):
        if offset + 8 > len(content):
            raise PublishError(f"{place_id}: terrain GLB chunk header is truncated")
        chunk_length, chunk_type = struct.unpack_from("<II", content, offset)
        offset += 8
        end = offset + chunk_length
        if end > len(content):
            raise PublishError(f"{place_id}: terrain GLB chunk is truncated")
        if chunk_type == 0x4E4F534A:
            if json_payload is not None:
                raise PublishError(f"{place_id}: terrain GLB has multiple JSON chunks")
            try:
                json_payload = json.loads(content[offset:end].rstrip(b" \t\r\n\0").decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise PublishError(f"{place_id}: terrain GLB JSON chunk is invalid") from exc
        offset = end
    if json_payload is None or not isinstance(json_payload, dict):
        raise PublishError(f"{place_id}: terrain GLB has no JSON object chunk")
    return json_payload


def _validate_point_record(record: Any, catalogue: dict[str, dict[str, str]]) -> dict[str, Any]:
    if not isinstance(record, dict) or set(record) != POINT_RECORD_KEYS:
        raise PublishError("Each point manifest row must have the exact required fields")
    place_id = record.get("id")
    if not isinstance(place_id, str) or not ID_PATTERN.fullmatch(place_id):
        raise PublishError("Point manifest has an invalid place ID")
    expected = catalogue.get(place_id)
    if expected is None or record.get("name") != expected["name"] or record.get("category") != expected["category"]:
        raise PublishError(f"{place_id}: point identity differs from the canonical catalogue")
    lon, lat = record.get("lon"), record.get("lat")
    if (isinstance(lon, bool) or not isinstance(lon, (int, float)) or not math.isfinite(lon)
            or isinstance(lat, bool) or not isinstance(lat, (int, float)) or not math.isfinite(lat)
            or not -141.0 <= lon <= -114.0 or not 48.0 <= lat <= 61.0):
        raise PublishError(f"{place_id}: point coordinates must be finite values within British Columbia")
    for field in POINT_SOURCE_KEYS:
        value = record.get(field)
        if not isinstance(value, str) or not value.strip():
            raise PublishError(f"{place_id}: point record has no valid {field}")
    licence_normalized = re.sub(r"\s+", " ", record["licence"]).strip().casefold()
    if ("all rights reserved" in licence_normalized or "no redistribution" in licence_normalized
            or "not for redistribution" in licence_normalized or "non-redistributable" in licence_normalized):
        raise PublishError(f"{place_id}: point licence explicitly withholds public redistribution")
    url = urlsplit(record["sourceUrl"])
    if url.scheme not in {"http", "https"} or not url.netloc:
        raise PublishError(f"{place_id}: point sourceUrl must be an HTTP or HTTPS URL")
    return record


def _expected_point_utm_frame(record: dict[str, Any]) -> tuple[int, tuple[float, float, float, float]]:
    try:
        from pyproj import Transformer
    except ImportError as exc:
        raise PublishError("Dual-source point publication requires pyproj; install backend/requirements.txt") from exc
    longitude, latitude = float(record["lon"]), float(record["lat"])
    zone = math.floor((longitude + 180.0) / 6.0) + 1
    epsg = 32600 + zone
    try:
        east, north = Transformer.from_crs(4326, epsg, always_xy=True).transform(longitude, latitude)
    except Exception as exc:
        raise PublishError(f"{record['id']}: could not project the independent point to UTM") from exc
    half = POINT_FRAME_SIDE_M / 2
    return epsg, (east - half, north - half, east + half, north + half)


def _validate_bounds_value(value: Any, place_id: str, source: str) -> tuple[float, float, float, float]:
    if not isinstance(value, (list, tuple)) or len(value) != 4:
        raise PublishError(f"{place_id}: {source} must contain four UTM bounds")
    if any(isinstance(item, bool) or not isinstance(item, (int, float)) or not math.isfinite(item) for item in value):
        raise PublishError(f"{place_id}: {source} contains invalid UTM bounds")
    left, bottom, right, top = (float(item) for item in value)
    if left >= right or bottom >= top:
        raise PublishError(f"{place_id}: {source} is not a valid UTM rectangle")
    return left, bottom, right, top


def _validate_point_frame(
    place_id: str,
    record: dict[str, Any],
    sources: dict[str, Any],
    manifest: dict[str, Any],
) -> None:
    expected_epsg, expected_bounds = _expected_point_utm_frame(record)
    source_epsg = sources.get("epsg")
    manifest_epsg = manifest.get("projectionEpsg")
    if (isinstance(source_epsg, bool) or source_epsg != expected_epsg
            or isinstance(manifest_epsg, bool) or manifest_epsg != expected_epsg):
        raise PublishError(f"{place_id}: source lock or manifest UTM EPSG differs from the independent point")
    config = sources.get("config")
    if not isinstance(config, dict) or config.get("pointSideM") != POINT_FRAME_SIDE_M:
        raise PublishError(f"{place_id}: source lock does not declare the fixed 8 km point frame")

    source_bounds = _validate_bounds_value(sources.get("boundsM"), place_id, "source lock boundsM")
    manifest_bounds = _validate_bounds_value(manifest.get("boundsM"), place_id, "manifest boundsM")
    for actual, expected in zip(source_bounds, expected_bounds):
        if abs(actual - expected) > POINT_FRAME_TOLERANCE_M:
            raise PublishError(f"{place_id}: source lock boundsM are not centered on the fixed point frame")
    for actual, expected in zip(manifest_bounds, expected_bounds):
        if abs(actual - expected) > POINT_FRAME_TOLERANCE_M:
            raise PublishError(f"{place_id}: manifest boundsM are not centered on the fixed point frame")
    for source_value, manifest_value in zip(source_bounds, manifest_bounds):
        if abs(source_value - manifest_value) > POINT_FRAME_TOLERANCE_M:
            raise PublishError(f"{place_id}: source lock and manifest boundsM differ")

    width, height = source_bounds[2] - source_bounds[0], source_bounds[3] - source_bounds[1]
    if abs(width - POINT_FRAME_SIDE_M) > POINT_FRAME_TOLERANCE_M or abs(height - POINT_FRAME_SIDE_M) > POINT_FRAME_TOLERANCE_M:
        raise PublishError(f"{place_id}: point frame is not an 8 km square")


def _load_point_rights_manifest(
    path: Path,
    records_by_id: dict[str, dict[str, Any]],
    point_snapshot_sha256: str,
) -> tuple[dict[str, dict[str, str]], str]:
    try:
        content = path.read_bytes()
    except FileNotFoundError as exc:
        raise PublishError(f"Missing independent point rights manifest: {path}") from exc
    except OSError as exc:
        raise PublishError(f"Could not read independent point rights manifest: {path}") from exc

    def unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        value: dict[str, Any] = {}
        for key, item in pairs:
            if key in value:
                raise PublishError("Point rights manifest contains duplicate JSON keys")
            value[key] = item
        return value

    try:
        manifest = json.loads(content.decode("utf-8"), object_pairs_hook=unique_object)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise PublishError(f"Could not read independent point rights manifest: {path}") from exc
    if not isinstance(manifest, dict) or set(manifest) != {"version", "pointManifestSha256", "places"}:
        raise PublishError("Point rights manifest has an invalid schema")
    if manifest.get("version") != 1 or manifest.get("pointManifestSha256") != point_snapshot_sha256:
        raise PublishError("Point rights manifest does not bind to the exact point manifest SHA-256")
    decisions = manifest.get("places")
    if not isinstance(decisions, dict) or set(decisions) != set(records_by_id):
        raise PublishError("Point rights decisions must cover the exact point-manifest IDs")

    validated: dict[str, dict[str, str]] = {}
    for place_id, record in records_by_id.items():
        decision = decisions[place_id]
        if not isinstance(decision, dict) or set(decision) - POINT_RIGHTS_ROW_KEYS:
            raise PublishError(f"{place_id}: point rights decision has an invalid schema")
        for field in POINT_RIGHTS_ROW_KEYS:
            if field not in decision:
                if field in {"officialTermsUrl", "reviewEvidenceUrl"}:
                    raise PublishError(f"{place_id}: point rights decision has no {field}")
                raise PublishError(f"{place_id}: point rights decision is missing {field}")
        if decision.get("decision") != "approved":
            raise PublishError(f"{place_id}: point source is not explicitly approved for publication")
        for field in POINT_SOURCE_KEYS:
            value = decision.get(field)
            if not isinstance(value, str) or not value.strip() or value != record[field]:
                raise PublishError(f"{place_id}: point rights {field} differs from the independent source record")
        for field in ("officialTermsUrl", "reviewEvidenceUrl"):
            value = decision.get(field)
            if not isinstance(value, str) or not value.strip():
                raise PublishError(f"{place_id}: point rights decision has no {field}")
            parsed_url = urlsplit(value)
            if (parsed_url.scheme != "https" or not parsed_url.netloc
                    or any(character.isspace() for character in value)):
                raise PublishError(f"{place_id}: {field} must be an absolute HTTPS URL")
        validated[place_id] = {
            "officialTermsUrl": decision["officialTermsUrl"],
            "reviewEvidenceUrl": decision["reviewEvidenceUrl"],
        }
    return validated, sha256_bytes(content)


def _validate_boundary_free_point_place(
    place: Place,
    record: dict[str, Any],
    point_rights: dict[str, str],
    point_snapshot_sha256: str,
) -> Place:
    place_id = place.place_id
    manifest = place.manifest
    if manifest.get("renderMode") != "point-centered-boundary-free":
        raise PublishError(f"{place_id}: point manifest renderMode differs")
    if manifest.get("pointSnapshotSha256") != point_snapshot_sha256:
        raise PublishError(f"{place_id}: generated point snapshot SHA-256 differs")
    expected_source = {key: record[key] for key in POINT_SOURCE_KEYS}
    point_source = manifest.get("pointSource")
    if not isinstance(point_source, dict) or set(point_source) != POINT_SOURCE_KEYS or point_source != expected_source:
        raise PublishError(f"{place_id}: generated point source identity, licence, or attribution differs")
    pin = manifest.get("representativePin")
    if not isinstance(pin, list) or len(pin) != 2 or pin != [record["lon"], record["lat"]]:
        raise PublishError(f"{place_id}: representative pin differs from the independent point manifest")

    place_root = place.assets[0].path.parent
    for path in place_root.rglob("*"):
        if "boundary" in path.name.casefold():
            raise PublishError(f"{place_id}: generated output contains boundary-related file {path.name}")
        if path.is_symlink():
            raise PublishError(f"{place_id}: generated point output contains a symbolic link")
    if not isinstance(manifest.get("sourceLockSha256"), str):
        raise PublishError(f"{place_id}: generated point manifest has no source-lock SHA-256")
    _validate_source_lock(place_id, place_root, manifest)
    strict_manifest = _load_json_unique(place_root / "manifest.json", "Point place manifest")
    if not isinstance(strict_manifest, dict) or strict_manifest.get("placeId") != place_id:
        raise PublishError(f"{place_id}: generated point manifest is invalid")
    source_path = place_root / "sources.json"
    sources = _load_json_unique(source_path, "Point source lock")
    if not isinstance(sources, dict):
        raise PublishError(f"{place_id}: point source lock root is not an object")
    if sources.get("renderMode") != "point-centered-boundary-free":
        raise PublishError(f"{place_id}: source lock renderMode differs")
    if sources.get("inputSha256") != point_snapshot_sha256:
        raise PublishError(f"{place_id}: source lock point snapshot SHA-256 differs")
    if sources.get("inputRecord") != record:
        raise PublishError(f"{place_id}: source lock input record differs from the independent point manifest")
    _validate_point_frame(place_id, record, sources, manifest)

    _assert_no_boundary_or_geometry_keys(strict_manifest, place_id=place_id, source="generated manifest")
    _assert_no_boundary_or_geometry_keys(sources, place_id=place_id, source="source lock")
    for metadata_path in place_root.rglob("*.json"):
        if metadata_path in {place_root / "manifest.json", source_path}:
            continue
        metadata = _load_json_unique(metadata_path, "point terrain metadata")
        _assert_no_boundary_or_geometry_keys(metadata, place_id=place_id, source=metadata_path.name)

    model = next((asset for asset in place.assets if asset.filename.endswith("-terrain.glb")), None)
    if model is None:
        raise PublishError(f"{place_id}: point render has no public terrain GLB")
    glb_json = _glb_json_chunk(model.path, place_id)
    _assert_no_boundary_or_geometry_keys(glb_json, place_id=place_id, source="terrain GLB")

    attribution = list(dict.fromkeys([
        *_manifest_text_list(manifest, "attribution", place_id),
        record["attribution"],
        f"Point source: {record['sourceName']} (record {record['sourceId']}); licence: {record['licence']}; {record['sourceUrl']}",
        f"Point licence terms: {point_rights['officialTermsUrl']}",
    ]))
    return Place(
        place.place_id,
        place.category,
        place.name,
        {
            **manifest,
            "attribution": attribution,
            "pointSource": expected_source,
            "pointRights": point_rights,
        },
        place.assets,
    )


def _load_boundary_rights_context(
    rights_path: Path,
    boundaries_path: Path,
    catalogue: dict[str, dict[str, str]],
) -> tuple[dict[str, Any], dict[str, dict[str, Any]], dict[str, Any], set[str], set[str]]:
    rights = _load_rights_manifest(rights_path)
    boundaries = _load_json(boundaries_path, "boundary snapshot")
    if not isinstance(rights, dict) or rights.get("version") != 1:
        raise PublishError("Boundary rights manifest must have version 1")
    snapshot_hash = rights.get("boundarySnapshotSha256")
    if not isinstance(snapshot_hash, str) or not SHA256_PATTERN.fullmatch(snapshot_hash):
        raise PublishError("Boundary rights manifest has no valid snapshot SHA-256")
    if sha256_file(boundaries_path) != snapshot_hash:
        raise PublishError("Boundary snapshot SHA-256 differs from the rights manifest")
    if not isinstance(boundaries, dict) or boundaries.get("type") != "FeatureCollection":
        raise PublishError("Boundary snapshot is not a FeatureCollection")
    features = boundaries.get("features")
    decisions = rights.get("places")
    expected_ids = set(catalogue)
    if not isinstance(features, list) or not isinstance(decisions, dict) or set(decisions) != expected_ids:
        raise PublishError("Boundary rights manifest and snapshot must cover the complete catalogue")
    features_by_id: dict[str, dict[str, Any]] = {}
    for feature in features:
        properties = feature.get("properties") if isinstance(feature, dict) else None
        place_id = properties.get("id") if isinstance(properties, dict) else None
        if not isinstance(place_id, str) or place_id in features_by_id:
            raise PublishError("Boundary snapshot has an invalid or repeated place ID")
        features_by_id[place_id] = feature
    if set(features_by_id) != expected_ids:
        raise PublishError("Boundary snapshot IDs do not match the complete catalogue")

    approved: set[str] = set()
    held: set[str] = set()
    for place_id, expected in catalogue.items():
        feature = features_by_id[place_id]["properties"]
        if feature.get("name") != expected["name"] or feature.get("category") != expected["category"]:
            raise PublishError(f"{place_id}: boundary snapshot identity differs from the canonical catalogue")
        decision = decisions[place_id]
        if not isinstance(decision, dict):
            raise PublishError(f"{place_id}: boundary rights decision is not an object")
        for field in ("sourceName", "sourceUrl", "sourceId"):
            value = decision.get(field)
            if not isinstance(value, str) or not value.strip() or value != feature.get(field):
                raise PublishError(f"{place_id}: rights decision {field} differs from the boundary snapshot")
        status = decision.get("decision")
        if status == "approved":
            attribution = decision.get("rightsAttribution")
            if not isinstance(attribution, list) or not attribution or any(
                not isinstance(item, str) or not item.strip() for item in attribution
            ):
                raise PublishError(f"{place_id}: approved boundary has no rights attribution")
            approved.add(place_id)
        elif status == "hold":
            reason = decision.get("reason")
            if not isinstance(reason, str) or not reason.strip():
                raise PublishError(f"{place_id}: held boundary has no reason")
            held.add(place_id)
        else:
            raise PublishError(f"{place_id}: boundary rights decision must be approved or hold")
    if approved & held or approved | held != expected_ids:
        raise PublishError("Boundary rights decisions do not partition the complete catalogue")
    return rights, features_by_id, decisions, approved, held


def apply_dual_source_gate(
    boundary_generated_root: Path,
    rights_path: Path,
    boundaries_path: Path,
    point_generated_root: Path,
    point_manifest_path: Path,
    point_rights_manifest_path: Path,
    catalogue_path: Path,
) -> ValidatedBatch:
    """Merge licensed boundary renders with independently sourced boundary-free point renders."""
    try:
        boundary_root = boundary_generated_root.resolve(strict=True)
        point_root = point_generated_root.resolve(strict=True)
        point_manifest_file = point_manifest_path.resolve(strict=True)
        point_rights_file = point_rights_manifest_path.resolve(strict=True)
    except OSError as exc:
        raise PublishError("The boundary root, point-generated root, point manifest, or point rights manifest is missing") from exc
    if not boundary_root.is_dir():
        raise PublishError("The boundary-generated root is not a directory")
    if (boundary_root == point_root or boundary_root in point_root.parents or point_root in boundary_root.parents):
        raise PublishError("Boundary and point generated roots must be separate directories")
    if not point_manifest_file.is_file():
        raise PublishError("Independent point manifest is not a regular file")
    if not point_rights_file.is_file():
        raise PublishError("Independent point rights manifest is not a regular file")
    independent_files = (point_manifest_file, point_rights_file)
    if point_manifest_file == point_rights_file:
        raise PublishError("Point manifest and point rights manifest must be separate files")
    if any(path.is_relative_to(boundary_root) or path.is_relative_to(point_root) for path in independent_files):
        raise PublishError("Point and point rights manifests must be stored outside generated output directories")

    catalogue = load_catalogue(catalogue_path)
    rights, features_by_id, decisions, approved_ids, held_ids = _load_boundary_rights_context(
        rights_path, boundaries_path, catalogue,
    )
    boundary_batch = validate_batch(
        boundary_root,
        catalogue_path,
        requested_ids=tuple(sorted(approved_ids)),
    )
    approved_places: list[Place] = []
    for place in boundary_batch.places:
        frozen_feature = features_by_id[place.place_id]
        feature = frozen_feature["properties"]
        locked_feature = _locked_boundary_properties(place, frozen_feature)
        if (feature.get("name") != place.name or feature.get("category") != place.category
                or locked_feature.get("name") != place.name or locked_feature.get("category") != place.category):
            raise PublishError(f"{place.place_id}: boundary identity differs from the approved snapshot")
        decision = decisions[place.place_id]
        for field, manifest_field in (
            ("sourceName", "boundarySource"),
            ("sourceUrl", "boundarySourceUrl"),
            ("sourceId", "boundarySourceId"),
        ):
            source_value = decision[field]
            if (feature.get(field) != source_value or place.manifest.get(manifest_field) != source_value
                    or locked_feature.get(field) != source_value):
                raise PublishError(f"{place.place_id}: boundary {field} differs from the approved source")
        attribution = list(dict.fromkeys([
            *_manifest_text_list(place.manifest, "attribution", place.place_id),
            *decision["rightsAttribution"],
        ]))
        approved_places.append(Place(
            place.place_id,
            place.category,
            place.name,
            {**place.manifest, "attribution": attribution},
            place.assets,
        ))
    if {place.place_id for place in approved_places} != approved_ids:
        raise PublishError("Approved boundary outputs do not exactly match the rights-approved place IDs")

    point_records, point_snapshot_sha256 = _load_point_manifest(point_manifest_file)
    if not isinstance(point_records, list) or not point_records:
        raise PublishError("Independent point manifest must be a non-empty JSON array")
    records_by_id: dict[str, dict[str, Any]] = {}
    for raw_record in point_records:
        record = _validate_point_record(raw_record, catalogue)
        place_id = record["id"]
        if place_id in records_by_id:
            raise PublishError(f"Independent point manifest repeats ID {place_id}")
        records_by_id[place_id] = record
    point_ids = set(records_by_id)
    if point_ids != held_ids or point_ids & approved_ids or point_ids | approved_ids != set(catalogue):
        raise PublishError("Point manifest IDs must exactly match held places and complete the disjoint catalogue")
    point_rights, point_rights_sha256 = _load_point_rights_manifest(
        point_rights_file, records_by_id, point_snapshot_sha256,
    )

    try:
        point_directories = {
            child.name for child in point_root.iterdir()
            if child.is_dir() and not child.is_symlink()
        }
        symlink_directories = [child.name for child in point_root.iterdir() if child.is_dir() and child.is_symlink()]
    except OSError as exc:
        raise PublishError("Could not list the point-generated directory") from exc
    if symlink_directories or point_directories != point_ids:
        raise PublishError("Point-generated directories must exactly match the held point-manifest IDs")

    point_batch = validate_batch(
        point_root,
        catalogue_path,
        requested_ids=tuple(sorted(point_ids)),
    )
    validated_point_places = tuple(
        _validate_boundary_free_point_place(
            place,
            records_by_id[place.place_id],
            point_rights[place.place_id],
            point_snapshot_sha256,
        )
        for place in point_batch.places
    )

    places = tuple(sorted((*approved_places, *validated_point_places), key=lambda place: place.place_id))
    if len(places) != CANONICAL_PLACE_COUNT or {place.place_id for place in places} != set(catalogue):
        raise PublishError("Dual-source publication does not cover every canonical place exactly once")
    provenance = {
        "boundaryRightsManifestSha256": sha256_file(rights_path),
        "boundarySnapshotSha256": rights["boundarySnapshotSha256"],
        "pointManifestSha256": point_snapshot_sha256,
        "pointRightsManifestSha256": point_rights_sha256,
    }
    index_bytes = _build_index(places, provenance)
    return ValidatedBatch(
        places=places,
        index_bytes=index_bytes,
        index_sha256=sha256_bytes(index_bytes),
        asset_bytes=sum(asset.size for place in places for asset in place.assets),
        rights_manifest_sha256=provenance["boundaryRightsManifestSha256"],
        validated_place_count=len(catalogue),
        held_place_ids=(),
        publication_provenance=provenance,
    )


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
    report = {
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
    if batch.rights_manifest_sha256 is not None:
        report.update({
            "rightsManifestSha256": batch.rights_manifest_sha256,
            "validatedPlaceCount": batch.validated_place_count,
            "approvedPlaceCount": len(batch.places),
            "heldPlaceCount": len(batch.held_place_ids),
            "heldPlaceIds": list(batch.held_place_ids),
        })
    if batch.publication_provenance is not None:
        report["publicationProvenance"] = batch.publication_provenance
        point_count = sum(place.manifest.get("renderMode") == "point-centered-boundary-free" for place in batch.places)
        report["approvedPlaceCount"] = len(batch.places) - point_count
        report["pointRenderedPlaceCount"] = point_count
        report["heldPlaceCount"] = 0
        report["heldPlaceIds"] = []
    return report


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
            CacheControl=IMMUTABLE_CACHE_CONTROL,
            Metadata={"sha256": expected_sha256},
        )
    return True


def normalize_key_prefix(prefix: str) -> str:
    path = PurePosixPath(prefix.strip("/"))
    if not prefix or path.is_absolute() or not path.parts or any(
        part in {"", ".", ".."} or not re.fullmatch(r"[A-Za-z0-9._-]+", part)
        for part in path.parts
    ):
        raise PublishError("Asset key prefix must contain only safe path segments")
    return str(path)


def _require_rights_gated_batch(batch: ValidatedBatch) -> None:
    if batch.rights_manifest_sha256 is None or batch.validated_place_count != CANONICAL_PLACE_COUNT:
        raise PublishError("Public upload requires a complete validated batch and an explicit boundary rights gate")
    point_places = [place for place in batch.places if place.manifest.get("renderMode") == "point-centered-boundary-free"]
    if point_places:
        provenance = batch.publication_provenance
        required_hashes = (
            "boundaryRightsManifestSha256", "boundarySnapshotSha256",
            "pointManifestSha256", "pointRightsManifestSha256",
        )
        if (not isinstance(provenance, dict)
                or any(not isinstance(provenance.get(field), str)
                       or not SHA256_PATTERN.fullmatch(provenance[field])
                       for field in required_hashes)
                or provenance["boundaryRightsManifestSha256"] != batch.rights_manifest_sha256):
            raise PublishError("Point-rendered public upload requires a validated point rights manifest")
        for place in point_places:
            point_rights = place.manifest.get("pointRights")
            if not isinstance(point_rights, dict) or set(point_rights) != {"officialTermsUrl", "reviewEvidenceUrl"}:
                raise PublishError(f"{place.place_id}: public upload has no validated point rights evidence")
            for field in ("officialTermsUrl", "reviewEvidenceUrl"):
                value = point_rights[field]
                parsed = urlsplit(value) if isinstance(value, str) else None
                if (parsed is None or parsed.scheme != "https" or not parsed.netloc
                        or any(character.isspace() for character in value)):
                    raise PublishError(f"{place.place_id}: public upload has invalid point rights evidence")


def publish_to_s3(
    client: Any,
    batch: ValidatedBatch,
    *,
    bucket: str,
    prefix: str,
) -> dict[str, int | str]:
    _require_rights_gated_batch(batch)
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


class WranglerRunner:
    """Run pinned Wrangler commands with a global cooldown between starts."""

    def __init__(self, *, delay_seconds: float):
        npx = shutil.which("npx")
        if not npx:
            raise PublishError("Wrangler upload requires Node.js npx on PATH")
        self.command = (npx, "--yes", f"wrangler@{WRANGLER_VERSION}")
        self.delay_seconds = delay_seconds
        self._lock = threading.Lock()
        self._next_start = 0.0

    def __call__(self, *arguments: str) -> subprocess.CompletedProcess[str]:
        with self._lock:
            now = time.monotonic()
            start_at = max(now, self._next_start)
            self._next_start = start_at + self.delay_seconds
        if start_at > now:
            time.sleep(start_at - now)
        try:
            return subprocess.run(
                [*self.command, *arguments],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                check=False,
            )
        except OSError as exc:
            # OS errors may include user paths. Never echo them into batch logs.
            raise PublishError(f"Could not start Wrangler ({type(exc).__name__})") from exc


def _wrangler_remote_hash(
    runner: Callable[..., subprocess.CompletedProcess[str]],
    bucket: str,
    key: str,
    expected_size: int,
) -> str | None:
    with tempfile.TemporaryDirectory(prefix="parkdex-visual-read-") as temporary:
        destination = Path(temporary) / "object"
        result = runner("r2", "object", "get", f"{bucket}/{key}", "--remote", "--file", str(destination))
        if result.returncode != 0:
            if WRANGLER_MISSING_MESSAGE in result.stderr or WRANGLER_MISSING_MESSAGE in result.stdout:
                return None
            raise PublishError(f"Wrangler could not inspect remote object: {key}")
        if not destination.is_file():
            raise PublishError(f"Wrangler returned no bytes for remote object: {key}")
        if destination.stat().st_size != expected_size:
            return "<conflict>"
        return sha256_file(destination)


def _ensure_wrangler_object(
    runner: Callable[..., subprocess.CompletedProcess[str]],
    bucket: str,
    key: str,
    *,
    local_path: Path,
    expected_size: int,
    expected_sha256: str,
    content_type: str,
) -> bool:
    existing_hash = _wrangler_remote_hash(runner, bucket, key, expected_size)
    if existing_hash is not None:
        if existing_hash != expected_sha256:
            raise PublishError(f"Immutable object key has conflicting bytes: {key}")
        return False

    try:
        local_matches = local_path.stat().st_size == expected_size and sha256_file(local_path) == expected_sha256
    except OSError as exc:
        raise PublishError(f"Could not read validated local asset: {key}") from exc
    if not local_matches:
        raise PublishError(f"Validated local asset changed before upload: {key}")

    result = runner(
        "r2", "object", "put", f"{bucket}/{key}", "--remote", "--force",
        "--file", str(local_path), "--content-type", content_type,
        "--cache-control", IMMUTABLE_CACHE_CONTROL,
    )
    if result.returncode != 0:
        raise PublishError(f"Wrangler could not upload remote object: {key}")
    return True


def publish_to_wrangler(
    batch: ValidatedBatch,
    *,
    bucket: str,
    prefix: str,
    runner: Callable[..., subprocess.CompletedProcess[str]],
    workers: int = 2,
    progress: Callable[[int, int], None] | None = None,
) -> dict[str, int | str]:
    """Upload validated assets with bounded parallelism, then publish the index."""
    _require_rights_gated_batch(batch)
    prefix = normalize_key_prefix(prefix)
    versioned_prefix = f"{prefix}/{batch.index_sha256}"
    assets = [asset for place in batch.places for asset in place.assets]
    uploaded = 0
    skipped = 0
    iterator = iter(assets)

    def transfer(asset: Asset) -> bool:
        return _ensure_wrangler_object(
            runner, bucket, f"{versioned_prefix}/{asset.key}",
            local_path=asset.path,
            expected_size=asset.size,
            expected_sha256=asset.sha256,
            content_type=asset.content_type,
        )

    with ThreadPoolExecutor(max_workers=workers) as executor:
        pending = {}

        def fill_pending() -> None:
            while len(pending) < workers * 2:
                asset = next(iterator, None)
                if asset is None:
                    break
                pending[executor.submit(transfer, asset)] = asset

        fill_pending()
        while pending:
            done, _ = wait(pending, return_when=FIRST_COMPLETED)
            for future in done:
                pending.pop(future)
                try:
                    did_upload = future.result()
                except Exception:
                    for remaining in pending:
                        remaining.cancel()
                    raise
                uploaded += int(did_upload)
                skipped += int(not did_upload)
                completed = uploaded + skipped
                if progress is not None and (completed % 100 == 0 or completed == len(assets)):
                    progress(completed, len(assets))
            fill_pending()

    index_key = f"{versioned_prefix}/index.json"
    with tempfile.TemporaryDirectory(prefix="parkdex-visual-index-") as temporary:
        index_path = Path(temporary) / "index.json"
        index_path.write_bytes(batch.index_bytes)
        did_upload = _ensure_wrangler_object(
            runner, bucket, index_key,
            local_path=index_path,
            expected_size=len(batch.index_bytes),
            expected_sha256=batch.index_sha256,
            content_type="application/json; charset=utf-8",
        )
    uploaded += int(did_upload)
    skipped += int(not did_upload)
    return {"prefix": versioned_prefix, "indexKey": index_key, "uploaded": uploaded, "skipped": skipped}


def _wrangler_configuration() -> tuple[str, str]:
    bucket = os.environ.get("PARKDEX_VISUAL_ASSETS_WRANGLER_BUCKET", "").strip()
    if bucket != "parkdex-visual-assets":
        raise PublishError("PARKDEX_VISUAL_ASSETS_WRANGLER_BUCKET must be parkdex-visual-assets")
    if bucket == os.environ.get("R2_BUCKET", "").strip():
        raise PublishError("The public visual-assets bucket must be separate from the private postcard bucket")
    prefix = normalize_key_prefix(os.environ.get("PARKDEX_VISUAL_ASSETS_WRANGLER_PREFIX", "parkdex/visual-assets/v1").strip())
    return bucket, prefix


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
    modes.add_argument("--upload", action="store_true", help="Upload all 1,030 validated places through S3")
    modes.add_argument("--upload-wrangler", action="store_true", help="Upload all 1,030 validated places through Cloudflare Wrangler")
    parser.add_argument("--ids", help="Comma-separated IDs for dry-run or local staging only")
    parser.add_argument("--rights-manifest", type=Path, help="Explicit per-place boundary rights decisions; required for public upload")
    parser.add_argument("--boundaries", type=Path, help="Exact boundary GeoJSON snapshot named by the rights manifest")
    parser.add_argument("--point-generated", type=Path, help="Independent point-centered boundary-free generated root for held places")
    parser.add_argument("--point-manifest", type=Path, help="Immutable independent point/source manifest for held places")
    parser.add_argument("--point-rights-manifest", type=Path, help="Per-place reviewed publication approvals and official terms for point sources")
    parser.add_argument("--wrangler-workers", type=int, default=2, help="Parallel Wrangler transfers, 1 to 8 (default: 2)")
    parser.add_argument("--wrangler-delay-seconds", type=float, default=0.5, help="Minimum time between Wrangler command starts (default: 0.5)")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        requested_ids = parse_ids(args.ids)
        if (args.upload or args.upload_wrangler) and requested_ids is not None:
            raise PublishError("Upload mode always publishes the complete 1,030-place catalogue; --ids is not allowed")
        if args.stage_dir is not None and requested_ids is None:
            raise PublishError("Local staging requires an explicit --ids subset")
        if args.upload_wrangler and not 1 <= args.wrangler_workers <= 8:
            raise PublishError("--wrangler-workers must be between 1 and 8")
        if args.upload_wrangler and (
            not math.isfinite(args.wrangler_delay_seconds) or args.wrangler_delay_seconds < 0
        ):
            raise PublishError("--wrangler-delay-seconds must be a finite non-negative number")
        if (args.rights_manifest is None) != (args.boundaries is None):
            raise PublishError("--rights-manifest and --boundaries must be supplied together")
        if (args.point_generated is None) != (args.point_manifest is None):
            raise PublishError("--point-generated and --point-manifest must be supplied together")
        if args.point_generated is not None and args.point_rights_manifest is None:
            raise PublishError("Dual-source publication requires --point-rights-manifest")
        if args.point_generated is not None and args.rights_manifest is None:
            raise PublishError("Dual-source publication requires --rights-manifest and --boundaries")
        if args.point_generated is None and args.point_rights_manifest is not None:
            raise PublishError("--point-rights-manifest requires --point-generated and --point-manifest")
        if args.point_generated is not None and requested_ids is not None:
            raise PublishError("Dual-source publication always validates the complete catalogue; --ids is not allowed")
        if (args.upload or args.upload_wrangler) and args.rights_manifest is None:
            raise PublishError("Public upload requires --rights-manifest and --boundaries")
        if args.stage_dir is not None and (args.rights_manifest is not None or args.point_generated is not None):
            raise PublishError("Rights-gated staging requires a complete batch; use --dry-run or public upload")

        if args.point_generated is not None:
            batch = apply_dual_source_gate(
                args.generated,
                args.rights_manifest,
                args.boundaries,
                args.point_generated,
                args.point_manifest,
                args.point_rights_manifest,
                args.catalogue,
            )
        else:
            batch = validate_batch(
                args.generated,
                args.catalogue,
                requested_ids=requested_ids,
                require_exact_directories=requested_ids is None,
            )
            if args.rights_manifest is not None:
                batch = apply_rights_gate(batch, args.rights_manifest, args.boundaries)
        report: dict[str, Any] = summarize(batch)

        if args.dry_run:
            report["status"] = "validated"
        elif args.stage_dir is not None:
            stage_subset(batch, args.stage_dir, args.generated)
            report["status"] = "staged"
            report["stageDirectory"] = str(args.stage_dir.resolve())
        else:
            catalogue = load_catalogue(args.catalogue)
            if len(catalogue) != CANONICAL_PLACE_COUNT or batch.validated_place_count != CANONICAL_PLACE_COUNT:
                raise PublishError(
                    f"Upload requires exactly {CANONICAL_PLACE_COUNT} canonical places; found {len(catalogue)}"
                )
            if args.upload_wrangler:
                bucket, prefix = _wrangler_configuration()
                runner = WranglerRunner(delay_seconds=args.wrangler_delay_seconds)
                preflight = runner("--version")
                if preflight.returncode != 0 or WRANGLER_VERSION not in preflight.stdout:
                    raise PublishError(f"Could not start pinned Wrangler {WRANGLER_VERSION}")

                def print_progress(completed: int, total: int) -> None:
                    print(
                        json.dumps({"status": "uploading", "completedAssets": completed, "totalAssets": total}, separators=(",", ":")),
                        file=sys.stderr,
                        flush=True,
                    )

                report.update(publish_to_wrangler(
                    batch,
                    bucket=bucket,
                    prefix=prefix,
                    runner=runner,
                    workers=args.wrangler_workers,
                    progress=print_progress,
                ))
            else:
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

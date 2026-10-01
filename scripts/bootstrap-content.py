#!/usr/bin/env python3
"""Verify and insert the pinned public content baseline exactly once."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
import os
import re
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import quote


ROOT = Path(__file__).resolve().parent.parent
CDN_ORIGIN = "https://kip-assets.parkdex.app"
PINNED_VERSION = "5f0d137050ac8f83a0dd42f98291010577fae75a7538d62127690fd0f7630744"
PINNED_MANIFEST_SHA256 = "d84ecf3f969cc00c351f85401625024b8f526a2d82ba7344f9980d9f01ae1c32"
HEX_SHA256 = re.compile(r"^[a-f0-9]{64}$")
COMMIT_SHA = re.compile(r"^[a-f0-9]{40,64}$")
PARK_FIELDS = (
    "id", "name", "short", "category", "region", "lat", "lng", "biome",
    "shape", "rarity", "scene", "seed", "blurb",
)
SOURCE_PATHS = {
    "data/parks.json": ("src/data/parks.json", "application/json"),
    "data/drive.json": ("src/data/drive.json", "application/json"),
    "boundaries.geojson": ("public/boundaries.geojson", "application/geo+json"),
}
BOOTSTRAP_LOCK_KEY = 845732145245001
MAX_PUBLIC_DOCUMENT_BYTES = 8 * 1024 * 1024


class BootstrapError(ValueError):
    """A safe error message that does not contain connection credentials."""


@dataclass(frozen=True)
class Baseline:
    manifest: dict[str, Any]
    manifest_bytes: bytes
    manifest_sha256: str
    files_by_path: dict[str, dict[str, Any]]
    source_bytes: dict[str, bytes]
    active_scene_bytes: dict[str, bytes]
    parks: list[dict[str, Any]]
    boundaries: list[dict[str, Any]]
    drive: dict[str, Any]
    object_rows: list[dict[str, Any]]
    map_manifest_bytes: bytes
    map_report: dict[str, Any]


def _strict_json(raw: bytes, description: str) -> Any:
    def reject_constant(value: str) -> None:
        raise ValueError(f"invalid JSON constant {value}")

    def reject_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f"duplicate key {key}")
            result[key] = value
        return result

    try:
        return json.loads(
            raw.decode("utf-8"),
            parse_constant=reject_constant,
            object_pairs_hook=reject_duplicates,
        )
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
        raise BootstrapError(f"{description} is not valid UTF-8 JSON: {exc}") from exc


def _canonical_bytes(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


def _hash(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _finite_number(value: Any) -> bool:
    return not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value)


def _load_map_builder() -> Any:
    builder_path = ROOT / "scripts" / "build-map-only-manifest.py"
    spec = importlib.util.spec_from_file_location("parkdex_map_only_manifest", builder_path)
    if spec is None or spec.loader is None:
        raise BootstrapError("map-only manifest builder is unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _validate_parks(parks: Any) -> list[dict[str, Any]]:
    if not isinstance(parks, list) or not parks:
        raise BootstrapError("data/parks.json must contain a non-empty array")
    seen: set[str] = set()
    for index, park in enumerate(parks):
        label = f"data/parks.json item {index}"
        if not isinstance(park, dict) or set(park) != set(PARK_FIELDS):
            raise BootstrapError(f"{label} must contain the pinned park fields")
        park_id = park["id"]
        if not isinstance(park_id, str) or not park_id or park_id in seen:
            raise BootstrapError(f"{label} has a missing or duplicate id")
        seen.add(park_id)
        for field in ("name", "short", "category", "region", "biome", "shape", "rarity", "blurb"):
            if not isinstance(park[field], str):
                raise BootstrapError(f"{label}.{field} must be a string")
        if park["scene"] is not None and not isinstance(park["scene"], str):
            raise BootstrapError(f"{label}.scene must be a string or null")
        if not _finite_number(park["lat"]) or not -90 <= park["lat"] <= 90:
            raise BootstrapError(f"{label}.lat is invalid")
        if not _finite_number(park["lng"]) or not -180 <= park["lng"] <= 180:
            raise BootstrapError(f"{label}.lng is invalid")
        if isinstance(park["seed"], bool) or not isinstance(park["seed"], int):
            raise BootstrapError(f"{label}.seed must be an integer")
    return parks


def _validate_boundaries(collection: Any, parks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not isinstance(collection, dict) or collection.get("type") != "FeatureCollection":
        raise BootstrapError("boundaries.geojson must be a GeoJSON FeatureCollection")
    features = collection.get("features")
    if not isinstance(features, list):
        raise BootstrapError("boundaries.geojson features must be an array")
    park_by_id = {park["id"]: park for park in parks}
    seen: set[str] = set()
    for index, feature in enumerate(features):
        if not isinstance(feature, dict) or set(feature) != {"type", "properties", "geometry"} or feature["type"] != "Feature":
            raise BootstrapError(f"boundary feature {index} has an invalid shape")
        properties = feature["properties"]
        geometry = feature["geometry"]
        if not isinstance(properties, dict) or set(properties) != {"id", "biome"}:
            raise BootstrapError(f"boundary feature {index} has invalid properties")
        park_id = properties["id"]
        if not isinstance(park_id, str) or park_id not in park_by_id or park_id in seen:
            raise BootstrapError(f"boundary feature {index} has a missing, unknown, or duplicate park id")
        if properties["biome"] != park_by_id[park_id]["biome"]:
            raise BootstrapError(f"boundary biome does not match park {park_id}")
        if not isinstance(geometry, dict) or set(geometry) != {"type", "coordinates"} or geometry["type"] != "MultiPolygon":
            raise BootstrapError(f"boundary geometry for {park_id} is invalid")
        polygons = geometry["coordinates"]
        if not isinstance(polygons, list) or not polygons:
            raise BootstrapError(f"boundary geometry for {park_id} has no polygons")
        seen.add(park_id)
    if seen != set(park_by_id):
        raise BootstrapError("boundary feature ids do not match data/parks.json")
    return features


def _validate_drive(drive: Any, parks: list[dict[str, Any]]) -> dict[str, Any]:
    if not isinstance(drive, dict) or set(drive) != {"hubs", "parks"}:
        raise BootstrapError("data/drive.json must contain hubs and parks")
    hubs = drive["hubs"]
    park_drive = drive["parks"]
    if not isinstance(hubs, list) or not hubs or not isinstance(park_drive, dict):
        raise BootstrapError("data/drive.json has an invalid shape")
    for index, hub in enumerate(hubs):
        if not isinstance(hub, dict) or set(hub) != {"name", "lng", "lat"}:
            raise BootstrapError(f"drive hub {index} has an invalid shape")
        if not isinstance(hub["name"], str) or not hub["name"].strip():
            raise BootstrapError(f"drive hub {index} has an invalid name")
        if not _finite_number(hub["lng"]) or not -180 <= hub["lng"] <= 180:
            raise BootstrapError(f"drive hub {index} has an invalid longitude")
        if not _finite_number(hub["lat"]) or not -90 <= hub["lat"] <= 90:
            raise BootstrapError(f"drive hub {index} has an invalid latitude")
    expected_ids = {park["id"] for park in parks}
    if set(park_drive) != expected_ids:
        raise BootstrapError("data/drive.json park ids do not match data/parks.json")
    for park_id, item in park_drive.items():
        if not isinstance(item, dict) or set(item) != {"drive", "walkM"}:
            raise BootstrapError(f"drive settings for {park_id} have an invalid shape")
        routes = item["drive"]
        if not isinstance(routes, list) or len(routes) != len(hubs):
            raise BootstrapError(f"drive route count for {park_id} does not match hubs")
        if not _finite_number(item["walkM"]) or item["walkM"] < 0:
            raise BootstrapError(f"walk distance for {park_id} is invalid")
        for route in routes:
            if route is None:
                continue
            if not isinstance(route, list) or len(route) != 2 or any(not _finite_number(value) or value < 0 for value in route):
                raise BootstrapError(f"drive route for {park_id} is invalid")
    return drive


def _validate_descriptor(raw: Any, version: str) -> dict[str, Any]:
    fields = {"path", "key", "url", "sha256", "byte_size", "content_type"}
    if not isinstance(raw, dict) or set(raw) != fields:
        raise BootstrapError("pinned content manifest contains an invalid file descriptor")
    path = raw["path"]
    if not isinstance(path, str) or not path or path.startswith("/") or "\\" in path or any(part in ("", ".", "..") for part in path.split("/")):
        raise BootstrapError("pinned content manifest contains an unsafe file path")
    if not isinstance(raw["sha256"], str) or not HEX_SHA256.fullmatch(raw["sha256"]):
        raise BootstrapError(f"pinned content manifest has an invalid hash for {path}")
    if isinstance(raw["byte_size"], bool) or not isinstance(raw["byte_size"], int) or raw["byte_size"] <= 0:
        raise BootstrapError(f"pinned content manifest has an invalid size for {path}")
    expected_key = f"releases/{version}/{path}"
    if raw["key"] != expected_key:
        raise BootstrapError(f"pinned content manifest has an invalid object key for {path}")
    if raw["url"] != f"{CDN_ORIGIN}/{quote(expected_key, safe='/')}" or not isinstance(raw["content_type"], str):
        raise BootstrapError(f"pinned content manifest has an invalid URL or MIME type for {path}")
    return raw


def load_baseline(root: Path = ROOT) -> Baseline:
    manifest_path = root / "database" / "content-manifest.json"
    manifest_bytes = manifest_path.read_bytes()
    manifest_sha256 = _hash(manifest_bytes)
    if manifest_sha256 != PINNED_MANIFEST_SHA256:
        raise BootstrapError("tracked content manifest does not match the pinned SHA-256")
    manifest = _strict_json(manifest_bytes, "database/content-manifest.json")
    required_manifest_fields = {"boundaryIds", "cdnOrigin", "files", "mapManifest", "parkIds", "sourceCommit", "version"}
    if not isinstance(manifest, dict) or set(manifest) != required_manifest_fields:
        raise BootstrapError("database/content-manifest.json has an unexpected shape")
    if manifest["version"] != PINNED_VERSION or manifest["cdnOrigin"] != CDN_ORIGIN:
        raise BootstrapError("database/content-manifest.json is not the pinned public release")
    if not isinstance(manifest["sourceCommit"], str) or not COMMIT_SHA.fullmatch(manifest["sourceCommit"]):
        raise BootstrapError("database/content-manifest.json has an invalid source commit")
    if not isinstance(manifest["files"], list) or not manifest["files"]:
        raise BootstrapError("database/content-manifest.json has no file inventory")

    files_by_path: dict[str, dict[str, Any]] = {}
    for entry in manifest["files"]:
        descriptor = _validate_descriptor(entry, PINNED_VERSION)
        if descriptor["path"] in files_by_path:
            raise BootstrapError(f"duplicate pinned content path: {descriptor['path']}")
        files_by_path[descriptor["path"]] = descriptor
    inventory = [
        {"path": item["path"], "byte_size": item["byte_size"], "sha256": item["sha256"]}
        for item in sorted(files_by_path.values(), key=lambda item: item["path"])
    ]
    if _hash(_canonical_bytes(inventory)) != PINNED_VERSION:
        raise BootstrapError("pinned content manifest version does not match its file inventory")

    source_bytes: dict[str, bytes] = {}
    for logical_path, (repository_path, content_type) in SOURCE_PATHS.items():
        descriptor = files_by_path.get(logical_path)
        if descriptor is None or descriptor["content_type"] != content_type:
            raise BootstrapError(f"pinned content manifest is missing {logical_path}")
        raw = (root / repository_path).read_bytes()
        if len(raw) != descriptor["byte_size"] or _hash(raw) != descriptor["sha256"]:
            raise BootstrapError(f"tracked source does not match the pinned hash for {logical_path}")
        source_bytes[logical_path] = raw

    parks = _validate_parks(_strict_json(source_bytes["data/parks.json"], "data/parks.json"))
    drive = _validate_drive(_strict_json(source_bytes["data/drive.json"], "data/drive.json"), parks)
    boundaries = _validate_boundaries(_strict_json(source_bytes["boundaries.geojson"], "boundaries.geojson"), parks)
    park_ids = [park["id"] for park in parks]
    boundary_ids = [feature["properties"]["id"] for feature in boundaries]
    if manifest["parkIds"] != park_ids or manifest["boundaryIds"] != boundary_ids:
        raise BootstrapError("pinned manifest ids do not match the public source JSON")
    for park in parks:
        scene = park["scene"]
        if scene is not None and f"art/badges/scenes/{scene}.webp" not in files_by_path:
            raise BootstrapError(f"park {park['id']} refers to an unregistered badge descriptor")
    active_scene_bytes: dict[str, bytes] = {}
    active_scene_paths = sorted({f"art/badges/scenes/{park['scene']}.webp" for park in parks if park["scene"] is not None})
    for logical_path in active_scene_paths:
        descriptor = files_by_path[logical_path]
        if descriptor["content_type"] != "image/webp" or descriptor["byte_size"] > 4 * 1024 * 1024:
            raise BootstrapError(f"active scene descriptor has an invalid type or size: {logical_path}")
        repository_path = root / "public" / Path(*logical_path.split("/"))
        raw = repository_path.read_bytes()
        if len(raw) != descriptor["byte_size"] or _hash(raw) != descriptor["sha256"]:
            raise BootstrapError(f"tracked active scene art does not match the pinned hash for {logical_path}")
        active_scene_bytes[logical_path] = raw

    map_builder = _load_map_builder()
    try:
        _, map_manifest_bytes, map_report = map_builder.build_manifest(manifest_path)
    except Exception as exc:
        raise BootstrapError("could not build the deterministic map-only manifest") from exc

    object_rows = [dict(entry) for entry in files_by_path.values()]
    manifest_key = f"releases/{PINNED_VERSION}/manifest.json"
    object_rows.append({
        "path": "manifest.json",
        "key": manifest_key,
        "url": f"{CDN_ORIGIN}/{quote(manifest_key, safe='/')}",
        "sha256": manifest_sha256,
        "byte_size": len(manifest_bytes),
        "content_type": "application/json",
    })
    object_rows.sort(key=lambda item: item["path"])
    return Baseline(
        manifest=manifest,
        manifest_bytes=manifest_bytes,
        manifest_sha256=manifest_sha256,
        files_by_path=files_by_path,
        source_bytes=source_bytes,
        active_scene_bytes=active_scene_bytes,
        parks=parks,
        boundaries=boundaries,
        drive=drive,
        object_rows=object_rows,
        map_manifest_bytes=map_manifest_bytes,
        map_report=map_report,
    )


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req: Any, fp: Any, code: int, msg: str, headers: Any, newurl: str) -> None:
        return None


def fetch_public_bytes(url: str) -> bytes:
    if not url.startswith(f"{CDN_ORIGIN}/") or "?" in url or "#" in url:
        raise BootstrapError("refusing to fetch a URL outside the pinned public CDN")
    request = urllib.request.Request(url, headers={"User-Agent": "parkdex-content-bootstrap/1"})
    opener = urllib.request.build_opener(_NoRedirect())
    try:
        with opener.open(request, timeout=25) as response:
            if response.getcode() != 200 or response.geturl() != url:
                raise BootstrapError("pinned public CDN response was not an exact HTTP 200")
            raw = response.read(MAX_PUBLIC_DOCUMENT_BYTES + 1)
    except BootstrapError:
        raise
    except urllib.error.HTTPError as exc:
        raise BootstrapError(f"public CDN returned HTTP {exc.code}") from exc
    except (OSError, urllib.error.URLError) as exc:
        raise BootstrapError("could not fetch a pinned public document from the CDN") from exc
    if len(raw) > MAX_PUBLIC_DOCUMENT_BYTES:
        raise BootstrapError("a pinned public document exceeds the allowed size")
    return raw


def _fetch_for_verification(fetcher: Any, url: str, description: str) -> bytes:
    try:
        return fetcher(url)
    except BootstrapError as exc:
        raise BootstrapError(f"could not verify {description}: {exc}") from exc


def verify_public_artifacts(baseline: Baseline, fetcher: Any = fetch_public_bytes) -> None:
    release_url = f"{CDN_ORIGIN}/releases/{PINNED_VERSION}/manifest.json"
    if _fetch_for_verification(fetcher, release_url, "the pinned release manifest") != baseline.manifest_bytes:
        raise BootstrapError("public release manifest bytes do not match the tracked pin")
    for logical_path, descriptor in baseline.files_by_path.items():
        if logical_path not in SOURCE_PATHS:
            continue
        raw = _fetch_for_verification(fetcher, descriptor["url"], f"{logical_path}")
        if len(raw) != descriptor["byte_size"] or _hash(raw) != descriptor["sha256"]:
            raise BootstrapError(f"public CDN bytes do not match the pinned hash for {logical_path}")
        if raw != baseline.source_bytes[logical_path]:
            raise BootstrapError(f"public CDN content does not match tracked source for {logical_path}")
    for logical_path, expected_bytes in baseline.active_scene_bytes.items():
        descriptor = baseline.files_by_path[logical_path]
        raw = _fetch_for_verification(fetcher, descriptor["url"], f"active scene art {logical_path}")
        if len(raw) != descriptor["byte_size"] or _hash(raw) != descriptor["sha256"]:
            raise BootstrapError(f"public CDN bytes do not match the pinned hash for {logical_path}")
        if raw != expected_bytes:
            raise BootstrapError(f"public CDN content does not match tracked source for {logical_path}")
    map_url = baseline.map_report["manifestUrl"]
    remote_map_manifest = _fetch_for_verification(fetcher, map_url, "the generated map-only manifest")
    if remote_map_manifest != baseline.map_manifest_bytes:
        raise BootstrapError("public map-only manifest bytes do not match the generated pin")
    if _hash(remote_map_manifest) != baseline.map_report["manifestSha256"]:
        raise BootstrapError("public map-only manifest hash does not match the generated pin")


def _database_url() -> str:
    value = os.environ.get("MIGRATION_DATABASE_URL") or os.environ.get("DATABASE_URL")
    if not value:
        raise BootstrapError("set MIGRATION_DATABASE_URL or DATABASE_URL before applying the bootstrap")
    return value


def _read_receipt(conn: Any) -> tuple[Any, ...] | None:
    with conn.cursor() as cursor:
        cursor.execute(
            "SELECT manifest_version, manifest_url, manifest_sha256 FROM public.content_bootstrap_receipt WHERE singleton = true"
        )
        return cursor.fetchone()


def _require_matching_receipt(receipt: tuple[Any, ...], baseline: Baseline) -> None:
    expected = (
        PINNED_VERSION,
        f"{CDN_ORIGIN}/releases/{PINNED_VERSION}/manifest.json",
        baseline.manifest_sha256,
    )
    if tuple(receipt) != expected:
        raise BootstrapError("existing bootstrap receipt does not match the pinned manifest identity")


def _json_value(value: Any, description: str) -> Any:
    if isinstance(value, str):
        return _strict_json(value.encode("utf-8"), description)
    return value


def _check_existing_seed_rows(cursor: Any, baseline: Baseline) -> None:
    """Reject drift in rows this seed would otherwise claim to initialize."""
    cursor.execute(
        "SELECT manifest FROM public.version_manifests WHERE version = %s",
        (PINNED_VERSION,),
    )
    existing_manifest = cursor.fetchone()
    if existing_manifest is not None and _json_value(existing_manifest[0], "stored version manifest") != baseline.manifest:
        raise BootstrapError("existing version manifest differs from the pinned baseline; refusing to seed")

    expected_objects = {row["path"]: row for row in baseline.object_rows}
    expected_object_keys = {row["key"] for row in baseline.object_rows}
    cursor.execute(
        "SELECT logical_path, object_key, url, sha256, byte_size, content_type FROM public.r2_objects"
    )
    for logical_path, object_key, url, sha256, byte_size, content_type in cursor.fetchall():
        expected = expected_objects.get(logical_path)
        if expected is not None:
            actual = (logical_path, object_key, url, sha256, byte_size, content_type)
            wanted = (
                expected["path"], expected["key"], expected["url"], expected["sha256"],
                expected["byte_size"], expected["content_type"],
            )
            if actual != wanted:
                raise BootstrapError(f"existing object descriptor differs from the pinned baseline: {logical_path}")
        elif object_key in expected_object_keys:
            raise BootstrapError("an existing object key conflicts with a pinned public descriptor")

    park_ids = [park["id"] for park in baseline.parks]
    expected_parks = {park["id"]: park for park in baseline.parks}
    cursor.execute(
        "SELECT id, name, short, category, region, lat, lng, biome, shape, rarity, scene, seed, blurb FROM public.parks WHERE id = ANY(%s)",
        (park_ids,),
    )
    for row in cursor.fetchall():
        actual = dict(zip(PARK_FIELDS, row, strict=True))
        expected = expected_parks[actual["id"]]
        if actual != expected:
            raise BootstrapError(f"existing park differs from the pinned baseline: {actual['id']}")

    expected_boundaries = {feature["properties"]["id"]: feature for feature in baseline.boundaries}
    cursor.execute(
        "SELECT park_id, feature FROM public.boundaries WHERE park_id = ANY(%s)",
        (park_ids,),
    )
    for park_id, feature in cursor.fetchall():
        if _json_value(feature, "stored boundary feature") != expected_boundaries[park_id]:
            raise BootstrapError(f"existing boundary differs from the pinned baseline: {park_id}")

    expected_hubs = {
        position: (hub["name"], hub["lng"], hub["lat"])
        for position, hub in enumerate(baseline.drive["hubs"])
    }
    cursor.execute("SELECT position, name, lng, lat FROM public.drive_hubs")
    for position, name, lng, lat in cursor.fetchall():
        if position not in expected_hubs or (name, lng, lat) != expected_hubs[position]:
            raise BootstrapError("existing drive hub inventory differs from the pinned baseline")

    expected_settings = {park_id: item["walkM"] for park_id, item in baseline.drive["parks"].items()}
    cursor.execute(
        "SELECT park_id, walk_m FROM public.park_drive_settings WHERE park_id = ANY(%s)",
        (park_ids,),
    )
    for park_id, walk_m in cursor.fetchall():
        if walk_m != expected_settings[park_id]:
            raise BootstrapError(f"existing drive settings differ from the pinned baseline: {park_id}")

    expected_routes = {
        (park_id, position): (None, None) if route is None else (route[0], route[1])
        for park_id, item in baseline.drive["parks"].items()
        for position, route in enumerate(item["drive"])
    }
    cursor.execute(
        "SELECT park_id, hub_position, distance_km, duration_min FROM public.park_drive WHERE park_id = ANY(%s)",
        (park_ids,),
    )
    for park_id, position, distance, duration in cursor.fetchall():
        expected = expected_routes.get((park_id, position))
        if expected is None or (distance, duration) != expected:
            raise BootstrapError(f"existing drive route differs from the pinned baseline: {park_id}")

    map_report = baseline.map_report
    cursor.execute("SELECT version, manifest_url, manifest_sha256 FROM public.content_map WHERE singleton = true")
    existing_map = cursor.fetchone()
    if existing_map is not None and tuple(existing_map) != (
        map_report["version"], map_report["manifestUrl"], map_report["manifestSha256"],
    ):
        raise BootstrapError("existing map pointer differs from the verified public manifest")


def seed_once(conn: Any, baseline: Baseline, jsonb_factory: Any, environment: str) -> bool:
    """Insert public rows in one transaction, then write the durable receipt last."""
    with conn.transaction():
        with conn.cursor() as cursor:
            cursor.execute("SELECT pg_advisory_xact_lock(%s)", (BOOTSTRAP_LOCK_KEY,))
            cursor.execute(
                "SELECT manifest_version, manifest_url, manifest_sha256 FROM public.content_bootstrap_receipt WHERE singleton = true"
            )
            existing_receipt = cursor.fetchone()
            if existing_receipt is not None:
                _require_matching_receipt(existing_receipt, baseline)
                return False
            cursor.execute("SET CONSTRAINTS ALL DEFERRED")
            _check_existing_seed_rows(cursor, baseline)

            cursor.execute(
                "INSERT INTO public.version_manifests (version, manifest) VALUES (%s, %s) ON CONFLICT (version) DO NOTHING",
                (PINNED_VERSION, jsonb_factory(baseline.manifest)),
            )
            for row in baseline.object_rows:
                cursor.execute(
                    """
                    INSERT INTO public.r2_objects (logical_path, object_key, url, sha256, byte_size, content_type)
                    VALUES (%(path)s, %(key)s, %(url)s, %(sha256)s, %(byte_size)s, %(content_type)s)
                    ON CONFLICT DO NOTHING
                    """,
                    row,
                )

            for position, hub in enumerate(baseline.drive["hubs"]):
                cursor.execute(
                    "INSERT INTO public.drive_hubs (position, name, lng, lat) VALUES (%s, %s, %s, %s) ON CONFLICT DO NOTHING",
                    (position, hub["name"], hub["lng"], hub["lat"]),
                )
            for park in baseline.parks:
                cursor.execute(
                    """
                    INSERT INTO public.parks (id, name, short, category, region, lat, lng, biome, shape, rarity, scene, seed, blurb)
                    VALUES (%(id)s, %(name)s, %(short)s, %(category)s, %(region)s, %(lat)s, %(lng)s, %(biome)s, %(shape)s, %(rarity)s, %(scene)s, %(seed)s, %(blurb)s)
                    ON CONFLICT DO NOTHING
                    """,
                    park,
                )
            for feature in baseline.boundaries:
                cursor.execute(
                    "INSERT INTO public.boundaries (park_id, feature) VALUES (%s, %s) ON CONFLICT DO NOTHING",
                    (feature["properties"]["id"], jsonb_factory(feature)),
                )
            for park_id, settings in baseline.drive["parks"].items():
                cursor.execute(
                    "INSERT INTO public.park_drive_settings (park_id, walk_m) VALUES (%s, %s) ON CONFLICT DO NOTHING",
                    (park_id, settings["walkM"]),
                )
                for position, route in enumerate(settings["drive"]):
                    distance, duration = (None, None) if route is None else (route[0], route[1])
                    cursor.execute(
                        """
                        INSERT INTO public.park_drive (park_id, hub_position, distance_km, duration_min)
                        VALUES (%s, %s, %s, %s) ON CONFLICT DO NOTHING
                        """,
                        (park_id, position, distance, duration),
                    )

            map_report = baseline.map_report
            cursor.execute(
                """
                INSERT INTO public.content_map (singleton, version, manifest_url, manifest_sha256)
                VALUES (true, %s, %s, %s)
                ON CONFLICT (singleton) DO NOTHING
                """,
                (map_report["version"], map_report["manifestUrl"], map_report["manifestSha256"]),
            )
            cursor.execute(
                """
                INSERT INTO public.content_bootstrap_receipt (singleton, manifest_version, manifest_url, manifest_sha256)
                VALUES (true, %s, %s, %s)
                """,
                (
                    PINNED_VERSION,
                    f"{CDN_ORIGIN}/releases/{PINNED_VERSION}/manifest.json",
                    baseline.manifest_sha256,
                ),
            )
    return True


def _import_psycopg() -> tuple[Any, Any]:
    try:
        import psycopg
        from psycopg.types.json import Jsonb
    except ImportError as exc:
        raise BootstrapError("psycopg is required; install the database bootstrap dependency") from exc
    return psycopg, Jsonb


def run(environment: str, apply: bool, root: Path = ROOT) -> str:
    if environment not in {"preview", "staging"}:
        raise BootstrapError("environment must be preview or staging")
    baseline = load_baseline(root)
    if not apply:
        verify_public_artifacts(baseline)
        return (
            f"dry run verified public baseline {PINNED_VERSION}: {len(baseline.parks)} parks, "
            f"{len(baseline.drive['hubs'])} hubs, {len(baseline.object_rows)} public object descriptors; no database writes"
        )

    database_url = _database_url()
    psycopg, jsonb_factory = _import_psycopg()
    try:
        with psycopg.connect(database_url, autocommit=True) as conn:
            receipt = _read_receipt(conn)
            if receipt is not None:
                _require_matching_receipt(receipt, baseline)
                return f"public baseline already bootstrapped with receipt {receipt[0]}"
            verify_public_artifacts(baseline)
            applied = seed_once(conn, baseline, jsonb_factory, environment)
    except BootstrapError:
        raise
    except Exception as exc:
        raise BootstrapError("database bootstrap failed; verify that approved migrations are applied") from exc
    if not applied:
        return "public baseline was bootstrapped by a concurrent delivery run; no baseline rows were reapplied"
    return (
        f"bootstrapped pinned public baseline {PINNED_VERSION} in {environment}: "
        f"{len(baseline.parks)} parks, {len(baseline.boundaries)} boundaries, "
        f"{len(baseline.drive['hubs'])} hubs, {len(baseline.object_rows)} object descriptors"
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="apply the verified public baseline; default is dry-run")
    parser.add_argument("--environment", required=True, choices=("preview", "staging"))
    args = parser.parse_args(argv)
    try:
        print(run(args.environment, args.apply))
        return 0
    except BootstrapError as exc:
        print(f"bootstrap-content: {exc}", file=sys.stderr)
        return 2
    except Exception:
        print("bootstrap-content: unexpected failure; sensitive details were suppressed", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Snapshot, import, and verify Parkdex Kip's static cloud content baseline."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import subprocess
import sys
from pathlib import Path, PurePosixPath
from typing import Any, Iterable
from urllib.parse import quote


ROOT = Path(__file__).resolve().parent.parent
MIGRATION = ROOT / "database" / "001_cloud_content.sql"
CDN_ORIGIN = "https://kip-assets.parkdex.app"
JSON_SOURCE_PATHS = {
    "src/data/parks.json": "data/parks.json",
    "src/data/drive.json": "data/drive.json",
    "public/boundaries.geojson": "boundaries.geojson",
}
PARK_FIELDS = (
    "id",
    "name",
    "short",
    "category",
    "region",
    "lat",
    "lng",
    "biome",
    "shape",
    "rarity",
    "scene",
    "seed",
    "blurb",
)
MANIFEST_ENTRY_FIELDS = {"path", "key", "url", "sha256", "byte_size", "content_type"}
HEX_SHA256 = re.compile(r"^[0-9a-f]{64}$")
COMMIT_SHA = re.compile(r"^[0-9a-f]{40,64}$")


class CloudContentError(Exception):
    """A safe, actionable error in snapshot or database content."""


def _strict_json(raw: bytes, description: str) -> Any:
    def reject_constant(value: str) -> None:
        raise ValueError(f"invalid JSON constant {value}")

    def reject_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f"duplicate object key {key!r}")
            result[key] = value
        return result

    try:
        return json.loads(
            raw.decode("utf-8"),
            parse_constant=reject_constant,
            object_pairs_hook=reject_duplicates,
        )
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
        raise CloudContentError(f"{description} is not valid UTF-8 JSON: {exc}") from exc


def _canonical_bytes(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


def _run_git(root: Path, *args: str, binary: bool = False) -> bytes | str:
    try:
        result = subprocess.run(
            ["git", "-C", str(root), *args],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except (OSError, subprocess.CalledProcessError) as exc:
        detail = exc.stderr.decode("utf-8", errors="replace").strip() if isinstance(exc, subprocess.CalledProcessError) else str(exc)
        raise CloudContentError(f"git {' '.join(args)} failed: {detail}") from exc
    return result.stdout if binary else result.stdout.decode("utf-8").strip()


def _tracked_art_paths(root: Path, commit: str | None = None) -> list[str]:
    if commit:
        raw = _run_git(root, "ls-tree", "-r", "--name-only", "-z", commit, "--", "public/art", binary=True)
    else:
        raw = _run_git(root, "ls-files", "-z", "--", "public/art", binary=True)
    assert isinstance(raw, bytes)
    return sorted(path for path in raw.decode("utf-8").split("\0") if path)


def _git_blob(root: Path, commit: str, repo_path: str) -> bytes:
    raw = _run_git(root, "show", f"{commit}:{repo_path}", binary=True)
    assert isinstance(raw, bytes)
    return raw


def _source_commit(root: Path, requested_commit: str | None = None) -> str:
    commit = requested_commit or str(_run_git(root, "rev-parse", "HEAD"))
    if not COMMIT_SHA.fullmatch(commit):
        raise CloudContentError(f"could not resolve a full source commit: {commit}")
    _run_git(root, "cat-file", "-e", f"{commit}^{{commit}}")
    tracked = _run_git(root, "ls-files", "--", *JSON_SOURCE_PATHS.keys(), "public/art")
    tracked_set = set(str(tracked).splitlines())
    missing = sorted(set(JSON_SOURCE_PATHS) - tracked_set)
    art_paths = _tracked_art_paths(root, commit)
    if set(_tracked_art_paths(root)) != set(art_paths):
        raise CloudContentError(f"tracked runtime art does not match selected source commit {commit}")
    if missing or not art_paths:
        detail = f"missing tracked input(s): {', '.join(missing)}" if missing else "no tracked public/art files"
        raise CloudContentError(f"source inputs are incomplete: {detail}")
    status = str(
        _run_git(
            root,
            "status",
            "--porcelain=v1",
            "--untracked-files=no",
            "--",
            *JSON_SOURCE_PATHS.keys(),
            "public/art",
        )
    )
    if status:
        raise CloudContentError("source data or runtime art has uncommitted changes; snapshot only a committed source tree")
    for repo_path in [*JSON_SOURCE_PATHS.keys(), *art_paths]:
        source = root / Path(repo_path)
        if not source.is_file():
            raise CloudContentError(f"tracked source input is missing: {repo_path}")
        if source.read_bytes() != _git_blob(root, commit, repo_path):
            raise CloudContentError(f"source input differs from committed {commit}: {repo_path}")
    return commit


def _validate_parks(parks: Any) -> list[dict[str, Any]]:
    if not isinstance(parks, list) or not parks:
        raise CloudContentError("data/parks.json must contain a non-empty park array")
    seen: set[str] = set()
    for index, park in enumerate(parks):
        label = f"data/parks.json item {index}"
        if not isinstance(park, dict) or set(park) != set(PARK_FIELDS):
            raise CloudContentError(f"{label} must contain exactly the 13 current park fields")
        park_id = park["id"]
        if not isinstance(park_id, str) or not park_id or park_id in seen:
            raise CloudContentError(f"{label} has a missing or duplicate id")
        seen.add(park_id)
        for field in ("name", "short", "category", "region", "biome", "shape", "rarity", "blurb"):
            if not isinstance(park[field], str):
                raise CloudContentError(f"{label}.{field} must be a string")
        if park["scene"] is not None and not isinstance(park["scene"], str):
            raise CloudContentError(f"{label}.scene must be a string or null")
        for field, minimum, maximum in (("lat", -90, 90), ("lng", -180, 180)):
            value = park[field]
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                raise CloudContentError(f"{label}.{field} must be a finite number")
            if not minimum <= value <= maximum:
                raise CloudContentError(f"{label}.{field} is out of range")
        if isinstance(park["seed"], bool) or not isinstance(park["seed"], int):
            raise CloudContentError(f"{label}.seed must be an integer")
    return parks


def _validate_drive(drive: Any, park_ids: list[str]) -> None:
    if not isinstance(drive, dict) or set(drive) != {"hubs", "parks"}:
        raise CloudContentError("data/drive.json must contain exactly hubs and parks")
    if not isinstance(drive["hubs"], list) or not isinstance(drive["parks"], dict):
        raise CloudContentError("data/drive.json has an invalid shape")
    drive_ids = list(drive["parks"])
    if len(drive_ids) != len(set(drive_ids)) or set(drive_ids) != set(park_ids):
        raise CloudContentError("data/drive.json park ids do not match data/parks.json")


def _validate_boundaries(collection: Any, park_ids: list[str]) -> list[dict[str, Any]]:
    if not isinstance(collection, dict) or collection.get("type") != "FeatureCollection":
        raise CloudContentError("boundaries.geojson must be a GeoJSON FeatureCollection")
    features = collection.get("features")
    if not isinstance(features, list):
        raise CloudContentError("boundaries.geojson features must be an array")
    ids: list[str] = []
    for index, feature in enumerate(features):
        if not isinstance(feature, dict) or feature.get("type") != "Feature":
            raise CloudContentError(f"boundary feature {index} is not a GeoJSON Feature")
        properties = feature.get("properties")
        if not isinstance(properties, dict) or not isinstance(properties.get("id"), str):
            raise CloudContentError(f"boundary feature {index} has no string properties.id")
        if "geometry" not in feature:
            raise CloudContentError(f"boundary feature {index} has no geometry")
        ids.append(properties["id"])
    if len(ids) != len(set(ids)) or set(ids) != set(park_ids) or len(ids) != len(park_ids):
        raise CloudContentError("boundary feature ids do not match data/parks.json")
    return features


def _default_map_source(root: Path) -> Path:
    candidates = [root / "public" / "map"]
    if len(root.parents) >= 3:
        candidates.append(root.parents[2] / "parkdex-badge-mockup" / "public" / "map")
    for candidate in candidates:
        if candidate.is_dir():
            return candidate
    raise CloudContentError("map source not found; pass --map-source pointing to a directory with island/ and fonts/")


def _map_files(map_source: Path) -> tuple[list[tuple[str, Path]], dict[str, int]]:
    source = map_source.resolve()
    island = source / "island"
    fonts = source / "fonts"
    manifest_path = island / "manifest.json"
    if not manifest_path.is_file() or not fonts.is_dir():
        raise CloudContentError("map source must contain island/manifest.json and fonts/")
    manifest = _strict_json(manifest_path.read_bytes(), str(manifest_path))
    if not isinstance(manifest, dict) or set(manifest) != {"size", "chunkBytes", "count"}:
        raise CloudContentError("map/island/manifest.json must have exactly size, chunkBytes, and count")
    size, chunk_bytes, count = (manifest[key] for key in ("size", "chunkBytes", "count"))
    if any(isinstance(value, bool) or not isinstance(value, int) or value <= 0 for value in (size, chunk_bytes, count)):
        raise CloudContentError("map manifest size, chunkBytes, and count must be positive integers")
    if count != math.ceil(size / chunk_bytes):
        raise CloudContentError("map manifest count does not match size and chunkBytes")

    actual_chunks: dict[int, Path] = {}
    for child in island.iterdir():
        if child.name == "manifest.json" and child.is_file():
            continue
        match = re.fullmatch(r"(\d{3,})\.bin", child.name)
        if not child.is_file() or not match:
            raise CloudContentError(f"unexpected file in map/island: {child.name}")
        chunk_index = int(match.group(1))
        if chunk_index in actual_chunks:
            raise CloudContentError(f"duplicate map chunk index: {chunk_index}")
        actual_chunks[chunk_index] = child
    expected_indices = set(range(count))
    if set(actual_chunks) != expected_indices:
        missing = sorted(expected_indices - set(actual_chunks))
        extra = sorted(set(actual_chunks) - expected_indices)
        raise CloudContentError(f"map chunks do not match manifest; missing={missing}, extra={extra}")
    for index in range(count):
        expected_size = min(chunk_bytes, size - index * chunk_bytes)
        actual_size = actual_chunks[index].stat().st_size
        if actual_size != expected_size:
            raise CloudContentError(f"map chunk {index:03d}.bin has {actual_size} bytes, expected {expected_size}")

    font_files: list[Path] = []
    for child in fonts.rglob("*"):
        if child.is_dir():
            continue
        if not child.is_file() or child.suffix.lower() != ".pbf":
            raise CloudContentError(f"unexpected file in map/fonts: {child.relative_to(fonts)}")
        font_files.append(child)
    if not font_files:
        raise CloudContentError("map source has no glyph .pbf files")

    files: list[tuple[str, Path]] = [("map/island/manifest.json", manifest_path)]
    files.extend((f"map/island/{index:03d}.bin", actual_chunks[index]) for index in range(count))
    files.extend((f"map/fonts/{path.relative_to(fonts).as_posix()}", path) for path in sorted(font_files, key=lambda item: item.relative_to(fonts).as_posix()))
    return files, manifest


def _content_type(path: str) -> str:
    suffix = PurePosixPath(path).suffix.lower()
    if suffix == ".json":
        return "application/json"
    if suffix == ".geojson":
        return "application/geo+json"
    if suffix == ".webp":
        return "image/webp"
    if suffix == ".pbf":
        return "application/x-protobuf"
    if suffix == ".bin":
        return "application/octet-stream"
    raise CloudContentError(f"no content type is defined for {path}")


def _safe_logical_path(value: Any) -> str:
    if not isinstance(value, str) or not value:
        raise CloudContentError("manifest file path must be a non-empty string")
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in ("", ".", "..") for part in path.parts) or "\\" in value:
        raise CloudContentError(f"unsafe logical path in snapshot manifest: {value!r}")
    return path.as_posix()


def _inventory_version(entries: Iterable[dict[str, Any]]) -> str:
    inventory = [{"path": item["path"], "byte_size": item["byte_size"], "sha256": item["sha256"]} for item in sorted(entries, key=lambda item: item["path"])]
    return hashlib.sha256(_canonical_bytes(inventory)).hexdigest()


def _url_for(origin: str, key: str) -> str:
    return f"{origin.rstrip('/')}/{quote(key, safe='/')}"


def _validate_url_origin(value: str) -> str:
    origin = value.rstrip("/")
    if not origin.startswith("https://") or any(ch.isspace() for ch in origin):
        raise CloudContentError("CDN origin must be an HTTPS origin without whitespace")
    if "/" in origin[len("https://") :]:
        raise CloudContentError("CDN origin must not include a path")
    return origin


def _validate_app_bytes(files: dict[str, bytes]) -> tuple[list[str], list[str], dict[str, int]]:
    parks = _validate_parks(_strict_json(files["data/parks.json"], "data/parks.json"))
    park_ids = [park["id"] for park in parks]
    available_art = {path for path in files if path.startswith("art/")}
    for park in parks:
        scene = park["scene"]
        if scene is not None and f"art/badges/scenes/{scene}.webp" not in available_art:
            raise CloudContentError(f"park {park['id']} references missing badge art for scene {scene}")
    _validate_drive(_strict_json(files["data/drive.json"], "data/drive.json"), park_ids)
    boundaries = _strict_json(files["boundaries.geojson"], "boundaries.geojson")
    features = _validate_boundaries(boundaries, park_ids)
    map_manifest = _strict_json(files["map/island/manifest.json"], "map/island/manifest.json")
    return park_ids, [feature["properties"]["id"] for feature in features], map_manifest


def build_snapshot(
    root: Path,
    map_source: Path,
    output_dir: Path,
    cdn_origin: str = CDN_ORIGIN,
    source_commit: str | None = None,
) -> dict[str, Any]:
    root = root.resolve()
    map_source = map_source.resolve()
    output_dir = output_dir.resolve()
    cdn_origin = _validate_url_origin(cdn_origin)
    if not root.is_dir():
        raise CloudContentError(f"source repository does not exist: {root}")
    if output_dir.exists() and any(output_dir.iterdir()):
        raise CloudContentError(f"snapshot output directory must be empty: {output_dir}")

    source_commit = _source_commit(root, source_commit)
    files: list[tuple[str, Path]] = []
    for repo_path, logical_path in JSON_SOURCE_PATHS.items():
        files.append((logical_path, root / Path(repo_path)))
    art_paths = _tracked_art_paths(root, source_commit)
    if not art_paths:
        raise CloudContentError("source commit has no tracked public/art files")
    files.extend((repo_path.removeprefix("public/"), root / Path(repo_path)) for repo_path in art_paths)
    map_entries, _ = _map_files(map_source)
    files.extend(map_entries)

    raw_sources: dict[str, bytes] = {}
    for logical_path, path in files:
        if not path.is_file():
            raise CloudContentError(f"snapshot source file is missing: {path}")
        raw_sources[logical_path] = path.read_bytes()
    park_ids, boundary_ids, map_manifest = _validate_app_bytes(raw_sources)

    source_files = {value: key for key, value in JSON_SOURCE_PATHS.items()}
    source_files.update({repo_path.removeprefix("public/"): repo_path for repo_path in art_paths})
    for logical_path, repo_path in source_files.items():
        if raw_sources[logical_path] != _git_blob(root, source_commit, repo_path):
            raise CloudContentError(f"source input differs from committed {source_commit}: {repo_path}")

    entries: list[dict[str, Any]] = []
    for logical_path, path in sorted(files, key=lambda item: item[0]):
        raw = raw_sources[logical_path]
        digest = hashlib.sha256(raw).hexdigest()
        entries.append(
            {
                "path": logical_path,
                "key": "",
                "url": "",
                "sha256": digest,
                "byte_size": len(raw),
                "content_type": _content_type(logical_path),
            }
        )
    version = _inventory_version(entries)
    for entry in entries:
        entry["key"] = f"releases/{version}/{entry['path']}"
        entry["url"] = _url_for(cdn_origin, entry["key"])

    manifest = {
        "version": version,
        "sourceCommit": source_commit,
        "cdnOrigin": cdn_origin,
        "parkIds": park_ids,
        "boundaryIds": boundary_ids,
        "mapManifest": map_manifest,
        "files": entries,
    }
    output_dir.mkdir(parents=True, exist_ok=True)
    for entry in entries:
        target = output_dir / "content" / Path(*PurePosixPath(entry["path"]).parts)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(raw_sources[entry["path"]])
    (output_dir / "manifest.json").write_bytes(_canonical_bytes(manifest) + b"\n")
    return manifest


def _snapshot_manifest(snapshot_dir: Path) -> tuple[dict[str, Any], bytes]:
    manifest_path = snapshot_dir / "manifest.json"
    if not manifest_path.is_file():
        raise CloudContentError(f"snapshot manifest is missing: {manifest_path}")
    manifest_bytes = manifest_path.read_bytes()
    manifest = _strict_json(manifest_bytes, str(manifest_path))
    if not isinstance(manifest, dict) or set(manifest) != {
        "version",
        "sourceCommit",
        "cdnOrigin",
        "parkIds",
        "boundaryIds",
        "mapManifest",
        "files",
    }:
        raise CloudContentError("snapshot manifest has unexpected top-level fields")
    return manifest, manifest_bytes


def validate_snapshot(snapshot_dir: Path, root: Path = ROOT) -> tuple[dict[str, Any], dict[str, bytes], bytes]:
    snapshot_dir = snapshot_dir.resolve()
    manifest, manifest_bytes = _snapshot_manifest(snapshot_dir)
    version = manifest["version"]
    if not isinstance(version, str) or not HEX_SHA256.fullmatch(version):
        raise CloudContentError("snapshot version must be a lowercase SHA256 hex digest")
    source_commit = manifest["sourceCommit"]
    if not isinstance(source_commit, str) or not COMMIT_SHA.fullmatch(source_commit):
        raise CloudContentError("snapshot sourceCommit must be a full Git commit id")
    _run_git(root, "cat-file", "-e", f"{source_commit}^{{commit}}")
    cdn_origin = _validate_url_origin(manifest["cdnOrigin"])
    entries = manifest["files"]
    if not isinstance(entries, list) or not entries:
        raise CloudContentError("snapshot manifest files must be a non-empty array")

    seen: set[str] = set()
    content: dict[str, bytes] = {}
    for entry in entries:
        if not isinstance(entry, dict) or set(entry) != MANIFEST_ENTRY_FIELDS:
            raise CloudContentError("each snapshot file entry must contain the six inventory fields")
        logical_path = _safe_logical_path(entry["path"])
        if logical_path in seen:
            raise CloudContentError(f"duplicate snapshot path: {logical_path}")
        seen.add(logical_path)
        if not isinstance(entry["sha256"], str) or not HEX_SHA256.fullmatch(entry["sha256"]):
            raise CloudContentError(f"invalid sha256 for {logical_path}")
        if isinstance(entry["byte_size"], bool) or not isinstance(entry["byte_size"], int) or entry["byte_size"] < 0:
            raise CloudContentError(f"invalid byte_size for {logical_path}")
        if entry["content_type"] != _content_type(logical_path):
            raise CloudContentError(f"unexpected content_type for {logical_path}")
        expected_key = f"releases/{version}/{logical_path}"
        if entry["key"] != expected_key or entry["url"] != _url_for(cdn_origin, expected_key):
            raise CloudContentError(f"key or URL does not match the immutable release path for {logical_path}")
        target = snapshot_dir / "content" / Path(*PurePosixPath(logical_path).parts)
        if not target.is_file():
            raise CloudContentError(f"snapshot content file is missing: {logical_path}")
        raw = target.read_bytes()
        if len(raw) != entry["byte_size"] or hashlib.sha256(raw).hexdigest() != entry["sha256"]:
            raise CloudContentError(f"snapshot content does not match inventory: {logical_path}")
        content[logical_path] = raw
    if set(content) != seen:
        raise CloudContentError("snapshot file inventory contains a duplicate path")
    if _inventory_version(entries) != version:
        raise CloudContentError("snapshot version does not match the content inventory")

    required = {"data/parks.json", "data/drive.json", "boundaries.geojson", "map/island/manifest.json"}
    missing = required - set(content)
    if missing:
        raise CloudContentError(f"snapshot is missing required file(s): {', '.join(sorted(missing))}")
    park_ids, boundary_ids, map_manifest = _validate_app_bytes(content)
    if manifest["parkIds"] != park_ids or manifest["boundaryIds"] != boundary_ids:
        raise CloudContentError("snapshot ordered park/boundary ids do not match the source JSON")
    if manifest["mapManifest"] != map_manifest:
        raise CloudContentError("snapshot mapManifest does not match map/island/manifest.json")
    _validate_map_snapshot(content, map_manifest)

    expected_art = _tracked_art_paths(root, source_commit)
    expected_logical_art = {path.removeprefix("public/") for path in expected_art}
    snapshot_art = {path for path in content if path.startswith("art/")}
    if expected_logical_art != snapshot_art:
        raise CloudContentError("snapshot runtime art does not match tracked public/art at sourceCommit")
    for source_path, logical_path in JSON_SOURCE_PATHS.items():
        if content[logical_path] != _git_blob(root, source_commit, source_path):
            raise CloudContentError(f"snapshot data is stale for sourceCommit: {source_path}")
    for repo_path in expected_art:
        logical_path = repo_path.removeprefix("public/")
        if content[logical_path] != _git_blob(root, source_commit, repo_path):
            raise CloudContentError(f"snapshot art is stale for sourceCommit: {repo_path}")
    allowed_prefixes = ("data/", "art/", "map/")
    unexpected = [path for path in content if path != "boundaries.geojson" and not path.startswith(allowed_prefixes)]
    if unexpected:
        raise CloudContentError(f"unexpected runtime content in snapshot: {', '.join(sorted(unexpected))}")
    return manifest, content, manifest_bytes


def _validate_map_snapshot(content: dict[str, bytes], map_manifest: Any) -> None:
    if not isinstance(map_manifest, dict):
        raise CloudContentError("mapManifest must be an object")
    size = map_manifest.get("size")
    chunk_bytes = map_manifest.get("chunkBytes")
    count = map_manifest.get("count")
    expected = {"map/island/manifest.json"}
    if any(isinstance(value, bool) or not isinstance(value, int) or value <= 0 for value in (size, chunk_bytes, count)):
        raise CloudContentError("mapManifest has invalid size, chunkBytes, or count")
    if count != math.ceil(size / chunk_bytes):
        raise CloudContentError("mapManifest count does not match size and chunkBytes")
    for index in range(count):
        path = f"map/island/{index:03d}.bin"
        expected.add(path)
        if path not in content:
            raise CloudContentError(f"snapshot map chunk is missing: {path}")
        if len(content[path]) != min(chunk_bytes, size - index * chunk_bytes):
            raise CloudContentError(f"snapshot map chunk has an unexpected size: {path}")
    font_paths = {path for path in content if path.startswith("map/fonts/") and path.endswith(".pbf")}
    if not font_paths:
        raise CloudContentError("snapshot has no map glyph files")
    expected.update(font_paths)
    actual_map_paths = {path for path in content if path.startswith("map/")}
    if actual_map_paths != expected:
        raise CloudContentError("snapshot map files do not match the map manifest and glyph inventory")


def _expected_object_rows(manifest: dict[str, Any], manifest_bytes: bytes) -> list[dict[str, Any]]:
    rows = [
        {
            "logical_path": item["path"],
            "object_key": item["key"],
            "url": item["url"],
            "sha256": item["sha256"],
            "byte_size": item["byte_size"],
            "content_type": item["content_type"],
        }
        for item in manifest["files"]
    ]
    key = f"releases/{manifest['version']}/manifest.json"
    rows.append(
        {
            "logical_path": "manifest.json",
            "object_key": key,
            "url": _url_for(manifest["cdnOrigin"], key),
            "sha256": hashlib.sha256(manifest_bytes).hexdigest(),
            "byte_size": len(manifest_bytes),
            "content_type": "application/json",
        }
    )
    return rows


def _dict_json_value(value: Any) -> Any:
    """Normalize psycopg JSON values to ordinary Python JSON data."""
    if isinstance(value, str):
        return _strict_json(value.encode("utf-8"), "database JSON value")
    return value


def _verify_database_schema(conn: Any) -> None:
    with conn.cursor() as cursor:
        cursor.execute(
            """
            SELECT tablename FROM pg_catalog.pg_tables
            WHERE schemaname = 'public' ORDER BY tablename
            """
        )
        tables = {row[0] for row in cursor.fetchall()}
        expected_tables = {"parks", "boundaries", "r2_objects", "version_manifests"}
        if tables != expected_tables:
            raise CloudContentError(f"public tables do not match the cloud content schema; expected {sorted(expected_tables)}, got {sorted(tables)}")
        cursor.execute(
            """
            SELECT table_name, column_name, data_type, is_nullable
            FROM information_schema.columns
            WHERE table_schema = 'public'
            ORDER BY table_name, ordinal_position
            """
        )
        actual_columns: dict[str, list[tuple[str, str, str]]] = {}
        for table_name, column_name, data_type, nullable in cursor.fetchall():
            actual_columns.setdefault(table_name, []).append((column_name, data_type, nullable))
    expected_columns = {
        "parks": [
            ("id", "text", "NO"),
            ("name", "text", "NO"),
            ("short", "text", "NO"),
            ("category", "text", "NO"),
            ("region", "text", "NO"),
            ("lat", "double precision", "NO"),
            ("lng", "double precision", "NO"),
            ("biome", "text", "NO"),
            ("shape", "text", "NO"),
            ("rarity", "text", "NO"),
            ("scene", "text", "YES"),
            ("seed", "integer", "NO"),
            ("blurb", "text", "NO"),
        ],
        "boundaries": [("park_id", "text", "NO"), ("feature", "jsonb", "NO")],
        "r2_objects": [
            ("logical_path", "text", "NO"),
            ("object_key", "text", "NO"),
            ("url", "text", "NO"),
            ("sha256", "text", "NO"),
            ("byte_size", "bigint", "NO"),
            ("content_type", "text", "NO"),
        ],
        "version_manifests": [("version", "text", "NO"), ("manifest", "jsonb", "NO")],
    }
    if actual_columns != expected_columns:
        raise CloudContentError("public table columns or types do not match the exact cloud content schema")

    expected_constraints = {
        ("parks", "p", "parks_pkey"),
        ("boundaries", "p", "boundaries_pkey"),
        ("boundaries", "f", "boundaries_park_id_fkey"),
        ("r2_objects", "p", "r2_objects_pkey"),
        ("r2_objects", "u", "r2_objects_object_key_key"),
        ("version_manifests", "p", "version_manifests_pkey"),
    }
    with conn.cursor() as cursor:
        cursor.execute(
            """
            SELECT rel.relname, con.contype, con.conname
            FROM pg_catalog.pg_constraint con
            JOIN pg_catalog.pg_class rel ON rel.oid = con.conrelid
            JOIN pg_catalog.pg_namespace ns ON ns.oid = rel.relnamespace
            WHERE ns.nspname = 'public' AND con.contype IN ('p', 'f', 'u')
            ORDER BY rel.relname, con.contype, con.conname
            """
        )
        constraints = set(cursor.fetchall())
    if constraints != expected_constraints:
        raise CloudContentError("public table primary, foreign, or unique constraints do not match the expected schema")


def _ensure_empty_or_exact_rows(conn: Any, manifest: dict[str, Any], content: dict[str, bytes], manifest_bytes: bytes) -> None:
    expected_parks = _validate_parks(_strict_json(content["data/parks.json"], "data/parks.json"))
    expected_features = _validate_boundaries(
        _strict_json(content["boundaries.geojson"], "boundaries.geojson"),
        [park["id"] for park in expected_parks],
    )
    expected_objects = _expected_object_rows(manifest, manifest_bytes)
    expected_object_paths = {row["logical_path"] for row in expected_objects}
    expected_park_ids = {park["id"] for park in expected_parks}

    with conn.cursor() as cursor:
        cursor.execute("SELECT id, name, short, category, region, lat, lng, biome, shape, rarity, scene, seed, blurb FROM public.parks")
        actual_parks = {row[0]: dict(zip(PARK_FIELDS, row, strict=True)) for row in cursor.fetchall()}
        extra_park_ids = set(actual_parks) - expected_park_ids
        if extra_park_ids:
            raise CloudContentError(f"database contains unexpected park ids: {sorted(extra_park_ids)[:5]}")
        for park in expected_parks:
            existing = actual_parks.get(park["id"])
            if existing is not None and existing != park:
                raise CloudContentError(f"existing park content differs from snapshot: {park['id']}")

        cursor.execute("SELECT park_id, feature FROM public.boundaries")
        actual_boundaries = {row[0]: _dict_json_value(row[1]) for row in cursor.fetchall()}
        expected_by_id = {feature["properties"]["id"]: feature for feature in expected_features}
        extra_boundary_ids = set(actual_boundaries) - set(expected_by_id)
        if extra_boundary_ids:
            raise CloudContentError(f"database contains unexpected boundary ids: {sorted(extra_boundary_ids)[:5]}")
        for park_id, feature in expected_by_id.items():
            existing = actual_boundaries.get(park_id)
            if existing is not None and existing != feature:
                raise CloudContentError(f"existing boundary feature differs from snapshot: {park_id}")

        cursor.execute("SELECT logical_path, object_key, url, sha256, byte_size, content_type FROM public.r2_objects")
        actual_objects = {
            row[0]: dict(zip(("logical_path", "object_key", "url", "sha256", "byte_size", "content_type"), row, strict=True)) for row in cursor.fetchall()
        }
        extra_paths = set(actual_objects) - expected_object_paths
        if extra_paths:
            raise CloudContentError(f"database contains unexpected R2 object paths: {sorted(extra_paths)[:5]}")
        expected_by_path = {row["logical_path"]: row for row in expected_objects}
        for logical_path, row in expected_by_path.items():
            existing = actual_objects.get(logical_path)
            if existing is not None and existing != row:
                raise CloudContentError(f"existing R2 object metadata differs from snapshot: {logical_path}")

        cursor.execute("SELECT version, manifest FROM public.version_manifests")
        actual_manifests = {row[0]: _dict_json_value(row[1]) for row in cursor.fetchall()}
        extra_versions = set(actual_manifests) - {manifest["version"]}
        if extra_versions:
            raise CloudContentError(f"database contains unexpected manifest versions: {sorted(extra_versions)}")
        existing_manifest = actual_manifests.get(manifest["version"])
        if existing_manifest is not None and existing_manifest != manifest:
            raise CloudContentError("existing version manifest differs from snapshot")


def import_snapshot(snapshot_dir: Path, database_url: str, root: Path = ROOT) -> None:
    manifest, content, manifest_bytes = validate_snapshot(snapshot_dir, root)
    try:
        import psycopg
        from psycopg.types.json import Jsonb
    except ImportError as exc:
        raise CloudContentError("psycopg is required; install database/requirements.txt") from exc

    with psycopg.connect(database_url) as conn:
        with conn.transaction():
            _verify_database_schema_or_prepare(conn)
            _ensure_empty_or_exact_rows(conn, manifest, content, manifest_bytes)
            _insert_missing_rows(conn, manifest, content, manifest_bytes, Jsonb)
            _verify_full_database(conn, manifest, content, manifest_bytes)


def _verify_database_schema_or_prepare(conn: Any) -> None:
    with conn.cursor() as cursor:
        cursor.execute("SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public'")
        tables = {row[0] for row in cursor.fetchall()}
    expected = {"parks", "boundaries", "r2_objects", "version_manifests"}
    if tables - expected:
        raise CloudContentError(f"unexpected existing public tables: {sorted(tables - expected)}")
    with conn.cursor() as cursor:
        cursor.execute(MIGRATION.read_text(encoding="utf-8"))
    _verify_database_schema(conn)


def _insert_missing_rows(
    conn: Any,
    manifest: dict[str, Any],
    content: dict[str, bytes],
    manifest_bytes: bytes,
    Jsonb: Any,
) -> None:
    parks = _validate_parks(_strict_json(content["data/parks.json"], "data/parks.json"))
    features = _validate_boundaries(_strict_json(content["boundaries.geojson"], "boundaries.geojson"), [park["id"] for park in parks])
    objects = _expected_object_rows(manifest, manifest_bytes)
    with conn.cursor() as cursor:
        for park in parks:
            cursor.execute(
                """
                INSERT INTO public.parks (id, name, short, category, region, lat, lng, biome, shape, rarity, scene, seed, blurb)
                VALUES (%(id)s, %(name)s, %(short)s, %(category)s, %(region)s, %(lat)s, %(lng)s, %(biome)s, %(shape)s, %(rarity)s, %(scene)s, %(seed)s, %(blurb)s)
                ON CONFLICT (id) DO NOTHING
                """,
                park,
            )
        for feature in features:
            park_id = feature["properties"]["id"]
            cursor.execute(
                "INSERT INTO public.boundaries (park_id, feature) VALUES (%s, %s) ON CONFLICT (park_id) DO NOTHING",
                (park_id, Jsonb(feature)),
            )
        for item in objects:
            cursor.execute(
                """
                INSERT INTO public.r2_objects (logical_path, object_key, url, sha256, byte_size, content_type)
                VALUES (%(logical_path)s, %(object_key)s, %(url)s, %(sha256)s, %(byte_size)s, %(content_type)s)
                ON CONFLICT (logical_path) DO NOTHING
                """,
                item,
            )
        cursor.execute(
            "INSERT INTO public.version_manifests (version, manifest) VALUES (%s, %s) ON CONFLICT (version) DO NOTHING",
            (manifest["version"], Jsonb(manifest)),
        )


def _verify_full_database(conn: Any, manifest: dict[str, Any], content: dict[str, bytes], manifest_bytes: bytes) -> None:
    _verify_database_schema(conn)
    parks = _validate_parks(_strict_json(content["data/parks.json"], "data/parks.json"))
    features = _validate_boundaries(_strict_json(content["boundaries.geojson"], "boundaries.geojson"), [park["id"] for park in parks])
    expected_parks = {park["id"]: park for park in parks}
    expected_boundaries = {feature["properties"]["id"]: feature for feature in features}
    expected_objects = {row["logical_path"]: row for row in _expected_object_rows(manifest, manifest_bytes)}
    with conn.cursor() as cursor:
        cursor.execute("SELECT id, name, short, category, region, lat, lng, biome, shape, rarity, scene, seed, blurb FROM public.parks")
        actual_parks = {row[0]: dict(zip(PARK_FIELDS, row, strict=True)) for row in cursor.fetchall()}
        if actual_parks != expected_parks:
            raise CloudContentError("database parks do not exactly match data/parks.json")

        cursor.execute("SELECT park_id, feature FROM public.boundaries")
        actual_boundaries = {row[0]: _dict_json_value(row[1]) for row in cursor.fetchall()}
        if actual_boundaries != expected_boundaries:
            raise CloudContentError("database boundaries do not exactly match boundaries.geojson")

        cursor.execute("SELECT logical_path, object_key, url, sha256, byte_size, content_type FROM public.r2_objects")
        actual_objects = {
            row[0]: dict(zip(("logical_path", "object_key", "url", "sha256", "byte_size", "content_type"), row, strict=True)) for row in cursor.fetchall()
        }
        if actual_objects != expected_objects:
            raise CloudContentError("database R2 object inventory does not exactly match snapshot metadata")

        cursor.execute("SELECT version, manifest FROM public.version_manifests")
        actual_manifests = {row[0]: _dict_json_value(row[1]) for row in cursor.fetchall()}
        if actual_manifests != {manifest["version"]: manifest}:
            raise CloudContentError("database version manifests do not exactly match the snapshot")


def verify_snapshot(snapshot_dir: Path, database_url: str, root: Path = ROOT) -> None:
    manifest, content, manifest_bytes = validate_snapshot(snapshot_dir, root)
    try:
        import psycopg
    except ImportError as exc:
        raise CloudContentError("psycopg is required; install database/requirements.txt") from exc
    with psycopg.connect(database_url) as conn:
        _verify_database_schema(conn)
        _verify_full_database(conn, manifest, content, manifest_bytes)


def _command_snapshot(args: argparse.Namespace) -> None:
    root = Path(args.root).resolve() if args.root else ROOT
    map_source = Path(args.map_source).resolve() if args.map_source else _default_map_source(root)
    manifest = build_snapshot(root, map_source, Path(args.output_dir), args.cdn_origin, args.source_commit)
    print(f"snapshot {manifest['version']}: {len(manifest['files'])} files, {len(manifest['parkIds'])} parks")


def _database_url(args: argparse.Namespace) -> str:
    database_url = args.database_url or os.environ.get("DATABASE_URL")
    if not database_url:
        raise CloudContentError("set DATABASE_URL or pass --database-url")
    return database_url


def _command_import(args: argparse.Namespace) -> None:
    import_snapshot(Path(args.snapshot), _database_url(args), Path(args.root).resolve() if args.root else ROOT)
    manifest, _, _ = validate_snapshot(Path(args.snapshot), Path(args.root).resolve() if args.root else ROOT)
    print(f"imported verified content version {manifest['version']}")


def _command_verify(args: argparse.Namespace) -> None:
    verify_snapshot(Path(args.snapshot), _database_url(args), Path(args.root).resolve() if args.root else ROOT)
    manifest, content, _ = validate_snapshot(Path(args.snapshot), Path(args.root).resolve() if args.root else ROOT)
    print(f"verified content version {manifest['version']}: {len(content)} files, {len(manifest['parkIds'])} parks")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    snapshot_parser = subparsers.add_parser("snapshot", help="copy committed app content and ignored map files into a release snapshot")
    snapshot_parser.add_argument("--output-dir", required=True)
    snapshot_parser.add_argument("--map-source", help="directory containing island/ and fonts/; defaults to the canonical workspace map")
    snapshot_parser.add_argument("--cdn-origin", default=CDN_ORIGIN)
    snapshot_parser.add_argument("--source-commit", help="Git commit to pin the tracked JSON and art sources to")
    snapshot_parser.add_argument("--root", help=argparse.SUPPRESS)
    snapshot_parser.set_defaults(run=_command_snapshot)

    for command, help_text in (
        ("import", "apply the idempotent schema and import an immutable baseline snapshot"),
        ("verify", "verify database schema and all rows against the original snapshot bytes"),
    ):
        command_parser = subparsers.add_parser(command, help=help_text)
        command_parser.add_argument("--snapshot", required=True)
        command_parser.add_argument("--database-url", help="defaults to DATABASE_URL")
        command_parser.add_argument("--root", help=argparse.SUPPRESS)
        command_parser.set_defaults(run=_command_import if command == "import" else _command_verify)

    args = parser.parse_args(argv)
    try:
        args.run(args)
    except CloudContentError as exc:
        print(f"cloud-content: {exc}", file=sys.stderr)
        return 2
    except Exception as exc:
        print(f"cloud-content: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Build a deterministic map-only R2 manifest from the pinned catalogue inventory."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path
from urllib.parse import quote


ROOT = Path(__file__).resolve().parent.parent
CDN_ORIGIN = "https://kip-assets.parkdex.app"
HEX_SHA256 = re.compile(r"^[a-f0-9]{64}$")
MAP_SCHEMA = "parkdex.content-map/v1"


class MapManifestError(ValueError):
    pass


def canonical_json(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def build_manifest(source: Path) -> tuple[dict, bytes, dict]:
    try:
        baseline = json.loads(source.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise MapManifestError(f"could not read the pinned content manifest: {exc}") from exc
    if not isinstance(baseline, dict) or not isinstance(baseline.get("version"), str):
        raise MapManifestError("pinned content manifest has an invalid shape")
    map_manifest = baseline.get("mapManifest")
    if not isinstance(map_manifest, dict) or set(map_manifest) != {"size", "chunkBytes", "count"}:
        raise MapManifestError("pinned mapManifest must contain size, chunkBytes, and count")
    size, chunk_bytes, count = (map_manifest[key] for key in ("size", "chunkBytes", "count"))
    if any(type(value) is not int or value <= 0 for value in (size, chunk_bytes, count)):
        raise MapManifestError("mapManifest values must be positive integers")
    if count != (size + chunk_bytes - 1) // chunk_bytes:
        raise MapManifestError("mapManifest count does not match size and chunkBytes")

    raw_files = baseline.get("files")
    if not isinstance(raw_files, list):
        raise MapManifestError("pinned content manifest files must be an array")
    by_path: dict[str, dict] = {}
    expected_island = {"map/island/manifest.json"} | {f"map/island/{index:03d}.bin" for index in range(count)}
    for raw in raw_files:
        if not isinstance(raw, dict) or not isinstance(raw.get("path"), str):
            raise MapManifestError("content file descriptor is invalid")
        path = raw["path"]
        if path.startswith("map/"):
            if path in by_path:
                raise MapManifestError(f"duplicate map path: {path}")
            by_path[path] = raw
    actual_island = {path for path in by_path if path.startswith("map/island/")}
    if actual_island != expected_island:
        raise MapManifestError("pinned map chunks do not match mapManifest")
    font_paths = {path for path in by_path if path.startswith("map/fonts/")}
    if not font_paths or any(not path.endswith(".pbf") for path in font_paths):
        raise MapManifestError("map-only manifest needs only .pbf glyph files under map/fonts/")
    unexpected = set(by_path) - expected_island - font_paths
    if unexpected:
        raise MapManifestError(f"unexpected map files: {sorted(unexpected)[:5]}")

    fields = {"path", "key", "url", "sha256", "byte_size", "content_type"}
    files: list[dict] = []
    for path in sorted(by_path):
        item = by_path[path]
        if set(item) != fields:
            raise MapManifestError(f"descriptor fields are invalid for {path}")
        if not isinstance(item["sha256"], str) or not HEX_SHA256.fullmatch(item["sha256"]):
            raise MapManifestError(f"descriptor hash is invalid for {path}")
        if type(item["byte_size"]) is not int or item["byte_size"] <= 0:
            raise MapManifestError(f"descriptor byte_size is invalid for {path}")
        if not isinstance(item["key"], str) or not item["key"].startswith(f"releases/{baseline['version']}/"):
            raise MapManifestError(f"descriptor key is not from the pinned release for {path}")
        if item["url"] != f"{CDN_ORIGIN}/{quote(item['key'], safe='/')}":
            raise MapManifestError(f"descriptor URL does not match its key for {path}")
        expected_type = "application/json" if path.endswith(".json") else "application/octet-stream" if path.endswith(".bin") else "application/x-protobuf"
        if item["content_type"] != expected_type:
            raise MapManifestError(f"descriptor MIME type is invalid for {path}")
        files.append({key: item[key] for key in sorted(fields)})

    version_inventory = {
        "mapManifest": map_manifest,
        "files": [{key: item[key] for key in ("path", "sha256", "byte_size")} for item in files],
    }
    version = hashlib.sha256(canonical_json(version_inventory)).hexdigest()
    manifest = {
        "schema": MAP_SCHEMA,
        "version": version,
        "mapManifest": {"size": size, "chunkBytes": chunk_bytes, "count": count},
        "files": files,
    }
    manifest_bytes = canonical_json(manifest) + b"\n"
    manifest_sha256 = hashlib.sha256(manifest_bytes).hexdigest()
    report = {
        "schema": MAP_SCHEMA,
        "version": version,
        "manifestUrl": f"{CDN_ORIGIN}/releases/{version}/map/manifest.json",
        "manifestSha256": manifest_sha256,
        "manifestBytes": len(manifest_bytes),
        "fileCount": len(files),
        "fileBytes": sum(item["byte_size"] for item in files),
    }
    return manifest, manifest_bytes, report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-manifest", type=Path, default=ROOT / "database" / "content-manifest.json")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        _, manifest_bytes, report = build_manifest(args.source_manifest)
        output = args.output.resolve()
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(manifest_bytes)
        print(json.dumps({**report, "output": str(output)}, separators=(",", ":")))
        return 0
    except (MapManifestError, OSError) as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

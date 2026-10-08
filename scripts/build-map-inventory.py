#!/usr/bin/env python3
"""Split a detailed PMTiles archive into chunks and build its map-only R2 inventory.

The output directory mirrors R2 keys:
  releases/<version>/map/island/NNN.bin       archive chunks
  releases/<version>/map/island/manifest.json the chunk layout read by the app
  releases/<version>/map/manifest.json        the parkdex.content-map/v1 inventory

Glyph descriptors are reused from an existing published inventory, so their
immutable objects are not uploaded again. The printed report is the map pointer
(version, manifestUrl, manifestSha256) that the app pins.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from urllib.parse import quote

CDN_ORIGIN = "https://kip-assets.parkdex.app"
MAP_SCHEMA = "parkdex.content-map/v1"
MAX_CHUNK_BYTES = 4 * 1024 * 1024


def canonical_json(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def descriptor(path: str, key: str, data: bytes, content_type: str) -> dict:
    return {
        "byte_size": len(data),
        "content_type": content_type,
        "key": key,
        "path": path,
        "sha256": hashlib.sha256(data).hexdigest(),
        "url": f"{CDN_ORIGIN}/{quote(key, safe='/')}",
    }


def font_descriptors(source: Path) -> list[dict]:
    inventory = json.loads(source.read_text(encoding="utf-8"))
    if inventory.get("schema") != MAP_SCHEMA:
        raise ValueError("glyph source is not a map inventory")
    fonts = [item for item in inventory["files"] if item["path"].startswith("map/fonts/")]
    if not fonts:
        raise ValueError("glyph source has no map/fonts descriptors")
    return fonts


def build(archive: Path, chunk_bytes: int, glyph_source: Path, output: Path) -> dict:
    if chunk_bytes <= 0 or chunk_bytes > MAX_CHUNK_BYTES:
        raise ValueError(f"chunk size must be between 1 and {MAX_CHUNK_BYTES} bytes")
    data = archive.read_bytes()
    size = len(data)
    count = (size + chunk_bytes - 1) // chunk_bytes
    layout = {"size": size, "chunkBytes": chunk_bytes, "count": count}
    layout_bytes = json.dumps(layout, separators=(",", ":")).encode("utf-8")

    chunks = [data[index * chunk_bytes:(index + 1) * chunk_bytes] for index in range(count)]
    entries: list[tuple[str, bytes, str]] = [("map/island/manifest.json", layout_bytes, "application/json")]
    entries += [(f"map/island/{index:03d}.bin", chunk, "application/octet-stream") for index, chunk in enumerate(chunks)]
    fonts = font_descriptors(glyph_source)

    # The version covers paths, hashes and sizes only, so it can be computed before keys exist.
    version_files = [
        {"path": path, "sha256": hashlib.sha256(blob).hexdigest(), "byte_size": len(blob)} for path, blob, _ in entries
    ] + [{"path": item["path"], "sha256": item["sha256"], "byte_size": item["byte_size"]} for item in fonts]
    version_files.sort(key=lambda item: item["path"])
    version = hashlib.sha256(canonical_json({"mapManifest": layout, "files": version_files})).hexdigest()

    release = output / "releases" / version
    files = []
    for path, blob, content_type in entries:
        target = release / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(blob)
        files.append(descriptor(path, f"releases/{version}/{path}", blob, content_type))
    files += [{key: item[key] for key in sorted(item)} for item in fonts]
    files.sort(key=lambda item: item["path"])

    inventory = {"schema": MAP_SCHEMA, "version": version, "mapManifest": layout, "files": files}
    inventory_bytes = canonical_json(inventory) + b"\n"
    (release / "map" / "manifest.json").write_bytes(inventory_bytes)
    return {
        "version": version,
        "manifestUrl": f"{CDN_ORIGIN}/releases/{version}/map/manifest.json",
        "manifestSha256": hashlib.sha256(inventory_bytes).hexdigest(),
        "mapManifest": layout,
        "uploadObjects": len(entries) + 1,
        "uploadBytes": sum(len(blob) for _, blob, _ in entries) + len(inventory_bytes),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--chunk-bytes", type=int, default=512 * 1024)
    parser.add_argument("--glyph-source", type=Path, required=True, help="a published map inventory whose glyph objects are reused")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        report = build(args.archive, args.chunk_bytes, args.glyph_source, args.output.resolve())
    except (OSError, ValueError, KeyError) as exc:
        print(str(exc), file=sys.stderr)
        return 1
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

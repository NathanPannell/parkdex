#!/usr/bin/env python3
"""Build, publish-check and point to an immutable CDN content catalogue release.

Newer app builds (content reader 3) load the whole park catalogue from these
files instead of one snapshot response, because installed builds and the API
reject responses over 4 MiB. See docs/content-catalogue.md.

  build  Read one database at one content revision and write a release
         directory that scripts/publish_content.py can upload unchanged.
  point  Verify a built release (and, unless told otherwise, its public CDN
         copy) and set public.content_catalogue to it in one transaction.

build only reads. point writes only with --apply.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sys
from typing import Any
from urllib.parse import quote

CDN_ORIGIN = "https://kip-assets.parkdex.app"
INDEX_SCHEMA = "parkdex.content-catalogue/v1"
CHUNK_SCHEMA = "parkdex.content-boundaries/v1"
RELEASE_SCHEMA = "parkdex.content-catalogue-release/v1"
CONTENT_SYNC_SCHEMA = "parkdex.content-sync/v1"
INDEX_PATH = "catalogue/index.json"
CHUNK_DIR = "catalogue/boundaries"
DEFAULT_MINIMUM_READER = 3
# Each chunk stays far below the 4 MiB client limit and compresses to about a
# quarter on the CDN, so a phone fetches a few dozen small immutable files.
TARGET_CHUNK_BYTES = 512 * 1024
MAX_FILE_BYTES = 4 * 1024 * 1024
# Chunks group parks by 2-degree cell of their pin, so a chunk covers one area.
CELL_DEGREES = 2
SHA256_RE = re.compile(r"^[a-f0-9]{64}$")
ENVIRONMENT_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")
PARK_COLUMNS = ("id", "name", "short", "category", "region", "lat", "lng", "biome", "shape", "rarity", "scene", "seed", "blurb")
ACCESS_FIELDS = ("googleMapsUrl", "trailheadLat", "trailheadLng")


class CatalogueError(ValueError):
    """Safe, actionable catalogue error."""


def compact(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")


def sha256(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def cell_of(park: dict[str, Any]) -> tuple[int, int]:
    return (math.floor(park["lng"] / CELL_DEGREES), math.floor(park["lat"] / CELL_DEGREES))


def feature_bbox(feature: dict[str, Any]) -> list[float]:
    xs: list[float] = []
    ys: list[float] = []
    for polygon in feature["geometry"]["coordinates"]:
        for ring in polygon:
            for x, y in ring:
                xs.append(x)
                ys.append(y)
    return [min(xs), min(ys), max(xs), max(ys)]


def chunk_boundaries(parks: list[dict[str, Any]], features: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    """Group boundaries by pin cell, then cut each run of cells at the target size."""
    by_id = {feature["properties"]["id"]: feature for feature in features}
    if set(by_id) != {park["id"] for park in parks} or len(by_id) != len(features):
        raise CatalogueError("Boundary ids do not match the park set")
    ordered = sorted(parks, key=lambda park: (cell_of(park), park["id"]))
    chunks: list[list[dict[str, Any]]] = []
    current: list[dict[str, Any]] = []
    size = 0
    for park in ordered:
        feature = by_id[park["id"]]
        feature_size = len(compact(feature))
        if feature_size > MAX_FILE_BYTES - 1024:
            raise CatalogueError(f"Boundary {park['id']} alone exceeds the content file limit")
        if current and size + feature_size > TARGET_CHUNK_BYTES:
            chunks.append(current)
            current, size = [], 0
        current.append(feature)
        size += feature_size + 1
    if current:
        chunks.append(current)
    return chunks


def build_release(snapshot: dict[str, Any], minimum_reader: int = DEFAULT_MINIMUM_READER) -> dict[str, Any]:
    """Turn one full snapshot (reader 3 shape) into index, chunk files and the R2 manifest."""
    if snapshot.get("schema") != CONTENT_SYNC_SCHEMA:
        raise CatalogueError("Snapshot schema is unsupported")
    parks = snapshot["parks"]
    features = snapshot["boundaries"]["features"]
    chunk_files: list[tuple[str, bytes]] = []
    descriptors: list[dict[str, Any]] = []
    for number, chunk in enumerate(chunk_boundaries(parks, features)):
        path = f"{CHUNK_DIR}/{number:03d}.json"
        raw = compact({"schema": CHUNK_SCHEMA, "features": chunk})
        if len(raw) > MAX_FILE_BYTES:
            raise CatalogueError(f"Boundary chunk {path} exceeds the content file limit")
        boxes = [feature_bbox(feature) for feature in chunk]
        descriptors.append(
            {
                "path": path,
                "sha256": sha256(raw),
                "byte_size": len(raw),
                "parkIds": [feature["properties"]["id"] for feature in chunk],
                "bbox": [min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes)],
            }
        )
        chunk_files.append((path, raw))
    index = {
        "schema": INDEX_SCHEMA,
        "revision": snapshot["revision"],
        "parks": parks,
        "drive": snapshot["drive"],
        "assets": snapshot["assets"],
        "map": snapshot["map"],
        "boundaryChunks": descriptors,
    }
    index_raw = compact(index)
    if len(index_raw) > MAX_FILE_BYTES:
        raise CatalogueError("Catalogue index exceeds the content file limit")
    # The index names every chunk by hash, so its hash identifies the whole release.
    version = sha256(index_raw)
    files = [(INDEX_PATH, index_raw), *chunk_files]
    prefix = f"releases/{version}/"
    manifest = {
        "schema": RELEASE_SCHEMA,
        "version": version,
        "cdnOrigin": CDN_ORIGIN,
        "revision": snapshot["revision"],
        "minimumReader": minimum_reader,
        "parkCount": len(parks),
        "files": [
            {
                "path": path,
                "key": prefix + path,
                "url": f"{CDN_ORIGIN}/{quote(prefix + path, safe='/')}",
                "sha256": sha256(raw),
                "byte_size": len(raw),
                "content_type": "application/json",
            }
            for path, raw in files
        ],
    }
    pointer = {
        "version": version,
        "revision": snapshot["revision"],
        "minimumReader": minimum_reader,
        "indexUrl": f"{CDN_ORIGIN}/{prefix}{INDEX_PATH}",
        "indexSha256": version,
        "indexBytes": len(index_raw),
        "parkCount": len(parks),
    }
    return {"manifest": manifest, "files": files, "pointer": pointer}


def write_release(release: dict[str, Any], out: Path, source: dict[str, Any]) -> dict[str, Any]:
    out = out.expanduser().resolve()
    content = out / "content"
    for path, raw in release["files"]:
        target = content / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(raw)
    (out / "manifest.json").write_bytes(json.dumps(release["manifest"], ensure_ascii=False, indent=2).encode("utf-8") + b"\n")
    pointer = {**release["pointer"], "source": source}
    (out / "pointer.json").write_bytes(json.dumps(pointer, ensure_ascii=False, indent=2).encode("utf-8") + b"\n")
    sizes = [item["byte_size"] for item in release["manifest"]["files"][1:]]
    return {
        "releaseDir": str(out),
        "version": release["pointer"]["version"],
        "revision": release["pointer"]["revision"],
        "parkCount": release["pointer"]["parkCount"],
        "indexBytes": release["pointer"]["indexBytes"],
        "chunkCount": len(sizes),
        "chunkBytesTotal": sum(sizes),
        "largestChunkBytes": max(sizes) if sizes else 0,
    }


def load_release(directory: Path) -> tuple[dict[str, Any], dict[str, Any]]:
    """Read a built release and check every file against its manifest and the pointer."""
    directory = directory.expanduser().resolve()
    try:
        manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
        pointer = json.loads((directory / "pointer.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise CatalogueError(f"Could not read the release ({type(exc).__name__})") from None
    if manifest.get("schema") != RELEASE_SCHEMA or not SHA256_RE.fullmatch(str(manifest.get("version"))):
        raise CatalogueError("Release manifest is not a content catalogue release")
    for item in manifest["files"]:
        raw = (directory / "content" / item["path"]).read_bytes()
        if len(raw) != item["byte_size"] or sha256(raw) != item["sha256"]:
            raise CatalogueError(f"Release file changed after build: {item['path']}")
    index = next(item for item in manifest["files"] if item["path"] == INDEX_PATH)
    expected = {
        "version": manifest["version"],
        "revision": manifest["revision"],
        "minimumReader": manifest["minimumReader"],
        "indexUrl": index["url"],
        "indexSha256": index["sha256"],
        "indexBytes": index["byte_size"],
        "parkCount": manifest["parkCount"],
    }
    if {key: pointer.get(key) for key in expected} != expected or index["sha256"] != manifest["version"]:
        raise CatalogueError("Release pointer does not match its manifest")
    return manifest, pointer


# Database access. psycopg is imported lazily so unit tests run without it.


def _connect():
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        raise CatalogueError("Set DATABASE_URL to the intended target database")
    try:
        import psycopg
    except ImportError:
        raise CatalogueError("psycopg is required; install database/requirements.txt") from None
    try:
        return psycopg.connect(database_url)
    except psycopg.Error as exc:
        raise CatalogueError(f"Could not connect to target database ({type(exc).__name__})") from None


def _identity(conn, target_host: str, environment: str) -> dict[str, Any]:
    info = conn.info
    identity = {"host": info.host or "", "port": info.port, "database": info.dbname, "environment": environment}
    if identity["host"] != target_host:
        raise CatalogueError(f"Declared target host {target_host!r} does not match connected host {identity['host']!r}")
    return identity


def _json(value: Any) -> Any:
    return json.loads(value) if isinstance(value, str) else value


def read_full_snapshot(conn) -> dict[str, Any]:
    """Every park that is not hidden, whatever its reader floor, in the reader 3 snapshot shape."""
    with conn.cursor() as cursor:
        cursor.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        cursor.execute("SELECT revision FROM public.content_clock WHERE singleton = true")
        revision = cursor.fetchone()[0]
        cursor.execute(
            "SELECT id, name, short, category, region, lat, lng, biome, shape, rarity, scene, seed, blurb, "
            "google_maps_url, trailhead_lat, trailhead_lng FROM public.parks ORDER BY id"
        )
        parks = []
        for row in cursor.fetchall():
            park = dict(zip(PARK_COLUMNS, row[:13], strict=True))
            park.update(dict(zip(ACCESS_FIELDS, row[13:], strict=True)))
            parks.append(park)
        cursor.execute("SELECT park_id, feature FROM public.boundaries ORDER BY park_id")
        features = [_json(row[1]) for row in cursor.fetchall()]
        cursor.execute("SELECT name, lng, lat FROM public.drive_hubs ORDER BY position")
        hubs = [{"name": row[0], "lng": row[1], "lat": row[2]} for row in cursor.fetchall()]
        cursor.execute("SELECT park_id, walk_m FROM public.park_drive_settings ORDER BY park_id")
        walk = {row[0]: row[1] for row in cursor.fetchall()}
        cursor.execute("SELECT park_id, hub_position, distance_km, duration_min FROM public.park_drive ORDER BY park_id, hub_position")
        routes: dict[str, list[Any]] = {}
        for park_id, _position, distance, duration in cursor.fetchall():
            routes.setdefault(park_id, []).append(None if distance is None or duration is None else [distance, duration])
        cursor.execute(
            "SELECT DISTINCT asset.logical_path, asset.object_key, asset.url, asset.sha256, asset.byte_size, asset.content_type "
            "FROM public.parks AS park JOIN public.r2_objects AS asset "
            "ON asset.logical_path = 'art/badges/scenes/' || park.scene || '.webp' "
            "WHERE park.scene IS NOT NULL ORDER BY asset.logical_path"
        )
        assets = [dict(zip(("path", "key", "url", "sha256", "byte_size", "content_type"), row, strict=True)) for row in cursor.fetchall()]
        cursor.execute("SELECT version, manifest_url, manifest_sha256 FROM public.content_map WHERE singleton = true")
        map_row = cursor.fetchone()
        cursor.execute("SELECT to_regclass('public.content_park_hidden') IS NOT NULL")
        hidden: set[str] = set()
        if cursor.fetchone()[0]:
            cursor.execute("SELECT park_id FROM public.content_park_hidden")
            hidden = {row[0] for row in cursor.fetchall()}
    conn.rollback()
    # Hidden parks (content_005_park_visibility.sql) stay in the database but leave every release.
    parks = [park for park in parks if park["id"] not in hidden]
    features = [feature for feature in features if feature["properties"]["id"] not in hidden]
    walk = {key: value for key, value in walk.items() if key not in hidden}
    routes = {key: value for key, value in routes.items() if key not in hidden}
    scenes = {f"art/badges/scenes/{park['scene']}.webp" for park in parks if park["scene"]}
    assets = [asset for asset in assets if asset["path"] in scenes]
    ids = [park["id"] for park in parks]
    if set(walk) != set(ids) or set(routes) != set(ids) or any(len(routes[i]) != len(hubs) for i in ids):
        raise CatalogueError("Drive rows are incomplete for the park set")
    return {
        "schema": CONTENT_SYNC_SCHEMA,
        "revision": revision,
        "parks": parks,
        "boundaries": {"type": "FeatureCollection", "features": features},
        "drive": {"hubs": hubs, "parks": {i: {"drive": routes[i], "walkM": walk[i]} for i in ids}},
        "assets": assets,
        "map": None if map_row is None else {"version": map_row[0], "manifestUrl": map_row[1], "manifestSha256": map_row[2]},
    }


def verify_cdn(manifest: dict[str, Any]) -> None:
    import requests

    for item in manifest["files"]:
        response = requests.get(item["url"], timeout=90)
        if response.status_code != 200 or len(response.content) != item["byte_size"] or sha256(response.content) != item["sha256"]:
            raise CatalogueError(f"CDN copy of {item['path']} is missing or different ({response.status_code}); upload the release first")


def set_pointer(conn, pointer: dict[str, Any], apply: bool) -> dict[str, Any]:
    with conn.transaction():
        with conn.cursor() as cursor:
            cursor.execute("SELECT revision, retention_floor FROM public.content_clock WHERE singleton = true FOR UPDATE")
            head, floor = cursor.fetchone()
            if pointer["revision"] > head:
                raise CatalogueError("Release revision is newer than this database; it was built from another database")
            if pointer["revision"] < floor:
                raise CatalogueError("Release revision is older than the retained change history; build a new release")
            cursor.execute("SELECT version, revision FROM public.content_catalogue WHERE singleton = true FOR UPDATE")
            current = cursor.fetchone()
            if current is not None and current[1] > pointer["revision"]:
                raise CatalogueError("A newer catalogue release is already published")
            result = {
                "headRevision": head,
                "retentionFloor": floor,
                "previous": None if current is None else {"version": current[0], "revision": current[1]},
                "next": {"version": pointer["version"], "revision": pointer["revision"]},
                "changesToReplay": head - pointer["revision"],
            }
            if current is not None and current[0] == pointer["version"]:
                return {**result, "result": "already-current"}
            if not apply:
                return {**result, "result": "dry-run"}
            cursor.execute(
                "INSERT INTO public.content_catalogue "
                "(singleton, version, revision, minimum_reader, index_url, index_sha256, index_bytes, park_count, published_at) "
                "VALUES (true, %s, %s, %s, %s, %s, %s, %s, clock_timestamp()) "
                "ON CONFLICT (singleton) DO UPDATE SET version = EXCLUDED.version, revision = EXCLUDED.revision, "
                "minimum_reader = EXCLUDED.minimum_reader, index_url = EXCLUDED.index_url, index_sha256 = EXCLUDED.index_sha256, "
                "index_bytes = EXCLUDED.index_bytes, park_count = EXCLUDED.park_count, published_at = EXCLUDED.published_at",
                (
                    pointer["version"],
                    pointer["revision"],
                    pointer["minimumReader"],
                    pointer["indexUrl"],
                    pointer["indexSha256"],
                    pointer["indexBytes"],
                    pointer["parkCount"],
                ),
            )
            return {**result, "result": "applied"}


def run_build(args: argparse.Namespace) -> dict[str, Any]:
    if not ENVIRONMENT_RE.fullmatch(args.target_environment):
        raise CatalogueError("Target environment must be a lowercase label such as staging or production")
    with _connect() as conn:
        identity = _identity(conn, args.target_host, args.target_environment)
        snapshot = read_full_snapshot(conn)
    release = build_release(snapshot, args.minimum_reader)
    return write_release(release, args.out, identity)


def run_point(args: argparse.Namespace) -> dict[str, Any]:
    manifest, pointer = load_release(args.release)
    source = pointer.get("source", {})
    if source.get("host") != args.expected_target_host or source.get("environment") != args.target_environment:
        raise CatalogueError("Release was built from a different database or environment")
    if not args.skip_cdn_check:
        verify_cdn(manifest)
    with _connect() as conn:
        identity = _identity(conn, args.expected_target_host, args.target_environment)
        if {key: identity[key] for key in ("host", "port", "database")} != {key: source.get(key) for key in ("host", "port", "database")}:
            raise CatalogueError("Connected database does not match the database the release was built from")
        return {"version": pointer["version"], **set_pointer(conn, pointer, args.apply)}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    build = commands.add_parser("build", help="write a release directory from DATABASE_URL (read only)")
    build.add_argument("--out", type=Path, required=True)
    build.add_argument("--target-host", required=True)
    build.add_argument("--target-environment", required=True)
    build.add_argument("--minimum-reader", type=int, default=DEFAULT_MINIMUM_READER)
    build.set_defaults(run=run_build)
    point = commands.add_parser("point", help="publish a built and uploaded release to readers")
    point.add_argument("--release", type=Path, required=True)
    point.add_argument("--expected-target-host", required=True)
    point.add_argument("--target-environment", required=True)
    point.add_argument("--skip-cdn-check", action="store_true", help="only for local dry runs")
    point.add_argument("--apply", action="store_true")
    point.set_defaults(run=run_point)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        result = args.run(args)
    except CatalogueError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    except Exception as exc:
        print(f"Content catalogue failed ({type(exc).__name__})", file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

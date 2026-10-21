#!/usr/bin/env python3
"""Build, plan and apply the OpenStreetMap park outline table (kip_osm.parks).

The "propose a park" search reads this table instead of live Overpass and Nominatim. The table
holds several extracts side by side, one source ID each (bc, nova-scotia), and a load only ever
touches its own source's outlines.

  extract  operator only: a Geofabrik .osm.pbf extract to a slim GeoJSON-lines file plus a
           manifest naming its source ID. Needs pyosmium and Shapely; CI never runs it.
  plan     read only: validate the slim file and capture that source's state in the target
           table into a hash-pinned plan.
  apply    replace that source's outlines with the planned file in one transaction. Other
           sources are untouched. Re-applying the same extract is a no-op, and an older extract
           than the one loaded for the same source is refused.
  status   read only: every loaded source with its date and outline counts.

See docs/osm-park-index.md.
"""

from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sys
from typing import Any, Iterable

SCHEMA = "parkdex.osm-park-index.v2"
MANIFEST_SCHEMA = "parkdex.osm-park-extract.v2"
LEISURE = {"park", "nature_reserve", "garden", "dog_park", "common", "recreation_ground"}
BOUNDARY = {"protected_area", "national_park"}
KEEP_TAGS = ("name", "leisure", "boundary", "landuse", "protect_class", "protection_title", "operator", "access", "designation")
# About 5 m at BC latitudes: faithful enough for check-ins, about 18 MB for the province.
SIMPLIFY_DEG = 0.00005
KIND_RE = re.compile(r"^(leisure|boundary|landuse)=[a-z_]+$")
ENV_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")
# One per Geofabrik extract, such as bc or nova-scotia; the same pattern the table checks.
SOURCE_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,39}$")
CONTROL_CHARS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
M_PER_DEG_LAT = 110_540.0
MAX_SOURCE_BYTES = 256 * 1024 * 1024
COLUMNS = ("osm_type", "osm_id", "name", "kind", "tags", "min_lat", "max_lat", "min_lng", "max_lng", "area_m2", "geometry", "source_date", "source_id")


class OsmIndexError(ValueError):
    """Safe, actionable input, plan or load error."""


# ---------------------------------------------------------------- tags


def kind_of(tags: dict[str, str]) -> str | None:
    """The tag that makes an area park-like, in the same order the API reports it."""
    if tags.get("leisure") in LEISURE:
        return f"leisure={tags['leisure']}"
    if tags.get("boundary") in BOUNDARY:
        return f"boundary={tags['boundary']}"
    if tags.get("landuse") == "recreation_ground":
        return "landuse=recreation_ground"
    return None


def is_public(tags: dict[str, str]) -> bool:
    return tags.get("access") not in ("private", "no")


# ---------------------------------------------------------------- geometry


def _ring(value: Any, label: str) -> list[list[float]]:
    if not isinstance(value, list) or len(value) < 4:
        raise OsmIndexError(f"{label} needs at least four positions")
    ring: list[list[float]] = []
    for position in value:
        if not isinstance(position, list) or len(position) < 2:
            raise OsmIndexError(f"{label} has a malformed position")
        lng, lat = position[0], position[1]
        if not all(isinstance(item, (int, float)) and not isinstance(item, bool) and math.isfinite(item) for item in (lng, lat)):
            raise OsmIndexError(f"{label} has a non-finite coordinate")
        if not (-180 <= lng <= 180 and -90 <= lat <= 90):
            raise OsmIndexError(f"{label} has a coordinate out of range")
        ring.append([round(float(lng), 7), round(float(lat), 7)])
    if ring[0] != ring[-1]:
        raise OsmIndexError(f"{label} is not closed")
    return ring


def normalize_geometry(value: Any, label: str) -> dict[str, Any]:
    """A Polygon or MultiPolygon as a MultiPolygon, every part and hole kept in order."""
    if not isinstance(value, dict):
        raise OsmIndexError(f"{label} has no geometry")
    if value.get("type") == "Polygon":
        polygons = [value.get("coordinates")]
    elif value.get("type") == "MultiPolygon":
        polygons = value.get("coordinates")
    else:
        raise OsmIndexError(f"{label} geometry must be a Polygon or MultiPolygon")
    if not isinstance(polygons, list) or not polygons:
        raise OsmIndexError(f"{label} geometry is empty")
    coordinates = []
    for index, polygon in enumerate(polygons):
        if not isinstance(polygon, list) or not polygon:
            raise OsmIndexError(f"{label} polygon {index} is empty")
        coordinates.append([_ring(ring, f"{label} polygon {index} ring {position}") for position, ring in enumerate(polygon)])
    return {"type": "MultiPolygon", "coordinates": coordinates}


def ring_area_m2(ring: list[list[float]]) -> float:
    """Shoelace area on a local flat projection, the same as the API's worker/osmParks.ts."""
    kx = 111_320.0 * math.cos(math.radians(ring[0][1]))
    total = 0.0
    for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
        total += (x1 * kx) * (y2 * M_PER_DEG_LAT) - (x2 * kx) * (y1 * M_PER_DEG_LAT)
    return abs(total) / 2


def area_m2(geometry: dict[str, Any]) -> float:
    area = 0.0
    for outer, *holes in geometry["coordinates"]:
        area += ring_area_m2(outer) - sum(ring_area_m2(hole) for hole in holes)
    return max(0.0, area)


def bbox(geometry: dict[str, Any]) -> tuple[float, float, float, float]:
    lngs = [point[0] for polygon in geometry["coordinates"] for ring in polygon for point in ring]
    lats = [point[1] for polygon in geometry["coordinates"] for ring in polygon for point in ring]
    return min(lats), max(lats), min(lngs), max(lngs)


# ---------------------------------------------------------------- slim file


def validate_record(record: Any, line_number: int) -> dict[str, Any]:
    label = f"line {line_number}"
    if not isinstance(record, dict):
        raise OsmIndexError(f"{label} is not an object")
    osm_type, osm_id, kind, tags = record.get("type"), record.get("id"), record.get("kind"), record.get("tags")
    if osm_type not in ("way", "relation"):
        raise OsmIndexError(f"{label} type must be way or relation")
    if not isinstance(osm_id, int) or isinstance(osm_id, bool) or osm_id <= 0:
        raise OsmIndexError(f"{label} id must be a positive integer")
    if not isinstance(tags, dict) or any(not isinstance(key, str) or not isinstance(value, str) for key, value in tags.items()):
        raise OsmIndexError(f"{label} tags must map text to text")
    tags = {key: CONTROL_CHARS.sub(" ", value).strip()[:300] for key, value in tags.items() if key in KEEP_TAGS}
    if not isinstance(kind, str) or not KIND_RE.fullmatch(kind) or kind != kind_of(tags):
        raise OsmIndexError(f"{label} kind does not match its tags")
    if not is_public(tags):
        raise OsmIndexError(f"{label} is a private area")
    geometry = normalize_geometry(record.get("geometry"), label)
    name = tags.get("name") or None
    min_lat, max_lat, min_lng, max_lng = bbox(geometry)
    return {
        "osm_type": osm_type,
        "osm_id": osm_id,
        "name": name,
        "kind": kind,
        "tags": tags,
        "min_lat": min_lat,
        "max_lat": max_lat,
        "min_lng": min_lng,
        "max_lng": max_lng,
        "area_m2": round(area_m2(geometry), 1),
        "geometry": geometry,
    }


def read_slim(path: Path) -> tuple[list[dict[str, Any]], str, int]:
    """Every record validated, with the file's SHA-256 and size."""
    path = path.expanduser().resolve()
    try:
        raw = path.read_bytes()
    except OSError as exc:
        raise OsmIndexError(f"Could not read the slim file ({type(exc).__name__})") from None
    if len(raw) > MAX_SOURCE_BYTES:
        raise OsmIndexError("The slim file is larger than 256 MB")
    rows: list[dict[str, Any]] = []
    seen: set[tuple[str, int]] = set()
    for number, line in enumerate(raw.decode("utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            raise OsmIndexError(f"line {number} is not JSON") from None
        row = validate_record(record, number)
        key = (row["osm_type"], row["osm_id"])
        if key in seen:
            raise OsmIndexError(f"line {number} repeats {key[0]}/{key[1]}")
        seen.add(key)
        rows.append(row)
    if not rows:
        raise OsmIndexError("The slim file has no parks")
    return rows, hashlib.sha256(raw).hexdigest(), len(raw)


def read_manifest(source: Path, sha256: str) -> dict[str, Any]:
    path = manifest_path(source)
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        raise OsmIndexError(f"Could not read the manifest {path.name}; run extract again") from None
    if manifest.get("schema") != MANIFEST_SCHEMA or manifest.get("sha256") != sha256:
        raise OsmIndexError("The manifest does not describe this slim file; run extract again")
    source_id_of(manifest.get("sourceId"))
    parse_date(manifest.get("sourceDate"))
    if not isinstance(manifest.get("sourceName"), str) or not manifest["sourceName"].strip():
        raise OsmIndexError("The manifest has no source name")
    return manifest


def source_id_of(value: Any) -> str:
    if not isinstance(value, str) or not SOURCE_ID_RE.fullmatch(value):
        raise OsmIndexError("The source ID must be a short lowercase label such as bc or nova-scotia")
    return value


def manifest_path(source: Path) -> Path:
    return source.expanduser().resolve().with_name(source.name + ".manifest.json")


def parse_date(value: Any) -> datetime:
    if not isinstance(value, str):
        raise OsmIndexError("The source date is missing")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise OsmIndexError("The source date is not an ISO 8601 time") from None
    if parsed.tzinfo is None:
        raise OsmIndexError("The source date needs a time zone")
    return parsed.astimezone(timezone.utc)


def iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------- extract (operator only)


def extract(pbf: Path, out: Path, source_id: str, source_date: str | None = None) -> dict[str, Any]:
    source_id = source_id_of(source_id)
    try:
        import osmium
        import shapely
        from shapely import wkb
    except ImportError:
        raise OsmIndexError("extract needs pyosmium and Shapely: pip install osmium shapely") from None

    class Parks(osmium.SimpleHandler):
        def __init__(self) -> None:
            super().__init__()
            self.factory = osmium.geom.WKBFactory()
            self.records: list[dict[str, Any]] = []
            self.failed = 0
            self.private = 0
            self.too_small = 0

        def area(self, area: Any) -> None:
            tags = {tag.k: tag.v for tag in area.tags}
            kind = kind_of(tags)
            if not kind:
                return
            if not is_public(tags):
                self.private += 1
                return
            try:
                geometry = wkb.loads(bytes.fromhex(self.factory.create_multipolygon(area)))
            except Exception:
                self.failed += 1
                return
            simple = shapely.set_precision(shapely.simplify(geometry, SIMPLIFY_DEG, preserve_topology=True), 1e-6)
            if simple.is_empty:
                simple = shapely.set_precision(geometry, 1e-6)
            record = {
                "type": "way" if area.from_way() else "relation",
                "id": area.orig_id(),
                "kind": kind,
                "tags": {key: tags[key] for key in KEEP_TAGS if key in tags},
                "geometry": json.loads(shapely.to_geojson(simple)),
            }
            # Areas a few centimetres across collapse at 1e-6 degrees; keep only what plan accepts.
            try:
                validate_record(record, 0)
            except OsmIndexError:
                self.too_small += 1
                return
            self.records.append(record)

    pbf = pbf.expanduser().resolve()
    if source_date is None:
        reader = osmium.io.Reader(str(pbf), osmium.osm.osm_entity_bits.NOTHING)
        try:
            source_date = reader.header().get("osmosis_replication_timestamp") or None
        finally:
            reader.close()
        if not source_date:
            raise OsmIndexError("The extract has no replication timestamp; pass --source-date")
    when = iso(parse_date(source_date))
    handler = Parks()
    handler.apply_file(str(pbf), locations=True, idx="flex_mem")
    # Sorted, so the same extract always gives the same file and SHA-256.
    records = sorted(handler.records, key=lambda record: (record["type"], record["id"]))
    out = out.expanduser().resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    body = "".join(json.dumps(record, separators=(",", ":"), ensure_ascii=False) + "\n" for record in records).encode("utf-8")
    out.write_bytes(body)
    by_kind = Counter(record["kind"] for record in records)
    manifest = {
        "schema": MANIFEST_SCHEMA,
        "sourceId": source_id,
        "sourceName": pbf.name,
        "sourceDate": when,
        "sha256": hashlib.sha256(body).hexdigest(),
        "bytes": len(body),
        "rows": len(records),
        "named": sum(1 for record in records if record["tags"].get("name")),
        "byKind": dict(sorted(by_kind.items())),
        "skippedPrivate": handler.private,
        "failedGeometry": handler.failed,
        "droppedTooSmall": handler.too_small,
        "simplifyDegrees": SIMPLIFY_DEG,
    }
    manifest_path(out).write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return manifest


# ---------------------------------------------------------------- plan


def canonical(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def plan_digest(plan: dict[str, Any]) -> str:
    return hashlib.sha256(canonical({key: value for key, value in plan.items() if key != "planSha256"})).hexdigest()


def decide(source_date: str, source_sha: str, current: dict[str, Any] | None) -> tuple[str, list[str]]:
    """For one source: replace a missing, older or different load of the same date; noop the same
    one; refuse an older extract."""
    if current is None:
        return "replace", []
    loaded = parse_date(current["sourceDate"])
    planned = parse_date(source_date)
    if planned < loaded:
        return "blocked", [f"The table already holds a newer extract for this source ({current['sourceDate']})"]
    if planned == loaded and current["sourceSha256"] == source_sha:
        return "noop", []
    return "replace", []


def shared_outlines(rows: list[dict[str, Any]], owners: dict[tuple[str, int], str]) -> dict[str, int]:
    """Outlines in this file that another source already holds, by that source. An OSM way or
    relation is one row whichever extract it came from; the source that loaded it first keeps it."""
    counts = Counter(owners[key] for key in ((row["osm_type"], row["osm_id"]) for row in rows) if key in owners)
    return dict(sorted(counts.items()))


def build_plan(
    source: Path,
    rows: list[dict[str, Any]],
    sha256: str,
    size: int,
    manifest: dict[str, Any],
    target: dict[str, Any],
    owners: dict[tuple[str, int], str] | None = None,
) -> dict[str, Any]:
    action, blockers = decide(manifest["sourceDate"], sha256, target["current"])
    plan = {
        "schema": SCHEMA,
        "source": {
            "id": source_id_of(manifest["sourceId"]),
            "path": str(source.expanduser().resolve()),
            "name": manifest["sourceName"],
            "sourceDate": iso(parse_date(manifest["sourceDate"])),
            "sha256": sha256,
            "bytes": size,
            "rows": len(rows),
            "named": sum(1 for row in rows if row["name"]),
            "byKind": dict(sorted(Counter(row["kind"] for row in rows).items())),
            "sharedWithOtherSources": shared_outlines(rows, owners or {}),
        },
        "target": target,
        "action": action,
        "blockers": blockers,
    }
    plan["planSha256"] = plan_digest(plan)
    return plan


def load_reviewed_plan(path: Path, reviewed_sha: str) -> dict[str, Any]:
    try:
        plan = json.loads(path.expanduser().read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        raise OsmIndexError("Could not read the plan") from None
    if plan.get("schema") != SCHEMA or plan.get("planSha256") != plan_digest(plan) or plan.get("planSha256") != reviewed_sha:
        raise OsmIndexError("The plan does not match the reviewed plan SHA-256")
    if plan.get("action") == "blocked":
        raise OsmIndexError("The plan is blocked: " + "; ".join(plan.get("blockers") or []))
    return plan


# ---------------------------------------------------------------- database


def _connect():
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        raise OsmIndexError("Set DATABASE_URL to the intended target database")
    try:
        import psycopg
    except ImportError:
        raise OsmIndexError("psycopg is required; install database/delivery-test-requirements.txt") from None
    try:
        return psycopg.connect(database_url)
    except psycopg.Error as exc:
        raise OsmIndexError(f"Could not connect to target database ({type(exc).__name__})") from None


def require_schema(cursor) -> None:
    cursor.execute("SELECT to_regclass('kip_osm.parks') IS NOT NULL AND to_regclass('kip_osm.source') IS NOT NULL")
    if not cursor.fetchone()[0]:
        raise OsmIndexError("kip_osm.parks is missing; deploy osm_parks_001_init.sql first")
    cursor.execute(
        "SELECT count(*) FROM information_schema.columns WHERE table_schema = 'kip_osm' AND table_name IN ('parks', 'source') AND column_name = 'source_id'"
    )
    if cursor.fetchone()[0] != 2:
        raise OsmIndexError("kip_osm has no source_id yet; deploy osm_parks_002_sources.sql first")


def read_state(cursor, source_id: str) -> dict[str, Any] | None:
    """What the table holds for one source, or None when it holds nothing for it."""
    require_schema(cursor)
    cursor.execute("SELECT source_date, source_sha256, source_name FROM kip_osm.source WHERE source_id = %s", (source_id,))
    row = cursor.fetchone()
    cursor.execute("SELECT count(*) FROM kip_osm.parks WHERE source_id = %s", (source_id,))
    rows = cursor.fetchone()[0]
    if row is None:
        return None if rows == 0 else {"sourceDate": "1970-01-01T00:00:00Z", "sourceSha256": "unknown", "sourceName": "unknown", "rows": rows}
    return {"sourceDate": iso(row[0]), "sourceSha256": row[1], "sourceName": row[2], "rows": rows}


def read_sources(cursor) -> list[dict[str, Any]]:
    """Every source in the table, with the outlines each one holds."""
    require_schema(cursor)
    cursor.execute(
        "SELECT coalesce(s.source_id, p.source_id), s.source_date, s.source_name, s.row_count, "
        "coalesce(p.rows, 0), coalesce(p.named, 0), coalesce(p.bytes, 0) "
        "FROM kip_osm.source s FULL JOIN (SELECT source_id, count(*) AS rows, count(name) AS named, "
        "sum(pg_column_size(o.*))::bigint AS bytes FROM kip_osm.parks o GROUP BY source_id) p ON p.source_id = s.source_id "
        "ORDER BY 1"
    )
    return [
        {
            "id": row[0],
            "sourceDate": iso(row[1]) if row[1] else None,
            "sourceName": row[2],
            "recordedRows": row[3],
            "rows": row[4],
            "named": row[5],
            "rowBytes": int(row[6]),
        }
        for row in cursor.fetchall()
    ]


def capture_target(conn, target_host: str, environment: str, source_id: str) -> tuple[dict[str, Any], dict[tuple[str, int], str]]:
    info = conn.info
    if target_host != (info.host or ""):
        raise OsmIndexError(f"Declared target host {target_host!r} does not match the connected host {info.host!r}")
    with conn.cursor() as cursor:
        cursor.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        current = read_state(cursor, source_id)
        others = [{key: source[key] for key in ("id", "sourceDate", "rows")} for source in read_sources(cursor) if source["id"] != source_id]
        cursor.execute("SELECT osm_type, osm_id, source_id FROM kip_osm.parks WHERE source_id <> %s", (source_id,))
        owners = {(row[0], row[1]): row[2] for row in cursor.fetchall()}
    conn.rollback()
    target = {
        "host": info.host or "",
        "port": info.port,
        "database": info.dbname,
        "environment": environment,
        "declaredHost": target_host,
        "sourceId": source_id,
        "current": current,
        "otherSources": others,
    }
    return target, owners


def _db_rows(rows: Iterable[dict[str, Any]], source_date: str, source_id: str) -> Iterable[tuple[Any, ...]]:
    for row in rows:
        yield (
            row["osm_type"],
            row["osm_id"],
            row["name"],
            row["kind"],
            json.dumps(row["tags"], ensure_ascii=False, sort_keys=True),
            row["min_lat"],
            row["max_lat"],
            row["min_lng"],
            row["max_lng"],
            row["area_m2"],
            json.dumps(row["geometry"], separators=(",", ":")),
            source_date,
            source_id,
        )


def apply_plan(conn, plan: dict[str, Any], rows: list[dict[str, Any]]) -> dict[str, Any]:
    source = plan["source"]
    source_id = source["id"]
    columns = ", ".join(COLUMNS)
    try:
        with conn.transaction():
            with conn.cursor() as cursor:
                # One loader at a time, whatever the source, and this source's state must still
                # be what the plan saw.
                cursor.execute("SELECT pg_advisory_xact_lock(hashtext('kip_osm.parks load'))")
                current = read_state(cursor, source_id)
                if current and current["sourceDate"] == source["sourceDate"] and current["sourceSha256"] == source["sha256"]:
                    return {"result": "unchanged", "sourceId": source_id, "rows": current["rows"], "sourceDate": current["sourceDate"]}
                if current != plan["target"]["current"]:
                    raise OsmIndexError("This source changed in the table since the plan was made; plan again")
                cursor.execute("CREATE TEMP TABLE osm_incoming (LIKE kip_osm.parks INCLUDING DEFAULTS) ON COMMIT DROP")
                with cursor.copy(f"COPY osm_incoming ({columns}) FROM STDIN") as copy:
                    for item in _db_rows(rows, source["sourceDate"], source_id):
                        copy.write_row(item)
                # Only this source's outlines go. An outline another source already holds stays
                # with that source, so loading one province never changes another one.
                cursor.execute("DELETE FROM kip_osm.parks WHERE source_id = %s", (source_id,))
                cursor.execute(f"INSERT INTO kip_osm.parks ({columns}) SELECT {columns} FROM osm_incoming ON CONFLICT (osm_type, osm_id) DO NOTHING")
                inserted = cursor.rowcount
                cursor.execute(
                    "SELECT p.source_id, count(*) FROM osm_incoming i JOIN kip_osm.parks p USING (osm_type, osm_id) "
                    "WHERE p.source_id <> %s GROUP BY p.source_id ORDER BY p.source_id",
                    (source_id,),
                )
                shared = {row[0]: row[1] for row in cursor.fetchall()}
                if inserted + sum(shared.values()) != len(rows):
                    raise OsmIndexError("The loaded row count does not match the plan")
                cursor.execute(
                    "INSERT INTO kip_osm.source (source_id, source_date, source_sha256, source_name, row_count, loaded_at) "
                    "VALUES (%s, %s, %s, %s, %s, now()) ON CONFLICT (source_id) DO UPDATE SET "
                    "source_date = EXCLUDED.source_date, source_sha256 = EXCLUDED.source_sha256, source_name = EXCLUDED.source_name, "
                    "row_count = EXCLUDED.row_count, loaded_at = EXCLUDED.loaded_at",
                    (source_id, source["sourceDate"], source["sha256"], source["name"], inserted),
                )
                cursor.execute("SELECT count(*) FROM kip_osm.parks WHERE source_id = %s", (source_id,))
                count = cursor.fetchone()[0]
                if count != inserted:
                    raise OsmIndexError("The loaded row count does not match the plan")
                cursor.execute("SELECT pg_total_relation_size('kip_osm.parks')")
                size = cursor.fetchone()[0]
                others = {item["id"]: item["rows"] for item in read_sources(cursor) if item["id"] != source_id}
                return {
                    "result": "replaced",
                    "sourceId": source_id,
                    "rows": count,
                    "sharedWithOtherSources": shared,
                    "otherSources": others,
                    "tableBytes": size,
                    "sourceDate": source["sourceDate"],
                }
    except OsmIndexError:
        raise
    except Exception as exc:
        # PostgreSQL errors can include connection details, so keep this safe.
        raise OsmIndexError(f"Load failed ({type(exc).__name__}); all changes were rolled back") from None


# ---------------------------------------------------------------- commands


def run_extract(args: argparse.Namespace) -> dict[str, Any]:
    return extract(args.pbf, args.out, args.source_id, args.source_date)


def run_plan(args: argparse.Namespace) -> dict[str, Any]:
    if not ENV_RE.fullmatch(args.target_environment):
        raise OsmIndexError("Target environment must be a lowercase label such as staging or local-qa")
    source_id = source_id_of(args.source_id)
    rows, sha256, size = read_slim(args.source)
    manifest = read_manifest(args.source, sha256)
    if manifest["sourceId"] != source_id:
        raise OsmIndexError(f"The slim file is source {manifest['sourceId']!r}, not {source_id!r}")
    with _connect() as conn:
        target, owners = capture_target(conn, args.target_host, args.target_environment, source_id)
    plan = build_plan(args.source, rows, sha256, size, manifest, target, owners)
    out = args.out.expanduser().resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(plan, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return {
        "planSha256": plan["planSha256"],
        "action": plan["action"],
        "blockers": plan["blockers"],
        "source": plan["source"],
        "target": plan["target"],
        "planPath": str(out),
    }


def run_apply(args: argparse.Namespace) -> dict[str, Any]:
    plan = load_reviewed_plan(args.plan, args.reviewed_plan_sha)
    if args.expected_target_host != plan["target"]["declaredHost"] or args.target_environment != plan["target"]["environment"]:
        raise OsmIndexError("Expected target host and environment must match the reviewed plan")
    if args.source_id != plan["source"]["id"]:
        raise OsmIndexError(f"The reviewed plan loads source {plan['source']['id']!r}, not {args.source_id!r}")
    rows, sha256, _ = read_slim(Path(plan["source"]["path"]))
    if sha256 != plan["source"]["sha256"] or len(rows) != plan["source"]["rows"]:
        raise OsmIndexError("The slim file changed since the plan was made")
    with _connect() as conn:
        if args.expected_target_host != (conn.info.host or ""):
            raise OsmIndexError("The connected host does not match the reviewed plan")
        result = apply_plan(conn, plan, rows)
    return {"planSha256": plan["planSha256"], "target": {key: plan["target"][key] for key in ("host", "database", "environment")}, **result}


def run_status(args: argparse.Namespace) -> dict[str, Any]:
    with _connect() as conn:
        host, database = conn.info.host or "", conn.info.dbname
        if args.target_host != host:
            raise OsmIndexError(f"Declared target host {args.target_host!r} does not match the connected host {host!r}")
        with conn.cursor() as cursor:
            cursor.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
            sources = read_sources(cursor)
            cursor.execute("SELECT count(*), pg_total_relation_size('kip_osm.parks') FROM kip_osm.parks")
            total, size = cursor.fetchone()
        conn.rollback()
    return {"host": host, "database": database, "sources": sources, "rows": total, "tableBytes": size}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    source_help = "extract label, such as bc or nova-scotia"
    extracting = commands.add_parser("extract", help="operator only: Geofabrik .osm.pbf to a slim GeoJSON-lines file and manifest")
    extracting.add_argument("--pbf", required=True, type=Path)
    extracting.add_argument("--source-id", required=True, help=source_help)
    extracting.add_argument("--out", required=True, type=Path, help="slim file; the manifest is written beside it")
    extracting.add_argument("--source-date", help="ISO 8601 data time, when the extract header has none")
    extracting.set_defaults(run=run_extract)

    planning = commands.add_parser("plan", help="read only: validate the slim file and freeze a plan for its source")
    planning.add_argument("--source", required=True, type=Path, help="slim GeoJSON-lines file from extract")
    planning.add_argument("--source-id", required=True, help=source_help + "; must match the slim file's manifest")
    planning.add_argument("--target-host", required=True, help="host expected from DATABASE_URL")
    planning.add_argument("--target-environment", required=True, help="label recorded in the plan, such as staging")
    planning.add_argument("--out", required=True, type=Path, help="path for the JSON plan")
    planning.set_defaults(run=run_plan)

    applying = commands.add_parser("apply", help="replace one source's outlines with the planned file in one transaction")
    applying.add_argument("--plan", required=True, type=Path)
    applying.add_argument("--reviewed-plan-sha", required=True, help="planSha256 shown by the plan command")
    applying.add_argument("--source-id", required=True, help="the source the reviewed plan loads")
    applying.add_argument("--expected-target-host", required=True)
    applying.add_argument("--target-environment", required=True)
    applying.set_defaults(run=run_apply)

    status = commands.add_parser("status", help="read only: every loaded source with its date and outline counts")
    status.add_argument("--target-host", required=True, help="host expected from DATABASE_URL")
    status.set_defaults(run=run_status)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        result = args.run(args)
    except OsmIndexError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    except Exception as exc:
        print(f"OSM park index failed ({type(exc).__name__})", file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2, sort_keys=True, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Plan and apply reviewed legacy park boundary imports."""
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
from urllib.parse import urlsplit

import requests

import cloud_content

SCHEMA = "parkdex.legacy-park-import.v1"
DEFAULT_BOUNDARY_URL = "https://staging.web.parkdex.app/data/boundaries.v1.geojson"
DEFAULT_CATALOGUE_URL = "https://api-staging-882c.up.railway.app/api/places"
ID_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
CONTROL_CHARS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
BIOMES = {"coast", "forest", "mountain", "lake", "waterfall", "river", "cave", "marsh", "heritage"}
CATEGORIES = {"national", "provincial", "regional", "municipal", "community"}
SHAPES = {"circle", "hex", "shield", "arch", "seal"}
RARITIES = {"common", "uncommon", "rare", "epic", "legendary"}
MAX_SOURCE_BYTES = 128 * 1024 * 1024


class ParkImportError(ValueError):
    """Safe, actionable input, review, or publication error."""


def canonical_bytes(value: Any) -> bytes:
    return cloud_content._canonical_bytes(value)


def sha256(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def plan_digest(plan: dict[str, Any]) -> str:
    return sha256(canonical_bytes({key: value for key, value in plan.items() if key != "planSha256"}))


def read_source(locator: str, label: str) -> tuple[bytes, dict[str, str]]:
    is_windows_path = bool(re.match(r"^[A-Za-z]:[\\/]", locator))
    parts = urlsplit(locator) if not is_windows_path else None
    if parts is not None and parts.scheme:
        if parts.scheme != "https" or not parts.netloc or parts.username or parts.password or parts.query or parts.fragment:
            raise ParkImportError(f"{label} source URL must be HTTPS without credentials, query, or fragment")
        try:
            response = requests.get(locator, timeout=90, stream=True)
            response.raise_for_status()
            chunks: list[bytes] = []
            total = 0
            for chunk in response.iter_content(1024 * 1024):
                if not chunk:
                    continue
                total += len(chunk)
                if total > MAX_SOURCE_BYTES:
                    raise ParkImportError(f"{label} source exceeds the 128 MiB limit")
                chunks.append(chunk)
            raw = b"".join(chunks)
        except ImportError:
            raise
        except requests.RequestException as exc:
            raise ParkImportError(f"Could not read {label} source ({type(exc).__name__})") from None
        return raw, {"kind": "url", "locator": locator, "sha256": sha256(raw)}

    path = Path(locator).expanduser().resolve()
    try:
        if path.stat().st_size > MAX_SOURCE_BYTES:
            raise ParkImportError(f"{label} source exceeds the 128 MiB limit")
        raw = path.read_bytes()
    except ImportError:
        raise
    except OSError as exc:
        raise ParkImportError(f"Could not read {label} source ({type(exc).__name__})") from None
    return raw, {"kind": "file", "locator": str(path), "sha256": sha256(raw)}


def parse_json(raw: bytes, label: str) -> Any:
    try:
        return cloud_content._strict_json(raw, label)
    except cloud_content.CloudContentError as exc:
        raise ParkImportError(str(exc)) from None


def _validate_position(position: Any, label: str) -> None:
    if not isinstance(position, list) or len(position) != 2:
        raise ParkImportError(f"{label} positions must contain exactly longitude and latitude")
    for axis, value, minimum, maximum in (
        ("longitude", position[0], -180, 180),
        ("latitude", position[1], -90, 90),
    ):
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise ParkImportError(f"{label} {axis} must be a finite number")
        if not minimum <= value <= maximum:
            raise ParkImportError(f"{label} {axis} is out of range")


def _geometry_summary(geometry: dict[str, Any], label: str) -> dict[str, Any]:
    kind = geometry.get("type")
    coordinates = geometry.get("coordinates")
    if set(geometry) != {"type", "coordinates"} or kind not in {"Polygon", "MultiPolygon"}:
        raise ParkImportError(f"{label} must be a 2D Polygon or MultiPolygon")
    polygons = [coordinates] if kind == "Polygon" else coordinates
    if not isinstance(polygons, list) or not polygons:
        raise ParkImportError(f"{label} has no polygon parts")
    ring_count = 0
    positions = 0
    for polygon_index, polygon in enumerate(polygons):
        if not isinstance(polygon, list) or not polygon:
            raise ParkImportError(f"{label} polygon {polygon_index} has no rings")
        for ring_index, ring in enumerate(polygon):
            ring_label = f"{label} polygon {polygon_index} ring {ring_index}"
            if not isinstance(ring, list) or len(ring) < 4:
                raise ParkImportError(f"{ring_label} must have at least four positions")
            for position in ring:
                _validate_position(position, ring_label)
            if ring[0] != ring[-1]:
                raise ParkImportError(f"{ring_label} is not closed")
            ring_count += 1
            positions += len(ring)
    try:
        from shapely.geometry import shape
    except ImportError:
        raise ParkImportError("Shapely is required; install database/requirements.txt") from None
    try:
        validated = shape(geometry)
    except Exception as exc:
        raise ParkImportError(f"{label} geometry could not be read ({type(exc).__name__})") from None
    if validated.is_empty or not validated.is_valid or validated.area <= 0:
        raise ParkImportError(f"{label} geometry is empty, invalid, or has no area")
    if validated.geom_type not in {"Polygon", "MultiPolygon"}:
        raise ParkImportError(f"{label} did not validate as a Polygon or MultiPolygon")
    xs = [position[0] for polygon in polygons for ring in polygon for position in ring]
    ys = [position[1] for polygon in polygons for ring in polygon for position in ring]
    return {
        "geometryType": "MultiPolygon",
        "polygonCount": len(polygons),
        "ringCount": ring_count,
        "holeCount": ring_count - len(polygons),
        "positionCount": positions,
        "bbox": [min(xs), min(ys), max(xs), max(ys)],
    }


def normalize_geometry(geometry: Any, label: str) -> tuple[dict[str, Any], dict[str, Any]]:
    if not isinstance(geometry, dict):
        raise ParkImportError(f"{label} has no geometry object")
    summary = _geometry_summary(geometry, label)
    if geometry["type"] == "Polygon":
        normalized = {"type": "MultiPolygon", "coordinates": [geometry["coordinates"]]}
    else:
        normalized = {"type": "MultiPolygon", "coordinates": geometry["coordinates"]}
    return normalized, summary


def parse_boundary_source(value: Any, selected_ids: set[str] | None = None) -> dict[str, dict[str, Any]]:
    if not isinstance(value, dict) or value.get("type") != "FeatureCollection" or not isinstance(value.get("features"), list):
        raise ParkImportError("Boundary source must be a GeoJSON FeatureCollection")
    by_id: dict[str, dict[str, Any]] = {}
    for index, feature in enumerate(value["features"]):
        label = f"boundary feature {index}"
        if not isinstance(feature, dict) or feature.get("type") != "Feature":
            if selected_ids is None:
                raise ParkImportError(f"{label} is not a GeoJSON Feature")
            continue
        properties = feature.get("properties")
        if not isinstance(properties, dict):
            if selected_ids is None:
                raise ParkImportError(f"{label} has no properties object")
            continue
        park_id = properties.get("id")
        if not isinstance(park_id, str) or not ID_RE.fullmatch(park_id):
            if selected_ids is None:
                raise ParkImportError(f"{label} has a missing or invalid stable properties.id")
            continue
        if selected_ids is not None and park_id not in selected_ids:
            continue
        if park_id in by_id:
            raise ParkImportError(f"Boundary source has duplicate park id {park_id}")
        source_ids = properties.get("sourceObjectIds", [])
        if not isinstance(source_ids, list) or any(
            isinstance(item, bool) or not isinstance(item, (str, int)) or not str(item).strip()
            for item in source_ids
        ):
            raise ParkImportError(f"{label} sourceObjectIds must be an array of strings or integers")
        if len({str(item) for item in source_ids}) != len(source_ids):
            raise ParkImportError(f"{label} has duplicate sourceObjectIds")
        primary_source_id = properties.get("sourceId")
        if primary_source_id is not None and (
            isinstance(primary_source_id, bool)
            or not isinstance(primary_source_id, (str, int))
            or not str(primary_source_id).strip()
        ):
            raise ParkImportError(f"{label} sourceId must be a non-empty string or integer")
        if not source_ids and primary_source_id is None:
            raise ParkImportError(f"{label} has no GIS source feature ID for reproducible provenance")
        if source_ids and primary_source_id is not None and str(primary_source_id) != str(source_ids[0]):
            raise ParkImportError(f"{label} sourceId does not match the first sourceObjectIds entry")
        geometry, summary = normalize_geometry(feature.get("geometry"), label)
        by_id[park_id] = {
            "sourceId": park_id,
            "sourceObjectIds": source_ids,
            "sourceFeatureIds": source_ids or [primary_source_id],
            "provenance": {key: item for key, item in properties.items() if key != "id"},
            "summary": summary,
            "geometry": geometry,
        }
    return by_id


def parse_catalogue(value: Any) -> dict[str, dict[str, Any]]:
    places = value.get("places") if isinstance(value, dict) else value
    if not isinstance(places, list):
        raise ParkImportError("Legacy catalogue must be an array or an object with a places array")
    by_id: dict[str, dict[str, Any]] = {}
    for index, place in enumerate(places):
        if not isinstance(place, dict):
            raise ParkImportError(f"Legacy catalogue item {index} must be an object")
        park_id = place.get("id")
        if not isinstance(park_id, str) or not ID_RE.fullmatch(park_id) or park_id in by_id:
            raise ParkImportError(f"Legacy catalogue item {index} has a missing, invalid, or duplicate id")
        by_id[park_id] = place
    return by_id


def parse_review(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != {"parks"} or not isinstance(value["parks"], dict):
        raise ParkImportError("New park review JSON must contain exactly a parks object")
    return value["parks"]


def parse_rarity_review(value: Any) -> dict[str, dict[str, str | None]]:
    if not isinstance(value, dict) or set(value) != {"parks"} or not isinstance(value["parks"], dict):
        raise ParkImportError("Rarity review JSON must contain exactly a parks object")
    if not value["parks"]:
        raise ParkImportError("Rarity review JSON must include one or more parks")
    reviews: dict[str, dict[str, str | None]] = {}
    for park_id, item in value["parks"].items():
        if not isinstance(park_id, str) or not ID_RE.fullmatch(park_id):
            raise ParkImportError("Rarity review park keys must be valid stable park IDs")
        if isinstance(item, str):
            rarity, rationale = item, None
        elif isinstance(item, dict) and set(item) == {"rarity", "rationale"}:
            rarity, rationale = item["rarity"], item["rationale"]
        else:
            raise ParkImportError(f"Rarity review for {park_id} must be a rarity string or an object with rarity and rationale")
        if not isinstance(rarity, str) or rarity not in RARITIES:
            raise ParkImportError(f"Rarity review for {park_id} must use a supported rarity")
        if rationale is not None:
            rationale = account_text(rationale, f"Rarity review for {park_id} rationale", 1000)
        elif isinstance(item, dict):
            raise ParkImportError(f"Rarity review for {park_id} requires a non-empty rationale when using an object")
        reviews[park_id] = {"rarity": rarity, "rationale": rationale}
    return reviews


def account_text(value: Any, label: str, maximum: int) -> str:
    if not isinstance(value, str):
        raise ParkImportError(f"{label} must be text")
    normalized = value.strip()
    utf16_length = sum(2 if ord(character) > 0xFFFF else 1 for character in normalized)
    if not normalized or utf16_length > maximum or CONTROL_CHARS.search(normalized):
        raise ParkImportError(f"{label} must be non-empty, at most {maximum} characters, and contain no control characters")
    return normalized


def validate_new_park(source_id: str, target_id: str, place: dict[str, Any], review: Any, hubs: list[dict[str, Any]]) -> tuple[dict[str, Any], dict[str, Any]]:
    if not isinstance(review, dict) or set(review) not in ({"presentation", "walkM", "drive"}, {"presentation", "walkM", "drive", "accessUnknown"}):
        raise ParkImportError(f"New park {source_id} review must contain presentation, walkM, and drive; accessUnknown is optional")
    presentation = review["presentation"]
    required = {"short", "biome", "shape", "rarity", "seed", "blurb"}
    if not isinstance(presentation, dict) or set(presentation) - (required | {"scene"}) or not required <= set(presentation):
        raise ParkImportError(f"New park {source_id} presentation must explicitly provide {', '.join(sorted(required))}; scene defaults to null")
    if not {"id", "name", "category", "region", "latitude", "longitude"} <= set(place):
        raise ParkImportError(f"Legacy catalogue entry {source_id} lacks required identity, name, category, region, or coordinates")
    category = place["category"]
    if category not in CATEGORIES:
        raise ParkImportError(f"Legacy catalogue entry {source_id} has an unsupported category")
    park = {
        "id": target_id,
        "name": place["name"],
        "short": presentation["short"],
        "category": category,
        "region": place["region"],
        "lat": place["latitude"],
        "lng": place["longitude"],
        "biome": presentation["biome"],
        "shape": presentation["shape"],
        "rarity": presentation["rarity"],
        "scene": presentation.get("scene"),
        "seed": presentation["seed"],
        "blurb": presentation["blurb"],
    }
    for field, maximum in (("id", 160), ("name", 140), ("short", 140), ("region", 140), ("blurb", 800)):
        park[field] = account_text(park[field], f"New park {source_id} {field}", maximum)
    if park["scene"] is not None:
        park["scene"] = account_text(park["scene"], f"New park {source_id} scene", 80)
    try:
        cloud_content._validate_parks([park])
    except cloud_content.CloudContentError as exc:
        raise ParkImportError(f"New park {source_id} is invalid: {exc}") from None
    if park["category"] not in CATEGORIES or park["biome"] not in BIOMES or park["shape"] not in SHAPES or park["rarity"] not in RARITIES:
        raise ParkImportError(f"New park {source_id} has a category, biome, shape, or rarity outside the database contract")
    if isinstance(park["seed"], bool) or not isinstance(park["seed"], int) or not 0 <= park["seed"] <= 1_000_000:
        raise ParkImportError(f"New park {source_id} seed must be an integer from 0 to 1000000 for account backup")
    if park["scene"] is not None and not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", park["scene"] if isinstance(park["scene"], str) else ""):
        raise ParkImportError(f"New park {source_id} scene must be null or a lowercase hyphenated slug")
    walk_m = review["walkM"]
    if isinstance(walk_m, bool) or not isinstance(walk_m, (int, float)) or not math.isfinite(walk_m) or not 0 <= walk_m <= 9007199254740991:
        raise ParkImportError(f"New park {source_id} walkM must be a finite non-negative number; use 0 with accessUnknown for unverified access")
    drive = review["drive"]
    if not isinstance(drive, list) or len(drive) != len(hubs) or not drive:
        raise ParkImportError(f"New park {source_id} drive must provide one entry for every current drive hub")
    access_unknown = review.get("accessUnknown")
    if "accessUnknown" in review and access_unknown is not True:
        raise ParkImportError(f"New park {source_id} accessUnknown must be true when supplied")
    normalized_drive: list[list[float] | None] = []
    has_route = False
    for position, route in enumerate(drive):
        if route is None:
            normalized_drive.append(None)
            continue
        if not isinstance(route, list) or len(route) != 2:
            raise ParkImportError(f"New park {source_id} drive[{position}] must be null or [distanceKm, durationMin]")
        distance, duration = route
        if any(isinstance(item, bool) or not isinstance(item, (int, float)) or not math.isfinite(item) or not 0 <= item <= 9007199254740991 for item in route):
            raise ParkImportError(f"New park {source_id} drive[{position}] has invalid route values")
        has_route = True
        normalized_drive.append([distance, duration])
    if access_unknown is True:
        if walk_m != 0 or has_route:
            raise ParkImportError(f"New park {source_id} accessUnknown requires walkM 0 and null for every drive hub")
    elif not has_route:
        raise ParkImportError(f"New park {source_id} all-null drive requires explicit accessUnknown true, walkM 0, and no verified routes")
    drive_record = {"walkM": walk_m, "drive": normalized_drive, "hubs": hubs}
    return park, drive_record


def geometry_hash(feature: Any) -> str | None:
    return None if feature is None else sha256(canonical_bytes(feature))


def _public_feature(park_id: str, biome: str, geometry: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": "Feature",
        "properties": {"id": park_id, "biome": biome},
        "geometry": geometry,
    }


def _source_provenance(record: dict[str, Any]) -> dict[str, Any]:
    return {
        "stableId": record["sourceId"],
        "sourceFeatureIds": record["sourceFeatureIds"],
        "sourceProperties": record["provenance"],
    }


def build_plan(
    boundary_features: dict[str, dict[str, Any]],
    boundary_source: dict[str, str],
    selected_source_ids: list[str],
    id_mapping: dict[str, str],
    target: dict[str, Any],
    parks: dict[str, dict[str, Any]],
    boundaries: dict[str, Any],
    catalogue: dict[str, dict[str, Any]] | None = None,
    catalogue_source: dict[str, str] | None = None,
    review: dict[str, Any] | None = None,
    review_source: dict[str, str] | None = None,
    hubs: list[dict[str, Any]] | None = None,
    rarity_review: dict[str, dict[str, str | None]] | None = None,
    rarity_review_source: dict[str, str] | None = None,
) -> dict[str, Any]:
    if not selected_source_ids or len(selected_source_ids) != len(set(selected_source_ids)):
        raise ParkImportError("Select one or more unique source park IDs with --park-id")
    unknown = set(selected_source_ids) - set(boundary_features)
    if unknown:
        raise ParkImportError("Selected park IDs are missing from the boundary source: " + ", ".join(sorted(unknown)))
    if set(id_mapping) - set(selected_source_ids):
        raise ParkImportError("An --id-map source must also appear in --park-id")
    target_ids = [id_mapping.get(item, item) for item in selected_source_ids]
    if len(target_ids) != len(set(target_ids)):
        raise ParkImportError("Selected source park IDs map to duplicate target IDs")
    if any(not ID_RE.fullmatch(item) for item in target_ids):
        raise ParkImportError("A target park ID is invalid")
    if (rarity_review is None) != (rarity_review_source is None):
        raise ParkImportError("Rarity review values and their source hash must be provided together")
    if rarity_review is not None:
        unselected = set(rarity_review) - set(selected_source_ids)
        if unselected:
            raise ParkImportError("Rarity review includes unselected source park IDs: " + ", ".join(sorted(unselected)))

    change_set: list[dict[str, Any]] = []
    blockers: list[str] = []
    for source_id in selected_source_ids:
        record = boundary_features[source_id]
        target_id = id_mapping.get(source_id, source_id)
        current_park = parks.get(target_id)
        current_feature = boundaries.get(target_id)
        if current_park is None:
            if rarity_review is not None and source_id in rarity_review:
                raise ParkImportError(f"Rarity review for {source_id} can only change an existing park")
            change: dict[str, Any] = {
                "sourceId": source_id,
                "targetId": target_id,
                "operation": "insert-park",
                "source": _source_provenance(record),
                "sourceGeometry": record["summary"],
                "targetBeforeHash": None,
            }
            if catalogue is None or review is None or hubs is None:
                missing = []
                if catalogue is None:
                    missing.append("legacy catalogue source")
                if review is None:
                    missing.append("reviewed new-park input")
                if hubs is None:
                    missing.append("target drive hubs")
                blocker = f"{source_id}: missing " + ", ".join(missing)
                blockers.append(blocker)
                change["blockers"] = missing
            elif source_id not in catalogue or source_id not in review:
                missing = []
                if source_id not in catalogue:
                    missing.append("catalogue park identity")
                if source_id not in review:
                    missing.append("reviewed presentation, walkM, and drive values")
                blockers.append(f"{source_id}: missing " + ", ".join(missing))
                change["blockers"] = missing
            else:
                park, drive_record = validate_new_park(source_id, target_id, catalogue[source_id], review[source_id], hubs)
                desired = _public_feature(target_id, park["biome"], record["geometry"])
                cloud_content._validate_boundaries({"type": "FeatureCollection", "features": [desired]}, [target_id])
                change.update({"desiredPark": park, "desiredDrive": drive_record, "desiredFeature": desired})
                if review[source_id].get("accessUnknown") is True:
                    change["accessUnknown"] = True
        else:
            biome = current_park.get("biome")
            if not isinstance(biome, str) or biome not in BIOMES:
                raise ParkImportError(f"Target park {target_id} has a biome outside the content contract")
            desired = _public_feature(target_id, biome, record["geometry"])
            cloud_content._validate_boundaries({"type": "FeatureCollection", "features": [desired]}, [target_id])
            change = {
                "sourceId": source_id,
                "targetId": target_id,
                "operation": "update-boundary",
                "source": _source_provenance(record),
                "sourceGeometry": record["summary"],
                "targetBeforeHash": geometry_hash(current_feature),
                "expectedBiome": biome,
                "targetGeometryBefore": _feature_summary(current_feature),
                "desiredFeature": desired,
            }
            rarity_item = rarity_review.get(source_id) if rarity_review is not None else None
            if rarity_item is not None:
                expected_rarity = current_park.get("rarity")
                if expected_rarity not in RARITIES:
                    raise ParkImportError(f"Target park {target_id} has a rarity outside the content contract")
                change["expectedRarity"] = expected_rarity
                change["desiredRarity"] = rarity_item["rarity"]
                if rarity_item["rationale"] is not None:
                    change["rarityReviewRationale"] = rarity_item["rationale"]
        change_set.append(change)

    plan: dict[str, Any] = {
        "schema": SCHEMA,
        "target": target,
        "sources": {
            "boundary": boundary_source,
            **({"catalogue": catalogue_source} if catalogue_source else {}),
            **({"newParkReview": review_source} if review_source else {}),
            **({"rarityReview": rarity_review_source} if rarity_review_source else {}),
        },
        "selectedSourceIds": selected_source_ids,
        "idMapping": id_mapping,
        "status": "blocked" if blockers else "ready",
        "blockers": blockers,
        "changes": change_set,
    }
    plan["planSha256"] = plan_digest(plan)
    return plan


def _feature_summary(feature: Any) -> dict[str, Any] | None:
    if not isinstance(feature, dict):
        return None
    geometry = feature.get("geometry")
    if not isinstance(geometry, dict):
        return None
    try:
        _, summary = normalize_geometry(geometry, "target boundary")
    except ParkImportError:
        return {"geometryType": geometry.get("type"), "valid": False}
    return summary


def _db_identity(conn) -> dict[str, Any]:
    info = conn.info
    return {"host": info.host or "", "port": info.port, "database": info.dbname}


def capture_target(conn, target_host: str, target_environment: str, selected_target_ids: list[str]) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any], list[dict[str, Any]]]:
    with conn.cursor() as cursor:
        cursor.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        cursor.execute("SELECT revision FROM public.content_clock WHERE singleton = true")
        revision_row = cursor.fetchone()
        if revision_row is None:
            raise ParkImportError("content sync migration is not installed on the target database")
        cursor.execute(
            "SELECT id, name, short, category, region, lat, lng, biome, shape, rarity, scene, seed, blurb "
            "FROM public.parks WHERE id = ANY(%s)",
            (selected_target_ids,),
        )
        parks = {row[0]: dict(zip(cloud_content.PARK_FIELDS, row, strict=True)) for row in cursor.fetchall()}
        cursor.execute("SELECT park_id, feature FROM public.boundaries WHERE park_id = ANY(%s)", (selected_target_ids,))
        boundaries = {row[0]: _jsonb(row[1]) for row in cursor.fetchall()}
        cursor.execute("SELECT position, name, lng, lat FROM public.drive_hubs ORDER BY position")
        hub_rows = cursor.fetchall()
        if hub_rows and [row[0] for row in hub_rows] != list(range(len(hub_rows))):
            raise ParkImportError("Target drive hubs are not contiguous from position zero")
        hubs = [{"position": row[0], "name": row[1], "lng": row[2], "lat": row[3]} for row in hub_rows]
    identity = _db_identity(conn)
    if target_host != identity["host"]:
        raise ParkImportError(f"Declared target host {target_host!r} does not match connected host {identity['host']!r}")
    target = {**identity, "environment": target_environment, "revision": revision_row[0], "declaredHost": target_host}
    return target, parks, boundaries, hubs


def _jsonb(value: Any) -> Any:
    if isinstance(value, str):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return value
    return value


def verify_plan_sources(plan: dict[str, Any]) -> None:
    for label, source in plan["sources"].items():
        if not isinstance(source, dict) or set(source) != {"kind", "locator", "sha256"}:
            raise ParkImportError(f"Plan has an invalid {label} source reference")
        if source["kind"] not in {"file", "url"} or not re.fullmatch(r"[0-9a-f]{64}", source["sha256"]):
            raise ParkImportError(f"Plan has an invalid {label} source hash")
        raw, current = read_source(source["locator"], label)
        if current["sha256"] != source["sha256"]:
            raise ParkImportError(f"{label} source changed after plan review")
        if source["kind"] == "file" and current["locator"] != source["locator"]:
            raise ParkImportError(f"{label} file location changed after plan review")


def load_reviewed_plan(path: Path, expected_sha: str) -> dict[str, Any]:
    try:
        plan = parse_json(path.read_bytes(), "reviewed plan")
    except OSError as exc:
        raise ParkImportError(f"Could not read reviewed plan ({type(exc).__name__})") from None
    if not isinstance(plan, dict) or plan.get("schema") != SCHEMA:
        raise ParkImportError("Reviewed plan has an unsupported schema")
    actual_sha = plan_digest(plan)
    if plan.get("planSha256") != actual_sha or expected_sha != actual_sha:
        raise ParkImportError("Reviewed plan SHA does not match --reviewed-plan-sha")
    if plan.get("status") != "ready" or plan.get("blockers"):
        raise ParkImportError("Blocked plan cannot be applied")
    return plan


def _current_state(cursor, target_ids: list[str]) -> tuple[int, dict[str, dict[str, Any]], dict[str, Any], list[dict[str, Any]]]:
    cursor.execute(
        "SELECT id, name, short, category, region, lat, lng, biome, shape, rarity, scene, seed, blurb "
        "FROM public.parks WHERE id = ANY(%s) ORDER BY id FOR UPDATE",
        (target_ids,),
    )
    parks = {item[0]: dict(zip(cloud_content.PARK_FIELDS, item, strict=True)) for item in cursor.fetchall()}
    cursor.execute("SELECT park_id, feature FROM public.boundaries WHERE park_id = ANY(%s) ORDER BY park_id FOR UPDATE", (target_ids,))
    boundaries = {item[0]: _jsonb(item[1]) for item in cursor.fetchall()}
    cursor.execute("SELECT park_id FROM public.park_drive_settings WHERE park_id = ANY(%s) ORDER BY park_id FOR UPDATE", (target_ids,))
    cursor.fetchall()
    cursor.execute("SELECT park_id, hub_position FROM public.park_drive WHERE park_id = ANY(%s) ORDER BY park_id, hub_position FOR UPDATE", (target_ids,))
    cursor.fetchall()
    # Lock target rows before the shared revision row to follow publisher lock order.
    cursor.execute("SELECT revision FROM public.content_clock WHERE singleton = true FOR UPDATE")
    row = cursor.fetchone()
    if row is None:
        raise ParkImportError("content sync migration is not installed on the target database")
    cursor.execute("SELECT position, name, lng, lat FROM public.drive_hubs ORDER BY position")
    hubs = [{"position": item[0], "name": item[1], "lng": item[2], "lat": item[3]} for item in cursor.fetchall()]
    return row[0], parks, boundaries, hubs


def _drive_matches(cursor, park_id: str, desired: dict[str, Any]) -> bool:
    cursor.execute("SELECT walk_m FROM public.park_drive_settings WHERE park_id = %s", (park_id,))
    settings = cursor.fetchone()
    if settings is None or settings[0] != desired["walkM"]:
        return False
    cursor.execute(
        "SELECT hub_position, distance_km, duration_min FROM public.park_drive WHERE park_id = %s ORDER BY hub_position",
        (park_id,),
    )
    routes = cursor.fetchall()
    wanted = desired["drive"]
    if len(routes) != len(wanted):
        return False
    for index, route in enumerate(wanted):
        if route is None:
            if tuple(routes[index]) != (index, None, None):
                return False
        elif tuple(routes[index]) != (index, route[0], route[1]):
            return False
    return True


def _matches_all(cursor, plan: dict[str, Any], parks: dict[str, dict[str, Any]], boundaries: dict[str, Any], hubs: list[dict[str, Any]]) -> bool:
    for change in plan["changes"]:
        park_id = change["targetId"]
        desired_feature = change["desiredFeature"]
        if boundaries.get(park_id) != desired_feature:
            return False
        if change["operation"] == "insert-park":
            if parks.get(park_id) != change["desiredPark"]:
                return False
            desired_hubs = change["desiredDrive"]["hubs"]
            if hubs != desired_hubs or not _drive_matches(cursor, park_id, change["desiredDrive"]):
                return False
        else:
            current_park = parks.get(park_id)
            if current_park is None or current_park["biome"] != change["expectedBiome"]:
                return False
            if "desiredRarity" in change and current_park["rarity"] != change["desiredRarity"]:
                return False
    return True


def _guard_target(plan: dict[str, Any], revision: int, parks: dict[str, dict[str, Any]], boundaries: dict[str, Any]) -> None:
    for change in plan["changes"]:
        park_id = change["targetId"]
        current_park = parks.get(park_id)
        current_feature = boundaries.get(park_id)
        if change["operation"] == "insert-park":
            if current_park is not None or current_feature is not None:
                raise ParkImportError(f"Target park {park_id} appeared after planning; create a new reviewed plan")
        else:
            if current_park is None:
                raise ParkImportError(f"Target park {park_id} was removed after planning")
            if current_park["biome"] != change["expectedBiome"]:
                raise ParkImportError(f"Target park {park_id} biome changed after planning")
            if "expectedRarity" in change and current_park["rarity"] != change["expectedRarity"]:
                raise ParkImportError(f"Target park {park_id} rarity changed after planning")
            if geometry_hash(current_feature) != change["targetBeforeHash"]:
                raise ParkImportError(f"Target boundary {park_id} changed after planning")
    if revision != plan["target"]["revision"]:
        raise ParkImportError("Target content revision changed after planning")


def _rarity_changes(plan: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        change for change in plan["changes"]
        if "desiredRarity" in change and change["desiredRarity"] != change["expectedRarity"]
    ]


def _lock_authoring_rollout(cursor: Any) -> None:
    cursor.execute("SELECT to_regclass('public.park_enrichment_rollout')")
    if cursor.fetchone()[0] is None:
        raise ParkImportError("Rarity changes require the park authoring migration so frozen art can be checked safely")
    cursor.execute("SELECT singleton FROM public.park_enrichment_rollout WHERE singleton = true FOR UPDATE")
    if cursor.fetchone() is None:
        raise ParkImportError("Rarity changes require an authoring rollout row to coordinate frozen job authoring")


def _guard_unpublished_selected_art(cursor: Any, changes: list[dict[str, Any]]) -> None:
    park_ids = [change["targetId"] for change in changes]
    cursor.execute(
        "SELECT park_id FROM public.park_enrichment_jobs "
        "WHERE park_id = ANY(%s) AND selected_art IS NOT NULL AND state <> 'published' ORDER BY park_id",
        (park_ids,),
    )
    selected = [row[0] for row in cursor.fetchall()]
    if selected:
        raise ParkImportError(
            "Unpublished frozen authoring art exists for affected rarity changes: " + ", ".join(selected)
        )


def apply_transaction(conn, plan: dict[str, Any], expected_host: str, target_environment: str) -> dict[str, Any]:
    identity = _db_identity(conn)
    declared_target = plan["target"]
    if target_environment != declared_target["environment"]:
        raise ParkImportError("Target environment does not match the reviewed plan")
    if expected_host != declared_target["declaredHost"] or identity != {key: declared_target[key] for key in ("host", "port", "database")}:
        raise ParkImportError("Connected target identity does not match the reviewed host, port, and database")
    ids = [change["targetId"] for change in plan["changes"]]
    rarity_changes = _rarity_changes(plan)
    try:
        with conn.transaction():
            with conn.cursor() as cursor:
                if rarity_changes:
                    # The authoring queue takes this lock before job changes. Hold it
                    # before locking the content clock so rarity checks cannot race a
                    # newly frozen selection.
                    _lock_authoring_rollout(cursor)
                revision, parks, boundaries, hubs = _current_state(cursor, ids)
                if _matches_all(cursor, plan, parks, boundaries, hubs):
                    return {"result": "already-current", "revision": revision, "changed": []}
                _guard_target(plan, revision, parks, boundaries)
                if rarity_changes:
                    _guard_unpublished_selected_art(cursor, rarity_changes)
                changed: list[dict[str, str]] = []
                for change in plan["changes"]:
                    park_id = change["targetId"]
                    if change["operation"] == "insert-park":
                        park = change["desiredPark"]
                        cursor.execute(
                            "INSERT INTO public.parks "
                            "(id, name, short, category, region, lat, lng, biome, shape, rarity, scene, seed, blurb) "
                            "VALUES (%(id)s, %(name)s, %(short)s, %(category)s, %(region)s, %(lat)s, %(lng)s, %(biome)s, %(shape)s, %(rarity)s, %(scene)s, %(seed)s, %(blurb)s)",
                            park,
                        )
                        drive = change["desiredDrive"]
                        cursor.execute("INSERT INTO public.park_drive_settings (park_id, walk_m) VALUES (%s, %s)", (park_id, drive["walkM"]))
                        for position, route in enumerate(drive["drive"]):
                            distance, duration = (None, None) if route is None else route
                            cursor.execute(
                                "INSERT INTO public.park_drive (park_id, hub_position, distance_km, duration_min) VALUES (%s, %s, %s, %s)",
                                (park_id, position, distance, duration),
                            )
                    elif change.get("desiredRarity") != change.get("expectedRarity"):
                        cursor.execute(
                            "UPDATE public.parks SET rarity = %s WHERE id = %s AND rarity = %s",
                            (change["desiredRarity"], park_id, change["expectedRarity"]),
                        )
                        if cursor.rowcount != 1:
                            raise ParkImportError(f"Target park {park_id} rarity changed during import")
                    feature_json = canonical_bytes(change["desiredFeature"]).decode("utf-8")
                    cursor.execute(
                        "INSERT INTO public.boundaries (park_id, feature) VALUES (%s, %s::jsonb) "
                        "ON CONFLICT (park_id) DO UPDATE SET feature = EXCLUDED.feature",
                        (park_id, feature_json),
                    )
                    changed.append({"sourceId": change["sourceId"], "targetId": park_id, "operation": change["operation"]})
                cursor.execute("SELECT revision FROM public.content_clock WHERE singleton = true")
                after = cursor.fetchone()
                return {"result": "applied", "revision": after[0] if after else None, "changed": changed}
    except ParkImportError:
        raise
    except Exception as exc:
        # PostgreSQL errors can include connection details, so keep this safe.
        raise ParkImportError(f"Import transaction failed ({type(exc).__name__}); all changes were rolled back") from None


def _connect():
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        raise ParkImportError("Set DATABASE_URL to the intended target database")
    try:
        import psycopg
    except ImportError:
        raise ParkImportError("psycopg is required; install database/requirements.txt") from None
    try:
        return psycopg.connect(database_url)
    except psycopg.Error as exc:
        raise ParkImportError(f"Could not connect to target database ({type(exc).__name__})") from None


def _parse_mappings(values: list[str]) -> dict[str, str]:
    mapping: dict[str, str] = {}
    for value in values:
        if value.count(":") != 1:
            raise ParkImportError("--id-map must use source-id:target-id")
        source_id, target_id = value.split(":", 1)
        if not source_id or not target_id or source_id in mapping:
            raise ParkImportError("--id-map entries must have unique non-empty source IDs")
        mapping[source_id] = target_id
    return mapping


def _write_plan(path: Path, plan: dict[str, Any]) -> None:
    path = path.expanduser().resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(plan, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False) + "\n", encoding="utf-8")


def read_park_id_file(path: Path | None) -> list[str]:
    """One stable ID per line, so batch imports avoid command-line length limits."""
    if path is None:
        return []
    try:
        text = path.expanduser().read_text(encoding="utf-8")
    except OSError as exc:
        raise ParkImportError(f"Could not read park ID file ({type(exc).__name__})") from None
    ids = [line.strip() for line in text.splitlines() if line.strip() and not line.lstrip().startswith("#")]
    if not ids:
        raise ParkImportError("Park ID file lists no park IDs")
    invalid = [item for item in ids if not ID_RE.fullmatch(item)]
    if invalid:
        raise ParkImportError("Park ID file has an invalid stable ID: " + invalid[0])
    return ids


def run_plan(args: argparse.Namespace) -> dict[str, Any]:
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", args.target_environment):
        raise ParkImportError("Target environment must be a lowercase label such as staging or local-qa")
    raw, boundary_source = read_source(args.source, "boundary")
    source_ids = [*(args.park_id or []), *read_park_id_file(getattr(args, "park_id_file", None))]
    features = parse_boundary_source(parse_json(raw, "boundary source"), set(source_ids))
    mapping = _parse_mappings(args.id_map)
    catalogue = None
    catalogue_source = None
    review = None
    review_source = None
    rarity_review = None
    rarity_review_source = None
    if args.catalogue_source:
        catalogue_raw, catalogue_source = read_source(args.catalogue_source, "catalogue")
        catalogue = parse_catalogue(parse_json(catalogue_raw, "legacy catalogue"))
    if args.new_park_review:
        review_raw, review_source = read_source(str(args.new_park_review), "new park review")
        review = parse_review(parse_json(review_raw, "new park review"))
    rarity_review_path = getattr(args, "rarity_review", None)
    if rarity_review_path:
        rarity_review_raw, rarity_review_source = read_source(str(rarity_review_path), "rarity review")
        rarity_review = parse_rarity_review(parse_json(rarity_review_raw, "rarity review"))
    target_ids = [mapping.get(item, item) for item in source_ids]
    with _connect() as conn:
        target, parks, boundaries, hubs = capture_target(conn, args.target_host, args.target_environment, target_ids)
    for target_id in target_ids:
        if target_id not in parks and target_id in boundaries:
            raise ParkImportError(f"Target boundary {target_id} has no matching park row")
    plan = build_plan(
        features, boundary_source, source_ids, mapping, target, parks, boundaries,
        catalogue, catalogue_source, review, review_source, hubs,
        rarity_review, rarity_review_source,
    )
    _write_plan(args.out, plan)
    return {"planSha256": plan["planSha256"], "status": plan["status"], "target": plan["target"], "changeCount": len(plan["changes"]), "blockers": plan["blockers"], "planPath": str(args.out.expanduser().resolve())}


def run_apply(args: argparse.Namespace) -> dict[str, Any]:
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", args.target_environment):
        raise ParkImportError("Target environment must be a lowercase label such as staging or local-qa")
    plan = load_reviewed_plan(args.plan, args.reviewed_plan_sha)
    if args.expected_target_host != plan["target"]["declaredHost"] or args.target_environment != plan["target"]["environment"]:
        raise ParkImportError("Expected target host and environment must match the reviewed plan")
    verify_plan_sources(plan)
    with _connect() as conn:
        result = apply_transaction(conn, plan, args.expected_target_host, args.target_environment)
    return {"planSha256": plan["planSha256"], "target": plan["target"], **result}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    planning = commands.add_parser("plan", help="create a read-only, hash-pinned import plan")
    planning.add_argument("--source", default=DEFAULT_BOUNDARY_URL, help="legacy FeatureCollection file or HTTPS URL")
    planning.add_argument("--park-id", action="append", default=[], help="exact legacy stable ID to include; repeat as needed")
    planning.add_argument("--park-id-file", type=Path, help="file with one legacy stable ID per line, added after any --park-id values")
    planning.add_argument("--id-map", action="append", default=[], help="explicit old-id:new-id rename; repeat as needed")
    planning.add_argument("--catalogue-source", default=None, help="legacy places JSON file or HTTPS URL, required when adding a park")
    planning.add_argument("--new-park-review", type=Path, help="review JSON with presentation, walkM, and drive for new parks")
    planning.add_argument("--rarity-review", type=Path, help="hash-pinned review JSON for rarity changes to existing parks")
    planning.add_argument("--target-host", required=True, help="host expected from DATABASE_URL")
    planning.add_argument("--target-environment", required=True, help="explicit label recorded in the plan")
    planning.add_argument("--out", required=True, type=Path, help="path for the frozen JSON review plan")
    planning.set_defaults(run=run_plan)

    applying = commands.add_parser("apply", help="apply one reviewed plan in one PostgreSQL transaction")
    applying.add_argument("--plan", required=True, type=Path)
    applying.add_argument("--reviewed-plan-sha", required=True, help="planSha256 value shown by the plan command")
    applying.add_argument("--expected-target-host", required=True)
    applying.add_argument("--target-environment", required=True)
    applying.set_defaults(run=run_apply)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        result = args.run(args)
    except ParkImportError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    except Exception as exc:
        print(f"Legacy park import failed ({type(exc).__name__})", file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2, sort_keys=True, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

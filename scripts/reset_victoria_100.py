"""Plan or apply the one-time Victoria 100 staging catalogue reset.

Apply is opt-in. The command requires a source-attributed, complete seed bundle,
an exact target database binding, an expected content revision, a reviewed plan
hash, and a verified public-only export before it writes any catalogue rows.
"""
from __future__ import annotations

import argparse
from dataclasses import dataclass
from copy import deepcopy
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sys
from typing import Any
from urllib.parse import unquote, urlsplit


ROOT = Path(__file__).resolve().parents[1]
WORKSPACE_ROOT = ROOT.parents[2] if ROOT.parent.name == "worktrees" and ROOT.parent.parent.name == ".codex" else ROOT
TRACKED_SEED_ROOT = ROOT / "database" / "seeds" / "victoria-100-20260927"
RANKED_LIST = TRACKED_SEED_ROOT / "victoria-top-100-staging-2026-09-27.json"
HISTORICAL_RANKED_LIST = WORKSPACE_ROOT / ".codex" / "outputs" / "victoria-top-100-staging-2026-09-27.json"
DEFAULT_BUNDLE = TRACKED_SEED_ROOT / "victoria-100-seed-v1.json"
HISTORICAL_RANKED_SHA256 = "05e1bf2566dc18fb148a3bfa06a5c8434ac37f2a6faa1d4c539b92b0078e4a42"
HISTORICAL_RANK_ORDER_SHA256 = "dae42130426baad3c212758ece4a540d8eed9f0edc270e238e0c8290addfdc38"
BUNDLE_SCHEMA = "parkdex.victoria-100-seed/v1"
BACKUP_SCHEMA = "parkdex.kip-public-content-backup/v1"
PLAN_SCHEMA = "parkdex.victoria-100-reset-plan/v1"
SYNC_SCHEMA = "parkdex.content-sync/v1"
MAX_SYNC_RESPONSE_BYTES = 4 * 1024 * 1024
RANKED_SOURCE_NAME = "victoria-top-100-staging-2026-09-27.json"
SKELETON_BLURB = "A new park to explore. Badge and park story coming soon."
UNRESOLVED_RANK_69_ID = "municipal-district-of-north-saanich-1850"
PARK_FIELDS = (
    "id", "name", "short", "category", "region", "lat", "lng", "biome",
    "shape", "rarity", "scene", "seed", "blurb",
)
FIELD_SET = set(PARK_FIELDS)
BIOMES = {"coast", "forest", "mountain", "lake", "waterfall", "river", "cave", "marsh", "heritage"}
CATEGORIES = {"national", "provincial", "regional", "municipal", "community"}
SHAPES = {"circle", "hex", "shield", "arch", "seal"}
RARITIES = {"common", "uncommon", "rare", "epic", "legendary"}
SHA256_RE = re.compile(r"^[a-f0-9]{64}$")
PARK_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")
RESET_LOCK_KEY = 58297261004100


class ResetError(RuntimeError):
    """A source, target, state, or database safety check failed."""


@dataclass(frozen=True)
class Seed:
    bundle_sha256: str
    ranked_sha256: str
    parks: tuple[dict[str, Any], ...]
    boundaries: dict[str, dict[str, Any]]
    hubs: tuple[dict[str, Any], ...]
    settings: dict[str, float]
    routes: dict[tuple[str, int], tuple[float | None, float | None]]
    source_attribution: dict[str, Any]

    @property
    def park_ids(self) -> tuple[str, ...]:
        return tuple(park["id"] for park in self.parks)


@dataclass(frozen=True)
class Target:
    environment: str
    target_id: str | None
    database_host: str
    database_name: str
    database_user: str


@dataclass
class DatabaseState:
    revision: int
    parks: dict[str, dict[str, Any]]
    boundaries: dict[str, Any]
    hubs: dict[int, tuple[str, float, float]]
    settings: dict[str, float]
    routes: dict[tuple[str, int], tuple[float | None, float | None]]
    jobs: dict[int, dict[str, Any]]
    marker: dict[str, Any] | None
    map_pointer: dict[str, Any] | None
    account_tables: tuple[str, ...] = ()
    account_table_counts: dict[str, int] | None = None
    public_table_counts: dict[str, int] | None = None


def _pairs_without_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ResetError(f"JSON contains duplicate object key {key!r}")
        result[key] = value
    return result


def _strict_json(raw: bytes, label: str) -> Any:
    try:
        return json.loads(raw.decode("utf-8"), object_pairs_hook=_pairs_without_duplicates,
                          parse_constant=lambda value: (_ for _ in ()).throw(ResetError(f"{label} contains invalid number {value}")))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ResetError(f"{label} is not valid UTF-8 JSON") from exc


def _object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ResetError(f"{label} must be an object")
    return value


def _text(value: Any, label: str, *, empty: bool = False) -> str:
    if not isinstance(value, str) or (not empty and not value.strip()):
        raise ResetError(f"{label} must be a non-empty string")
    return value


def _number(value: Any, label: str, minimum: float, maximum: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < minimum or value > maximum:
        raise ResetError(f"{label} is outside its valid range")
    return float(value)


def _safe_integer(value: Any, label: str, minimum: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum or value > 9007199254740991:
        raise ResetError(f"{label} must be a safe integer")
    return value


def _valid_source_url(value: Any, label: str) -> str:
    url = _text(value, label)
    parsed = urlsplit(url)
    if parsed.scheme != "https" or not parsed.hostname:
        raise ResetError(f"{label} must be an HTTPS source URL")
    return url


def _rank_order_sha256(records: list[dict[str, Any]]) -> str:
    pairs = [[record.get("rank"), record.get("id")] for record in records]
    raw = json.dumps(pairs, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def _validate_ranked_list(path: Path, historical_path: Path | None = None) -> tuple[list[dict[str, Any]], str, str]:
    try:
        raw = path.read_bytes()
    except OSError as exc:
        raise ResetError(f"could not read corrected ranked source file: {path}") from exc
    if path.name != RANKED_SOURCE_NAME:
        raise ResetError(f"corrected ranked source file must retain the canonical filename {RANKED_SOURCE_NAME}")
    ranked_sha = hashlib.sha256(raw).hexdigest()
    records = _strict_json(raw, "ranked source")
    if not isinstance(records, list) or len(records) != 100:
        raise ResetError("ranked source must contain exactly 100 ordered records")
    ids: set[str] = set()
    checked: list[dict[str, Any]] = []
    for position, raw_record in enumerate(records, start=1):
        record = _object(raw_record, f"ranked record {position}")
        rank = _safe_integer(record.get("rank"), f"ranked record {position}.rank", 1)
        if rank != position:
            raise ResetError("ranked source ranks must be exactly 1 through 100 in file order")
        park_id = _text(record.get("id"), f"ranked record {position}.id")
        if not PARK_ID_RE.fullmatch(park_id) or park_id in ids:
            raise ResetError(f"ranked source has an invalid or duplicate park id at rank {position}")
        ids.add(park_id)
        _text(record.get("name"), f"ranked record {position}.name")
        checked.append(record)
    if historical_path is not None:
        try:
            historical_raw = historical_path.read_bytes()
        except OSError as exc:
            raise ResetError(f"could not read historical ranked source file: {historical_path}") from exc
        if historical_path.name != RANKED_SOURCE_NAME:
            raise ResetError(f"historical ranked source file must retain the canonical filename {RANKED_SOURCE_NAME}")
        historical_sha = hashlib.sha256(historical_raw).hexdigest()
        historical_records = _strict_json(historical_raw, "historical ranked source")
        if not isinstance(historical_records, list) or len(historical_records) != 100:
            raise ResetError("historical ranked source must contain exactly 100 ordered records")
        historical_pairs = [(record.get("rank"), record.get("id")) for record in historical_records if isinstance(record, dict)]
        corrected_pairs = [(record.get("rank"), record.get("id")) for record in checked]
        if historical_pairs != corrected_pairs:
            raise ResetError("corrected ranked source must preserve the exact historical rank and park ID order")
    else:
        historical_sha = HISTORICAL_RANKED_SHA256
        if _rank_order_sha256(checked) != HISTORICAL_RANK_ORDER_SHA256:
            raise ResetError("corrected ranked source IDs/order do not match the pinned historical source")
    rank69 = checked[68]
    if (
        rank69.get("id") == UNRESOLVED_RANK_69_ID
        and rank69.get("current_official_name") == "Cy Hampson Park"
    ):
        raise ResetError("rank 69 still labels OID 1850 as Cy Hampson Park; use the corrected, source-pinned Bazan Bay identity")
    if rank69.get("id") == UNRESOLVED_RANK_69_ID and (
        rank69.get("name") != "Bazan Bay Park" or rank69.get("current_official_name") != "Bazan Bay Park"
    ):
        raise ResetError("rank 69 Bazan Bay identity is not fully corrected in the executable ranked source")
    return checked, ranked_sha, historical_sha


def _validate_park(raw_park: Any, expected_rank: int, expected_ranked: dict[str, Any]) -> dict[str, Any]:
    park = _object(raw_park, f"seed park at rank {expected_rank}")
    missing = FIELD_SET - set(park)
    if missing:
        raise ResetError(f"seed park at rank {expected_rank} is missing runtime fields: {sorted(missing)}")
    if _safe_integer(park.get("rank"), f"seed park at rank {expected_rank}.rank", 1) != expected_rank:
        raise ResetError("seed parks must follow the ranked source order")
    park_id = _text(park["id"], f"seed park at rank {expected_rank}.id")
    if park_id != expected_ranked["id"]:
        raise ResetError(f"seed park rank {expected_rank} does not match the ranked source ID")
    if not PARK_ID_RE.fullmatch(park_id):
        raise ResetError(f"seed park rank {expected_rank} has an invalid id")
    if park.get("category") != expected_ranked.get("category"):
        raise ResetError(f"seed park category does not match the ranked source for {park_id}")
    if park.get("region") != expected_ranked.get("region"):
        raise ResetError(f"seed park region does not match the ranked source for {park_id}")
    if park.get("scene") is not None:
        raise ResetError(f"seed park scene must be NULL for the initial rollout: {park_id}")
    name = _text(park["name"], f"seed park {park_id}.name")
    if name != expected_ranked.get("name"):
        raise ResetError(f"seed park name does not match the ranked source for {park_id}")
    short = _text(park["short"], f"seed park {park_id}.short")
    region = _text(park["region"], f"seed park {park_id}.region", empty=True)
    category = _text(park["category"], f"seed park {park_id}.category")
    biome = _text(park["biome"], f"seed park {park_id}.biome")
    shape = _text(park["shape"], f"seed park {park_id}.shape")
    rarity = _text(park["rarity"], f"seed park {park_id}.rarity")
    if category not in CATEGORIES or biome not in BIOMES or shape not in SHAPES or rarity not in RARITIES:
        raise ResetError(f"seed park has an unsupported category, biome, shape, or rarity: {park_id}")
    if not isinstance(park["blurb"], str):
        raise ResetError(f"seed park blurb must be text: {park_id}")
    if park["blurb"] != SKELETON_BLURB:
        raise ResetError(f"seed park must use the exact initial skeleton blurb: {park_id}")
    seed = _safe_integer(park["seed"], f"seed park {park_id}.seed")
    if seed > 2147483647:
        raise ResetError(f"seed park value is outside PostgreSQL integer range: {park_id}")
    result = {
        "id": park_id, "name": name, "short": short, "category": category, "region": region,
        "lat": _number(park["lat"], f"seed park {park_id}.lat", -90, 90),
        "lng": _number(park["lng"], f"seed park {park_id}.lng", -180, 180),
        "biome": biome, "shape": shape, "rarity": rarity, "scene": None,
        "seed": seed, "blurb": park["blurb"],
    }
    if not name.strip() or not short.strip():
        raise ResetError(f"seed park has an empty name or short label: {park_id}")
    return result


def _validate_boundary(raw_feature: Any, park: dict[str, Any]) -> dict[str, Any]:
    feature = _object(raw_feature, f"boundary for {park['id']}")
    if set(feature) != {"type", "properties", "geometry"} or feature.get("type") != "Feature":
        raise ResetError(f"boundary feature has invalid GeoJSON fields: {park['id']}")
    properties = _object(feature.get("properties"), f"boundary properties for {park['id']}")
    if set(properties) != {"id", "biome"} or properties.get("id") != park["id"] or properties.get("biome") != park["biome"]:
        raise ResetError(f"boundary identity or biome does not match its park: {park['id']}")
    geometry = _object(feature.get("geometry"), f"boundary geometry for {park['id']}")
    if set(geometry) != {"type", "coordinates"} or geometry.get("type") != "MultiPolygon":
        raise ResetError(f"boundary must be an exact MultiPolygon feature: {park['id']}")
    polygons = geometry.get("coordinates")
    if not isinstance(polygons, list) or not polygons:
        raise ResetError(f"boundary has no polygon coordinates: {park['id']}")
    for polygon_index, polygon in enumerate(polygons):
        if not isinstance(polygon, list) or not polygon:
            raise ResetError(f"boundary polygon is empty: {park['id']}")
        for ring_index, ring in enumerate(polygon):
            if not isinstance(ring, list) or len(ring) < 4:
                raise ResetError(f"boundary ring is too short: {park['id']}")
            points: list[tuple[float, float]] = []
            for point in ring:
                if not isinstance(point, list) or len(point) != 2:
                    raise ResetError(f"boundary coordinate is invalid: {park['id']}")
                points.append((_number(point[0], f"boundary {park['id']} longitude", -180, 180),
                               _number(point[1], f"boundary {park['id']} latitude", -90, 90)))
            if points[0] != points[-1]:
                raise ResetError(f"boundary ring is not closed: {park['id']}")
    return feature


def _validate_source_attribution(value: Any, expected_ids: set[str], ranked_sha: str, historical_sha: str) -> dict[str, Any]:
    attribution = _object(value, "sourceAttribution")
    ranked = _object(attribution.get("rankedList"), "sourceAttribution.rankedList")
    if ranked.get("sha256") != ranked_sha or Path(_text(ranked.get("path"), "ranked source path")).name != RANKED_SOURCE_NAME:
        raise ResetError("source attribution does not pin the exact ranked source file and hash")
    original = _object(attribution.get("originalRankedList"), "sourceAttribution.originalRankedList")
    if original.get("sha256") != historical_sha or Path(_text(original.get("path"), "historical ranked source path")).name != RANKED_SOURCE_NAME:
        raise ResetError("source attribution does not pin the unchanged historical ranked source bytes")

    geometry = attribution.get("geometry")
    if not isinstance(geometry, list) or len(geometry) != 100:
        raise ResetError("source attribution must identify all 100 boundary source records")
    geometry_ids: set[str] = set()
    for index, raw_item in enumerate(geometry):
        item = _object(raw_item, f"geometry source record {index + 1}")
        park_id = _text(item.get("parkId"), f"geometry source record {index + 1}.parkId")
        if park_id not in expected_ids or park_id in geometry_ids:
            raise ResetError("geometry source attribution has an unknown or duplicate park id")
        geometry_ids.add(park_id)
        _valid_source_url(item.get("sourceUrl"), f"geometry source URL for {park_id}")
        _text(item.get("sourceId"), f"geometry source ID for {park_id}")
        if not SHA256_RE.fullmatch(_text(item.get("sha256"), f"geometry source hash for {park_id}")):
            raise ResetError(f"geometry source hash is invalid: {park_id}")
    if geometry_ids != expected_ids:
        raise ResetError("geometry sources do not cover the exact 100 park IDs")

    drive = _object(attribution.get("drive"), "sourceAttribution.drive")
    for key in ("hubs", "routes"):
        item = _object(drive.get(key), f"sourceAttribution.drive.{key}")
        _valid_source_url(item.get("sourceUrl"), f"sourceAttribution.drive.{key}.sourceUrl")
        if not SHA256_RE.fullmatch(_text(item.get("sha256"), f"sourceAttribution.drive.{key}.sha256")):
            raise ResetError(f"sourceAttribution.drive.{key} hash is invalid")

    rank69 = _object(attribution.get("rank69"), "sourceAttribution.rank69")
    _text(rank69.get("decision"), "rank 69 identity decision")
    sources = rank69.get("sources")
    if not isinstance(sources, list) or len(sources) < 2:
        raise ResetError("rank 69 requires at least two source references to pin the resolved park identity")
    for index, source_value in enumerate(sources, start=1):
        source_url = source_value.get("url") if isinstance(source_value, dict) else source_value
        _valid_source_url(source_url, f"rank 69 source URL {index}")
    return attribution


def load_seed(bundle_path: Path, ranked_path: Path = RANKED_LIST,
              historical_ranked_path: Path | None = None) -> Seed:
    try:
        raw_bundle = bundle_path.read_bytes()
    except OSError as exc:
        raise ResetError(f"could not read seed bundle: {bundle_path}") from exc
    bundle_sha = hashlib.sha256(raw_bundle).hexdigest()
    bundle = _object(_strict_json(raw_bundle, "seed bundle"), "seed bundle")
    if bundle.get("schema") != BUNDLE_SCHEMA:
        raise ResetError(f"seed bundle schema must be {BUNDLE_SCHEMA}")
    ranked, ranked_sha, historical_sha = _validate_ranked_list(ranked_path, historical_ranked_path)
    if bundle.get("rankedListSha256") != ranked_sha:
        raise ResetError("seed bundle rankedListSha256 does not match the exact ranked source bytes")
    expected_ids = {record["id"] for record in ranked}
    raw_parks = bundle.get("parks")
    if not isinstance(raw_parks, list) or len(raw_parks) != 100:
        raise ResetError("seed bundle must contain exactly 100 ranked park skeletons")
    parks = tuple(_validate_park(item, index, ranked[index - 1]) for index, item in enumerate(raw_parks, 1))
    if len({park["id"] for park in parks}) != 100:
        raise ResetError("seed bundle has duplicate park IDs")

    raw_boundaries = bundle.get("boundaries")
    if not isinstance(raw_boundaries, list) or len(raw_boundaries) != 100:
        raise ResetError("seed bundle must contain exactly 100 boundaries")
    parks_by_id = {park["id"]: park for park in parks}
    boundaries: dict[str, dict[str, Any]] = {}
    for item in raw_boundaries:
        feature = _object(item, "boundary feature")
        properties = _object(feature.get("properties"), "boundary properties")
        park_id = properties.get("id")
        if not isinstance(park_id, str) or park_id not in parks_by_id or park_id in boundaries:
            raise ResetError("seed boundary has an unknown or duplicate park id")
        boundaries[park_id] = _validate_boundary(feature, parks_by_id[park_id])
    if set(boundaries) != expected_ids:
        raise ResetError("seed boundaries do not match the exact ranked park IDs")

    drive = _object(bundle.get("drive"), "seed drive")
    raw_hubs = drive.get("hubs")
    if not isinstance(raw_hubs, list) or len(raw_hubs) != 8:
        raise ResetError("seed bundle must contain exactly 8 ordered drive hubs")
    hubs: list[dict[str, Any]] = []
    for position, raw_hub in enumerate(raw_hubs):
        hub = _object(raw_hub, f"drive hub {position}")
        name = _text(hub.get("name"), f"drive hub {position}.name")
        hubs.append({"name": name, "lng": _number(hub.get("lng"), f"drive hub {position}.lng", -180, 180),
                     "lat": _number(hub.get("lat"), f"drive hub {position}.lat", -90, 90)})
    if len({hub["name"] for hub in hubs}) != 8:
        raise ResetError("drive hub names must be unique")

    raw_settings = drive.get("settings")
    if not isinstance(raw_settings, list) or len(raw_settings) != 100:
        raise ResetError("seed drive settings must contain exactly 100 parks")
    settings: dict[str, float] = {}
    for raw_setting in raw_settings:
        item = _object(raw_setting, "drive setting")
        park_id = _text(item.get("parkId"), "drive setting.parkId")
        if park_id not in expected_ids or park_id in settings:
            raise ResetError("drive settings contain an unknown or duplicate park id")
        settings[park_id] = _number(item.get("walkM"), f"drive setting walkM for {park_id}", 0, 9007199254740991)
    if set(settings) != expected_ids:
        raise ResetError("drive settings do not match the exact ranked park IDs")

    raw_routes = drive.get("routes")
    if not isinstance(raw_routes, list) or len(raw_routes) != 800:
        raise ResetError("seed bundle must contain exactly 800 park-to-hub route rows")
    routes: dict[tuple[str, int], tuple[float | None, float | None]] = {}
    for raw_route in raw_routes:
        item = _object(raw_route, "drive route")
        park_id = _text(item.get("parkId"), "drive route.parkId")
        position = _safe_integer(item.get("hubPosition"), "drive route.hubPosition")
        if park_id not in expected_ids or position >= 8 or (park_id, position) in routes:
            raise ResetError("drive route has an unknown park, hub, or duplicate pair")
        distance = item.get("distanceKm")
        duration = item.get("durationMin")
        if (distance is None) != (duration is None):
            raise ResetError(f"drive route has only one estimate: {park_id} hub {position}")
        if distance is None:
            pair = (None, None)
        else:
            pair = (_number(distance, f"drive route distance for {park_id}", 0, 9007199254740991),
                    _number(duration, f"drive route duration for {park_id}", 0, 9007199254740991))
        routes[(park_id, position)] = pair
    expected_pairs = {(park_id, position) for park_id in expected_ids for position in range(8)}
    if set(routes) != expected_pairs:
        raise ResetError("drive routes do not cover the exact 100 by 8 park and hub matrix")

    attribution = _validate_source_attribution(bundle.get("sourceAttribution"), expected_ids, ranked_sha, historical_sha)
    return Seed(bundle_sha, ranked_sha, parks, boundaries, tuple(hubs), settings, routes, attribution)


def parse_target(database_url: str, environment: str, target_id: str | None, expected_host: str) -> Target:
    uri = urlsplit(database_url)
    if uri.scheme not in {"postgres", "postgresql"} or not uri.hostname or not uri.username or uri.password is None:
        raise ResetError("database URL must be a complete PostgreSQL connection URI")
    host = uri.hostname.lower().rstrip(".")
    if host != expected_host.lower().rstrip("."):
        raise ResetError("database host does not match --expected-database-host")
    database_name = unquote(uri.path.lstrip("/"))
    database_user = unquote(uri.username)
    if environment == "staging":
        if target_id is not None:
            raise ResetError("--target-id is allowed only for an owned-preview target")
        if database_name != "parkdex_kip":
            raise ResetError("staging target must use database parkdex_kip")
        if database_user != "parkdex_kip_owner":
            raise ResetError("staging target must use the configured staging owner role")
    elif environment == "owned-preview":
        if target_id != "18":
            raise ResetError("owned-preview reset is restricted to PR 18")
        database_match = re.fullmatch(r"kip_preview_18_([a-f0-9]{10})", database_name)
        user_match = re.fullmatch(r"kip_pr_18_([a-f0-9]{10})", database_user)
        if not database_match or not user_match or database_match.group(1) != user_match.group(1):
            raise ResetError("PR 18 target must use its exact preview database and role identity")
    else:
        raise ResetError("target must be staging or owned-preview")
    return Target(environment, target_id, host, database_name, database_user)


def _float_db(value: Any) -> float | None:
    return None if value is None else float(value)


def load_database_state(conn: Any) -> DatabaseState:
    with conn.cursor() as cursor:
        cursor.execute("SELECT revision FROM public.content_clock WHERE singleton = true")
        clock = cursor.fetchone()
        if clock is None:
            raise ResetError("content clock is missing; apply approved content migrations first")
        revision = int(clock[0])
        cursor.execute("SELECT id, name, short, category, region, lat, lng, biome, shape, rarity, scene, seed, blurb FROM public.parks")
        parks: dict[str, dict[str, Any]] = {}
        for row in cursor.fetchall():
            park = dict(zip(PARK_FIELDS, row, strict=True))
            parks[park["id"]] = park
        cursor.execute("SELECT park_id, feature FROM public.boundaries")
        boundaries = {row[0]: row[1] for row in cursor.fetchall()}
        cursor.execute("SELECT position, name, lng, lat FROM public.drive_hubs")
        hubs = {int(row[0]): (row[1], float(row[2]), float(row[3])) for row in cursor.fetchall()}
        cursor.execute("SELECT park_id, walk_m FROM public.park_drive_settings")
        settings = {row[0]: float(row[1]) for row in cursor.fetchall()}
        cursor.execute("SELECT park_id, hub_position, distance_km, duration_min FROM public.park_drive")
        routes = {(row[0], int(row[1])): (_float_db(row[2]), _float_db(row[3])) for row in cursor.fetchall()}
        cursor.execute("""
            SELECT rank, park_id, state, lease_token, lease_expires_at, attempt_count,
                   frozen_research, selected_art, publication_result, published_at, last_error,
                   render_calls_started, run_manifest_path, run_manifest_sha256, render_call_log
              FROM public.park_enrichment_jobs
             ORDER BY rank
        """)
        jobs = {
            int(row[0]): {
                "park_id": row[1], "state": row[2], "lease_token": row[3],
                "lease_expires_at": row[4], "attempt_count": int(row[5]),
                "frozen_research": row[6], "selected_art": row[7],
                "publication_result": row[8], "published_at": row[9], "last_error": row[10],
                "render_calls_started": int(row[11]), "run_manifest_path": row[12],
                "run_manifest_sha256": row[13], "render_call_log": row[14],
            }
            for row in cursor.fetchall()
        }
        cursor.execute("""
            SELECT source_bundle_sha256, ranked_list_sha256, expected_count,
                   applied_content_revision, target_environment, target_id, database_host
              FROM public.park_enrichment_rollout
             WHERE singleton = true
        """)
        marker_row = cursor.fetchone()
        marker = None if marker_row is None else dict(zip((
            "source_bundle_sha256", "ranked_list_sha256", "expected_count", "applied_content_revision",
            "target_environment", "target_id", "database_host",
        ), marker_row, strict=True))
        cursor.execute("SELECT version, manifest_url, manifest_sha256 FROM public.content_map WHERE singleton = true")
        map_row = cursor.fetchone()
        map_pointer = None if map_row is None else dict(zip(("version", "manifest_url", "manifest_sha256"), map_row, strict=True))
        cursor.execute("""
            SELECT table_name FROM information_schema.tables
             WHERE table_schema = 'kip_account' AND table_type = 'BASE TABLE'
             ORDER BY table_name
        """)
        account_tables = tuple(row[0] for row in cursor.fetchall())
        account_table_counts: dict[str, int] = {}
        for table_name in account_tables:
            if not re.fullmatch(r"[a-z_][a-z0-9_]*", table_name):
                raise ResetError("account schema contains an unexpected table name")
            cursor.execute(f'SELECT count(*) FROM "kip_account"."{table_name}"')
            count_row = cursor.fetchone()
            account_table_counts[table_name] = int(count_row[0])
        public_table_counts: dict[str, int] = {}
        for table_name in sorted(BACKUP_TABLES):
            if not re.fullmatch(r"[a-z_][a-z0-9_]*", table_name):
                raise ResetError("public backup allowlist contains an unexpected table name")
            cursor.execute(f'SELECT count(*) FROM public."{table_name}"')
            count_row = cursor.fetchone()
            public_table_counts[table_name] = int(count_row[0])
    return DatabaseState(revision, parks, boundaries, hubs, settings, routes, jobs, marker, map_pointer,
                         account_tables, account_table_counts, public_table_counts)


def _legacy_source(root: Path = ROOT) -> tuple[dict[str, dict[str, Any]], dict[str, Any], dict[int, tuple[str, float, float]], dict[str, float], dict[tuple[str, int], tuple[float | None, float | None]]]:
    try:
        raw_parks = _strict_json((root / "src/data/parks.json").read_bytes(), "tracked legacy parks")
        raw_boundaries = _strict_json((root / "public/boundaries.geojson").read_bytes(), "tracked legacy boundaries")
        raw_drive = _strict_json((root / "src/data/drive.json").read_bytes(), "tracked legacy drive data")
    except OSError as exc:
        raise ResetError("tracked legacy catalogue sources are missing") from exc
    if not isinstance(raw_parks, list) or not isinstance(raw_boundaries, dict) or not isinstance(raw_drive, dict):
        raise ResetError("tracked legacy catalogue sources have an invalid shape")
    parks = {park["id"]: {field: park[field] for field in PARK_FIELDS} for park in raw_parks}
    boundaries = {feature["properties"]["id"]: feature for feature in raw_boundaries.get("features", [])}
    hubs = {position: (hub["name"], float(hub["lng"]), float(hub["lat"])) for position, hub in enumerate(raw_drive.get("hubs", []))}
    settings: dict[str, float] = {}
    routes: dict[tuple[str, int], tuple[float | None, float | None]] = {}
    for park_id, entry in raw_drive.get("parks", {}).items():
        settings[park_id] = float(entry["walkM"])
        if len(entry["drive"]) != len(hubs):
            raise ResetError(f"tracked legacy route source does not have 8 rows: {park_id}")
        for position, route in enumerate(entry["drive"]):
            routes[(park_id, position)] = (None, None) if route is None else (float(route[0]), float(route[1]))
    if len(parks) != len(raw_parks) or len(boundaries) != len(raw_boundaries.get("features", [])):
        raise ResetError("tracked legacy catalogue has duplicate park or boundary IDs")
    return parks, boundaries, hubs, settings, routes


def _seed_rows(seed: Seed) -> tuple[dict[str, dict[str, Any]], dict[str, Any], dict[int, tuple[str, float, float]], dict[str, float], dict[tuple[str, int], tuple[float | None, float | None]]]:
    parks = {park["id"]: dict(park) for park in seed.parks}
    boundaries = deepcopy(seed.boundaries)
    hubs = {position: (hub["name"], hub["lng"], hub["lat"]) for position, hub in enumerate(seed.hubs)}
    return parks, boundaries, hubs, dict(seed.settings), dict(seed.routes)


def _same_rows(state: DatabaseState, rows: tuple[dict[str, dict[str, Any]], dict[str, Any], dict[int, tuple[str, float, float]], dict[str, float], dict[tuple[str, int], tuple[float | None, float | None]]]) -> bool:
    parks, boundaries, hubs, settings, routes = rows
    return (
        state.parks == parks and state.boundaries == boundaries and state.hubs == hubs
        and state.settings == settings and state.routes == routes
    )


def _job_mapping(seed: Seed) -> dict[int, str]:
    return {rank: park["id"] for rank, park in enumerate(seed.parks, start=1)}


def _published(job: dict[str, Any]) -> bool:
    return job.get("published_at") is not None or job.get("publication_result") is not None or job.get("state") == "published"


def _selected_scene_slug(job: dict[str, Any], park_id: str) -> str:
    selected = job.get("selected_art")
    if not isinstance(selected, dict) or not isinstance(selected.get("scene_slug"), str):
        raise ResetError(f"published queue job has no selected scene identity: {park_id}")
    candidate = selected["scene_slug"]
    desired = selected.get("desired")
    if not isinstance(desired, dict) or desired.get("scene") != candidate:
        raise ResetError(f"published queue job selected-art scene does not match desired park scene: {park_id}")
    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", candidate):
        raise ResetError(f"published queue job has an invalid selected scene identity: {park_id}")
    return candidate


def _verify_published_replay(state: DatabaseState, seed: Seed) -> None:
    parks, boundaries, hubs, settings, routes = _seed_rows(seed)
    if set(state.parks) != set(parks) or set(state.boundaries) != set(boundaries):
        raise ResetError("published rollout has missing or unexpected park/boundary IDs")
    if state.boundaries != boundaries:
        raise ResetError("published rollout boundary rows differ from the pinned seed bundle")
    if state.hubs != hubs or state.settings != settings or state.routes != routes:
        raise ResetError("published rollout drive rows differ from the pinned seed bundle")
    for rank, job in state.jobs.items():
        park_id = job["park_id"]
        actual = state.parks.get(park_id)
        if actual is None:
            raise ResetError(f"published rollout park is missing: {park_id}")
        if _published(job):
            expected_scene = _selected_scene_slug(job, park_id)
            if actual.get("scene") != expected_scene:
                raise ResetError(f"published rollout scene differs from selected art for {park_id}")
        elif actual != parks[park_id]:
            raise ResetError(f"unpublished park changed from its initial skeleton: {park_id}")


def classify_state(state: DatabaseState, seed: Seed, target: Target, root: Path = ROOT) -> str:
    """Return reset, exact-replay, or published-replay; reject divergent state."""
    marker = state.marker
    expected_jobs = _job_mapping(seed)
    if marker is not None:
        expected_marker = {
            "source_bundle_sha256": seed.bundle_sha256,
            "ranked_list_sha256": seed.ranked_sha256,
            "expected_count": 100,
            "target_environment": target.environment,
            "target_id": target.target_id,
            "database_host": target.database_host,
        }
        if any(marker.get(key) != value for key, value in expected_marker.items()):
            raise ResetError("existing Victoria rollout marker differs from this seed bundle or target; refusing to reset")
        if marker.get("applied_content_revision") is None:
            raise ResetError("existing Victoria rollout marker has no applied content revision")
        if marker["applied_content_revision"] > state.revision:
            raise ResetError("existing Victoria rollout marker is ahead of the content clock")
        actual_jobs = {rank: item["park_id"] for rank, item in state.jobs.items()}
        if actual_jobs != expected_jobs:
            raise ResetError("existing rollout marker has a different queue rank and park ID mapping")
        if len(state.jobs) != 100:
            raise ResetError("existing rollout queue does not contain exactly 100 rows")
        if any(_published(job) for job in state.jobs.values()):
            _verify_published_replay(state, seed)
            return "published-replay"
        progressed = any(
            job.get("state") != "queued" or job.get("lease_token") is not None
            or job.get("lease_expires_at") is not None or job.get("attempt_count") != 0
            or job.get("frozen_research") is not None or job.get("selected_art") is not None
            or job.get("last_error") is not None or job.get("render_calls_started") != 0
            or job.get("run_manifest_path") is not None or job.get("run_manifest_sha256") is not None
            or job.get("render_call_log") not in (None, [])
            for job in state.jobs.values()
        )
        if progressed:
            if not _same_rows(state, _seed_rows(seed)):
                raise ResetError("rollout queue has progress and catalogue skeletons have diverged")
            return "in-progress-replay"
        if not _same_rows(state, _seed_rows(seed)):
            raise ResetError("catalogue rows differ from the recorded reset bundle; refusing to reset")
        return "exact-replay"

    if state.jobs:
        raise ResetError("enrichment queue rows exist without a rollout marker; refusing to replace them")
    legacy = _legacy_source(root)
    if not _same_rows(state, legacy):
        raise ResetError("current catalogue differs from tracked legacy sources; refusing to reset divergent rows")
    if _same_rows(state, _seed_rows(seed)):
        raise ResetError("catalogue already matches the Victoria seed but has no rollout marker")
    return "reset"


def _normalize_json_numbers(value: Any) -> Any:
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ResetError("cannot estimate wire size for a non-finite number")
        if value.is_integer():
            return int(value)
        return value
    if isinstance(value, list):
        return [_normalize_json_numbers(item) for item in value]
    if isinstance(value, tuple):
        return [_normalize_json_numbers(item) for item in value]
    if isinstance(value, dict):
        return {key: _normalize_json_numbers(item) for key, item in value.items()}
    return value


def _wire_json_bytes(value: Any) -> int:
    compact = json.dumps(_normalize_json_numbers(value), ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    compact = re.sub(r"e([+-])0+(\d+)", r"e\1\2", compact)
    return len(compact.encode("utf-8"))


def estimate_wire_sizes(state: DatabaseState, seed: Seed) -> tuple[int, int]:
    """Estimate canonical content snapshot and one unsplittable reset batch."""
    parks, boundaries, hubs, settings, routes = _seed_rows(seed)
    drive_parks = {
        park_id: {
            "drive": [list(routes[(park_id, position)]) if routes[(park_id, position)][0] is not None else None for position in range(8)],
            "walkM": settings[park_id],
        }
        for park_id in sorted(parks)
    }
    snapshot = {
        "schema": SYNC_SCHEMA,
        "revision": state.revision + 1,
        "parks": [parks[park_id] for park_id in sorted(parks)],
        "boundaries": {"type": "FeatureCollection", "features": [boundaries[park_id] for park_id in sorted(boundaries)]},
        "drive": {"hubs": [{"name": hubs[position][0], "lng": hubs[position][1], "lat": hubs[position][2]} for position in sorted(hubs)],
                  "parks": drive_parks},
        "assets": [],
        "map": None if state.map_pointer is None else {
            "version": state.map_pointer["version"],
            "manifestUrl": state.map_pointer["manifest_url"],
            "manifestSha256": state.map_pointer["manifest_sha256"],
        },
    }

    old_ids = set(state.parks) - set(seed.park_ids)
    changes: list[dict[str, Any]] = []
    for park_id in sorted(old_ids):
        changes.append({"entity": "park", "op": "delete", "id": park_id})
    for park_id in sorted(parks):
        changes.append({"entity": "park", "op": "upsert", "id": park_id, "value": parks[park_id]})
    for park_id in sorted(old_ids):
        changes.append({"entity": "boundary", "op": "delete", "id": park_id})
    for park_id in sorted(boundaries):
        changes.append({"entity": "boundary", "op": "upsert", "id": park_id, "value": boundaries[park_id]})
    for park_id in sorted(old_ids):
        changes.append({"entity": "drive", "op": "delete", "id": park_id})
    for park_id in sorted(parks):
        changes.append({"entity": "drive", "op": "upsert", "id": park_id, "value": drive_parks[park_id]})
    changes.append({"entity": "hubs", "op": "upsert", "id": "default",
                    "value": [{"name": hubs[position][0], "lng": hubs[position][1], "lat": hubs[position][2]} for position in sorted(hubs)]})
    batch = {
        "schema": SYNC_SCHEMA,
        "fromRevision": state.revision,
        "throughRevision": state.revision + 1,
        "headRevision": state.revision + 1,
        "hasMore": False,
        "batches": [{"revision": state.revision + 1, "changes": changes}],
    }
    return _wire_json_bytes(snapshot), _wire_json_bytes(batch)


def validate_wire_sizes(snapshot_bytes: int, batch_bytes: int) -> None:
    if snapshot_bytes > MAX_SYNC_RESPONSE_BYTES:
        raise ResetError(f"post-reset content snapshot is {snapshot_bytes} bytes, above the 4 MiB sync limit")
    if batch_bytes > MAX_SYNC_RESPONSE_BYTES:
        raise ResetError(f"reset revision batch is {batch_bytes} bytes, above the 4 MiB sync limit")


def _insert_or_update_catalogue(cursor: Any, seed: Seed, state: DatabaseState, jsonb_factory: Any) -> None:
    target_ids = set(seed.park_ids)
    old_ids = sorted(set(state.parks) - target_ids)
    if len(old_ids) != 96:
        raise ResetError(f"expected to retire exactly 96 legacy parks, found {len(old_ids)}")
    cursor.execute("DELETE FROM public.parks WHERE id = ANY(%s)", (old_ids,))

    park_insert = """
        INSERT INTO public.parks (id, name, short, category, region, lat, lng, biome, shape, rarity, scene, seed, blurb)
        VALUES (%(id)s, %(name)s, %(short)s, %(category)s, %(region)s, %(lat)s, %(lng)s, %(biome)s,
                %(shape)s, %(rarity)s, NULL, %(seed)s, %(blurb)s)
        ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name, short = EXCLUDED.short, category = EXCLUDED.category,
            region = EXCLUDED.region, lat = EXCLUDED.lat, lng = EXCLUDED.lng,
            biome = EXCLUDED.biome, shape = EXCLUDED.shape, rarity = EXCLUDED.rarity,
            scene = NULL, seed = EXCLUDED.seed, blurb = EXCLUDED.blurb
    """
    for park in seed.parks:
        cursor.execute(park_insert, park)

    boundary_insert = """
        INSERT INTO public.boundaries (park_id, feature) VALUES (%s, %s)
        ON CONFLICT (park_id) DO UPDATE SET feature = EXCLUDED.feature
    """
    for park_id in seed.park_ids:
        cursor.execute(boundary_insert, (park_id, jsonb_factory(seed.boundaries[park_id])))

    cursor.execute("DELETE FROM public.park_drive")
    cursor.execute("DELETE FROM public.park_drive_settings")
    cursor.execute("DELETE FROM public.drive_hubs")
    for position, hub in enumerate(seed.hubs):
        cursor.execute("INSERT INTO public.drive_hubs (position, name, lng, lat) VALUES (%s, %s, %s, %s)",
                       (position, hub["name"], hub["lng"], hub["lat"]))
    for park_id in seed.park_ids:
        cursor.execute("INSERT INTO public.park_drive_settings (park_id, walk_m) VALUES (%s, %s)",
                       (park_id, seed.settings[park_id]))
    for park_id in seed.park_ids:
        for position in range(8):
            distance, duration = seed.routes[(park_id, position)]
            cursor.execute("""
                INSERT INTO public.park_drive (park_id, hub_position, distance_km, duration_min)
                VALUES (%s, %s, %s, %s)
            """, (park_id, position, distance, duration))


def apply_reset(conn: Any, seed: Seed, state: DatabaseState, target: Target, jsonb_factory: Any) -> int:
    """Perform all tracked catalogue and queue DML in the caller's transaction."""
    cursor = conn.cursor()
    try:
        cursor.execute("SET CONSTRAINTS ALL DEFERRED")
        _insert_or_update_catalogue(cursor, seed, state, jsonb_factory)
        for rank, park in enumerate(seed.parks, start=1):
            cursor.execute("INSERT INTO public.park_enrichment_jobs (rank, park_id) VALUES (%s, %s)", (rank, park["id"]))
        cursor.execute("SELECT revision FROM public.content_clock WHERE singleton = true")
        clock = cursor.fetchone()
        if clock is None:
            raise ResetError("content clock disappeared while resetting the catalogue")
        revision = int(clock[0])
        if revision != state.revision + 1:
            raise ResetError(f"reset must create exactly one content revision, got {state.revision} to {revision}")
        cursor.execute("""
            INSERT INTO public.park_enrichment_rollout
                (singleton, source_bundle_sha256, ranked_list_sha256, expected_count,
                 applied_content_revision, target_environment, target_id, database_host)
            VALUES (true, %s, %s, 100, %s, %s, %s, %s)
        """, (seed.bundle_sha256, seed.ranked_sha256, revision, target.environment, target.target_id, target.database_host))
        return revision
    finally:
        cursor.close()


BACKUP_TABLES = {
    "parks", "boundaries", "drive_hubs", "park_drive_settings", "park_drive", "content_map",
    "content_clock", "content_bootstrap_receipt", "r2_objects", "version_manifests",
    "content_change_batches", "content_changes", "park_enrichment_rollout", "park_enrichment_jobs",
}


def _backup_table_rows(tables: dict[str, Any], name: str) -> list[dict[str, Any]]:
    rows = tables.get(name)
    if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
        raise ResetError(f"public backup export table {name} is missing or malformed")
    return rows


def _backup_rows_match(rows: list[dict[str, Any]], expected: dict[Any, Any], key_fields: tuple[str, ...], value_fields: tuple[str, ...], label: str) -> bool:
    actual: dict[Any, Any] = {}
    for row in rows:
        if any(field not in row for field in key_fields + value_fields):
            raise ResetError(f"public backup export table {label} is missing a required column")
        key = tuple(row[field] for field in key_fields)
        if len(key) == 1:
            key = key[0]
        if key in actual:
            raise ResetError(f"public backup export table {label} has duplicate primary keys")
        actual[key] = tuple(row[field] for field in value_fields)
    if len(key_fields) == 1 and len(value_fields) == 1:
        actual = {key: value[0] for key, value in actual.items()}
    if label == "parks":
        expected = {key: tuple(row[field] for field in value_fields) for key, row in expected.items()}
    return actual == expected


def validate_public_export(path: Path, expected_sha256: str, target: Target, state: DatabaseState) -> dict[str, Any]:
    if not SHA256_RE.fullmatch(expected_sha256):
        raise ResetError("--backup-sha256 must be a lowercase SHA-256 digest")
    try:
        raw = path.read_bytes()
    except OSError as exc:
        raise ResetError(f"could not read public backup export: {path}") from exc
    actual_sha256 = hashlib.sha256(raw).hexdigest()
    if actual_sha256 != expected_sha256:
        raise ResetError("public backup export bytes do not match --backup-sha256")
    export = _object(_strict_json(raw, "public backup export"), "public backup export")
    if export.get("schema") != BACKUP_SCHEMA:
        raise ResetError(f"backup export schema must be {BACKUP_SCHEMA}")
    export_target = _object(export.get("target"), "backup target")
    if export_target.get("environment") != target.environment or export_target.get("targetId") != target.target_id:
        raise ResetError("public backup export target does not match the requested reset target")
    database = _object(export.get("database"), "backup database identity")
    if (database.get("host", "").lower().rstrip(".") != target.database_host
            or database.get("name") != target.database_name or database.get("role") != target.database_user):
        raise ResetError("public backup export database identity does not match the active connection")
    export_revision = _safe_integer(export.get("revision"), "backup export revision")
    if export_revision != state.revision:
        raise ResetError(f"public backup export revision {export_revision} does not match database revision {state.revision}")
    tables = _object(export.get("tables"), "backup tables")
    if set(tables) != BACKUP_TABLES:
        missing = sorted(BACKUP_TABLES - set(tables))
        extra = sorted(set(tables) - BACKUP_TABLES)
        raise ResetError(f"public backup export table allowlist differs; missing={missing}, extra={extra}")
    if state.public_table_counts is None or set(state.public_table_counts) != BACKUP_TABLES:
        raise ResetError("live database table counts are unavailable for the public backup allowlist")
    for table_name in sorted(BACKUP_TABLES):
        backup_rows = _backup_table_rows(tables, table_name)
        if len(backup_rows) != state.public_table_counts[table_name]:
            raise ResetError(f"public backup export row count for {table_name} does not match the live database")

    parks = _backup_table_rows(tables, "parks")
    if not _backup_rows_match(parks, state.parks, ("id",), PARK_FIELDS[1:], "parks"):
        raise ResetError("public backup export park rows do not match the active database revision")
    boundaries = _backup_table_rows(tables, "boundaries")
    if not _backup_rows_match(boundaries, state.boundaries, ("park_id",), ("feature",), "boundaries"):
        raise ResetError("public backup export boundary rows do not match the active database revision")
    hubs = _backup_table_rows(tables, "drive_hubs")
    if not _backup_rows_match(hubs, state.hubs, ("position",), ("name", "lng", "lat"), "drive_hubs"):
        raise ResetError("public backup export hub rows do not match the active database revision")
    settings = _backup_table_rows(tables, "park_drive_settings")
    if not _backup_rows_match(settings, state.settings, ("park_id",), ("walk_m",), "park_drive_settings"):
        raise ResetError("public backup export drive settings do not match the active database revision")
    routes = _backup_table_rows(tables, "park_drive")
    if not _backup_rows_match(routes, state.routes, ("park_id", "hub_position"), ("distance_km", "duration_min"), "park_drive"):
        raise ResetError("public backup export route rows do not match the active database revision")

    clock_rows = _backup_table_rows(tables, "content_clock")
    if len(clock_rows) != 1 or clock_rows[0].get("revision") != state.revision:
        raise ResetError("public backup export content clock does not match the active database revision")
    for table_name in BACKUP_TABLES:
        _backup_table_rows(tables, table_name)
    private_counts = _object(export.get("privateTableCounts"), "backup privateTableCounts")
    if set(private_counts) != set(state.account_tables):
        raise ResetError("public backup export private table count inventory differs from the database")
    export_counts = {name: _safe_integer(count, f"private table count {name}") for name, count in private_counts.items()}
    if export_counts != (state.account_table_counts or {}):
        raise ResetError("private account table counts changed since the reviewed public export")
    return {"path": str(path.resolve()), "sha256": actual_sha256, "revision": export_revision}


def build_plan_report(seed: Seed, target: Target, state: DatabaseState, backup: dict[str, Any], mode: str,
                      snapshot_size: int, batch_size: int) -> dict[str, Any]:
    reset = mode == "reset"
    report: dict[str, Any] = {
        "schema": PLAN_SCHEMA,
        "mode": mode,
        "target": {"environment": target.environment, "targetId": target.target_id},
        "database": {"host": target.database_host, "name": target.database_name, "role": target.database_user},
        "seedBundleSha256": seed.bundle_sha256,
        "rankedListSha256": seed.ranked_sha256,
        "expectedRevision": state.revision,
        "backup": backup,
        "operations": {
            "parksToDelete": 96 if reset else 0,
            "parksToInsertOrUpdate": 100 if reset else 0,
            "boundariesToUpsert": 100 if reset else 0,
            "driveHubsToReplace": 8 if reset else 0,
            "driveSettingsToReplace": 100 if reset else 0,
            "routesToReplace": 800 if reset else 0,
            "queueJobsToInsert": 100 if reset else 0,
            "rolloutMarkerToInsert": 1 if reset else 0,
        },
        "wireSizes": {
            "contentSnapshotBytes": snapshot_size,
            "resetRevisionBatchBytes": batch_size,
            "limitBytes": MAX_SYNC_RESPONSE_BYTES,
        },
    }
    plan_bytes = json.dumps(_normalize_json_numbers(report), ensure_ascii=False, sort_keys=True,
                            separators=(",", ":"), allow_nan=False).encode("utf-8")
    report["planSha256"] = hashlib.sha256(plan_bytes).hexdigest()
    return report


def _database_url(args: argparse.Namespace) -> str:
    value = args.database_url or os.environ.get("DATABASE_URL")
    if not value:
        raise ResetError("set DATABASE_URL or pass --database-url")
    return value


def _account_table_counts(cursor: Any) -> dict[str, int]:
    cursor.execute("""
        SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'kip_account' AND table_type = 'BASE TABLE'
         ORDER BY table_name
    """)
    names = [row[0] for row in cursor.fetchall()]
    counts: dict[str, int] = {}
    for name in names:
        if not re.fullmatch(r"[a-z_][a-z0-9_]*", name):
            raise ResetError("account schema contains an unexpected table name")
        cursor.execute(f'SELECT count(*) FROM "kip_account"."{name}"')
        row = cursor.fetchone()
        counts[name] = int(row[0])
    return counts


def _plan_json(report: dict[str, Any]) -> str:
    return json.dumps(_normalize_json_numbers(report), ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"), allow_nan=False)


def _plan_text(report: dict[str, Any]) -> str:
    backup = report["backup"]
    operations = report["operations"]
    wire = report["wireSizes"]
    return "\n".join((
        f"mode={report['mode']}",
        f"target={report['target']['environment']}{' PR #' + report['target']['targetId'] if report['target']['targetId'] else ''}",
        f"database={report['database']['name']}@{report['database']['host']}",
        f"content-revision={report['expectedRevision']}",
        f"seed={report['seedBundleSha256']}",
        f"backup={backup['path']} sha256={backup['sha256']}",
        f"plan-sha256={report['planSha256']}",
        f"operations={json.dumps(operations, sort_keys=True, separators=(',', ':'))}",
        f"snapshot-wire-size={wire['contentSnapshotBytes']} bytes; reset-batch-wire-size={wire['resetRevisionBatchBytes']} bytes; limit={wire['limitBytes']} bytes",
    ))


def run(args: argparse.Namespace) -> str:
    database_url = _database_url(args)
    target = parse_target(database_url, args.target, args.target_id, args.expected_database_host)
    seed = load_seed(Path(args.seed_bundle).resolve(), Path(args.ranked_list).resolve())
    if args.apply and args.expected_revision is None:
        raise ResetError("--apply requires --expected-revision from the reviewed dry run")
    if args.apply and not args.reviewed_plan_sha256:
        raise ResetError("--apply requires --reviewed-plan-sha256 from the reviewed dry-run JSON")
    if not args.backup_path or not args.backup_sha256:
        raise ResetError("--backup-path and --backup-sha256 are required to bind the public export to the plan")
    backup_path = Path(args.backup_path).resolve()
    try:
        import psycopg
        from psycopg.types.json import Jsonb
    except ImportError as exc:
        raise ResetError("psycopg is required; install database/requirements.txt") from exc

    with psycopg.connect(database_url) as conn:
        with conn.transaction():
            with conn.cursor() as cursor:
                if args.apply:
                    cursor.execute("SELECT pg_advisory_xact_lock(%s)", (RESET_LOCK_KEY,))
                    cursor.execute("SELECT revision FROM public.content_clock WHERE singleton = true FOR UPDATE")
                    locked_clock = cursor.fetchone()
                    if locked_clock is None:
                        raise ResetError("content clock is missing; apply approved content migrations first")
                    if int(locked_clock[0]) != args.expected_revision:
                        raise ResetError(f"content revision changed: expected {args.expected_revision}, found {int(locked_clock[0])}")
                else:
                    cursor.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
            state = load_database_state(conn)
            if args.expected_revision is not None and state.revision != args.expected_revision:
                raise ResetError(f"content revision changed: expected {args.expected_revision}, found {state.revision}")
            backup = validate_public_export(backup_path, args.backup_sha256, target, state)
            mode = classify_state(state, seed, target)
            snapshot_size, batch_size = estimate_wire_sizes(state, seed)
            validate_wire_sizes(snapshot_size, batch_size)
            report = build_plan_report(seed, target, state, backup, mode, snapshot_size, batch_size)
            if args.apply:
                reviewed_sha = args.reviewed_plan_sha256.lower()
                if not SHA256_RE.fullmatch(reviewed_sha) or reviewed_sha != report["planSha256"]:
                    raise ResetError("reviewed plan SHA-256 does not match this exact seed, export, target, and revision")
                if mode == "reset":
                    revision = apply_reset(conn, seed, state, target, Jsonb)
                    with conn.cursor() as cursor:
                        after_counts = _account_table_counts(cursor)
                    if after_counts != (state.account_table_counts or {}):
                        raise ResetError("private account table counts changed during the public catalogue reset")
                    report["result"] = "reset-and-queue-seed-committed"
                    report["appliedContentRevision"] = revision
                    report["privateTableCountsAfter"] = after_counts
                else:
                    report["result"] = "no-op-existing-rollout-preserved"
            else:
                report["result"] = "dry-run-no-database-writes"
            return _plan_json(report) if args.format == "json" else _plan_text(report)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seed-bundle", default=str(DEFAULT_BUNDLE))
    parser.add_argument("--ranked-list", default=str(RANKED_LIST))
    parser.add_argument("--database-url", help="defaults to DATABASE_URL; never printed")
    parser.add_argument("--target", choices=("staging", "owned-preview"), required=True)
    parser.add_argument("--target-id", help="required as 18 for an owned PR 18 preview")
    parser.add_argument("--expected-database-host", required=True,
                        help="exact Neon/database host expected for the chosen target")
    parser.add_argument("--expected-revision", type=int,
                        help="content revision shown by the reviewed dry run; required with --apply")
    parser.add_argument("--backup-path", required=True, help="public-only export created for this exact database and revision")
    parser.add_argument("--backup-sha256", required=True, help="exact SHA-256 of --backup-path")
    parser.add_argument("--reviewed-plan-sha256", help="planSha256 from the reviewed dry-run JSON; required with --apply")
    parser.add_argument("--format", choices=("json", "text"), default="json")
    parser.add_argument("--apply", action="store_true", help="apply the reset; default operation is read-only dry run")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.target == "owned-preview" and args.target_id != "18":
        parser.error("--target owned-preview requires --target-id 18")
    if args.target == "staging" and args.target_id is not None:
        parser.error("--target-id is only valid with --target owned-preview")
    try:
        print(run(args))
        return 0
    except ResetError as exc:
        print(f"victoria-100-reset: {exc}", file=sys.stderr)
        return 2
    except Exception as exc:
        print(f"victoria-100-reset: operation failed ({type(exc).__name__}); transaction was rolled back", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Build the reproducible legacy British Columbia park import bundle.

The bundle selects every legacy web Parkdex park that is not already in the
staging or production catalogue, keeps its complete displayed geometry and
source grouping, compares every park by stable ID, and writes importer inputs
in two phases. Phase 1 (Vancouver Island and the Gulf Islands) fits the
content sync response limit. Phase 2 (the rest of BC) does not yet; see the
bundle README.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
from pathlib import Path
import re
import sys
from typing import Any

import import_legacy_parks as importer

SCHEMA = "parkdex.legacy-bc-import-bundle.v1"
DEFAULT_BUNDLE = Path(__file__).resolve().parents[1] / "database" / "imports" / "legacy-bc-20261007"
ISLAND_BUNDLE = "../provincial-regional-20260929"
SOURCE_HASHES = {
    "legacy-places.json": "f93058cc0e0df94412c1045f649aed38ede37d8076637944b5d2b958adbf4d6a",
    "legacy-boundaries.geojson.gz": "c9be9a8a8813ad0147692bcd99fc14a22300ac037c34906b127031c740846cc8",
    "staging-rev158-snapshot.json.gz": "a333ad619079744e29a44c92b99118981101e5e350f3527a7471b7e905f5d750",
    "staging-removals-20260930.json": None,
    "fetch-record.json": None,
}
PRODUCTION_SNAPSHOT = f"{ISLAND_BUNDLE}/sources/baseline-snapshot.json"
PRODUCTION_SNAPSHOT_SHA256 = "6c181f43a031bd587f5c54a9c54f554c762a76ef8443466c90ce963bbbbcf4a1"
ISLAND_OUTPUTS = ("new-park-review.json", "boundaries.geojson", "catalogue.json")
EXPECTED_LEGACY_PLACES = 1656
# Islands are geographic check-offs in the legacy app, not parks, and no
# installed build accepts an island category.
EXCLUDED_CATEGORY = "island"
# Phase 1 is where the Victoria field test plays; it keeps the full snapshot
# under the 4 MiB content sync limit that installed builds enforce.
PHASE_1_REGIONS = ("Southern Vancouver Island",)
PHASE_1_EXTRA_IDS = ("national-gulf-islands-national-park-reserve", "national-pacific-rim-national-park-reserve")
MAX_SYNC_RESPONSE_BYTES = 4 * 1024 * 1024
# Current readers (reader=2) also receive googleMapsUrl and trailhead fields.
# Measured on staging revision 158: 1,752,260 bytes at reader 2 against
# 1,705,889 at reader 1. A new park adds the three fields as nulls.
STAGING_READER_2_EXTRA_BYTES = 1_752_260 - 1_705_889
READER_2_NULL_FIELDS_BYTES = len(',"googleMapsUrl":null,"trailheadLat":null,"trailheadLng":null')
MIN_SNAPSHOT_HEADROOM_BYTES = 512 * 1024
DUPLICATE_OVERLAP = 0.5
OVERLAP_REPORT_FLOOR = 0.01
CATEGORY_WORDS = {
    "national": "national park",
    "provincial": "provincial park",
    "regional": "regional park",
    "municipal": "municipal park",
    "community": "community park",
}
# Name rules, first match wins. Biome only picks the park card tile and map
# fill colour; it is presentation, not a habitat claim.
BIOME_RULES = (
    ("waterfall", ("falls", "waterfall", "waterfalls", "cascade", "cascades")),
    ("cave", ("cave", "caves", "cavern", "caverns")),
    ("lake", ("lake", "lakes", "pond", "ponds", "reservoir", "lac")),
    ("marsh", ("marsh", "marshes", "swamp", "bog", "wetland", "wetlands", "fen", "slough")),
    ("river", ("river", "creek", "brook", "stream", "rapids", "estuary", "canyon")),
    ("coast", ("beach", "beaches", "bay", "cove", "point", "spit", "marine", "harbour", "harbor", "lagoon",
               "island", "islands", "islet", "islets", "inlet", "shore", "shoreline", "waterfront", "seaside",
               "sound", "strait", "sands", "wharf", "dock", "foreshore", "headland", "arm", "passage", "channel",
               "ocean", "oceanview", "seaview", "sea", "seawall")),
    ("mountain", ("mount", "mountain", "mountains", "mt", "peak", "peaks", "ridge", "hill", "hills", "summit",
                  "bluff", "bluffs", "plateau", "alpine", "range", "glacier", "butte", "rock", "rocks")),
    ("heritage", ("heritage", "historic", "memorial", "cemetery", "fort", "centennial", "cenotaph", "monument",
                  "pioneer", "museum")),
)
SHORT_NAME = re.compile(
    r"\s+(?:(?:regional|provincial|marine|nature|heritage|ecological|national|community)\s+)?park(?:\s+reserve)?$",
    re.IGNORECASE,
)


def sha256(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def json_bytes(value: Any, compact: bool = False) -> bytes:
    if compact:
        text = json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    else:
        text = json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False)
    return (text + "\n").encode("utf-8")


def geometry_digest(value: Any) -> str:
    return sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))


def read_sources(bundle_dir: Path) -> dict[str, bytes]:
    raw: dict[str, bytes] = {}
    for name, expected in SOURCE_HASHES.items():
        path = bundle_dir / "sources" / name
        try:
            data = path.read_bytes()
        except OSError as exc:
            raise importer.ParkImportError(f"Missing bundle source {name} ({type(exc).__name__})") from None
        if name.endswith(".gz"):
            data = gzip.decompress(data)
        if expected is not None and sha256(data) != expected:
            raise importer.ParkImportError(f"Pinned source {name} changed: expected {expected}, got {sha256(data)}")
        raw[name] = data
    production = (bundle_dir / PRODUCTION_SNAPSHOT).resolve()
    data = production.read_bytes()
    if sha256(data) != PRODUCTION_SNAPSHOT_SHA256:
        raise importer.ParkImportError("Pinned production revision 26 snapshot changed")
    raw["production"] = data
    for name in ISLAND_OUTPUTS:
        raw[f"island/{name}"] = (bundle_dir / ISLAND_BUNDLE / name).resolve().read_bytes()
    return raw


# Geometry normalization: the same planar-face even-odd rule as the island
# bundle, so invalid source rings keep exactly the area the app counts as inside.

def in_ring(point: tuple[float, float], ring: list[list[float]]) -> bool:
    x, y = point
    inside = False
    for a, b in zip(ring, ring[1:]):
        if (a[1] > y) != (b[1] > y) and x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]:
            inside = not inside
    return inside


def legacy_inside(point: tuple[float, float], geometry: dict[str, Any]) -> bool:
    polygons = [geometry["coordinates"]] if geometry["type"] == "Polygon" else geometry["coordinates"]
    return any(
        in_ring(point, polygon[0]) and not any(in_ring(point, hole) for hole in polygon[1:])
        for polygon in polygons
    )


def polygons_of(geometry: dict[str, Any]) -> list[Any]:
    return [geometry["coordinates"]] if geometry["type"] == "Polygon" else geometry["coordinates"]


def counts(geometry: dict[str, Any]) -> dict[str, int]:
    polygons = polygons_of(geometry)
    return {
        "polygons": len(polygons),
        "holes": sum(len(polygon) - 1 for polygon in polygons),
        "rings": sum(len(polygon) for polygon in polygons),
        "positions": sum(len(ring) for polygon in polygons for ring in polygon),
    }


def _polygonal(value: Any) -> Any:
    from shapely.geometry import MultiPolygon
    from shapely.ops import unary_union

    if value.geom_type in ("Polygon", "MultiPolygon"):
        return value
    parts = [child for child in getattr(value, "geoms", []) if child.geom_type in ("Polygon", "MultiPolygon")]
    return unary_union(parts) if parts else MultiPolygon()


def normalize_invalid(feature: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any] | None]:
    from shapely.geometry import LineString, MultiPolygon, mapping, shape
    from shapely.ops import polygonize, unary_union
    from shapely.validation import make_valid

    source = feature["geometry"]
    original = shape(source)
    if original.is_valid:
        return feature, None
    park_id = feature["properties"]["id"]
    lines = [LineString(ring) for polygon in polygons_of(source) for ring in polygon]
    faces = list(polygonize(unary_union(lines)))
    included = [face for face in faces if legacy_inside(_probe(face), source)]
    if not included:
        raise importer.ParkImportError(f"{park_id}: normalization found no interior faces")
    rebuilt = unary_union(included)
    if rebuilt.is_empty or not rebuilt.is_valid:
        raise importer.ParkImportError(f"{park_id}: normalized geometry is invalid")
    parts = list(rebuilt.geoms) if rebuilt.geom_type == "MultiPolygon" else [rebuilt]
    geometry = json.loads(json.dumps(mapping(MultiPolygon(parts))))
    geometry = {"type": "MultiPolygon", "coordinates": geometry["coordinates"]}
    if not shape(geometry).is_valid:
        raise importer.ParkImportError(f"{park_id}: serialized normalized geometry is invalid")
    independent = _polygonal(make_valid(original))
    independent_difference = independent.symmetric_difference(rebuilt).area
    report = {
        "parkId": park_id,
        "method": "planar-face-even-odd-ring-union",
        "sourceGeometrySha256": geometry_digest(source),
        "normalizedGeometrySha256": geometry_digest(geometry),
        "sourceCounts": counts(source),
        "normalizedCounts": counts(geometry),
        "planarFaces": len(faces),
        "includedFaces": len(included),
        "normalizedArea": rebuilt.area,
        "independentMakeValidArea": independent.area,
        "independentMakeValidSymmetricDifferenceRatio": independent_difference / rebuilt.area,
    }
    return {**feature, "geometry": geometry}, report


def _probe(face: Any) -> tuple[float, float]:
    point = face.representative_point()
    return (point.x, point.y)


def coverage(source: dict[str, Any], output: dict[str, Any]) -> dict[str, float]:
    """Area of the legacy displayed interior that the output keeps and adds."""
    from shapely.geometry import shape
    from shapely.validation import make_valid

    source_shape = shape(source)
    if not source_shape.is_valid:
        source_shape = _polygonal(make_valid(source_shape))
    output_shape = shape(output)
    area = source_shape.area
    if area <= 0:
        raise importer.ParkImportError("Source geometry has no area")
    kept = source_shape.intersection(output_shape).area
    added = output_shape.difference(source_shape).area
    return {"sourceAreaKept": round(kept / area, 9), "areaAdded": round(added / area, 9)}


def even_odd_agreement(source: dict[str, Any], output: dict[str, Any], grid: int = 24) -> dict[str, int]:
    """Grid samples where the legacy even-odd rule and the output disagree."""
    from shapely.geometry import Point, shape

    output_shape = shape(output)
    west, south, east, north = output_shape.bounds
    disagreements = 0
    for row in range(grid):
        for column in range(grid):
            point = (west + (column + 0.5) * (east - west) / grid, south + (row + 0.5) * (north - south) / grid)
            if legacy_inside(point, source) != output_shape.contains(Point(point)):
                disagreements += 1
    return {"samples": grid * grid, "disagreements": disagreements}


def containment_probes(geometry: dict[str, Any]) -> dict[str, list[float]]:
    """A point in a secondary region and a point in a hole, for app containment tests."""
    from shapely.geometry import Polygon

    probes: dict[str, list[float]] = {}
    polygons = polygons_of(geometry)
    if len(polygons) > 1:
        point = Polygon(polygons[1][0], polygons[1][1:]).representative_point()
        probes["secondaryRegion"] = [point.x, point.y]
    for polygon in polygons:
        if len(polygon) > 1:
            point = Polygon(polygon[1]).representative_point()
            if not legacy_inside((point.x, point.y), geometry):
                probes["hole"] = [point.x, point.y]
                break
    return probes


# Presentation for new parks. Per-park art and descriptions are retired, so
# every new park is plain: no scene, a circle badge and a factual line.

def short_name(name: str) -> str:
    return SHORT_NAME.sub("", name.strip()).strip() or name.strip()


def biome_for(name: str) -> tuple[str, str | None]:
    words = set(re.findall(r"[a-z]+", name.lower()))
    for biome, keywords in BIOME_RULES:
        for keyword in keywords:
            if keyword in words:
                return biome, keyword
    return "forest", None


def seed_for(park_id: str) -> int:
    return int.from_bytes(hashlib.sha256(park_id.encode("utf-8")).digest()[:8], "big") % 1_000_001


def blurb_for(place: dict[str, Any], properties: dict[str, Any]) -> str:
    kind = CATEGORY_WORDS[place["category"]]
    jurisdiction = properties.get("jurisdiction")
    where = f"the {jurisdiction}" if jurisdiction else place["region"]
    article = "An" if kind[0] in "aeiou" else "A"
    return f"{article} {kind} in {where}."


def new_park_review(place: dict[str, Any], properties: dict[str, Any], hub_count: int) -> dict[str, Any]:
    biome, _ = biome_for(place["name"])
    return {
        "presentation": {
            "short": short_name(place["name"]),
            "biome": biome,
            "shape": "circle",
            # Common is open from the first visit in every installed build, so
            # no new park is locked behind a collector rank.
            "rarity": "common",
            "seed": seed_for(place["id"]),
            "blurb": blurb_for(place, properties),
            "scene": None,
        },
        # No reviewed routes exist for these parks; the app sends visitors to
        # Google Maps for the explicit unknown-access sentinel.
        "accessUnknown": True,
        "walkM": 0,
        "drive": [None] * hub_count,
    }


def compact_size(value: Any) -> int:
    return len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


def projected_snapshot_bytes(snapshot: dict[str, Any], parks: list[dict[str, Any]], features: list[dict[str, Any]],
                             drive: dict[str, Any]) -> int:
    projected = {
        **snapshot,
        "parks": [*snapshot["parks"], *parks],
        "boundaries": {"type": "FeatureCollection", "features": [*snapshot["boundaries"]["features"], *features]},
        "drive": {"hubs": snapshot["drive"]["hubs"], "parks": {**snapshot["drive"]["parks"], **drive}},
    }
    return compact_size(projected)


def wire_records(changes: list[tuple[str, dict[str, Any], dict[str, Any]]], hub_count: int) -> tuple[list, list, dict]:
    parks: list[dict[str, Any]] = []
    features: list[dict[str, Any]] = []
    drive: dict[str, Any] = {}
    for park_id, park, feature in changes:
        parks.append(park)
        features.append(feature)
        drive[park_id] = {"drive": [None] * hub_count, "walkM": 0}
    return parks, features, drive


def island_projection(raw: dict[str, bytes], hub_count: int) -> tuple[list, list, dict]:
    """Records the island bundle adds to production when it is applied first."""
    review = importer.parse_review(importer.parse_json(raw["island/new-park-review.json"], "island review"))
    catalogue = importer.parse_catalogue(importer.parse_json(raw["island/catalogue.json"], "island catalogue"))
    boundaries = importer.parse_boundary_source(importer.parse_json(raw["island/boundaries.geojson"], "island boundaries"))
    hubs = [{"position": index} for index in range(hub_count)]
    parks, features, drive = [], [], {}
    for park_id in review:
        park, drive_record = importer.validate_new_park(park_id, park_id, catalogue[park_id], review[park_id], hubs)
        parks.append(park)
        features.append({"type": "Feature", "properties": {"id": park_id, "biome": park["biome"]},
                         "geometry": boundaries[park_id]["geometry"]})
        drive[park_id] = {"drive": drive_record["drive"], "walkM": drive_record["walkM"]}
    return parks, features, drive


def overlaps(new_features: dict[str, dict[str, Any]], existing: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    from shapely.geometry import shape
    from shapely.strtree import STRtree

    ids = sorted(existing)
    shapes = [shape(existing[park_id]["geometry"]) for park_id in ids]
    tree = STRtree(shapes)
    found: list[dict[str, Any]] = []
    for park_id in sorted(new_features):
        candidate = shape(new_features[park_id]["geometry"])
        for index in tree.query(candidate):
            other = shapes[index]
            shared = candidate.intersection(other).area
            if shared <= 0:
                continue
            new_share, existing_share = shared / candidate.area, shared / other.area
            if max(new_share, existing_share) >= OVERLAP_REPORT_FLOOR:
                found.append({
                    "newId": park_id,
                    "existingId": ids[int(index)],
                    "shareOfNewPark": round(new_share, 6),
                    "shareOfExistingPark": round(existing_share, 6),
                    "duplicate": min(new_share, existing_share) >= DUPLICATE_OVERLAP,
                })
    return found


def existing_comparison(legacy_geometry: dict[str, Any], target_feature: dict[str, Any] | None) -> dict[str, Any]:
    from shapely.geometry import shape

    if target_feature is None:
        return {"target": "missing"}
    target_geometry = target_feature["geometry"]
    legacy_counts, target_counts = counts(legacy_geometry), counts(target_geometry)
    legacy_shape, target_shape = shape(legacy_geometry), shape(target_geometry)
    difference = legacy_shape.symmetric_difference(target_shape).area / legacy_shape.area
    return {
        "targetCounts": target_counts,
        "polygonsMatch": legacy_counts["polygons"] == target_counts["polygons"],
        "holesMatch": legacy_counts["holes"] == target_counts["holes"],
        "symmetricDifferenceRatio": round(difference, 9),
    }


def build_bundle(bundle_dir: Path, include_phase_2_boundaries: bool = False) -> dict[str, Any]:
    raw = read_sources(bundle_dir)
    places_value = importer.parse_json(raw["legacy-places.json"], "legacy places")
    places_list = places_value["places"]
    places = importer.parse_catalogue(places_value)
    boundary_value = importer.parse_json(raw["legacy-boundaries.geojson.gz"], "legacy boundaries")
    legacy_features = {feature["properties"]["id"]: feature for feature in boundary_value["features"]}
    if len(places) != EXPECTED_LEGACY_PLACES or set(places) != set(legacy_features):
        raise importer.ParkImportError("Legacy places and displayed boundaries must cover the same 1,656 stable IDs")
    staging = importer.parse_json(raw["staging-rev158-snapshot.json.gz"], "staging snapshot")
    production = importer.parse_json(raw["production"], "production snapshot")
    removals = importer.parse_json(raw["staging-removals-20260930.json"], "staging removals")
    if staging["drive"]["hubs"] != production["drive"]["hubs"]:
        raise importer.ParkImportError("Staging and production drive hubs differ; new-park reviews need one hub list")
    hub_count = len(staging["drive"]["hubs"])
    staging_ids = {park["id"] for park in staging["parks"]}
    production_ids = {park["id"] for park in production["parks"]}
    removed_ids = {item["id"] for item in removals["removed"]}
    if removed_ids & staging_ids or not removed_ids <= production_ids:
        raise importer.ParkImportError("Operator removals must be absent from staging and present in production revision 26")

    existing_features = {
        feature["properties"]["id"]: feature
        for snapshot in (production, staging)
        for feature in snapshot["boundaries"]["features"]
    }
    normalized: dict[str, dict[str, Any]] = {}
    normalization_reports: list[dict[str, Any]] = []
    for park_id, feature in legacy_features.items():
        if feature["properties"]["category"] == EXCLUDED_CATEGORY:
            continue
        output, report = normalize_invalid(feature)
        normalized[park_id] = output
        if report:
            normalization_reports.append(report)

    candidates = [place["id"] for place in places_list if place["category"] != EXCLUDED_CATEGORY and place["id"] not in staging_ids | production_ids]
    overlap_report = overlaps({park_id: normalized[park_id] for park_id in candidates}, existing_features)
    duplicates = {item["newId"] for item in overlap_report if item["duplicate"]}
    selected = [park_id for park_id in candidates if park_id not in duplicates]
    phase_1 = [park_id for park_id in selected if places[park_id]["region"] in PHASE_1_REGIONS or park_id in PHASE_1_EXTRA_IDS]
    phase_1_set = set(phase_1)
    phase_2 = [park_id for park_id in selected if park_id not in phase_1_set]

    records = importer.parse_boundary_source({"type": "FeatureCollection", "features": [normalized[park_id] for park_id in selected]})
    reviews: dict[str, dict[str, Any]] = {}
    wire: dict[str, tuple[str, dict[str, Any], dict[str, Any]]] = {}
    hubs = [{"position": index} for index in range(hub_count)]
    for park_id in selected:
        review = new_park_review(places[park_id], legacy_features[park_id]["properties"], hub_count)
        park, _ = importer.validate_new_park(park_id, park_id, places[park_id], review, hubs)
        reviews[park_id] = review
        feature = {"type": "Feature", "properties": {"id": park_id, "biome": park["biome"]}, "geometry": records[park_id]["geometry"]}
        wire[park_id] = (park_id, park, feature)

    comparison = comparison_rows(places_list, legacy_features, normalized, records, selected, phase_1_set,
                                 staging_ids, production_ids, removed_ids, duplicates, existing_features)
    projections = size_projections(raw, staging, production, wire, phase_1, phase_2, hub_count)
    if projections["staging"]["phase1"]["headroomBytes"] < MIN_SNAPSHOT_HEADROOM_BYTES:
        raise importer.ParkImportError("Phase 1 leaves too little content sync headroom on staging")
    if projections["production"]["islandThenPhase1"]["headroomBytes"] < MIN_SNAPSHOT_HEADROOM_BYTES:
        raise importer.ParkImportError("Phase 1 leaves too little content sync headroom on production")

    selection = {
        "schema": "parkdex.legacy-bc-import-selection.v1",
        "legacyPlaceCount": len(places),
        "candidateCount": len(candidates),
        "selectedCount": len(selected),
        "phases": {
            "1": {"scope": "Vancouver Island and the Gulf Islands (legacy region Southern Vancouver Island, plus the Gulf Islands and Pacific Rim national park reserves)", "count": len(phase_1), "status": "ready"},
            "2": {"scope": "The rest of British Columbia", "count": len(phase_2), "status": "blocked-by-content-sync-size"},
        },
        "excluded": {
            "islands": {"reason": "Legacy island check-offs are not parks, and installed builds reject an island category.", "ids": sorted(park_id for park_id in places if places[park_id]["category"] == EXCLUDED_CATEGORY)},
            "operatorRemovals": {"reason": removals["note"], "ids": sorted(removed_ids)},
            "existingStaging": {"reason": "Already in the staging catalogue at revision 158.", "count": len(staging_ids & set(places))},
            "existingProductionOnly": {"reason": "Already in the production catalogue at revision 26.", "ids": sorted((production_ids - staging_ids) & set(places) - removed_ids)},
            "duplicates": {"reason": f"At least {DUPLICATE_OVERLAP:.0%} of both footprints overlap an existing park.", "ids": sorted(duplicates)},
        },
    }
    sources = {park_id: normalized[park_id] for park_id in selected}
    outputs = write_outputs(bundle_dir, places, selected, phase_1, phase_2, reviews, sources, selection, comparison,
                            normalization_reports, overlap_report, include_phase_2_boundaries)
    phase_2_boundaries = boundary_bytes(sources, phase_2)
    manifest = {
        "schema": SCHEMA,
        "sources": {name: {"sha256": sha256(data), "bytes": len(data)} for name, data in raw.items()},
        "outputs": {name: {"sha256": sha256(data), "bytes": len(data)} for name, data in outputs.items()},
        "phase2BoundariesNotCommitted": {"file": "phase-2/boundaries.geojson", "sha256": sha256(phase_2_boundaries), "bytes": len(phase_2_boundaries)},
        "counts": summary_counts(places, selected, phase_1, phase_2, reviews, records, normalization_reports, comparison, duplicates),
        "contentSyncProjection": projections,
        "presentationRules": {
            "short": "Legacy name without a trailing park-type phrase such as Park, Regional Park or National Park Reserve.",
            "biome": "First matching name keyword in BIOME_RULES of scripts/build_bc_import.py, otherwise forest.",
            "shape": "circle",
            "rarity": "common",
            "seed": "First 8 bytes of SHA-256 of the park ID, modulo 1,000,001.",
            "blurb": "A factual line: 'A <category> park in the <jurisdiction>', or in <region> when the source has no jurisdiction.",
            "scene": None,
            "access": "accessUnknown true, walkM 0 and null for every drive hub.",
        },
        "publication": {"providerActions": False, "databaseWrites": False, "badgeArtworkIncluded": False},
    }
    manifest_raw = json_bytes(manifest)
    (bundle_dir / "manifest.json").write_bytes(manifest_raw)
    return {
        "bundleDir": str(bundle_dir.resolve()),
        "selected": len(selected),
        "phase1": len(phase_1),
        "phase2": len(phase_2),
        "manifestSha256": sha256(manifest_raw),
        "outputs": {name: sha256(data) for name, data in outputs.items()},
        "contentSyncProjection": projections,
    }


def comparison_rows(places_list, legacy_features, normalized, records, selected, phase_1_set, staging_ids,
                    production_ids, removed_ids, duplicates, existing_features) -> list[dict[str, Any]]:
    selected_set = set(selected)
    rows: list[dict[str, Any]] = []
    for place in places_list:
        park_id = place["id"]
        if place["category"] == EXCLUDED_CATEGORY:
            continue
        source = legacy_features[park_id]
        properties = source["properties"]
        source_ids = properties.get("sourceObjectIds") or [properties.get("sourceId")]
        row: dict[str, Any] = {
            "id": park_id,
            "name": place["name"],
            "category": place["category"],
            "sourceName": properties.get("sourceName"),
            "sourceFeatureIds": [str(item) for item in source_ids],
            "sourceCounts": counts(source["geometry"]),
            "sourceValid": normalized[park_id]["geometry"] is source["geometry"],
        }
        if park_id in selected_set:
            output = records[park_id]["geometry"]
            output_counts = counts(output)
            row.update({
                "status": "new-phase-1" if park_id in phase_1_set else "new-phase-2",
                "outputSourceFeatureIds": [str(item) for item in records[park_id]["sourceFeatureIds"]],
                "outputCounts": output_counts,
                "polygonsMatch": output_counts["polygons"] == row["sourceCounts"]["polygons"],
                "holesMatch": output_counts["holes"] == row["sourceCounts"]["holes"],
                "coverage": coverage(source["geometry"], output),
                **({} if row["sourceValid"] else {"evenOddAgreement": even_odd_agreement(source["geometry"], output)}),
                "probes": containment_probes(output),
            })
        elif park_id in duplicates:
            row["status"] = "excluded-duplicate"
        elif park_id in removed_ids:
            row["status"] = "excluded-operator-removal"
        else:
            row["status"] = "existing-staging" if park_id in staging_ids else "existing-production"
            row["existing"] = existing_comparison(normalized[park_id]["geometry"], existing_features.get(park_id))
        rows.append(row)
    return rows


def size_projections(raw, staging, production, wire, phase_1, phase_2, hub_count) -> dict[str, Any]:
    def entry(snapshot, adds):
        parks = [record for group in adds for record in group[0]]
        features = [record for group in adds for record in group[1]]
        drive = {key: value for group in adds for key, value in group[2].items()}
        size = projected_snapshot_bytes(snapshot, parks, features, drive)
        # Production has no researched map links yet, so the staging figure is an upper bound.
        reader_2 = size + STAGING_READER_2_EXTRA_BYTES + READER_2_NULL_FIELDS_BYTES * (len(snapshot["parks"]) + len(parks) - len(staging["parks"]))
        return {
            "parks": len(snapshot["parks"]) + len(parks),
            "snapshotBytes": size,
            "reader2SnapshotBytesEstimate": reader_2,
            "headroomBytes": MAX_SYNC_RESPONSE_BYTES - max(size, reader_2),
        }

    first = wire_records([wire[park_id] for park_id in phase_1], hub_count)
    second = wire_records([wire[park_id] for park_id in phase_2], hub_count)
    island = island_projection(raw, hub_count)
    return {
        "limitBytes": MAX_SYNC_RESPONSE_BYTES,
        "staging": {
            "current": entry(staging, []),
            "phase1": entry(staging, [first]),
            "phase1And2": entry(staging, [first, second]),
        },
        "production": {
            "current": entry(production, []),
            "islandThenPhase1": entry(production, [island, first]),
            "islandThenPhase1And2": entry(production, [island, first, second]),
        },
        "phase1ChangeBatchBytes": compact_size([{"entity": kind, "op": "upsert", "id": park_id, "value": value}
                                                for park_id, park, feature in (wire[item] for item in phase_1)
                                                for kind, value in (("park", park), ("boundary", feature), ("drive", {"drive": [None] * hub_count, "walkM": 0}))]),
    }


def summary_counts(places, selected, phase_1, phase_2, reviews, records, normalization_reports, comparison, duplicates) -> dict[str, Any]:
    def by(field_values):
        result: dict[str, int] = {}
        for value in field_values:
            result[value] = result.get(value, 0) + 1
        return dict(sorted(result.items()))

    new_rows = [row for row in comparison if row["status"].startswith("new-")]
    existing_rows = [row for row in comparison if row["status"].startswith("existing-")]
    return {
        "selected": len(selected),
        "phase1": len(phase_1),
        "phase2": len(phase_2),
        "duplicatesExcluded": len(duplicates),
        "categories": {"phase1": by(places[i]["category"] for i in phase_1), "phase2": by(places[i]["category"] for i in phase_2)},
        "biomes": by(reviews[i]["presentation"]["biome"] for i in selected),
        "normalizedInvalidSources": len(normalization_reports),
        "normalizedSelected": sum(1 for report in normalization_reports if report["parkId"] in records),
        "newParkComparison": {
            "sourceFeatureIdsMatch": sum(row["sourceFeatureIds"] == row["outputSourceFeatureIds"] for row in new_rows),
            "polygonsMatch": sum(row["polygonsMatch"] for row in new_rows),
            "holesMatch": sum(row["holesMatch"] for row in new_rows),
            "fullCoverage": sum(row["coverage"]["sourceAreaKept"] >= 0.999999 for row in new_rows),
            "total": len(new_rows),
        },
        "existingParkComparison": {
            "total": len(existing_rows),
            "polygonsMatch": sum(row["existing"].get("polygonsMatch", False) for row in existing_rows),
            "holesMatch": sum(row["existing"].get("holesMatch", False) for row in existing_rows),
            "sameArea": sum(row["existing"].get("symmetricDifferenceRatio", 1) < 0.001 for row in existing_rows),
        },
        "geometryTotals": {
            "phase1": {key: sum(records[i]["summary"][key] for i in phase_1) for key in ("polygonCount", "holeCount", "positionCount")},
            "phase2": {key: sum(records[i]["summary"][key] for i in phase_2) for key in ("polygonCount", "holeCount", "positionCount")},
        },
    }


def boundary_bytes(sources: dict[str, dict[str, Any]], ids: list[str]) -> bytes:
    """Importer input: legacy features with their source properties, invalid rings normalized."""
    return json_bytes({"type": "FeatureCollection", "features": [sources[park_id] for park_id in ids]}, compact=True)


def write_outputs(bundle_dir, places, selected, phase_1, phase_2, reviews, sources, selection, comparison,
                  normalization_reports, overlap_report, include_phase_2_boundaries) -> dict[str, bytes]:
    files: dict[str, bytes] = {
        "selection.json": json_bytes(selection),
        "catalogue.json": json_bytes([places[park_id] for park_id in selected]),
        "comparison-report.json": json_bytes({"schema": "parkdex.legacy-bc-boundary-comparison.v1", "parks": comparison}),
        "normalization.json": json_bytes({"method": "planar-face-even-odd-ring-union", "parks": normalization_reports}),
        "overlaps.json": json_bytes({"duplicateThreshold": DUPLICATE_OVERLAP, "reportFloor": OVERLAP_REPORT_FLOOR, "overlaps": overlap_report}),
    }
    for phase, ids in (("phase-1", phase_1), ("phase-2", phase_2)):
        files[f"{phase}/park-ids.txt"] = ("\n".join(ids) + "\n").encode("utf-8")
        files[f"{phase}/new-park-review.json"] = json_bytes({"parks": {park_id: reviews[park_id] for park_id in ids}})
    files["phase-1/boundaries.geojson"] = boundary_bytes(sources, phase_1)
    for name, data in files.items():
        path = bundle_dir / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    if include_phase_2_boundaries:
        (bundle_dir / "phase-2" / "boundaries.geojson").write_bytes(boundary_bytes(sources, phase_2))
    return files


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle-dir", type=Path, default=DEFAULT_BUNDLE)
    parser.add_argument("--include-phase-2-boundaries", action="store_true",
                        help="also write phase-2/boundaries.geojson, which is not committed")
    args = parser.parse_args(argv)
    try:
        result = build_bundle(args.bundle_dir.resolve(), args.include_phase_2_boundaries)
    except importer.ParkImportError as exc:
        print(f"legacy BC import bundle: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

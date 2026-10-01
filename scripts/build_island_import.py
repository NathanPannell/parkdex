#!/usr/bin/env python3
"""Build the reproducible Vancouver Island provincial and regional park bundle."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import sys
from typing import Any

import import_legacy_parks as importer


EXCLUDED_ID = "provincial-allison-harbour-marine-park"
EXPECTED_CANDIDATES = 271
EXPECTED_SELECTED = 270
EXPECTED_EXISTING = 26
EXPECTED_NEW = 244
GEOMETRY_PRESERVATION_OVERRIDES = {
    "regional-east-sooke-regional-park": (
        "Preserve the more precise rev26 staging geometry. It has the same three polygons and no holes as the legacy boundary, while the legacy copy is rounded and has about 0.12% symmetric-difference area. This intentionally retains current coverage and does not claim exact legacy geometry."
    ),
}
REQUIRED_SOURCE_FILES = {
    "catalogue": "island-catalogue.json",
    "rawBoundary": "island-boundaries.raw.geojson",
    "auditedRawBoundary": "island-boundaries.audit-original.geojson",
    "normalizedBoundary": "island-boundaries.normalized.geojson",
    "normalizationReport": "island-boundaries.normalization.json",
    "normalizer": "normalize-island-boundaries.py",
    "rarityResearch": "rarity-review-271.json",
    "biomeReview": "biome-review.json",
    "routeReview": "reviewed-routes.json",
    "parkMetadata": "parks.json",
    "driveMetadata": "drive.json",
    "targetSnapshot": "baseline-snapshot.json",
    "identityAudit": "identity-dedup-audit.json",
}
EXPECTED_SOURCE_HASHES = {
    "island-catalogue.json": "419bdf709cfead9be0547f50b46198bf91bf0ccbdd0041643dcab701467b21ba",
    "island-boundaries.raw.geojson": "e17e5a62e3b31ec46bbf0a4f0603c13f6eaca12822ad00bf760a96f9f0f3574c",
    "island-boundaries.audit-original.geojson": "5f185fa46c85c5e87a84823afc6930d7151d7a9af45605d3cd8eeb2f47cbb1aa",
    "island-boundaries.normalized.geojson": "d17d3d2cf9a758552022d87deb8dc38b135c28ebf1b8e7920219b38355070725",
    "island-boundaries.normalization.json": "00e09b175ea60c868f0200281242f39cc4611dbddda6d77a948d814105926701",
    "normalize-island-boundaries.py": "c8801067943b128f1562c4d98e764cecbf6edd21bfa4cfad47dbc1eb88659a4d",
    "rarity-review-271.json": "3af88e9fd9186afc728267aaf8420750fae3e2bd16d396bbe618acb52e492bb6",
    "biome-review.json": "3dde027e0b1134b91404c6e65d58bc27fbc98deb13a797b5683aa7006c49fead",
    "reviewed-routes.json": "3b74d45de86c7e9542e8a0cf9687fa8fef8a1d8f6a4c7539f17195faf9cf18e3",
    "parks.json": "64575506a2f06e3fe77ffa390860ec5b81d9b9472880527bfe33ec0c2e42c196",
    "drive.json": "d21e40023efc848f460b44c9bad0bc2edd1a79e6646e841c1c7e1d26a2baf099",
    "baseline-snapshot.json": "6c181f43a031bd587f5c54a9c54f554c762a76ef8443466c90ce963bbbbcf4a1",
    "identity-dedup-audit.json": "7cfb143b56859bacede129dc6884441a2a4b18bb320c168346dec6a2b0d0c8ba",
}


def sha256(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def json_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode("utf-8")


def read_json(path: Path, label: str) -> Any:
    try:
        return importer.parse_json(path.read_bytes(), label)
    except OSError as exc:
        raise importer.ParkImportError(f"Could not read {label} ({type(exc).__name__})") from None


def write_json(path: Path, value: Any) -> bytes:
    raw = json_bytes(value)
    path.write_bytes(raw)
    return raw


def _source_inventory(source_dir: Path) -> dict[str, dict[str, Any]]:
    inventory: dict[str, dict[str, Any]] = {}
    for role, name in REQUIRED_SOURCE_FILES.items():
        path = source_dir / name
        try:
            raw = path.read_bytes()
        except OSError as exc:
            raise importer.ParkImportError(f"Missing bundle source {name} ({type(exc).__name__})") from None
        digest = sha256(raw)
        expected = EXPECTED_SOURCE_HASHES.get(name)
        if expected is not None and digest != expected:
            raise importer.ParkImportError(f"Pinned source {name} hash changed: expected {expected}, got {digest}")
        inventory[name] = {"role": role, "bytes": len(raw), "sha256": digest}
    return inventory


def _short_name(name: str) -> str:
    return re.sub(
        r"\s+(?:(?:regional|provincial|marine|nature|heritage|ecological|national)\s+)?park$",
        "",
        name.strip(),
        flags=re.IGNORECASE,
    ).strip() or name.strip()


def _new_presentation(
    place: dict[str, Any],
    rarity_item: dict[str, Any],
    metadata: dict[str, Any] | None,
    reviewed_biome: str | None = None,
) -> dict[str, Any]:
    if metadata is not None:
        presentation = {
            "short": metadata["short"],
            "biome": metadata["biome"],
            "shape": metadata["shape"],
            "rarity": rarity_item["rarity"],
            "seed": metadata["seed"],
            "blurb": metadata["blurb"],
            "scene": None,
        }
    else:
        park_id = place["id"]
        seed = int.from_bytes(hashlib.sha256(park_id.encode("utf-8")).digest()[:8], "big") % 1_000_001
        category_label = place["category"]
        category_label = category_label[0].upper() + category_label[1:]
        presentation = {
            "short": _short_name(place["name"]),
            "biome": reviewed_biome,
            "shape": "circle",
            "rarity": rarity_item["rarity"],
            "seed": seed,
            "blurb": f"A {category_label.lower()} park in {place['region']}. Parkdex badge and park story coming soon.",
            "scene": None,
        }
    return presentation


def _sum_geometry(records: dict[str, dict[str, Any]]) -> dict[str, int]:
    keys = ("polygonCount", "holeCount", "ringCount", "positionCount")
    return {key: sum(record["summary"][key] for record in records.values()) for key in keys}


def build_bundle(bundle_dir: Path) -> dict[str, Any]:
    source_dir = bundle_dir / "sources"
    source_inventory = _source_inventory(source_dir)
    source = {role: source_dir / name for role, name in REQUIRED_SOURCE_FILES.items()}

    catalogue_bytes = source["catalogue"].read_bytes()
    catalogue_value = read_json(source["catalogue"], "island catalogue")
    catalogue_list = importer.parse_catalogue(catalogue_value)
    catalogue_order = [item["id"] for item in catalogue_value]
    if len(catalogue_order) != EXPECTED_CANDIDATES or len(catalogue_list) != EXPECTED_CANDIDATES:
        raise importer.ParkImportError(f"Island catalogue must contain exactly {EXPECTED_CANDIDATES} unique candidates")

    audit = read_json(source["identityAudit"], "identity and geographic-scope audit")
    frozen_inputs = audit.get("frozenInputs", {})
    audited_catalogue_hash = frozen_inputs.get("sources\\island-catalogue.json", {}).get("sha256")
    audited_boundary_hash = frozen_inputs.get("sources\\island-boundaries.geojson", {}).get("sha256")
    if audited_catalogue_hash != source_inventory["island-catalogue.json"]["sha256"]:
        raise importer.ParkImportError("Candidate catalogue does not match the identity audit frozen input")
    if audited_boundary_hash != source_inventory["island-boundaries.audit-original.geojson"]["sha256"]:
        raise importer.ParkImportError("Audited raw boundary source does not match the identity audit frozen input")
    excluded = audit.get("geographicScopeDecision", {}).get("excludedMainland")
    if not isinstance(excluded, dict) or excluded.get("id") != EXCLUDED_ID or not isinstance(excluded.get("reason"), str):
        raise importer.ParkImportError("Identity audit must explicitly exclude Allison Harbour Marine Park with a reason")
    if EXCLUDED_ID not in catalogue_list:
        raise importer.ParkImportError("The explicit mainland exclusion is missing from the candidate catalogue")
    excluded_record = catalogue_list[EXCLUDED_ID]
    if excluded_record["name"] != excluded.get("name") or excluded_record["category"] != excluded.get("category"):
        raise importer.ParkImportError("The explicit exclusion identity does not match the catalogue")

    selected_ids = [park_id for park_id in catalogue_order if park_id != EXCLUDED_ID]
    if len(selected_ids) != EXPECTED_SELECTED:
        raise importer.ParkImportError("Final island scope must contain exactly 270 IDs after the explicit mainland exclusion")
    selected = set(selected_ids)
    category_counts = {category: sum(catalogue_list[park_id]["category"] == category for park_id in selected_ids)
                       for category in ("provincial", "regional")}
    if category_counts != {"provincial": 134, "regional": 136}:
        raise importer.ParkImportError(f"Unexpected selected category counts: {category_counts}")

    normalized_raw = source["normalizedBoundary"].read_bytes()
    audited_raw = source["auditedRawBoundary"].read_bytes()
    normalization = read_json(source["normalizationReport"], "boundary normalization report")
    if sha256(source["rawBoundary"].read_bytes()) != normalization.get("sourceFileSha256"):
        raise importer.ParkImportError("Raw boundary bytes do not match the normalization report source hash")
    if source["rawBoundary"].read_bytes() != audited_raw + b"\n":
        raise importer.ParkImportError("Normalized raw boundary input must match the audited source bytes plus its documented terminal LF")
    if sha256(normalized_raw) != normalization.get("outputFileSha256"):
        raise importer.ParkImportError("Normalized boundary bytes do not match the normalization report output hash")
    if normalization.get("parkCount") != EXPECTED_CANDIDATES:
        raise importer.ParkImportError("Boundary normalization report does not cover all 271 candidates")
    normalized_value = read_json(source["normalizedBoundary"], "normalized island boundaries")
    boundary_records = importer.parse_boundary_source(normalized_value)
    if set(boundary_records) != set(catalogue_list):
        raise importer.ParkImportError("Normalized boundaries and catalogue do not have exact 271-ID coverage")
    source_selected_features = [feature for feature in normalized_value["features"] if feature["properties"]["id"] in selected]
    if len(source_selected_features) != EXPECTED_SELECTED:
        raise importer.ParkImportError("Filtered island boundaries do not contain exactly 270 features")

    rarity_source = read_json(source["rarityResearch"], "271-park rarity research")
    rarity_all = rarity_source.get("parks")
    if not isinstance(rarity_all, dict) or set(rarity_all) != set(catalogue_list):
        raise importer.ParkImportError("Rarity research must provide exactly one reviewed entry for each of the 271 candidates")
    rarity_by_id = {park_id: rarity_all[park_id] for park_id in selected_ids}
    for park_id, item in rarity_by_id.items():
        if not isinstance(item, dict) or item.get("rarity") not in importer.RARITIES or not isinstance(item.get("rationale"), str) or not item["rationale"].strip():
            raise importer.ParkImportError(f"Rarity research for {park_id} must include a supported rarity and rationale")

    baseline = read_json(source["targetSnapshot"], "revision-26 target snapshot")
    if baseline.get("revision") != 26:
        raise importer.ParkImportError("Pinned target snapshot must be staging content revision 26")
    baseline_parks_list = baseline.get("parks")
    if not isinstance(baseline_parks_list, list):
        raise importer.ParkImportError("Target snapshot has no parks array")
    baseline_parks = importer.parse_catalogue(baseline_parks_list)
    existing_ids = selected & set(baseline_parks)
    new_ids = selected - existing_ids
    if len(existing_ids) != EXPECTED_EXISTING or len(new_ids) != EXPECTED_NEW:
        raise importer.ParkImportError(f"Pinned target overlap must be 26 existing and 244 new, got {len(existing_ids)} and {len(new_ids)}")
    existing_rarity_change_ids = [
        park_id for park_id in catalogue_order
        if park_id in existing_ids and baseline_parks[park_id].get("rarity") != rarity_by_id[park_id]["rarity"]
    ]
    existing_rarity_changed_scene_count = sum(
        baseline_parks[park_id].get("scene") is not None for park_id in existing_rarity_change_ids
    )
    if len(existing_rarity_change_ids) != 7 or existing_rarity_changed_scene_count != 4:
        raise importer.ParkImportError("Pinned rarity review and revision-26 snapshot must yield seven actual rarity changes, four with existing scenes")
    audited_overlaps = {item["id"] for item in audit.get("targetOverlap", {}).get("exactStableIdOverlaps", [])}
    if audited_overlaps != existing_ids:
        raise importer.ParkImportError("Target snapshot overlaps do not match the audited exact stable-ID overlap set")

    baseline_boundaries = baseline.get("boundaries", {}).get("features")
    if not isinstance(baseline_boundaries, list):
        raise importer.ParkImportError("Pinned target snapshot has no boundary feature list")
    baseline_boundary_by_id = {
        feature.get("properties", {}).get("id"): feature
        for feature in baseline_boundaries
        if isinstance(feature, dict) and isinstance(feature.get("properties"), dict)
    }
    selected_feature_by_id = {feature["properties"]["id"]: feature for feature in source_selected_features}
    preservation_records: list[dict[str, Any]] = []
    for park_id, rationale in GEOMETRY_PRESERVATION_OVERRIDES.items():
        if park_id not in existing_ids or park_id not in baseline_boundary_by_id or park_id not in selected_feature_by_id:
            raise importer.ParkImportError(f"Geometry preservation override {park_id} is missing from selected, source, or target features")
        source_feature = selected_feature_by_id[park_id]
        target_feature = baseline_boundary_by_id[park_id]
        source_geometry = source_feature["geometry"]
        target_geometry = target_feature.get("geometry")
        normalized_target, target_summary = importer.normalize_geometry(target_geometry, f"target override {park_id}")
        source_summary = boundary_records[park_id]["summary"]
        if source_summary["polygonCount"] != target_summary["polygonCount"] or source_summary["holeCount"] != target_summary["holeCount"]:
            raise importer.ParkImportError(f"Geometry preservation override {park_id} changes polygon or hole counts")
        from shapely.geometry import shape
        source_shape = shape(source_geometry)
        target_shape = shape(normalized_target)
        symmetric_difference_area = source_shape.symmetric_difference(target_shape).area
        relative_difference = symmetric_difference_area / source_shape.area if source_shape.area else 1.0
        replacement = {"type": "Feature", "properties": source_feature["properties"], "geometry": target_geometry}
        selected_feature_by_id[park_id] = replacement
        preservation_records.append({
            "parkId": park_id,
            "baselineRevision": baseline["revision"],
            "sourceLegacyGeometrySha256": sha256(importer.canonical_bytes(source_geometry)),
            "preservedTargetGeometrySha256": sha256(importer.canonical_bytes(target_geometry)),
            "sourceLegacyGeometrySummary": source_summary,
            "preservedTargetGeometrySummary": target_summary,
            "symmetricDifferenceAreaDegreesSquared": symmetric_difference_area,
            "relativeSymmetricDifference": relative_difference,
            "rationale": rationale,
        })
    selected_features = [selected_feature_by_id[feature["properties"]["id"]] for feature in source_selected_features]
    output_boundary_records = importer.parse_boundary_source({"type": "FeatureCollection", "features": selected_features})
    if set(output_boundary_records) != selected:
        raise importer.ParkImportError("Final boundary output no longer covers the complete selected ID set")
    selected_boundary_records = {park_id: output_boundary_records[park_id] for park_id in selected_ids}

    parks_metadata_value = read_json(source["parkMetadata"], "bundled park metadata")
    if not isinstance(parks_metadata_value, list):
        raise importer.ParkImportError("Bundled park metadata must be an array")
    park_metadata = importer.parse_catalogue(parks_metadata_value)
    metadata_new_ids = new_ids & set(park_metadata)
    biome_reviews = read_json(source["biomeReview"], "explicit new-park biome review")
    if not isinstance(biome_reviews, dict):
        raise importer.ParkImportError("Biome review must be an object keyed by selected new park ID")
    unbundled_metadata_new_ids = new_ids - metadata_new_ids
    if set(biome_reviews) != unbundled_metadata_new_ids:
        missing = sorted(unbundled_metadata_new_ids - set(biome_reviews))
        extra = sorted(set(biome_reviews) - unbundled_metadata_new_ids)
        raise importer.ParkImportError(f"Biome review must exactly cover {len(unbundled_metadata_new_ids)} new parks without bundled metadata; missing={missing[:5]}, extra={extra[:5]}")
    for park_id, item in biome_reviews.items():
        if not isinstance(item, dict) or set(item) not in ({"biome", "rationale", "sources"}, {"biome", "rationale", "sources", "uncertain"}):
            raise importer.ParkImportError(f"Biome review for {park_id} must contain biome, rationale, sources, and optional uncertain")
        if item["biome"] not in importer.BIOMES:
            raise importer.ParkImportError(f"Biome review for {park_id} must use a supported biome")
        importer.account_text(item["rationale"], f"Biome review for {park_id} rationale", 1000)
        if "uncertain" in item and not isinstance(item["uncertain"], bool):
            raise importer.ParkImportError(f"Biome review for {park_id} uncertain must be boolean")
        sources_value = item["sources"]
        source_records = [sources_value] if isinstance(sources_value, (str, dict)) else sources_value
        if not isinstance(source_records, list) or not source_records:
            raise importer.ParkImportError(f"Biome review for {park_id} sources must contain one or more HTTPS sources")
        for source_record in source_records:
            if isinstance(source_record, str):
                url = source_record
            elif isinstance(source_record, dict) and set(source_record) == {"url", "title"}:
                url = source_record["url"]
                importer.account_text(source_record["title"], f"Biome review for {park_id} source title", 300)
            else:
                raise importer.ParkImportError(f"Biome review for {park_id} source must be an HTTPS URL or a url/title record")
            if not isinstance(url, str) or not url.strip().startswith("https://"):
                raise importer.ParkImportError(f"Biome review for {park_id} source URL must use HTTPS")
    drive_metadata = read_json(source["driveMetadata"], "bundled drive metadata")
    drive_rows = drive_metadata.get("parks") if isinstance(drive_metadata, dict) else None
    hubs = drive_metadata.get("hubs") if isinstance(drive_metadata, dict) else None
    baseline_hubs = baseline.get("drive", {}).get("hubs")
    if not isinstance(drive_rows, dict) or not isinstance(hubs, list) or hubs != baseline_hubs:
        raise importer.ParkImportError("Bundled drive metadata hubs must exactly match the revision-26 target hubs")
    route_review = read_json(source["routeReview"], "reviewed route import data")
    route_rows = route_review.get("parks") if isinstance(route_review, dict) else None
    if not isinstance(route_rows, list):
        raise importer.ParkImportError("Route review must contain a parks array")
    route_by_id = {item.get("id"): item for item in route_rows if isinstance(item, dict)}
    if len(route_by_id) != len(route_rows):
        raise importer.ParkImportError("Route review contains missing or duplicate park IDs")
    metadata_candidate_ids = new_ids & set(park_metadata) & set(drive_rows)
    local_route_ids = {
        park_id for park_id in metadata_candidate_ids
        if isinstance(drive_rows[park_id].get("drive"), list)
        and any(route is not None for route in drive_rows[park_id]["drive"])
    }
    reviewed_route_ids = new_ids & set(route_by_id)
    if local_route_ids & reviewed_route_ids:
        raise importer.ParkImportError("A new park has competing bundled and route-review access sources")
    unknown_route_ids = new_ids - local_route_ids - reviewed_route_ids
    if metadata_candidate_ids - local_route_ids - unknown_route_ids:
        raise importer.ParkImportError("A park metadata row lacks its paired drive metadata")
    reviewed_unknown_count = sum(
        isinstance(item.get("importProposal"), dict) and item["importProposal"].get("accessUnknown") is True
        for item in route_by_id.values() if item.get("id") in new_ids
    )
    if len(local_route_ids) != 94 or len(reviewed_route_ids) != 51 or len(unknown_route_ids) != 99 or reviewed_unknown_count != 18:
        raise importer.ParkImportError("Access-source split changed from 94 routed metadata, 51 reviewed routes, and 99 explicitly unknown new parks")
    target_hubs = [{"position": i, **hub} for i, hub in enumerate(hubs)]

    new_review: dict[str, Any] = {}
    selected_catalogue = [catalogue_list[park_id] for park_id in catalogue_order if park_id in selected]
    access_counts = {
        "bundledDrive": 0,
        "reviewedRoute": 0,
        "reviewedAccessUnknown": 0,
        "unreviewedAccessUnknown": 0,
    }
    for park_id in catalogue_order:
        if park_id not in new_ids:
            continue
        place = catalogue_list[park_id]
        rarity_item = rarity_by_id[park_id]
        metadata = park_metadata.get(park_id)
        if park_id in local_route_ids:
            drive = drive_rows[park_id]
            review = {
                "presentation": _new_presentation(place, rarity_item, metadata),
                "walkM": drive.get("walkM"),
                "drive": drive.get("drive"),
            }
            access_counts["bundledDrive"] += 1
        elif park_id in route_by_id:
            proposal = route_by_id[park_id].get("importProposal")
            if not isinstance(proposal, dict):
                raise importer.ParkImportError(f"Reviewed route for {park_id} has no importProposal")
            review = {
                "presentation": _new_presentation(place, rarity_item, metadata, biome_reviews.get(park_id, {}).get("biome")),
                "walkM": proposal.get("walkM"),
                "drive": proposal.get("drive"),
            }
            if proposal.get("accessUnknown") is True:
                review["accessUnknown"] = True
                access_counts["reviewedAccessUnknown"] += 1
            else:
                access_counts["reviewedRoute"] += 1
        else:
            review = {
                "presentation": _new_presentation(place, rarity_item, metadata, biome_reviews.get(park_id, {}).get("biome")),
                "walkM": 0,
                "drive": [None] * len(hubs),
                "accessUnknown": True,
            }
            access_counts["unreviewedAccessUnknown"] += 1
        importer.validate_new_park(park_id, park_id, place, review, target_hubs)
        if review["presentation"].get("scene") is not None:
            raise importer.ParkImportError(f"New park {park_id} unexpectedly has a scene")
        new_review[park_id] = review

    rarity_review = {
        "parks": {
            park_id: {"rarity": rarity_by_id[park_id]["rarity"], "rationale": rarity_by_id[park_id]["rationale"].strip()}
            for park_id in catalogue_order if park_id in existing_ids
        }
    }
    new_review_file = {"parks": new_review}
    if set(rarity_review["parks"]) != existing_ids or set(new_review) != new_ids:
        raise importer.ParkImportError("Existing rarity review and new-park review must exactly partition the selected IDs")

    selection = {
        "schema": "parkdex.island-import-selection.v1",
        "scope": "Vancouver Island and surrounding islands",
        "catalogueSha256": sha256(catalogue_bytes),
        "candidateCount": len(catalogue_order),
        "selectedCount": len(selected_ids),
        "selectedIds": selected_ids,
        "categoryCounts": category_counts,
        "excluded": {
            "id": EXCLUDED_ID,
            "name": excluded["name"],
            "category": excluded["category"],
            "reason": excluded["reason"],
            "sourceId": excluded.get("sourceId"),
            "region": excluded.get("region"),
            "latitude": excluded_record.get("latitude"),
            "longitude": excluded_record.get("longitude"),
        },
    }
    output_files: dict[str, bytes] = {}
    output_files["selection.json"] = write_json(bundle_dir / "selection.json", selection)
    output_files["boundaries.geojson"] = write_json(bundle_dir / "boundaries.geojson", {
        "type": "FeatureCollection",
        "features": selected_features,
    })
    output_files["catalogue.json"] = write_json(bundle_dir / "catalogue.json", selected_catalogue)
    output_files["rarity-review.json"] = write_json(bundle_dir / "rarity-review.json", rarity_review)
    output_files["new-park-review.json"] = write_json(bundle_dir / "new-park-review.json", new_review_file)

    parsed_review = importer.parse_review(read_json(bundle_dir / "new-park-review.json", "built new-park review"))
    parsed_rarity = importer.parse_rarity_review(read_json(bundle_dir / "rarity-review.json", "built rarity review"))
    parsed_catalogue = importer.parse_catalogue(read_json(bundle_dir / "catalogue.json", "built new catalogue"))
    if set(parsed_review) != new_ids or set(parsed_catalogue) != selected or set(parsed_rarity) != existing_ids:
        raise importer.ParkImportError("Built review files fail strict importer ID coverage checks")

    geometry_totals = _sum_geometry(selected_boundary_records)
    category_rarity_counts: dict[str, dict[str, int]] = {}
    for category in ("provincial", "regional"):
        category_rarity_counts[category] = {
            rarity: sum(catalogue_list[park_id]["category"] == category and rarity_by_id[park_id]["rarity"] == rarity for park_id in selected_ids)
            for rarity in sorted(importer.RARITIES)
        }
    manifest = {
        "schema": "parkdex.island-park-import-bundle.v1",
        "scope": "Vancouver Island and surrounding islands",
        "sourceInventory": source_inventory,
        "rawSourceInventory": audit.get("frozenInputs", {}),
        "selection": {
            "file": "selection.json",
            "sha256": sha256(output_files["selection.json"]),
            "candidateCount": EXPECTED_CANDIDATES,
            "selectedCount": EXPECTED_SELECTED,
            "categoryCounts": category_counts,
            "excluded": selection["excluded"],
        },
        "target": {
            "environment": "staging",
            "contentRevision": baseline["revision"],
            "parkCountBefore": len(baseline_parks),
            "exactSelectedIdOverlap": len(existing_ids),
            "existingIds": [park_id for park_id in catalogue_order if park_id in existing_ids],
            "newIds": [park_id for park_id in catalogue_order if park_id in new_ids],
            "existingRarityReviews": len(existing_ids),
            "existingRarityChanges": len(existing_rarity_change_ids),
            "existingRarityChangedIds": existing_rarity_change_ids,
            "existingRarityChangedSceneCount": existing_rarity_changed_scene_count,
            "expectedParkCountAfterImport": len(baseline_parks) + len(new_ids),
        },
        "outputs": {
            name: {"bytes": len(raw), "sha256": sha256(raw)}
            for name, raw in output_files.items()
        },
        "counts": {
            "features": len(selected_features),
            "catalogueEntries": len(selected_catalogue),
            "newParks": len(new_ids),
            "existingRarityReviews": len(rarity_review["parks"]),
            "existingRarityChanges": len(existing_rarity_change_ids),
            "existingRarityChangedSceneCount": existing_rarity_changed_scene_count,
            "newScenesNull": sum(item["presentation"]["scene"] is None for item in new_review.values()),
            "newParksWithoutArtwork": len(new_ids),
            "biomeSources": {
                "bundledMetadata": len(metadata_new_ids),
                "explicitReview": len(biome_reviews),
                "explicitReviewUncertain": sum(item.get("uncertain") is True for item in biome_reviews.values()),
                "explicitReviewCounts": {biome: sum(item["biome"] == biome for item in biome_reviews.values()) for biome in sorted(importer.BIOMES)},
            },
            "accessSources": access_counts,
            "newUnknownAccessTotal": access_counts["reviewedAccessUnknown"] + access_counts["unreviewedAccessUnknown"],
            "rarities": {rarity: sum(item["rarity"] == rarity for item in rarity_by_id.values()) for rarity in sorted(importer.RARITIES)},
            "rarityByCategory": category_rarity_counts,
        },
        "geometry": {
            "normalizationMethod": normalization["method"],
            "normalizerSha256": source_inventory["normalize-island-boundaries.py"]["sha256"],
            "rawInputSha256": normalization["sourceFileSha256"],
            "auditedRawSourceSha256": source_inventory["island-boundaries.audit-original.geojson"]["sha256"],
            "normalizationInputHasOneTerminalLfBeyondAuditedBytes": True,
            "normalizationReportSha256": source_inventory["island-boundaries.normalization.json"]["sha256"],
            "normalizedSourceSha256": source_inventory["island-boundaries.normalized.geojson"]["sha256"],
            "selectedGeometryTotals": geometry_totals,
            "legacySourceGeometryCount": EXPECTED_SELECTED - len(preservation_records),
            "explicitTargetPreservationOverrides": preservation_records,
            "sourceFeatureIdsPreserved": True,
            "sourcePropertiesPreserved": True,
            "sourceFeatureOrderPreserved": True,
        },
        "publication": {"providerActions": False, "productionChanges": False, "badgeArtworkIncluded": False},
    }
    manifest_raw = write_json(bundle_dir / "manifest.json", manifest)
    return {
        "bundleDir": str(bundle_dir.resolve()),
        "selected": len(selected_ids),
        "existing": len(existing_ids),
        "new": len(new_ids),
        "unknownAccess": access_counts["reviewedAccessUnknown"] + access_counts["unreviewedAccessUnknown"],
        "manifestSha256": sha256(manifest_raw),
        "outputs": {name: sha256(raw) for name, raw in output_files.items()},
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--bundle-dir",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "database" / "imports" / "provincial-regional-20260929",
        help="Bundle directory containing sources/ and receiving deterministic outputs",
    )
    args = parser.parse_args(argv)
    try:
        result = build_bundle(args.bundle_dir.resolve())
    except importer.ParkImportError as exc:
        print(f"island import bundle: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

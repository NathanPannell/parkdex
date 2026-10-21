"""Rebuild only invalid island-scope display boundaries from legacy ring semantics.

Usage: python normalize-island-boundaries.py

The legacy input is never modified. Each polygonized planar face is included
iff the Parkdex even-odd ring test includes its interior, with multipolygon
parts combined as a union. This preserves area even when source rings cross or
source polygon parts overlap. Zero-area linework has no interior and is omitted.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import shapely
from shapely.geometry import LineString, MultiPolygon, mapping, shape
from shapely.ops import polygonize, unary_union
from shapely.validation import make_valid


HERE = Path(__file__).resolve().parent
SOURCE = HERE / "island-boundaries.geojson"
OUTPUT = HERE / "island-boundaries.normalized.geojson"
REPORT = HERE / "island-boundaries.normalization.json"


def digest(value: object) -> str:
    raw = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    return hashlib.sha256(raw).hexdigest()


def in_ring(point: tuple[float, float], ring: list[list[float]]) -> bool:
    """Interior portion of src/lib/geo.ts inRing, for off-edge face probes."""
    x, y = point
    inside = False
    for a, b in zip(ring, ring[1:]):
        if (a[1] > y) != (b[1] > y) and x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]:
            inside = not inside
    return inside


def legacy_inside(point: tuple[float, float], geometry: dict) -> bool:
    polygons = [geometry["coordinates"]] if geometry["type"] == "Polygon" else geometry["coordinates"]
    return any(in_ring(point, polygon[0]) and not any(in_ring(point, hole) for hole in polygon[1:]) for polygon in polygons)


def polygon_parts(geometry):
    if geometry.geom_type == "Polygon":
        return [geometry]
    if geometry.geom_type == "MultiPolygon":
        return list(geometry.geoms)
    raise ValueError(f"unexpected polygon output: {geometry.geom_type}")


def counts(geometry: dict) -> dict:
    polygons = [geometry["coordinates"]] if geometry["type"] == "Polygon" else geometry["coordinates"]
    return {
        "polygons": len(polygons),
        "holes": sum(len(polygon) - 1 for polygon in polygons),
        "rings": sum(len(polygon) for polygon in polygons),
        "positions": sum(len(ring) for polygon in polygons for ring in polygon),
    }


def normalize(feature: dict) -> tuple[dict, dict]:
    source = feature["geometry"]
    original = shape(source)
    if original.is_valid:
        return feature, {}

    polygons = [source["coordinates"]] if source["type"] == "Polygon" else source["coordinates"]
    lines = [LineString(ring) for polygon in polygons for ring in polygon]
    faces = list(polygonize(unary_union(lines)))
    if not faces:
        raise ValueError(f"{feature['properties']['id']}: no planar faces")
    decisions = []
    included = []
    for face in faces:
        probe = face.representative_point()
        point = (probe.x, probe.y)
        if not face.contains(probe):
            raise ValueError("face probe is on boundary")
        selected = legacy_inside(point, source)
        if selected:
            included.append(face)
        decisions.append(
            {
                "probe": list(point),
                "included": selected,
                "area": face.area,
                "faceSha256": digest(mapping(face)),
            }
        )
    rebuilt = unary_union(included)
    if rebuilt.is_empty or not rebuilt.is_valid or rebuilt.geom_type not in ("Polygon", "MultiPolygon"):
        raise ValueError(f"{feature['properties']['id']}: invalid rebuilt geometry")
    if not all(rebuilt.covers(face.representative_point()) == decision["included"] for face, decision in zip(faces, decisions)):
        raise ValueError(f"{feature['properties']['id']}: face membership changed")
    result_geometry = mapping(MultiPolygon(polygon_parts(rebuilt)))
    result_geometry = json.loads(json.dumps(result_geometry))
    if not shape(result_geometry).is_valid:
        raise ValueError(f"{feature['properties']['id']}: serialized geometry invalid")
    normalized_feature = {**feature, "geometry": result_geometry}

    # Valid individual polygon components have an unambiguous geometric union.
    # Their symmetric difference with the rebuilt interior must have zero area.
    source_parts = [shape({"type": "Polygon", "coordinates": p}) for p in polygons]
    valid_parts = all(part.is_valid for part in source_parts)
    union_difference_area = None
    if valid_parts:
        union_difference_area = unary_union(source_parts).symmetric_difference(rebuilt).area
        if union_difference_area > 1e-18:
            raise ValueError(f"{feature['properties']['id']}: source-part union changed")

    # For self-crossing rings, make_valid is an independent polygonal comparison.
    independent_difference_area = None
    if not valid_parts:
        repaired = make_valid(original)
        repair_polygons = []

        def collect(value):
            if value.geom_type == "Polygon":
                repair_polygons.append(value)
            elif hasattr(value, "geoms"):
                for child in value.geoms:
                    collect(child)

        collect(repaired)
        independent_difference_area = unary_union(repair_polygons).symmetric_difference(rebuilt).area
        if independent_difference_area > 1e-18:
            raise ValueError(f"{feature['properties']['id']}: independent make_valid differs")

    report = {
        "parkId": feature["properties"]["id"],
        "sourceName": feature["properties"].get("sourceName"),
        "sourceUrl": feature["properties"].get("sourceUrl"),
        "sourceObjectIds": feature["properties"].get("sourceObjectIds") or [feature["properties"]["sourceId"]],
        "sourceGeometrySha256": digest(source),
        "normalizedGeometrySha256": digest(result_geometry),
        "sourceCounts": counts(source),
        "normalizedCounts": counts(result_geometry),
        "sourceAreaAsParsed": original.area,
        "normalizedArea": rebuilt.area,
        "normalization": "planar-face-even-odd-ring-union",
        "allSourceComponentsValid": valid_parts,
        "sourceComponentUnionSymmetricDifferenceArea": union_difference_area,
        "independentMakeValidSymmetricDifferenceArea": independent_difference_area,
        "planarFaces": decisions,
        "zeroAreaLineworkNote": "Source line segments with no interior are not represented in the valid polygon output.",
    }
    return normalized_feature, report


def main() -> None:
    source_bytes = SOURCE.read_bytes()
    document = json.loads(source_bytes)
    if document["type"] != "FeatureCollection" or len(document["features"]) != 271:
        raise ValueError("unexpected frozen island scope")
    ids = [feature["properties"]["id"] for feature in document["features"]]
    if len(ids) != len(set(ids)):
        raise ValueError("duplicate park ID")
    changes = []
    output_features = []
    for feature in document["features"]:
        normalized_feature, report = normalize(feature)
        output_features.append(normalized_feature)
        if report:
            changes.append(report)
    if len(changes) != 7:
        raise ValueError(f"expected seven invalid features; found {len(changes)}")
    if not all(shape(feature["geometry"]).is_valid for feature in output_features):
        raise ValueError("normalized catalogue still contains invalid geometry")
    result = {**document, "features": output_features}
    output_bytes = (json.dumps(result, separators=(",", ":"), ensure_ascii=False) + "\n").encode()
    report = {
        "method": "planar-face-even-odd-ring-union",
        "sourcePath": SOURCE.name,
        "sourceFileSha256": hashlib.sha256(source_bytes).hexdigest(),
        "outputPath": OUTPUT.name,
        "outputFileSha256": hashlib.sha256(output_bytes).hexdigest(),
        "outputGeometrySha256": digest({f["properties"]["id"]: f["geometry"] for f in output_features}),
        "shapelyVersion": shapely.__version__,
        "parkCount": len(output_features),
        "changedParkCount": len(changes),
        "changes": changes,
    }
    OUTPUT.write_bytes(output_bytes)
    REPORT.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"{len(output_features)} parks; {len(changes)} normalized; source sha256 {report['sourceFileSha256']}")
    for item in changes:
        print(item["parkId"], item["sourceCounts"], "->", item["normalizedCounts"])


if __name__ == "__main__":
    main()

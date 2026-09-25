from datetime import datetime, timedelta, timezone
import json

import pytest

from backend.app.claims import (
    BoundaryRegistry,
    ClaimInputError,
    LocationSample,
    get_boundary_registry,
    validate_location_sample,
)
from backend.app.offline_claims import validate_offline_location_sample
from shapely.geometry import Point, box, shape


def feature(place_id, category, coordinates):
    return {
        "type": "Feature",
        "properties": {"id": place_id, "category": category},
        "geometry": {"type": "Polygon", "coordinates": coordinates},
    }


def registry_for(tmp_path, features):
    path = tmp_path / "boundaries.geojson"
    path.write_text(
        json.dumps({"type": "FeatureCollection", "features": features}),
        encoding="utf-8",
    )
    return BoundaryRegistry(path)


def sample(latitude, longitude, accuracy=20):
    return LocationSample(
        latitude, longitude, accuracy, datetime.now(timezone.utc)
    )


def test_viewport_boundary_query_uses_polygon_intersection_not_anchor(tmp_path):
    edge_park = feature(
        "edge-park",
        "provincial",
        [[
            [-123.2, 48.8],
            [-122.8, 48.8],
            [-122.8, 49.2],
            [-123.2, 49.2],
            [-123.2, 48.8],
        ]],
    )
    registry = registry_for(tmp_path, [edge_park])
    viewport = box(-123.19, 48.95, -123.15, 49.05)
    geometry = shape(registry.feature("edge-park")["geometry"])

    assert not viewport.covers(geometry.representative_point())
    assert registry.features_intersecting_bounds(
        -123.19, 48.95, -123.15, 49.05
    ) == ("edge-park",)


def test_viewport_boundary_query_supports_world_and_antimeridian_bounds(tmp_path):
    west_edge = feature(
        "west-edge",
        "island",
        [[[-179.8, 0], [-179.2, 0], [-179.2, 1], [-179.8, 1], [-179.8, 0]]],
    )
    east_edge = feature(
        "east-edge",
        "island",
        [[[179.2, 0], [179.8, 0], [179.8, 1], [179.2, 1], [179.2, 0]]],
    )
    center = feature(
        "center",
        "regional",
        [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
    )
    registry = registry_for(tmp_path, [west_edge, east_edge, center])

    assert registry.features_intersecting_bounds(
        179.5, -1, -179.5, 2
    ) == ("west-edge", "east-edge")
    assert registry.features_intersecting_bounds(
        -180, -90, 180, 90
    ) == ("west-edge", "east-edge", "center")


def test_exact_containment_precedes_buffer_and_park_precedes_island(tmp_path):
    island = feature(
        "island",
        "island",
        [[[-124.1, 48.9], [-123.9, 48.9], [-123.9, 49.1], [-124.1, 49.1], [-124.1, 48.9]]],
    )
    park = feature(
        "park",
        "regional",
        [[[-124.01, 48.99], [-123.99, 48.99], [-123.99, 49.01], [-124.01, 49.01], [-124.01, 48.99]]],
    )
    registry = registry_for(tmp_path, [island, park])
    assert registry.recommend(sample(49, -124)).place_id == "park"
    # An exact island beats a park that is merely within the accuracy buffer.
    assert registry.recommend(sample(49, -124.0102, 50)).place_id == "island"


def test_holes_multipolygons_exclusions_and_stable_ties(tmp_path):
    holed = feature(
        "holed",
        "regional",
        [
            [[-124.1, 48.9], [-123.9, 48.9], [-123.9, 49.1], [-124.1, 49.1], [-124.1, 48.9]],
            [[-124.01, 48.99], [-124.01, 49.01], [-123.99, 49.01], [-123.99, 48.99], [-124.01, 48.99]],
        ],
    )
    small = feature(
        "small",
        "regional",
        [[[-124.005, 48.995], [-123.995, 48.995], [-123.995, 49.005], [-124.005, 49.005], [-124.005, 48.995]]],
    )
    registry = registry_for(tmp_path, [holed, small])
    assert registry.recommend(sample(49, -124)).place_id == "small"
    assert registry.recommend(sample(49, -124), {"small"}) is None

    ring = [[-124.01, 48.99], [-123.99, 48.99], [-123.99, 49.01], [-124.01, 49.01], [-124.01, 48.99]]
    tie = registry_for(
        tmp_path,
        [feature("z-park", "regional", [ring]), feature("a-park", "regional", [ring])],
    )
    chosen = tie.recommend(sample(48.99, -124.01, 10))
    assert chosen.match_kind == "exact"
    assert chosen.place_id == "a-park"


def test_exact_offline_containment_honors_holes_multipolygons_and_no_buffer(tmp_path):
    holed = feature(
        "holed",
        "regional",
        [
            [[-124.1, 48.9], [-123.9, 48.9], [-123.9, 49.1], [-124.1, 49.1], [-124.1, 48.9]],
            [[-124.01, 48.99], [-124.01, 49.01], [-123.99, 49.01], [-123.99, 48.99], [-124.01, 48.99]],
        ],
    )
    multi = {
        "type": "Feature",
        "properties": {"id": "multi", "category": "national"},
        "geometry": {
            "type": "MultiPolygon",
            "coordinates": [
                [[[-123.8, 48.9], [-123.7, 48.9], [-123.7, 49.0], [-123.8, 49.0], [-123.8, 48.9]]],
                [[[-123.6, 49.0], [-123.5, 49.0], [-123.5, 49.1], [-123.6, 49.1], [-123.6, 49.0]]],
            ],
        },
    }
    registry = registry_for(tmp_path, [holed, multi])
    assert registry.contains_exact("holed", 49.05, -124.05)
    assert not registry.contains_exact("holed", 49, -124)
    assert registry.contains_exact("holed", 49, -124.1)
    assert not registry.contains_exact("holed", 49, -124.01)
    assert registry.contains_exact("multi", 48.95, -123.75)
    assert registry.contains_exact("multi", 49.05, -123.55)
    assert not registry.contains_exact("multi", 49, -123.65)
    # The online recommender accepts this point within its 10 m floor, while
    # the offline authoritative predicate correctly requires polygon coverage.
    projected = registry._exact_geometries["holed"]
    projected_boundary = registry.boundaries[0].geometry
    point = projected_boundary.buffer(5).exterior.representative_point()
    longitude, latitude = registry._project.transform(
        point.x, point.y, direction="INVERSE"
    )
    assert registry.recommend(sample(latitude, longitude, 20)).place_id == "holed"
    assert not registry.contains_exact("holed", latitude, longitude)
    assert projected.is_valid


def test_multipolygon_parts_and_real_canonical_asset_are_loaded(tmp_path):
    registry = registry_for(
        tmp_path,
        [
            {
                "type": "Feature",
                "properties": {"id": "multi", "category": "national"},
                "geometry": {
                    "type": "MultiPolygon",
                    "coordinates": [
                        [[[-124.1, 48.9], [-124.0, 48.9], [-124.0, 49.0], [-124.1, 49.0], [-124.1, 48.9]]],
                        [[[-123.9, 49.0], [-123.8, 49.0], [-123.8, 49.1], [-123.9, 49.1], [-123.9, 49.0]]],
                    ],
                },
            }
        ],
    )
    assert registry.recommend(sample(49.05, -123.85)).place_id == "multi"
    canonical = get_boundary_registry(False)
    assert len(canonical.place_ids) > 0
    assert len(canonical.version) == 64
    assert len(canonical.offline_version) == 64
    assert all(boundary.area_meters_2 > 0 for boundary in canonical.boundaries)
    for place_id, offline_feature in canonical.features.items():
        offline_geometry = shape(offline_feature["geometry"])
        assert offline_geometry.is_valid
        interior = offline_geometry.representative_point()
        assert canonical.contains_exact(place_id, interior.y, interior.x)


def test_invalid_source_geometry_emits_and_checks_the_same_repaired_feature(tmp_path):
    bowtie = feature(
        "invalid-source",
        "regional",
        [[
            [-124.1, 48.9],
            [-123.9, 49.1],
            [-123.9, 48.9],
            [-124.1, 49.1],
            [-124.1, 48.9],
        ]],
    )
    registry = registry_for(tmp_path, [bowtie])
    repaired_feature = registry.feature("invalid-source")
    repaired_geometry = shape(repaired_feature["geometry"])
    assert repaired_feature["geometry"]["type"] in {"Polygon", "MultiPolygon"}
    assert repaired_geometry.is_valid
    for latitude, longitude in ((48.95, -123.95), (49.05, -124.05)):
        assert registry.contains_exact("invalid-source", latitude, longitude)
        assert repaired_geometry.covers(Point(longitude, latitude))
    assert not registry.contains_exact("invalid-source", 49.08, -124.02)


def test_location_freshness_accuracy_and_future_skew_are_enforced():
    now = datetime.now(timezone.utc)
    valid = validate_location_sample(49, -124, 50, int(now.timestamp() * 1000), now)
    assert valid.accuracy_meters == 50
    for offset_ms, code in ((-60_001, "location_stale"), (10_001, "location_time_in_future")):
        with pytest.raises(ClaimInputError) as raised:
            validate_location_sample(
                49,
                -124,
                5,
                int(now.timestamp() * 1000) + offset_ms,
                now,
            )
        assert raised.value.code == code
    with pytest.raises(ClaimInputError) as raised:
        validate_location_sample(49, -124, 50.1, int(now.timestamp() * 1000), now)
    assert raised.value.code == "location_accuracy_too_low"
    with pytest.raises(ClaimInputError) as raised:
        validate_location_sample(float("nan"), -124, 5, int(now.timestamp() * 1000), now)
    assert raised.value.code == "invalid_location"


def test_offline_location_accepts_historical_fix_only_inside_grant_window():
    now = datetime.now(timezone.utc)
    issued_at = now - timedelta(days=8)
    expires_at = issued_at + timedelta(days=30)
    historical_ms = int((now - timedelta(days=7)).timestamp() * 1000)
    sample = validate_offline_location_sample(
        49,
        -124,
        50,
        historical_ms,
        grant_issued_at=issued_at,
        grant_expires_at=expires_at,
        now=now,
    )
    assert sample.captured_at == datetime.fromtimestamp(
        historical_ms / 1000, tz=timezone.utc
    )

    invalid_cases = (
        (int((issued_at - timedelta(milliseconds=1)).timestamp() * 1000), 5, "offline_location_before_grant"),
        (int((expires_at + timedelta(milliseconds=1)).timestamp() * 1000), 5, "offline_location_after_grant"),
        (int((now + timedelta(seconds=11)).timestamp() * 1000), 5, "location_time_in_future"),
        (historical_ms, 50.1, "location_accuracy_too_low"),
    )
    for captured_at, accuracy, code in invalid_cases:
        with pytest.raises(ClaimInputError) as raised:
            validate_offline_location_sample(
                49,
                -124,
                accuracy,
                captured_at,
                grant_issued_at=issued_at,
                grant_expires_at=expires_at,
                now=now,
            )
        assert raised.value.code == code

    with pytest.raises(ClaimInputError) as raised:
        validate_offline_location_sample(
            49,
            -124,
            5,
            10**100,
            grant_issued_at=issued_at,
            grant_expires_at=expires_at,
            now=now,
        )
    assert raised.value.code == "invalid_location_time"


def test_boundary_tolerance_is_reported_accuracy_clamped_to_ten_and_fifty_metres(
    tmp_path,
):
    park = feature(
        "park",
        "regional",
        [[[-124.01, 48.99], [-123.99, 48.99], [-123.99, 49.01], [-124.01, 49.01], [-124.01, 48.99]]],
    )
    registry = registry_for(tmp_path, [park])
    boundary = registry.boundaries[0].geometry

    def sample_at_buffer_distance(distance_meters: float, accuracy: float):
        projected = boundary.buffer(distance_meters).exterior.representative_point()
        longitude, latitude = registry._project.transform(
            projected.x, projected.y, direction="INVERSE"
        )
        return sample(latitude, longitude, accuracy)

    # Issue #84 deliberately gives even a very accurate fix a 10 m tolerance.
    assert registry.recommend(sample_at_buffer_distance(9.9, 1)).place_id == "park"
    assert registry.recommend(sample_at_buffer_distance(10.1, 1)) is None
    # Above the floor, reported accuracy is the cutoff (and input validation
    # separately rejects samples worse than the 50 m ceiling).
    assert registry.recommend(sample_at_buffer_distance(24.9, 25)).place_id == "park"
    assert registry.recommend(sample_at_buffer_distance(25.1, 25)) is None

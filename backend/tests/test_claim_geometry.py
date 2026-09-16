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
    assert all(boundary.area_meters_2 > 0 for boundary in canonical.boundaries)


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

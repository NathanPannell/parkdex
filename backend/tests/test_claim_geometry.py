from datetime import datetime, timezone
import json

from backend.app.claims import BoundaryRegistry, LocationSample, get_boundary_registry, validate_location_sample, ClaimInputError


def feature(place_id, category, coordinates):
    return {
        "type": "Feature",
        "properties": {"id": place_id, "category": category},
        "geometry": {"type": "Polygon", "coordinates": coordinates},
    }


def registry_for(tmp_path, features):
    path = tmp_path / "boundaries.geojson"
    path.write_text(json.dumps({"type": "FeatureCollection", "features": features}), encoding="utf-8")
    return BoundaryRegistry(path)


def sample(latitude, longitude, accuracy=20):
    return LocationSample(latitude, longitude, accuracy, datetime.now(timezone.utc))


def test_exact_containment_globally_precedes_buffer_then_park_precedes_island(tmp_path):
    island = feature("island", "island", [[[-124.1, 48.9], [-123.9, 48.9], [-123.9, 49.1], [-124.1, 49.1], [-124.1, 48.9]]])
    park = feature("park", "regional", [[[-124.01, 48.99], [-123.99, 48.99], [-123.99, 49.01], [-124.01, 49.01], [-124.01, 48.99]]])
    registry = registry_for(tmp_path, [island, park])
    assert registry.recommend(sample(49, -124)).place_id == "park"
    # An exact island beats a park that is merely within the accuracy buffer.
    near_park = sample(49, -124.0102, 50)
    assert registry.recommend(near_park).place_id == "island"


def test_holes_are_not_containment_and_exclusions_are_respected(tmp_path):
    holed = feature("holed", "regional", [
        [[-124.1, 48.9], [-123.9, 48.9], [-123.9, 49.1], [-124.1, 49.1], [-124.1, 48.9]],
        [[-124.01, 48.99], [-124.01, 49.01], [-123.99, 49.01], [-123.99, 48.99], [-124.01, 48.99]],
    ])
    small = feature("small", "regional", [[[-124.005, 48.995], [-123.995, 48.995], [-123.995, 49.005], [-124.005, 49.005], [-124.005, 48.995]]])
    registry = registry_for(tmp_path, [holed, small])
    assert registry.recommend(sample(49, -124)).place_id == "small"
    assert registry.recommend(sample(49, -124), {"small"}) is None


def test_boundary_points_are_exact_and_stable_id_breaks_full_ties(tmp_path):
    ring = [[-124.01, 48.99], [-123.99, 48.99], [-123.99, 49.01], [-124.01, 49.01], [-124.01, 48.99]]
    registry = registry_for(tmp_path, [
        feature("z-park", "regional", [ring]),
        feature("a-park", "regional", [ring]),
    ])
    chosen = registry.recommend(sample(48.99, -124.01, 10))
    assert chosen.match_kind == "exact"
    assert chosen.place_id == "a-park"


def test_multipolygon_parts_are_claimable(tmp_path):
    path = tmp_path / "boundaries.geojson"
    path.write_text(json.dumps({
        "type": "FeatureCollection",
        "features": [{
            "type": "Feature",
            "properties": {"id": "multi", "category": "national"},
            "geometry": {"type": "MultiPolygon", "coordinates": [
                [[[-124.1, 48.9], [-124.0, 48.9], [-124.0, 49.0], [-124.1, 49.0], [-124.1, 48.9]]],
                [[[-123.9, 49.0], [-123.8, 49.0], [-123.8, 49.1], [-123.9, 49.1], [-123.9, 49.0]]],
            ]},
        }],
    }), encoding="utf-8")
    registry = BoundaryRegistry(path)
    assert registry.recommend(sample(49.05, -123.85)).place_id == "multi"


def test_real_canonical_asset_has_complete_reviewed_geometry():
    registry = get_boundary_registry()
    assert len(registry.place_ids) == 195
    assert len(registry.version) == 64
    assert all(boundary.area_meters_2 > 0 for boundary in registry.boundaries)


def test_location_freshness_accuracy_and_future_skew_are_enforced():
    now = datetime.now(timezone.utc)
    valid = validate_location_sample(49, -124, 50, int(now.timestamp() * 1000), now)
    assert valid.accuracy_meters == 50
    for offset_ms, code in ((-60_001, "location_stale"), (10_001, "location_time_in_future")):
        try:
            validate_location_sample(49, -124, 5, int(now.timestamp() * 1000) + offset_ms, now)
        except ClaimInputError as exc:
            assert exc.code == code
        else:
            raise AssertionError("invalid sample was accepted")
    try:
        validate_location_sample(49, -124, 50.1, int(now.timestamp() * 1000), now)
    except ClaimInputError as exc:
        assert exc.code == "location_accuracy_too_low"
    else:
        raise AssertionError("inaccurate sample was accepted")

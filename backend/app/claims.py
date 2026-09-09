from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import secrets
from typing import Iterable

from pyproj import Transformer
from shapely.geometry import GeometryCollection, MultiPolygon, Point, Polygon, shape
from shapely.ops import transform, unary_union
from shapely.validation import make_valid


PROJECT_ROOT = Path(__file__).resolve().parents[2]
BOUNDARY_PATH = PROJECT_ROOT / "data" / "boundaries.geojson"
MAX_ACCURACY_METERS = 50.0
MAX_SAMPLE_AGE_SECONDS = 60.0
MAX_FUTURE_SKEW_SECONDS = 10.0
RECOMMENDATION_TOKEN_LENGTH = 43


class ClaimInputError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class LocationSample:
    latitude: float
    longitude: float
    accuracy_meters: float
    captured_at: datetime


@dataclass(frozen=True)
class Candidate:
    place_id: str
    match_kind: str
    distance_meters: float
    area_meters_2: float
    is_island: bool


@dataclass(frozen=True)
class _Boundary:
    place_id: str
    is_island: bool
    geometry: object
    area_meters_2: float


class BoundaryRegistry:
    def __init__(self, path: Path = BOUNDARY_PATH):
        payload = path.read_bytes()
        document = json.loads(payload)
        if document.get("type") != "FeatureCollection":
            raise RuntimeError("Canonical boundary data is not a FeatureCollection")
        project = Transformer.from_crs("EPSG:4326", "EPSG:3005", always_xy=True).transform
        boundaries: list[_Boundary] = []
        seen: set[str] = set()
        for feature in document.get("features", []):
            properties = feature.get("properties") or {}
            place_id = properties.get("id")
            category = properties.get("category")
            if not isinstance(place_id, str) or not place_id or place_id in seen:
                raise RuntimeError("Canonical boundary data has a missing or duplicate place id")
            if category not in {"national", "provincial", "regional", "island"}:
                raise RuntimeError(f"Canonical boundary {place_id} has an invalid category")
            projected = transform(project, shape(feature.get("geometry")))
            if not projected.is_valid:
                repaired = make_valid(projected)
                polygonal = [item for item in getattr(repaired, "geoms", [repaired]) if isinstance(item, (Polygon, MultiPolygon))]
                projected = unary_union(polygonal) if polygonal else GeometryCollection()
            if projected.is_empty or not projected.is_valid or projected.area <= 0:
                raise RuntimeError(f"Canonical boundary {place_id} is invalid")
            seen.add(place_id)
            boundaries.append(_Boundary(place_id, category == "island", projected, projected.area))
        if not boundaries:
            raise RuntimeError("Canonical boundary data is empty")
        self.boundaries = tuple(boundaries)
        self.place_ids = frozenset(seen)
        self.version = hashlib.sha256(payload).hexdigest()
        self._project = Transformer.from_crs("EPSG:4326", "EPSG:3005", always_xy=True)

    def recommend(self, sample: LocationSample, excluded_place_ids: Iterable[str] = ()) -> Candidate | None:
        excluded = frozenset(excluded_place_ids)
        x, y = self._project.transform(sample.longitude, sample.latitude)
        point = Point(x, y)
        buffer_meters = min(MAX_ACCURACY_METERS, max(10.0, sample.accuracy_meters))
        candidates: list[Candidate] = []
        for boundary in self.boundaries:
            if boundary.place_id in excluded:
                continue
            exact = boundary.geometry.covers(point)
            distance = 0.0 if exact else float(boundary.geometry.distance(point))
            if not exact and distance > buffer_meters:
                continue
            candidates.append(Candidate(
                place_id=boundary.place_id,
                match_kind="exact" if exact else "buffer",
                distance_meters=distance,
                area_meters_2=boundary.area_meters_2,
                is_island=boundary.is_island,
            ))
        if not candidates:
            return None
        return min(candidates, key=lambda candidate: (
            0 if candidate.match_kind == "exact" else 1,
            1 if candidate.is_island else 0,
            candidate.distance_meters,
            candidate.area_meters_2,
            candidate.place_id,
        ))

    def representative_sample(self, place_id: str, now: datetime) -> LocationSample:
        boundary = next((item for item in self.boundaries if item.place_id == place_id), None)
        if boundary is None:
            raise KeyError(place_id)
        projected = boundary.geometry.representative_point()
        longitude, latitude = self._project.transform(projected.x, projected.y, direction="INVERSE")
        return LocationSample(latitude, longitude, 5.0, now)


def validate_location_sample(
    latitude: float,
    longitude: float,
    accuracy_meters: float,
    captured_at_epoch_ms: int,
    now: datetime | None = None,
) -> LocationSample:
    if not all(math.isfinite(value) for value in (latitude, longitude, accuracy_meters)):
        raise ClaimInputError("invalid_location", "Location values must be finite")
    if not -90 <= latitude <= 90 or not -180 <= longitude <= 180:
        raise ClaimInputError("invalid_location", "Location coordinates are out of range")
    if accuracy_meters <= 0 or accuracy_meters > MAX_ACCURACY_METERS:
        raise ClaimInputError("location_accuracy_too_low", "Location accuracy must be 50 metres or better")
    try:
        captured_at = datetime.fromtimestamp(captured_at_epoch_ms / 1000, tz=timezone.utc)
    except (OverflowError, OSError, ValueError):
        raise ClaimInputError("invalid_location_time", "Location timestamp is invalid") from None
    received_at = now or datetime.now(timezone.utc)
    age = (received_at - captured_at).total_seconds()
    if age > MAX_SAMPLE_AGE_SECONDS:
        raise ClaimInputError("location_stale", "Location must be captured within the last 60 seconds")
    if age < -MAX_FUTURE_SKEW_SECONDS:
        raise ClaimInputError("location_time_in_future", "Location timestamp is too far in the future")
    return LocationSample(latitude, longitude, accuracy_meters, captured_at)


def create_recommendation_token() -> tuple[str, str]:
    token = secrets.token_urlsafe(32)
    return token, hashlib.sha256(token.encode("ascii")).hexdigest()


def recommendation_token_hash(token: str) -> str | None:
    if len(token) != RECOMMENDATION_TOKEN_LENGTH:
        return None
    try:
        token.encode("ascii")
    except UnicodeEncodeError:
        return None
    return hashlib.sha256(token.encode("ascii")).hexdigest()


_registry: BoundaryRegistry | None = None


def get_boundary_registry() -> BoundaryRegistry:
    global _registry
    if _registry is None:
        _registry = BoundaryRegistry()
    return _registry

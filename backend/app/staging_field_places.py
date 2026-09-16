from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

from psycopg import Connection


PROJECT_ROOT = Path(__file__).resolve().parents[2]
STAGING_FIELD_PLACES_PATH = PROJECT_ROOT / "data" / "staging-field-places.json"
ALLOWED_CATEGORIES = frozenset({"national", "provincial", "regional", "island"})
PLACE_ALIASES = frozenset({"places", "p"})


def place_visibility_clause(alias: str = "places") -> str:
    """Return the new-API visibility predicate for a fixed SQL table alias."""

    if alias not in PLACE_ALIASES:
        raise ValueError("Unsupported places table alias")
    return (
        f"({alias}.active OR "
        f"(%s::boolean AND {alias}.field_test_scope = 'staging' "
        f"AND {alias}.id = ANY(%s)))"
    )


def place_visibility_params(
    include_staging_field_places: bool,
) -> tuple[bool, list[str]]:
    return (
        include_staging_field_places,
        list(current_staging_field_place_ids()),
    )


def load_staging_field_places(
    source_path: Path = STAGING_FIELD_PLACES_PATH,
) -> tuple[dict, ...]:
    document = json.loads(source_path.read_bytes())
    if not isinstance(document, list) or not document:
        raise RuntimeError("Staging field-place data must be a non-empty array")

    required = {
        "id",
        "name",
        "category",
        "latitude",
        "longitude",
        "region",
        "description",
        "sourceUrl",
        "sourceName",
    }
    seen: set[str] = set()
    places: list[dict] = []
    for item in document:
        if not isinstance(item, dict) or not required.issubset(item):
            raise RuntimeError("Staging field-place data has an invalid record")
        place_id = item["id"]
        if not isinstance(place_id, str) or not place_id or place_id in seen:
            raise RuntimeError("Staging field-place data has a missing or duplicate id")
        if item["category"] not in ALLOWED_CATEGORIES:
            raise RuntimeError(f"Staging field place {place_id} has an invalid category")
        latitude = item["latitude"]
        longitude = item["longitude"]
        if not isinstance(latitude, (int, float)) or not 47 <= latitude <= 52:
            raise RuntimeError(f"Staging field place {place_id} has an invalid latitude")
        if not isinstance(longitude, (int, float)) or not -130 <= longitude <= -122:
            raise RuntimeError(f"Staging field place {place_id} has an invalid longitude")
        for key in required - {"latitude", "longitude"}:
            if not isinstance(item[key], str) or not item[key].strip():
                raise RuntimeError(
                    f"Staging field place {place_id} has an invalid {key}"
                )
        source_id = item.get("sourceId")
        if source_id is not None and (
            not isinstance(source_id, str) or not source_id.strip()
        ):
            raise RuntimeError(f"Staging field place {place_id} has an invalid sourceId")
        seen.add(place_id)
        places.append(item)
    return tuple(places)


@lru_cache(maxsize=1)
def current_staging_field_place_ids() -> tuple[str, ...]:
    return tuple(place["id"] for place in load_staging_field_places())


def sync_staging_field_places(
    conn: Connection,
    *,
    enabled: bool,
    source_path: Path = STAGING_FIELD_PLACES_PATH,
) -> None:
    """Reconcile staging-only rows inside the caller-owned transaction."""

    conn.execute(
        "UPDATE places SET active = FALSE WHERE field_test_scope IS NOT NULL"
    )
    if not enabled:
        return

    for place in load_staging_field_places(source_path):
        row = conn.execute(
            """
            INSERT INTO places (
                id, name, category, latitude, longitude, region, description,
                source_url, source_name, source_id, active, field_test_scope
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, FALSE, 'staging')
            ON CONFLICT (id) DO UPDATE SET
                name = EXCLUDED.name,
                category = EXCLUDED.category,
                latitude = EXCLUDED.latitude,
                longitude = EXCLUDED.longitude,
                region = EXCLUDED.region,
                description = EXCLUDED.description,
                source_url = EXCLUDED.source_url,
                source_name = EXCLUDED.source_name,
                source_id = EXCLUDED.source_id,
                active = FALSE,
                field_test_scope = EXCLUDED.field_test_scope
            WHERE places.field_test_scope = 'staging'
            RETURNING id
            """,
            (
                place["id"],
                place["name"],
                place["category"],
                place["latitude"],
                place["longitude"],
                place["region"],
                place["description"],
                place["sourceUrl"],
                place["sourceName"],
                place.get("sourceId"),
            ),
        ).fetchone()
        if row is None:
            raise RuntimeError(
                f"Staging field place id collides with canonical place: {place['id']}"
            )

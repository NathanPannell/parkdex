import asyncio
from contextlib import asynccontextmanager
from datetime import datetime, timezone
import hashlib
import importlib.util
import inspect
import json
import os
from pathlib import Path
from types import SimpleNamespace
import uuid

import psycopg
import pytest
from fastapi.testclient import TestClient

import backend.app.claims as claims
import backend.app.main as api
from backend.app.claims import LocationSample
from backend.app.staging_field_places import (
    current_staging_field_place_ids,
    load_staging_field_places,
    place_visibility_clause,
    place_visibility_params,
    sync_staging_field_places,
)


ROOT = Path(__file__).resolve().parents[2]
PLACE_ID = "provincial-goldstream-park"
CANONICAL_BELLHOUSE_ID = "provincial-bellhouse-park"
RETIRED_PLACE_ID = "regional-bell-park"
PIN_LATITUDE = 48.475557
PIN_LONGITUDE = -123.542431


def staging_fixture_place(
    place_id: str = "regional-staging-fixture",
    name: str = "Staging Fixture Park",
) -> dict[str, object]:
    return {
        "id": place_id,
        "name": name,
        "category": "regional",
        "latitude": 48.475557,
        "longitude": -123.542431,
        "region": "South Island",
        "description": "A synthetic staging fixture for backend behavior tests.",
        "sourceUrl": "https://example.test/parks/fixture",
        "sourceName": "Test fixture",
        "sourceId": "fixture-1",
    }


def test_staging_field_overlay_is_empty_and_canonical_bellhouse_remains() -> None:
    places = json.loads(
        (ROOT / "data/staging-field-places.json").read_text(encoding="utf-8")
    )
    boundaries = json.loads(
        (ROOT / "data/staging-field-boundaries.geojson").read_text(
            encoding="utf-8"
        )
    )
    assert places == []
    assert load_staging_field_places() == ()
    assert current_staging_field_place_ids() == ()
    assert boundaries["type"] == "FeatureCollection"
    assert boundaries["features"] == []

    canonical_places = json.loads(
        (ROOT / "data/places.json").read_text(encoding="utf-8")
    )
    bellhouse = next(
        place for place in canonical_places if place["id"] == "provincial-bellhouse-park"
    )
    assert bellhouse["name"] == "Bellhouse Park"
    canonical_boundaries = json.loads(
        (ROOT / "data/boundaries.geojson").read_text(encoding="utf-8")
    )
    assert any(
        feature["properties"]["id"] == "provincial-bellhouse-park"
        for feature in canonical_boundaries["features"]
    )


def test_boundary_registry_cache_is_keyed_by_staging_overlay_inclusion() -> None:
    claims.get_boundary_registry.cache_clear()
    try:
        canonical = claims.get_boundary_registry(False)
        staging = claims.get_boundary_registry(True)
        assert claims.get_boundary_registry(False) is canonical
        assert claims.get_boundary_registry(True) is staging
        assert RETIRED_PLACE_ID not in canonical.place_ids
        assert RETIRED_PLACE_ID not in staging.place_ids
        assert "provincial-bellhouse-park" in canonical.place_ids
        assert "provincial-bellhouse-park" in staging.place_ids
        assert staging.version != canonical.version
        assert canonical.version == hashlib.sha256(
            (ROOT / "data/boundaries.geojson").read_bytes()
        ).hexdigest()
        recommendation = staging.recommend(
            LocationSample(
                PIN_LATITUDE,
                PIN_LONGITUDE,
                5,
                datetime.now(timezone.utc),
            )
        )
        assert recommendation is not None
        assert recommendation.place_id == PLACE_ID
        assert recommendation.match_kind == "exact"

        # Reversing initialization order must not poison the other cache key.
        claims.get_boundary_registry.cache_clear()
        staging_first = claims.get_boundary_registry(True)
        canonical_second = claims.get_boundary_registry(False)
        assert RETIRED_PLACE_ID not in staging_first.place_ids
        assert RETIRED_PLACE_ID not in canonical_second.place_ids
        assert PLACE_ID in staging_first.place_ids
        assert PLACE_ID in canonical_second.place_ids
    finally:
        claims.get_boundary_registry.cache_clear()


def test_staging_overlay_rejects_a_duplicate_canonical_id(tmp_path: Path) -> None:
    feature = {
        "type": "Feature",
        "properties": {"id": "duplicate", "category": "regional"},
        "geometry": {
            "type": "Polygon",
            "coordinates": [
                [
                    [-123.1, 49.0],
                    [-123.0, 49.0],
                    [-123.0, 49.1],
                    [-123.1, 49.1],
                    [-123.1, 49.0],
                ]
            ],
        },
    }
    canonical = tmp_path / "canonical.geojson"
    overlay = tmp_path / "overlay.geojson"
    payload = {"type": "FeatureCollection", "features": [feature]}
    canonical.write_text(json.dumps(payload), encoding="utf-8")
    overlay.write_text(json.dumps(payload), encoding="utf-8")
    with pytest.raises(RuntimeError, match="duplicate place id"):
        claims.BoundaryRegistry(canonical, overlay_path=overlay)


def test_staging_field_place_sync_is_idempotent_and_retires_scoped_rows() -> None:
    if not os.environ.get("DATABASE_URL"):
        return
    stale_id = "regional-stale-staging-field-place"
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        try:
            conn.execute(
                "DELETE FROM places WHERE field_test_scope IS NOT NULL"
            )
            conn.execute(
                """
                INSERT INTO places (
                    id, name, category, latitude, longitude, region,
                    description, source_url, source_name, active, field_test_scope
                ) VALUES (%s, 'Bell Park', 'regional', 49, -123,
                          'Test', '', 'https://example.test', 'Test', FALSE, 'staging')
                """,
                (RETIRED_PLACE_ID,),
            )
            conn.execute(
                """
                INSERT INTO places (
                    id, name, category, latitude, longitude, region,
                    description, source_url, source_name, active, field_test_scope
                ) VALUES (%s, 'Stale field place', 'regional', 49, -123,
                          'Test', '', 'https://example.test', 'Test', FALSE, 'staging')
                """,
                (stale_id,),
            )
            sync_staging_field_places(conn, enabled=True)
            sync_staging_field_places(conn, enabled=True)
            conn.commit()

            retired = conn.execute(
                "SELECT name, source_url, source_name, source_id, active, "
                "field_test_scope FROM places WHERE id = %s",
                (RETIRED_PLACE_ID,),
            ).fetchone()
            assert retired == (
                "Bell Park",
                "https://example.test",
                "Test",
                None,
                False,
                "staging",
            )
            assert conn.execute(
                "SELECT COUNT(*) FROM places WHERE id = %s", (RETIRED_PLACE_ID,)
            ).fetchone()[0] == 1
            assert conn.execute(
                "SELECT active FROM places WHERE id = %s", (stale_id,)
            ).fetchone()[0] is False
            # Literal N-1 APIs remain active-only, while new staging code sees
            # only ids in the current overlay. A retired fixture is not
            # resurrected just because its scoped history remains in Postgres.
            assert conn.execute(
                "SELECT id FROM places WHERE active AND id = %s",
                (RETIRED_PLACE_ID,),
            ).fetchone() is None
            assert conn.execute(
                f"SELECT id FROM places WHERE {place_visibility_clause()} "
                "AND id = %s",
                (*place_visibility_params(False), RETIRED_PLACE_ID),
            ).fetchone() is None
            assert conn.execute(
                f"SELECT id FROM places WHERE {place_visibility_clause()} "
                "AND id = %s",
                (*place_visibility_params(True), RETIRED_PLACE_ID),
            ).fetchone() is None
            assert place_visibility_params(True) == (True, [])
            assert conn.execute(
                f"SELECT id FROM places WHERE {place_visibility_clause()} "
                "AND id = %s",
                (*place_visibility_params(True), stale_id),
            ).fetchone() is None
            with pytest.raises(psycopg.errors.CheckViolation):
                with conn.transaction():
                    conn.execute(
                        "UPDATE places SET active = TRUE WHERE id = %s",
                        (RETIRED_PLACE_ID,),
                    )
            assert conn.execute(
                "SELECT active FROM places WHERE id = %s",
                (PLACE_ID,),
            ).fetchone()[0] is True
            sync_staging_field_places(conn, enabled=False)
            assert conn.execute(
                "SELECT active FROM places WHERE id = %s",
                (RETIRED_PLACE_ID,),
            ).fetchone()[0] is False
            conn.commit()
        finally:
            conn.execute("DELETE FROM places WHERE field_test_scope IS NOT NULL")
            conn.commit()


def test_retirement_migration_hides_old_row_from_n_minus_one_visibility() -> None:
    if not os.environ.get("DATABASE_URL"):
        return
    migration = (
        ROOT / "database/migrations/0021_retire_bell_park_staging_overlay.sql"
    ).read_text(encoding="utf-8")
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        try:
            conn.execute(
                """
                INSERT INTO places (
                    id, name, category, latitude, longitude, region,
                    description, source_url, source_name, source_id, active,
                    field_test_scope
                ) VALUES (
                    %s, 'Bell Park', 'regional', 49.0918726, -123.0600868,
                    'Lower Mainland', 'Retired staging fixture',
                    'https://example.test/bell-park', 'Test fixture', 'legacy',
                    FALSE, 'staging'
                )
                ON CONFLICT (id) DO UPDATE SET
                    active = FALSE,
                    field_test_scope = 'staging'
                """,
                (RETIRED_PLACE_ID,),
            )
            conn.execute(migration)

            assert conn.execute(
                "SELECT active, field_test_scope FROM places WHERE id = %s",
                (RETIRED_PLACE_ID,),
            ).fetchone() == (False, None)
            assert conn.execute(
                f"SELECT id FROM places WHERE {place_visibility_clause()} "
                "AND id = %s",
                (True, [RETIRED_PLACE_ID], RETIRED_PLACE_ID),
            ).fetchone() is None
        finally:
            conn.rollback()


def test_staging_field_place_sync_rejects_canonical_id_collision(
    tmp_path: Path,
) -> None:
    if not os.environ.get("DATABASE_URL"):
        return
    collision_path = tmp_path / "collision.json"
    place = staging_fixture_place(
        place_id="provincial-goldstream-park",
        name="Goldstream Park staged collision",
    )
    collision_path.write_text(json.dumps([place]), encoding="utf-8")

    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        original = conn.execute(
            "SELECT name, field_test_scope FROM places WHERE id = %s",
            (place["id"],),
        ).fetchone()
        with pytest.raises(RuntimeError, match="collides with canonical"):
            sync_staging_field_places(
                conn,
                enabled=True,
                source_path=collision_path,
            )
        conn.rollback()
        assert conn.execute(
            "SELECT name, field_test_scope FROM places WHERE id = %s",
            (place["id"],),
        ).fetchone() == original


def test_future_canonical_seed_promotes_scoped_row_without_losing_history(
    tmp_path: Path,
) -> None:
    if not os.environ.get("DATABASE_URL"):
        return
    generator_path = ROOT / "scripts/build_seed_migration.py"
    spec = importlib.util.spec_from_file_location(
        "field_place_seed_generator", generator_path
    )
    assert spec is not None and spec.loader is not None
    generator = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(generator)

    place = staging_fixture_place(
        place_id="regional-promoted-field-fixture",
        name="Promoted fixture canonical",
    )
    staging_source = tmp_path / "staging-places.json"
    staging_source.write_text(json.dumps([place]), encoding="utf-8")
    canonical_source = tmp_path / "places.json"
    canonical_source.write_text(json.dumps([place]), encoding="utf-8")
    generator.SOURCE = canonical_source
    seed_sql = generator.render_for_target(Path("0020_promote_field_fixture.sql"))

    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        try:
            sync_staging_field_places(
                conn, enabled=True, source_path=staging_source
            )
            account_id = conn.execute(
                "INSERT INTO accounts (email) VALUES (%s) RETURNING id",
                (f"promotion-{uuid.uuid4()}@example.com",),
            ).fetchone()[0]
            conn.execute(
                "INSERT INTO account_visits (account_id, place_id) VALUES (%s, %s)",
                (account_id, place["id"]),
            )

            conn.execute(seed_sql)

            assert conn.execute(
                "SELECT name, active, field_test_scope FROM places WHERE id = %s",
                (place["id"],),
            ).fetchone() == ("Promoted fixture canonical", True, None)
            assert conn.execute(
                "SELECT 1 FROM account_visits WHERE account_id = %s AND place_id = %s",
                (account_id, place["id"]),
            ).fetchone() is not None
        finally:
            # The generated catalogue update is intentionally exercised as one
            # transaction and rolled back so it cannot retire the test database's
            # real canonical catalogue.
            conn.rollback()


def test_lifespan_orders_pool_sync_registry_then_id_validation(monkeypatch) -> None:
    events: list[object] = []

    class Result:
        def fetchall(self):
            return [{"id": PLACE_ID}]

    class Connection:
        def execute(self, _sql, _params=()):
            events.append("validate")
            return Result()

        def commit(self):
            events.append("commit")

    def fake_connection():
        yield Connection()

    def fake_sync(_conn, *, enabled, source_path=None):
        del source_path
        events.append(("sync", enabled))

    def fake_registry(enabled):
        events.append(("registry", enabled))
        return SimpleNamespace(place_ids=frozenset({PLACE_ID}))

    class FakeMcp:
        @asynccontextmanager
        async def lifespan(self):
            events.append("mcp")
            yield

    monkeypatch.setattr(api.settings, "enable_staging_field_places", True)
    monkeypatch.setattr(api.settings, "app_environment", "staging")
    monkeypatch.setattr(api.settings, "railway_environment_name", "staging")
    monkeypatch.setattr(api, "open_pool", lambda: events.append("pool"))
    monkeypatch.setattr(api, "close_pool", lambda: events.append("close"))
    monkeypatch.setattr(api, "connection", fake_connection)
    monkeypatch.setattr(api, "sync_staging_field_places", fake_sync)
    monkeypatch.setattr(api, "get_boundary_registry", fake_registry)
    monkeypatch.setattr(api, "mcp_http_app", FakeMcp())

    async def exercise():
        async with api.lifespan(api.app):
            events.append("yield")

    asyncio.run(exercise())
    assert events[:5] == [
        "pool",
        ("sync", True),
        ("registry", True),
        "validate",
        "commit",
    ]
    assert events[-1] == "close"
    assert "photo_deletion_worker" not in inspect.getsource(api.lifespan)


def test_enabled_staging_startup_hides_retired_bell_and_keeps_canonical_parks(
    monkeypatch,
) -> None:
    if not os.environ.get("DATABASE_URL"):
        return
    email = f"empty-overlay-{uuid.uuid4()}@example.com"
    claims.get_boundary_registry.cache_clear()
    monkeypatch.setattr(api.settings, "enable_staging_field_places", True)
    monkeypatch.setattr(api.settings, "app_environment", "staging")
    monkeypatch.setattr(api.settings, "railway_environment_name", "staging")
    try:
        with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
            conn.execute(
                """
                INSERT INTO places (
                    id, name, category, latitude, longitude, region,
                    description, source_url, source_name, source_id, active,
                    field_test_scope
                ) VALUES (
                    %s, 'Bell Park', 'regional', 49.0918726, -123.0600868,
                    'Lower Mainland', 'Retired staging fixture',
                    'https://example.test/bell-park', 'Test fixture', 'legacy',
                    FALSE, 'staging'
                )
                ON CONFLICT (id) DO UPDATE SET
                    active = FALSE,
                    field_test_scope = 'staging'
                """,
                (RETIRED_PLACE_ID,),
            )
            conn.commit()

        with TestClient(api.app) as client:
            registration = client.post(
                "/api/auth/register",
                json={"email": email, "password": "goldstream qa password"},
            )
            assert registration.status_code == 201, registration.text
            registered = registration.json()
            headers = {"Authorization": f"Bearer {registered['token']}"}
            places = client.get("/api/places", headers=headers)
            assert places.status_code == 200
            listed_ids = {place["id"] for place in places.json()["places"]}
            assert PLACE_ID in listed_ids
            assert CANONICAL_BELLHOUSE_ID in listed_ids
            assert RETIRED_PLACE_ID not in listed_ids
            search = client.get(
                "/api/places/search",
                headers=headers,
                params={"query": "Bell Park"},
            )
            assert search.status_code == 200, search.text
            assert RETIRED_PLACE_ID not in {
                place["id"] for place in search.json()["places"]
            }
            assert client.get(
                f"/api/places/{RETIRED_PLACE_ID}", headers=headers
            ).status_code == 404
            bellhouse_search = client.get(
                "/api/places/search",
                headers=headers,
                params={"query": "Bellhouse Park"},
            )
            assert bellhouse_search.status_code == 200, bellhouse_search.text
            assert [place["id"] for place in bellhouse_search.json()["places"]] == [
                CANONICAL_BELLHOUSE_ID
            ]
            detail = client.get(
                f"/api/places/{CANONICAL_BELLHOUSE_ID}", headers=headers
            )
            assert detail.status_code == 200, detail.text
            group = client.post(
                "/api/groups",
                headers=headers,
                json={"name": "Field check", "placeIds": [CANONICAL_BELLHOUSE_ID]},
            )
            assert group.status_code == 201, group.text
            assert [place["id"] for place in group.json()["places"]] == [
                CANONICAL_BELLHOUSE_ID
            ]
            assert client.get("/ready").json()["boundaryVersion"] == (
                claims.get_boundary_registry(True).version
            )
            recommendation = client.post(
                "/api/claim-recommendations",
                headers=headers,
                json={
                    "location": {
                        "latitude": PIN_LATITUDE,
                        "longitude": PIN_LONGITUDE,
                        "accuracyMeters": 5,
                        "capturedAtEpochMs": int(
                            datetime.now(timezone.utc).timestamp() * 1000
                        ),
                    }
                },
            )
            assert recommendation.status_code == 200, recommendation.text
            assert recommendation.json()["candidate"]["placeId"] == PLACE_ID
            claimed = client.post(
                "/api/claims",
                headers=headers,
                json={
                    "recommendationToken": recommendation.json()[
                        "recommendationToken"
                    ],
                    "expectedPlaceId": PLACE_ID,
                },
            )
            assert claimed.status_code == 200, claimed.text
            assert claimed.json()["placeId"] == PLACE_ID
            state = client.get("/api/places", headers=headers).json()
            assert PLACE_ID in state["visitedIds"]
    finally:
        claims.get_boundary_registry.cache_clear()
        with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
            conn.execute("DELETE FROM accounts WHERE email = %s", (email,))
            conn.execute("DELETE FROM places WHERE field_test_scope IS NOT NULL")
            conn.execute(
                "DELETE FROM auth_rate_limits WHERE action = ANY(%s)",
                (["register", "register_global", "claim_recommendation", "claim_recommendation_global"],),
            )
            conn.commit()


def test_api_image_contains_both_staging_overlay_files() -> None:
    dockerfile = (ROOT / "backend/Dockerfile.api").read_text(encoding="utf-8")
    assert "COPY data/staging-field-places.json" in dockerfile
    assert "COPY data/staging-field-boundaries.geojson" in dockerfile

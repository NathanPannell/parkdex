import os

import psycopg
from fastapi.testclient import TestClient

from backend.app.main import app

TEST_PLACE = "integration-test-place"
KEY_ONE = "a" * 43
KEY_TWO = "b" * 43


def test_visit_collection_is_persistent_and_isolated() -> None:
    database_url = os.environ["DATABASE_URL"]
    with psycopg.connect(database_url) as conn:
        conn.execute(
            """
            INSERT INTO places (
                id, name, category, latitude, longitude, region, description,
                source_url, source_name
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (id) DO NOTHING
            """,
            (
                TEST_PLACE,
                "Integration Test Park",
                "regional",
                49.0,
                -124.0,
                "Test region",
                "A deterministic CI fixture.",
                "https://example.com/source",
                "Test source",
            ),
        )
        conn.execute("DELETE FROM visits WHERE place_id = %s", (TEST_PLACE,))
        conn.commit()

    try:
        with TestClient(app) as client:
            readiness = client.get("/ready")
            assert readiness.status_code == 200
            assert readiness.json()["commit"]

            visit = client.put(
                f"/api/visits/{TEST_PLACE}",
                headers={"X-Collection-Key": KEY_ONE},
                json={"visited": True},
            )
            assert visit.status_code == 200
            repeated = client.put(
                f"/api/visits/{TEST_PLACE}",
                headers={"X-Collection-Key": KEY_ONE},
                json={"visited": True},
            )
            assert repeated.status_code == 200
            assert repeated.json()["visitedCount"] == visit.json()["visitedCount"]
            assert repeated.json()["visitedAt"] == visit.json()["visitedAt"]

            first = client.get("/api/places", headers={"X-Collection-Key": KEY_ONE})
            second = client.get("/api/places", headers={"X-Collection-Key": KEY_TWO})
            assert TEST_PLACE in first.json()["visitedIds"]
            assert first.json()["visits"] == [{"placeId": TEST_PLACE, "visitedAt": visit.json()["visitedAt"]}]
            assert TEST_PLACE not in second.json()["visitedIds"]
            assert second.json()["visits"] == []

            with psycopg.connect(database_url) as conn:
                conn.execute("UPDATE places SET active = FALSE WHERE id = %s", (TEST_PLACE,))
                conn.commit()
            retired = client.get("/api/places", headers={"X-Collection-Key": KEY_ONE}).json()
            assert TEST_PLACE not in {place["id"] for place in retired["places"]}
            assert TEST_PLACE not in retired["visitedIds"]
            with psycopg.connect(database_url) as conn:
                preserved = conn.execute(
                    "SELECT 1 FROM visits WHERE place_id = %s", (TEST_PLACE,)
                ).fetchone()
                assert preserved is not None
                conn.execute("UPDATE places SET active = TRUE WHERE id = %s", (TEST_PLACE,))
                conn.commit()

            undo = client.put(
                f"/api/visits/{TEST_PLACE}",
                headers={"X-Collection-Key": KEY_ONE},
                json={"visited": False},
            )
            assert undo.status_code == 200
            assert undo.json()["visited"] is False
    finally:
        with psycopg.connect(database_url) as conn:
            conn.execute("DELETE FROM visits WHERE place_id = %s", (TEST_PLACE,))
            conn.execute("DELETE FROM places WHERE id = %s", (TEST_PLACE,))
            conn.commit()

import os

import psycopg
from fastapi.testclient import TestClient

from backend.app.main import app


PLACE_IDS = ["trip-test-alpha", "trip-test-beta", "trip-test-gamma"]
EMAILS = ["trip-owner@example.com", "trip-other@example.com"]


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_private_trips_search_and_membership_are_persistent_and_isolated() -> None:
    database_url = os.environ["DATABASE_URL"]
    with psycopg.connect(database_url) as conn:
        conn.execute("DELETE FROM accounts WHERE email = ANY(%s)", (EMAILS,))
        conn.execute("DELETE FROM places WHERE id = ANY(%s)", (PLACE_IDS,))
        conn.execute(
            """
            INSERT INTO places (id, name, category, latitude, longitude, region, description, source_url, source_name)
            VALUES
              (%s, 'Trip Test Alpha', 'national', 49.0, -124.0, 'North', 'Ocean overlook', 'https://example.com/a', 'Test'),
              (%s, 'Trip Test Beta', 'provincial', 49.1, -124.0, 'North', 'Quiet lake', 'https://example.com/b', 'Test'),
              (%s, 'Trip Test Gamma', 'island', 50.0, -125.0, 'West', 'Island reserve', 'https://example.com/c', 'Test')
            """,
            PLACE_IDS,
        )
        conn.commit()

    try:
        with TestClient(app) as client:
            first = client.post("/api/auth/register", json={"email": EMAILS[0], "password": "trip owner password"})
            second = client.post("/api/auth/register", json={"email": EMAILS[1], "password": "trip other password"})
            first_headers, second_headers = auth(first.json()["token"]), auth(second.json()["token"])

            created = client.post(
                "/api/trips",
                headers=first_headers,
                json={"name": "Island Weekend", "placeIds": [PLACE_IDS[0], PLACE_IDS[0], PLACE_IDS[1]]},
            )
            assert created.status_code == 201
            trip = created.json()
            assert trip["name"] == "Island Weekend"
            assert trip["placeIds"] == PLACE_IDS[:2]

            repeated = client.post(
                f"/api/trips/{trip['id']}/places",
                headers=first_headers,
                json={"placeIds": [PLACE_IDS[1], PLACE_IDS[2], PLACE_IDS[2]]},
            )
            assert repeated.status_code == 200
            assert repeated.json()["placeIds"] == PLACE_IDS

            groups = client.get("/api/groups", headers=first_headers)
            assert groups.status_code == 200
            wishlists = [group for group in groups.json() if group["isWishlist"]]
            assert len(wishlists) == 1
            wishlist = client.post(
                "/api/wishlist/places", headers=first_headers, json={"placeIds": [PLACE_IDS[0], PLACE_IDS[0]]}
            )
            assert wishlist.status_code == 200
            assert wishlist.json()["placeIds"] == [PLACE_IDS[0]]
            assert client.get("/api/wishlist", headers=second_headers).json()["placeIds"] == []

            assert client.get("/api/trips", headers=second_headers).json() == []
            assert client.get(f"/api/trips/{trip['id']}", headers=second_headers).status_code == 404
            assert client.get("/api/trips").status_code == 401

            filtered = client.get(
                "/api/places/search",
                headers=first_headers,
                params={"type": "provincial", "query": "Trip Test Beta", "visited": "false"},
            )
            assert filtered.status_code == 200
            assert [place["id"] for place in filtered.json()["places"]] == [PLACE_IDS[1]]

            nearby = client.get(
                "/api/places/search",
                headers=first_headers,
                params={"latitude": 49.0, "longitude": -124.0, "radius_km": 20, "query": "Trip Test", "limit": 1, "offset": 0},
            )
            assert nearby.status_code == 200
            assert nearby.json()["places"][0]["id"] == PLACE_IDS[0]
            assert nearby.json()["places"][0]["distanceKm"] == 0
            assert nearby.json()["total"] == 2

            bad_origin = client.get(
                "/api/places/search", headers=first_headers, params={"latitude": 49}
            )
            assert bad_origin.status_code == 400

            with psycopg.connect(database_url) as conn:
                conn.execute("UPDATE places SET active = FALSE WHERE id = %s", (PLACE_IDS[1],))
                conn.commit()
            inactive = client.post(
                f"/api/trips/{trip['id']}/places",
                headers=first_headers,
                json={"placeIds": [PLACE_IDS[1]]},
            )
            assert inactive.status_code == 400
            details = client.get(f"/api/places/{PLACE_IDS[1]}", headers=first_headers)
            assert details.status_code == 404
    finally:
        with psycopg.connect(database_url) as conn:
            conn.execute("DELETE FROM accounts WHERE email = ANY(%s)", (EMAILS,))
            conn.execute("DELETE FROM places WHERE id = ANY(%s)", (PLACE_IDS,))
            conn.commit()

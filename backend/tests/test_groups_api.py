import os
from concurrent.futures import ThreadPoolExecutor

import psycopg
from fastapi.testclient import TestClient
from psycopg.rows import dict_row

from backend.app.main import app
from backend.app.groups import ensure_wishlist


PLACE_IDS = ["group-test-alpha", "group-test-beta", "group-test-gamma"]
EMAILS = ["group-owner@example.com", "group-other@example.com"]


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_private_groups_search_and_membership_are_persistent_and_isolated() -> None:
    database_url = os.environ["DATABASE_URL"]
    with psycopg.connect(database_url) as conn:
        conn.execute("DELETE FROM accounts WHERE email = ANY(%s)", (EMAILS,))
        conn.execute("DELETE FROM places WHERE id = ANY(%s)", (PLACE_IDS,))
        conn.execute(
            """
            INSERT INTO places (id, name, category, latitude, longitude, region, description, source_url, source_name)
            VALUES
              (%s, 'Group Test Alpha', 'national', 49.0, -124.0, 'North', 'Ocean overlook', 'https://example.com/a', 'Test'),
              (%s, 'Group Test Beta', 'provincial', 49.1, -124.0, 'North', 'Quiet lake', 'https://example.com/b', 'Test'),
              (%s, 'Group Test Gamma', 'island', 50.0, -125.0, 'West', 'Island reserve', 'https://example.com/c', 'Test')
            """,
            PLACE_IDS,
        )
        conn.commit()

    try:
        with TestClient(app) as client:
            first = client.post("/api/auth/register", json={"email": EMAILS[0], "password": "group owner password"})
            second = client.post("/api/auth/register", json={"email": EMAILS[1], "password": "group other password"})
            first_headers, second_headers = auth(first.json()["token"]), auth(second.json()["token"])

            created = client.post(
                "/api/groups",
                headers=first_headers,
                json={"name": "Island Weekend", "placeIds": [PLACE_IDS[0], PLACE_IDS[0], PLACE_IDS[1]]},
            )
            assert created.status_code == 201
            group = created.json()
            assert group["name"] == "Island Weekend"
            assert group["placeIds"] == PLACE_IDS[:2]

            repeated = client.post(
                f"/api/groups/{group['id']}/places",
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
            wishlist_id = wishlist.json()["id"]
            assert client.patch(
                f"/api/groups/{wishlist_id}", headers=first_headers, json={"name": "Later"}
            ).status_code == 409
            assert client.delete(f"/api/groups/{wishlist_id}", headers=first_headers).status_code == 409
            assert {item["id"] for item in client.get("/api/groups", headers=first_headers).json()} == {group["id"], wishlist_id}
            assert client.post(
                "/api/groups", headers=first_headers, json={"name": "Wishlist", "placeIds": []}
            ).status_code == 422
            assert client.get("/api/wishlist", headers=second_headers).json()["placeIds"] == []

            second_groups = client.get("/api/groups", headers=second_headers).json()
            assert len(second_groups) == 1 and second_groups[0]["isWishlist"]
            assert client.get(f"/api/groups/{group['id']}", headers=second_headers).status_code == 404
            assert client.post(
                f"/api/groups/{group['id']}/places", headers=second_headers, json={"placeIds": [PLACE_IDS[2]]}
            ).status_code == 404
            assert client.get("/api/groups").status_code == 401

            filtered = client.get(
                "/api/places/search",
                headers=first_headers,
                params={"type": "provincial", "query": "Group Test Beta", "visited": "false"},
            )
            assert filtered.status_code == 200
            assert [place["id"] for place in filtered.json()["places"]] == [PLACE_IDS[1]]

            nearby = client.get(
                "/api/places/search",
                headers=first_headers,
                params={"latitude": 49.0, "longitude": -124.0, "radius_km": 20, "query": "Group Test", "limit": 1, "offset": 0},
            )
            assert nearby.status_code == 200
            assert nearby.json()["places"][0]["id"] == PLACE_IDS[0]
            assert nearby.json()["places"][0]["distanceKm"] == 0
            assert nearby.json()["total"] == 2
            next_nearby = client.get(
                "/api/places/search",
                headers=first_headers,
                params={"latitude": 49.0, "longitude": -124.0, "radius_km": 20, "query": "Group Test", "limit": 1, "offset": 1},
            )
            assert [place["id"] for place in next_nearby.json()["places"]] == [PLACE_IDS[1]]

            bad_origin = client.get(
                "/api/places/search", headers=first_headers, params={"latitude": 49}
            )
            assert bad_origin.status_code == 400
            radius_without_origin = client.get(
                "/api/places/search", headers=first_headers, params={"radius_km": 20}
            )
            assert radius_without_origin.status_code == 400

            with psycopg.connect(database_url) as conn:
                conn.execute("UPDATE places SET active = FALSE WHERE id = %s", (PLACE_IDS[1],))
                conn.commit()
            inactive = client.post(
                f"/api/groups/{group['id']}/places",
                headers=first_headers,
                json={"placeIds": [PLACE_IDS[1]]},
            )
            assert inactive.status_code == 400
            details = client.get(f"/api/places/{PLACE_IDS[1]}", headers=first_headers)
            assert details.status_code == 404
            renamed = client.patch(
                f"/api/groups/{group['id']}", headers=first_headers, json={"name": "Renamed route"}
            )
            assert renamed.status_code == 200
            assert renamed.json()["name"] == "Renamed route"
            removed = client.request(
                "DELETE",
                f"/api/groups/{group['id']}/places",
                headers=first_headers,
                json={"placeIds": [PLACE_IDS[2]]},
            )
            assert removed.status_code == 200
            assert PLACE_IDS[2] not in removed.json()["placeIds"]
            assert client.delete(f"/api/groups/{group['id']}", headers=first_headers).status_code == 204
    finally:
        with psycopg.connect(database_url) as conn:
            conn.execute("DELETE FROM accounts WHERE email = ANY(%s)", (EMAILS,))
            conn.execute("DELETE FROM places WHERE id = ANY(%s)", (PLACE_IDS,))
            conn.commit()


def test_wishlist_is_a_singleton_under_concurrent_creation() -> None:
    database_url = os.environ["DATABASE_URL"]
    email = "wishlist-race@example.com"
    with psycopg.connect(database_url) as conn:
        conn.execute("DELETE FROM accounts WHERE email = %s", (email,))
        conn.commit()
    try:
        with TestClient(app) as client:
            response = client.post(
                "/api/auth/register",
                json={"email": email, "password": "wishlist race password"},
            )
            assert response.status_code == 201
            account_id = response.json()["account"]["id"]

        def create_once(_: int) -> str:
            with psycopg.connect(database_url, row_factory=dict_row) as conn:
                return ensure_wishlist(conn, account_id)["id"]

        with ThreadPoolExecutor(max_workers=6) as executor:
            ids = list(executor.map(create_once, range(12)))
        assert len(set(ids)) == 1
        with psycopg.connect(database_url) as conn:
            count = conn.execute(
                "SELECT COUNT(*) FROM account_groups WHERE account_id = %s AND is_wishlist",
                (account_id,),
            ).fetchone()[0]
            assert count == 1
    finally:
        with psycopg.connect(database_url) as conn:
            conn.execute("DELETE FROM accounts WHERE email = %s", (email,))
            conn.commit()

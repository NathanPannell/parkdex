import os
from concurrent.futures import ThreadPoolExecutor
from threading import Event

import psycopg
import pytest
from fastapi.testclient import TestClient
from psycopg.errors import CheckViolation
from psycopg.rows import dict_row

import backend.app.main as main_module
from backend.app.main import app
from backend.app.groups import create_group_row, ensure_wishlist, lock_account_group_mutations


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


def test_database_enforces_wishlist_group_identity() -> None:
    database_url = os.environ["DATABASE_URL"]
    email = "wishlist-constraint@example.com"
    with psycopg.connect(database_url) as conn:
        conn.execute("DELETE FROM accounts WHERE email = %s", (email,))
        account_id = conn.execute(
            "INSERT INTO accounts (email) VALUES (%s) RETURNING id", (email,)
        ).fetchone()[0]
        conn.commit()
        try:
            with pytest.raises(CheckViolation):
                conn.execute(
                    "INSERT INTO account_groups (account_id, name, is_wishlist) VALUES (%s, 'Wishlist', FALSE)",
                    (account_id,),
                )
        finally:
            conn.rollback()
            conn.execute("DELETE FROM accounts WHERE id = %s", (account_id,))
            conn.commit()


def test_account_reset_waits_for_direct_group_mutation_then_clears_it(monkeypatch) -> None:
    """The direct path mirrors an in-process MCP mutation racing the HTTP reset."""
    database_url = os.environ["DATABASE_URL"]
    email = "group-reset-race@example.com"
    place_id = "group-reset-race-place"
    with psycopg.connect(database_url) as conn:
        conn.execute("DELETE FROM accounts WHERE email = %s", (email,))
        conn.execute("DELETE FROM places WHERE id = %s", (place_id,))
        conn.execute(
            """
            INSERT INTO places (id, name, category, latitude, longitude, region, description, source_url, source_name)
            VALUES (%s, 'Reset Race', 'regional', 49.0, -124.0, 'South', '', 'https://example.test/reset', 'Test')
            """,
            (place_id,),
        )
        conn.commit()
    try:
        with TestClient(app) as client:
            registered = client.post(
                "/api/auth/register",
                json={"email": email, "password": "group reset race password"},
            ).json()
            account_id = registered["account"]["id"]
            headers = auth(registered["token"])
            lock_attempted = Event()
            original_lock = main_module.lock_account_progress

            def instrumented_lock(conn, locked_account_id: str) -> None:
                lock_attempted.set()
                original_lock(conn, locked_account_id)

            monkeypatch.setattr(main_module, "lock_account_progress", instrumented_lock)
            with psycopg.connect(database_url, row_factory=dict_row) as mutation_conn:
                lock_account_group_mutations(mutation_conn, account_id)
                created = create_group_row(mutation_conn, account_id, "MCP race", [place_id])
                with ThreadPoolExecutor(max_workers=1) as executor:
                    resetting = executor.submit(client.delete, "/api/account/progress", headers=headers)
                    assert lock_attempted.wait(timeout=2), "reset never reached account lock acquisition"
                    assert not resetting.done(), "reset completed while the MCP-style mutation held the account lock"
                    mutation_conn.commit()
                    assert resetting.result(timeout=5).status_code == 204
            groups = client.get("/api/groups", headers=headers).json()
            assert len(groups) == 1
            assert groups[0]["isWishlist"] is True
            assert groups[0]["placeIds"] == []
            assert groups[0]["id"] != created["id"]
    finally:
        with psycopg.connect(database_url) as conn:
            conn.execute("DELETE FROM accounts WHERE email = %s", (email,))
            conn.execute("DELETE FROM places WHERE id = %s", (place_id,))
            conn.commit()


def test_account_reset_rolls_back_every_progress_collection_when_wishlist_recreation_fails(monkeypatch) -> None:
    database_url = os.environ["DATABASE_URL"]
    email = "group-reset-rollback@example.com"
    place_id = "group-reset-rollback-place"
    with psycopg.connect(database_url) as conn:
        conn.execute("DELETE FROM accounts WHERE email = %s", (email,))
        conn.execute("DELETE FROM places WHERE id = %s", (place_id,))
        conn.execute(
            """
            INSERT INTO places (id, name, category, latitude, longitude, region, description, source_url, source_name)
            VALUES (%s, 'Rollback Park', 'regional', 49.0, -124.0, 'South', '', 'https://example.test/rollback', 'Test')
            """,
            (place_id,),
        )
        conn.commit()
    try:
        with TestClient(app) as client:
            registered = client.post(
                "/api/auth/register",
                json={"email": email, "password": "group reset rollback password"},
            ).json()
            account_id = registered["account"]["id"]
            headers = auth(registered["token"])
            assert client.put(f"/api/visits/{place_id}", headers=headers, json={"visited": True}).status_code == 200
            assert client.put("/api/trails/west_coast_trail", headers=headers, json={"completed": True}).status_code == 200
            group = client.post(
                "/api/groups", headers=headers, json={"name": "Keep together", "placeIds": [place_id]}
            ).json()
            wishlist = client.post(
                "/api/wishlist/places", headers=headers, json={"placeIds": [place_id]}
            ).json()

            def fail_wishlist_recreation(*_args, **_kwargs):
                raise RuntimeError("forced reset failure")

            monkeypatch.setattr(main_module, "ensure_wishlist", fail_wishlist_recreation)
            with pytest.raises(RuntimeError, match="forced reset failure"):
                client.delete("/api/account/progress", headers=headers)

            with psycopg.connect(database_url) as conn:
                assert conn.execute(
                    "SELECT 1 FROM account_visits WHERE account_id = %s AND place_id = %s",
                    (account_id, place_id),
                ).fetchone()
                assert conn.execute(
                    "SELECT 1 FROM account_trail_completions WHERE account_id = %s AND trail_id = 'west_coast_trail'",
                    (account_id,),
                ).fetchone()
                groups = conn.execute(
                    "SELECT id, is_wishlist FROM account_groups WHERE account_id = %s ORDER BY is_wishlist, id",
                    (account_id,),
                ).fetchall()
                assert {str(row[0]) for row in groups} == {group["id"], wishlist["id"]}
                memberships = conn.execute(
                    """
                    SELECT ag.id, agp.place_id
                    FROM account_groups ag
                    JOIN account_group_places agp ON agp.group_id = ag.id
                    WHERE ag.account_id = %s
                    """,
                    (account_id,),
                ).fetchall()
                assert {(str(row[0]), row[1]) for row in memberships} == {
                    (group["id"], place_id),
                    (wishlist["id"], place_id),
                }
    finally:
        with psycopg.connect(database_url) as conn:
            conn.execute("DELETE FROM accounts WHERE email = %s", (email,))
            conn.execute("DELETE FROM places WHERE id = %s", (place_id,))
            conn.commit()

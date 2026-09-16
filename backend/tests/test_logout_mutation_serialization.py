from concurrent.futures import ThreadPoolExecutor
import hashlib
import os
from threading import Event, Lock

import psycopg
import pytest
from fastapi.testclient import TestClient

import backend.app.main as api


GUEST_KEY = "logout-race-guest-collection-key-0000000000000"
GROUP_NAME = "Logout race group"
TRAIL_ID = "west_coast_trail"


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def cleanup(email: str, place_id: str) -> None:
    guest_hash = hashlib.sha256(GUEST_KEY.encode("ascii")).hexdigest()
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        conn.execute("DELETE FROM accounts WHERE email = %s", (email,))
        conn.execute("DELETE FROM visits WHERE owner_hash = %s", (guest_hash,))
        conn.execute(
            "DELETE FROM guest_trail_completions WHERE owner_hash = %s",
            (guest_hash,),
        )
        conn.execute("DELETE FROM places WHERE id = %s", (place_id,))
        conn.execute(
            "DELETE FROM auth_rate_limits WHERE action = ANY(%s)",
            (["register", "register_global"],),
        )
        conn.commit()


def seed_import_source(place_id: str) -> None:
    guest_hash = hashlib.sha256(GUEST_KEY.encode("ascii")).hexdigest()
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        conn.execute(
            """
            INSERT INTO places (
                id, name, category, latitude, longitude, region, description,
                source_url, source_name
            ) VALUES (%s, 'Logout race place', 'regional', 49, -124, 'Test',
                      '', 'https://example.test/logout-race', 'Test')
            """,
            (place_id,),
        )
        conn.execute(
            "INSERT INTO visits (owner_hash, place_id) VALUES (%s, %s)",
            (guest_hash, place_id),
        )
        conn.execute(
            "INSERT INTO guest_trail_completions (owner_hash, trail_id) "
            "VALUES (%s, %s)",
            (guest_hash, TRAIL_ID),
        )
        conn.commit()


def mutation_request(
    kind: str,
    client: TestClient,
    headers: dict[str, str],
):
    if kind == "group":
        return client.post(
            "/api/groups",
            headers=headers,
            json={"name": GROUP_NAME, "placeIds": []},
        )
    if kind == "trail":
        return client.put(
            f"/api/trails/{TRAIL_ID}",
            headers=headers,
            json={"completed": True},
        )
    return client.post(
        "/api/account/import-guest",
        headers={**headers, "X-Collection-Key": GUEST_KEY},
    )


def account_write_exists(conn, kind: str, account_id: str, place_id: str) -> bool:
    if kind == "group":
        return (
            conn.execute(
                "SELECT 1 FROM account_groups "
                "WHERE account_id = %s AND name = %s",
                (account_id, GROUP_NAME),
            ).fetchone()
            is not None
        )
    if kind == "trail":
        return (
            conn.execute(
                "SELECT 1 FROM account_trail_completions "
                "WHERE account_id = %s AND trail_id = %s",
                (account_id, TRAIL_ID),
            ).fetchone()
            is not None
        )
    visit = conn.execute(
        "SELECT 1 FROM account_visits WHERE account_id = %s AND place_id = %s",
        (account_id, place_id),
    ).fetchone()
    trail = conn.execute(
        "SELECT 1 FROM account_trail_completions "
        "WHERE account_id = %s AND trail_id = %s",
        (account_id, TRAIL_ID),
    ).fetchone()
    return visit is not None and trail is not None


@pytest.mark.parametrize("kind", ["group", "trail", "import"])
def test_logout_waits_for_inflight_account_mutation(kind, monkeypatch):
    email = f"logout-inflight-{kind}@example.com"
    place_id = f"logout-inflight-{kind}-place"
    cleanup(email, place_id)
    if kind == "import":
        seed_import_source(place_id)
    release_mutation = Event()
    mutation_holds_lock = Event()
    logout_attempted_lock = Event()
    call_guard = Lock()
    call_count = 0
    original_revalidate = api.revalidate_locked_account_identity

    def instrumented_revalidate(conn, expected, authorization):
        nonlocal call_count
        with call_guard:
            call_count += 1
            current_call = call_count
        if current_call == 1:
            identity = original_revalidate(conn, expected, authorization)
            mutation_holds_lock.set()
            if not release_mutation.wait(timeout=10):
                raise AssertionError("test did not release the account mutation")
            return identity
        logout_attempted_lock.set()
        return original_revalidate(conn, expected, authorization)

    try:
        with TestClient(api.app) as client:
            registered = client.post(
                "/api/auth/register",
                json={"email": email, "password": "logout race password"},
            ).json()
            account_id = registered["account"]["id"]
            headers = bearer(registered["token"])
            monkeypatch.setattr(
                api, "revalidate_locked_account_identity", instrumented_revalidate
            )
            with ThreadPoolExecutor(max_workers=2) as executor:
                mutation_future = executor.submit(
                    mutation_request, kind, client, headers
                )
                assert mutation_holds_lock.wait(timeout=10)
                logout_future = executor.submit(
                    client.post, "/api/auth/logout", headers=headers
                )
                assert logout_attempted_lock.wait(timeout=10)
                assert not logout_future.done()
                release_mutation.set()
                mutation = mutation_future.result(timeout=10)
                logout = logout_future.result(timeout=10)

            assert mutation.status_code == (201 if kind == "group" else 200)
            assert logout.status_code == 204
            assert client.get("/api/auth/me", headers=headers).status_code == 401
            with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
                assert account_write_exists(conn, kind, account_id, place_id)
    finally:
        release_mutation.set()
        cleanup(email, place_id)


@pytest.mark.parametrize("kind", ["group", "trail", "import"])
def test_account_mutation_queued_behind_logout_rejects_stale_bearer(
    kind,
    monkeypatch,
):
    email = f"logout-stale-{kind}@example.com"
    place_id = f"logout-stale-{kind}-place"
    cleanup(email, place_id)
    if kind == "import":
        seed_import_source(place_id)
    logout_attempted_lock = Event()
    mutation_attempted_lock = Event()
    call_guard = Lock()
    call_count = 0
    original_revalidate = api.revalidate_locked_account_identity

    def instrumented_revalidate(conn, expected, authorization):
        nonlocal call_count
        with call_guard:
            call_count += 1
            current_call = call_count
        (logout_attempted_lock if current_call == 1 else mutation_attempted_lock).set()
        return original_revalidate(conn, expected, authorization)

    try:
        with TestClient(api.app) as client:
            registered = client.post(
                "/api/auth/register",
                json={"email": email, "password": "logout race password"},
            ).json()
            account_id = registered["account"]["id"]
            headers = bearer(registered["token"])
            monkeypatch.setattr(
                api, "revalidate_locked_account_identity", instrumented_revalidate
            )
            with psycopg.connect(os.environ["DATABASE_URL"]) as blocker:
                blocker.execute(
                    "SELECT id FROM accounts WHERE id = %s FOR UPDATE",
                    (account_id,),
                )
                with ThreadPoolExecutor(max_workers=2) as executor:
                    logout_future = executor.submit(
                        client.post, "/api/auth/logout", headers=headers
                    )
                    if not logout_attempted_lock.wait(timeout=10):
                        blocker.rollback()
                        raise AssertionError("logout did not request the account lock")
                    mutation_future = executor.submit(
                        mutation_request, kind, client, headers
                    )
                    if not mutation_attempted_lock.wait(timeout=10):
                        blocker.rollback()
                        raise AssertionError("mutation did not request the account lock")
                    assert not logout_future.done()
                    assert not mutation_future.done()
                    blocker.commit()
                    logout = logout_future.result(timeout=10)
                    mutation = mutation_future.result(timeout=10)

            assert logout.status_code == 204
            assert mutation.status_code == 401
            with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
                assert not account_write_exists(conn, kind, account_id, place_id)
    finally:
        cleanup(email, place_id)

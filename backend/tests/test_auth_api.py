import hashlib
import os

import psycopg
from fastapi.testclient import TestClient

from backend.app.main import app


TEST_PLACE = "auth-integration-test-place"
GUEST_KEY = "g" * 43
ACCOUNT_EMAILS = ("explorer@example.com", "other@example.com")


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_accounts_are_isolated_and_guest_progress_import_is_idempotent() -> None:
    database_url = os.environ["DATABASE_URL"]
    guest_hash = hashlib.sha256(GUEST_KEY.encode("ascii")).hexdigest()
    with psycopg.connect(database_url) as conn:
        conn.execute(
            """
            INSERT INTO places (
                id, name, category, latitude, longitude, region, description,
                source_url, source_name
            ) VALUES (%s, %s, 'regional', 49, -124, 'Test region',
                      'A deterministic CI fixture.', 'https://example.com', 'Test source')
            ON CONFLICT (id) DO UPDATE SET active = TRUE
            """,
            (TEST_PLACE, "Auth Integration Test Park"),
        )
        conn.execute("DELETE FROM accounts WHERE email = ANY(%s)", (list(ACCOUNT_EMAILS),))
        conn.execute("DELETE FROM visits WHERE owner_hash = %s", (guest_hash,))
        conn.execute("DELETE FROM guest_trail_completions WHERE owner_hash = %s", (guest_hash,))
        conn.execute("INSERT INTO visits (owner_hash, place_id) VALUES (%s, %s)", (guest_hash, TEST_PLACE))
        conn.commit()

    try:
        with TestClient(app) as client:
            guest_visit = client.put(
                f"/api/visits/{TEST_PLACE}",
                headers={"X-Collection-Key": GUEST_KEY},
                json={"visited": True},
            )
            assert guest_visit.status_code == 200
            guest_trail = client.put(
                "/api/trails/west_coast_trail",
                headers={"X-Collection-Key": GUEST_KEY},
                json={"completed": True},
            )
            assert guest_trail.status_code == 200

            created = client.post(
                "/api/auth/register",
                json={"email": "Explorer@Example.com", "password": "correct horse battery"},
            )
            assert created.status_code == 201
            body = created.json()
            token = body["token"]
            assert len(token) == 43
            assert body["account"]["email"] == ACCOUNT_EMAILS[0]
            assert body["visitedIds"] == []
            assert body["completedTrailIds"] == []

            with psycopg.connect(database_url, row_factory=psycopg.rows.dict_row) as conn:
                account = conn.execute(
                    "SELECT password_hash FROM accounts WHERE email = %s", (ACCOUNT_EMAILS[0],)
                ).fetchone()
                assert account["password_hash"].startswith("$argon2id$")
                assert "correct horse battery" not in account["password_hash"]
                assert conn.execute(
                    "SELECT 1 FROM account_sessions WHERE token_hash = %s",
                    (hashlib.sha256(token.encode()).hexdigest(),),
                ).fetchone()
                assert conn.execute(
                    "SELECT 1 FROM account_sessions WHERE token_hash = %s", (token,)
                ).fetchone() is None

            duplicate = client.post(
                "/api/auth/register",
                json={"email": ACCOUNT_EMAILS[0], "password": "another valid password"},
            )
            assert duplicate.status_code == 409

            imported = client.post(
                "/api/account/import-guest",
                headers={**bearer(token), "X-Collection-Key": GUEST_KEY},
            )
            assert imported.status_code == 200
            assert imported.json()["importedVisitCount"] == 1
            assert imported.json()["importedTrailCount"] == 1
            assert imported.json()["visitedIds"] == [TEST_PLACE]
            assert imported.json()["completedTrailIds"] == ["west_coast_trail"]
            repeated = client.post(
                "/api/account/import-guest",
                headers={**bearer(token), "X-Collection-Key": GUEST_KEY},
            )
            assert repeated.json()["importedVisitCount"] == 0
            assert repeated.json()["importedTrailCount"] == 0

            places = client.get("/api/places", headers=bearer(token))
            assert TEST_PLACE in places.json()["visitedIds"]
            assert places.json()["completedTrailIds"] == ["west_coast_trail"]
            ambiguous = client.put(
                f"/api/visits/{TEST_PLACE}",
                headers={**bearer(token), "X-Collection-Key": GUEST_KEY},
                json={"visited": False},
            )
            assert ambiguous.status_code == 400

            second = client.post(
                "/api/auth/register",
                json={"email": ACCOUNT_EMAILS[1], "password": "correct horse staple"},
            )
            second_state = client.get("/api/auth/me", headers=bearer(second.json()["token"]))
            assert second_state.json()["visitedIds"] == []
            assert second_state.json()["completedTrailIds"] == []

            logged_in = client.post(
                "/api/auth/login",
                json={"email": ACCOUNT_EMAILS[0], "password": "correct horse battery"},
            )
            assert logged_in.status_code == 200
            assert logged_in.json()["visitedIds"] == [TEST_PLACE]
            assert logged_in.json()["completedTrailIds"] == ["west_coast_trail"]

            assert client.delete("/api/account/progress").status_code == 401
            reset = client.delete("/api/account/progress", headers=bearer(token))
            assert reset.status_code == 204
            assert reset.content == b""
            reset_state = client.get("/api/auth/me", headers=bearer(token)).json()
            assert reset_state["visitedIds"] == []
            assert reset_state["visits"] == []
            assert reset_state["completedTrailIds"] == []
            # Resetting one account leaves guest data and other accounts untouched.
            assert TEST_PLACE in client.get(
                "/api/places", headers={"X-Collection-Key": GUEST_KEY}
            ).json()["visitedIds"]
            assert client.get("/api/auth/me", headers=bearer(second.json()["token"])).json()["visitedIds"] == []
            # Other live sessions for the same account immediately see the reset.
            assert client.get(
                "/api/auth/me", headers=bearer(logged_in.json()["token"])
            ).json()["visitedIds"] == []

            logout = client.post("/api/auth/logout", headers=bearer(token))
            assert logout.status_code == 204
            assert client.get("/api/auth/me", headers=bearer(token)).status_code == 401
            assert client.get("/api/auth/me", headers=bearer(logged_in.json()["token"])).status_code == 200
    finally:
        with psycopg.connect(database_url) as conn:
            conn.execute("DELETE FROM accounts WHERE email = ANY(%s)", (list(ACCOUNT_EMAILS),))
            conn.execute("DELETE FROM visits WHERE owner_hash = %s", (guest_hash,))
            conn.execute("DELETE FROM guest_trail_completions WHERE owner_hash = %s", (guest_hash,))
            conn.execute("DELETE FROM places WHERE id = %s", (TEST_PLACE,))
            conn.commit()


def test_authenticated_visit_and_trail_flow_is_idempotent_and_isolated() -> None:
    database_url = os.environ["DATABASE_URL"]
    place_id = "authenticated-flow-test-place"
    guest_key = "h" * 43
    guest_hash = hashlib.sha256(guest_key.encode("ascii")).hexdigest()
    emails = ["flow-one@example.com", "flow-two@example.com"]
    with psycopg.connect(database_url) as conn:
        conn.execute(
            """
            INSERT INTO places (
                id, name, category, latitude, longitude, region, description,
                source_url, source_name
            ) VALUES (%s, 'Authenticated Flow Park', 'regional', 49, -124,
                      'Test region', 'A deterministic CI fixture.',
                      'https://example.com', 'Test source')
            ON CONFLICT (id) DO UPDATE SET active = TRUE
            """,
            (place_id,),
        )
        conn.execute("DELETE FROM accounts WHERE email = ANY(%s)", (emails,))
        conn.execute("DELETE FROM visits WHERE owner_hash = %s", (guest_hash,))
        conn.execute("DELETE FROM guest_trail_completions WHERE owner_hash = %s", (guest_hash,))
        conn.commit()
    try:
        with TestClient(app) as client:
            first = client.post(
                "/api/auth/register",
                json={"email": emails[0], "password": "authenticated flow password"},
            )
            second = client.post(
                "/api/auth/register",
                json={"email": emails[1], "password": "independent flow password"},
            )
            first_headers = bearer(first.json()["token"])
            second_headers = bearer(second.json()["token"])
            with psycopg.connect(database_url) as conn:
                conn.execute(
                    "INSERT INTO account_visits (account_id, place_id) VALUES (%s, %s)",
                    (first.json()["account"]["id"], place_id),
                )
                conn.commit()

            checked = client.put(
                f"/api/visits/{place_id}", headers=first_headers, json={"visited": True}
            )
            repeated = client.put(
                f"/api/visits/{place_id}", headers=first_headers, json={"visited": True}
            )
            assert checked.status_code == 200
            assert repeated.json()["visitedCount"] == checked.json()["visitedCount"] == 1

            for trail_id in ("west_coast_trail", "juan_de_fuca_trail"):
                trail = client.put(
                    f"/api/trails/{trail_id}",
                    headers=first_headers,
                    json={"completed": True},
                )
                assert trail.status_code == 200
            assert trail.json()["completedTrailCount"] == 2

            me = client.get("/api/auth/me", headers=first_headers)
            places = client.get("/api/places", headers=first_headers)
            assert me.json()["visitedIds"] == [place_id]
            assert me.json()["visits"] == [{"placeId": place_id, "visitedAt": checked.json()["visitedAt"]}]
            assert me.json()["completedTrailIds"] == [
                "juan_de_fuca_trail",
                "west_coast_trail",
            ]
            assert places.json()["visitedIds"] == me.json()["visitedIds"]
            assert places.json()["visits"] == me.json()["visits"]
            assert places.json()["completedTrailIds"] == me.json()["completedTrailIds"]

            guest = client.get("/api/places", headers={"X-Collection-Key": guest_key})
            other = client.get("/api/auth/me", headers=second_headers)
            assert place_id not in guest.json()["visitedIds"]
            assert guest.json()["completedTrailIds"] == []
            assert other.json()["visitedIds"] == []
            assert other.json()["visits"] == []
            assert other.json()["completedTrailIds"] == []

            undone = client.put(
                f"/api/visits/{place_id}", headers=first_headers, json={"visited": False}
            )
            trail_undone = client.put(
                "/api/trails/west_coast_trail",
                headers=first_headers,
                json={"completed": False},
            )
            assert undone.json()["visitedCount"] == 0
            assert trail_undone.json()["completedTrailCount"] == 1
            final = client.get("/api/auth/me", headers=first_headers).json()
            assert final["visitedIds"] == []
            assert final["completedTrailIds"] == ["juan_de_fuca_trail"]

            blocked_guest_insert = client.put(
                f"/api/visits/{place_id}",
                headers={"X-Collection-Key": guest_key},
                json={"visited": True},
            )
            assert blocked_guest_insert.status_code == 409
            assert client.get("/api/auth/me", headers=first_headers).json()["visitedIds"] == []
            assert client.get("/api/auth/me", headers=second_headers).json()["visitedIds"] == []
    finally:
        with psycopg.connect(database_url) as conn:
            conn.execute("DELETE FROM accounts WHERE email = ANY(%s)", (emails,))
            conn.execute("DELETE FROM visits WHERE owner_hash = %s", (guest_hash,))
            conn.execute("DELETE FROM guest_trail_completions WHERE owner_hash = %s", (guest_hash,))
            conn.execute("DELETE FROM places WHERE id = %s", (place_id,))
            conn.commit()


def test_login_rate_limit_and_expired_session() -> None:
    database_url = os.environ["DATABASE_URL"]
    email = "rate-limit@example.com"
    with psycopg.connect(database_url) as conn:
        conn.execute("DELETE FROM accounts WHERE email = %s", (email,))
        conn.execute("DELETE FROM auth_login_attempts")
        conn.commit()
    try:
        with TestClient(app) as client:
            created = client.post(
                "/api/auth/register", json={"email": email, "password": "valid password 123"}
            ).json()
            for _ in range(5):
                response = client.post(
                    "/api/auth/login", json={"email": email, "password": "wrong password"}
                )
                assert response.status_code == 401
                assert response.json()["detail"] == "Invalid email or password"
            blocked = client.post(
                "/api/auth/login", json={"email": email, "password": "valid password 123"}
            )
            assert blocked.status_code == 429
            assert int(blocked.headers["Retry-After"]) > 0
            # Different accounts behind the same proxy do not share a throttle.
            other_email = "independent-login@example.com"
            for _ in range(5):
                other = client.post(
                    "/api/auth/login",
                    headers={"X-Real-IP": "203.0.113.7"},
                    json={"email": other_email, "password": "wrong password"},
                )
                assert other.status_code == 401
            assert client.post(
                "/api/auth/login",
                headers={"X-Real-IP": "203.0.113.8"},
                json={"email": other_email.upper(), "password": "wrong password"},
            ).status_code == 429

            token_hash = hashlib.sha256(created["token"].encode()).hexdigest()
            with psycopg.connect(database_url) as conn:
                conn.execute(
                    "UPDATE account_sessions SET expires_at = NOW() - INTERVAL '1 second', "
                    "created_at = NOW() - INTERVAL '1 day' WHERE token_hash = %s",
                    (token_hash,),
                )
                conn.commit()
            assert client.get("/api/auth/me", headers=bearer(created["token"])).status_code == 401
    finally:
        with psycopg.connect(database_url) as conn:
            conn.execute("DELETE FROM accounts WHERE email = %s", (email,))
            conn.execute("DELETE FROM auth_login_attempts")
            conn.commit()


def test_concurrent_login_attempts_cannot_bypass_limit(monkeypatch) -> None:
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier, Lock
    import time
    import backend.app.main as api

    database_url = os.environ["DATABASE_URL"]
    email = "concurrent-login@example.com"
    start = Barrier(10)
    count_lock = Lock()
    checks = 0
    original_verify = api.verify_password

    def counted_verify(password_hash, password):
        nonlocal checks
        with count_lock:
            checks += 1
        # Widen the former read/check/write race while retaining real hashing.
        time.sleep(0.03)
        return original_verify(password_hash, password)

    monkeypatch.setattr(api, "verify_password", counted_verify)
    with psycopg.connect(database_url) as conn:
        conn.execute("DELETE FROM auth_login_attempts")
    try:
        with TestClient(app) as client:
            def attempt(_):
                start.wait(timeout=10)
                return client.post(
                    "/api/auth/login",
                    json={"email": email, "password": "wrong password"},
                ).status_code

            with ThreadPoolExecutor(max_workers=10) as executor:
                statuses = list(executor.map(attempt, range(10)))
            assert statuses.count(401) == 5
            assert statuses.count(429) == 5
            assert checks == 5
    finally:
        with psycopg.connect(database_url) as conn:
            conn.execute("DELETE FROM auth_login_attempts")


def test_password_hashing_does_not_hold_the_database_pool(monkeypatch) -> None:
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event, Lock
    import backend.app.main as api

    database_url = os.environ["DATABASE_URL"]
    email = "pool-release-login@example.com"
    release_hashes = Event()
    all_hashing = Event()
    count_lock = Lock()
    hashing_count = 0
    original_verify = api.verify_password

    def blocked_verify(password_hash, password):
        nonlocal hashing_count
        with count_lock:
            hashing_count += 1
            if hashing_count == 5:
                all_hashing.set()
        if not release_hashes.wait(timeout=10):
            raise AssertionError("test did not release password checks")
        return original_verify(password_hash, password)

    monkeypatch.setattr(api, "verify_password", blocked_verify)
    with psycopg.connect(database_url) as conn:
        conn.execute("DELETE FROM auth_login_attempts")
        conn.commit()
    try:
        with TestClient(app) as client, ThreadPoolExecutor(max_workers=5) as executor:
            attempts = [
                executor.submit(
                    client.post,
                    "/api/auth/login",
                    json={"email": email, "password": "wrong password"},
                )
                for _ in range(5)
            ]
            assert all_hashing.wait(timeout=10)
            readiness = client.get("/ready")
            assert readiness.status_code == 200
            release_hashes.set()
            assert [attempt.result(timeout=10).status_code for attempt in attempts] == [401] * 5
    finally:
        release_hashes.set()
        with psycopg.connect(database_url) as conn:
            conn.execute("DELETE FROM auth_login_attempts")
            conn.commit()

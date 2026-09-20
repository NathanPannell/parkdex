import asyncio
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
from io import BytesIO
import os
from threading import Event, Lock

import psycopg
import pytest
from fastapi.testclient import TestClient
from PIL import Image
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

import backend.app.db as db
import backend.app.main as api
from backend.app.object_storage import (
    MemoryObjectStorage,
    ObjectStorageError,
    ObjectStorageNotFound,
)


EMAILS = ("claims-backend-one@example.com", "claims-backend-two@example.com")


@pytest.fixture(autouse=True)
def enable_server_owned_claim_fixtures(monkeypatch):
    """Enable named fixtures only inside this test module.

    The setting is patched on the already-created application object so the
    rest of the backend suite continues to exercise production-safe defaults.
    """

    monkeypatch.setattr(api.settings, "app_environment", "test")
    monkeypatch.setattr(api.settings, "claim_test_mode", True)
    monkeypatch.setattr(api.settings, "railway_environment_name", None)


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def cleanup():
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        conn.execute(
            "DELETE FROM photo_object_deletions WHERE account_id IN "
            "(SELECT id FROM accounts WHERE email = ANY(%s))",
            (list(EMAILS),),
        )
        conn.execute("DELETE FROM accounts WHERE email = ANY(%s)", (list(EMAILS),))
        conn.execute(
            "DELETE FROM auth_rate_limits WHERE action = ANY(%s)",
            (
                [
                    "claim_recommendation",
                    "claim_recommendation_global",
                    "claim_photo_upload",
                    "claim_photo_upload_global",
                    "register",
                    "register_global",
                ],
            ),
        )
        conn.commit()


def fixture_claim(client: TestClient, headers: dict[str, str]):
    recommendation = client.post(
        "/api/claim-recommendations",
        headers=headers,
        json={"testFixtureId": "inside-goldstream"},
    )
    assert recommendation.status_code == 200, recommendation.text
    claim = client.post(
        "/api/claims",
        headers=headers,
        json={
            "recommendationToken": recommendation.json()["recommendationToken"],
            "expectedPlaceId": recommendation.json()["candidate"]["placeId"],
        },
    )
    assert claim.status_code == 200, claim.text
    return recommendation.json(), claim.json()


def photo_bytes() -> bytes:
    output = BytesIO()
    Image.new("RGB", (80, 60), "forestgreen").save(output, format="PNG")
    return output.getvalue()


def test_claim_capability_bridges_old_account_clients_before_enforcement(
    monkeypatch,
):
    if not os.environ.get("DATABASE_URL"):
        return
    cleanup()
    place_id = "provincial-goldstream-park"
    try:
        with TestClient(api.app) as client:
            account = client.post(
                "/api/auth/register",
                json={"email": EMAILS[0], "password": "claims backend password"},
            ).json()
            headers = bearer(account["token"])

            monkeypatch.setattr(api.settings, "visit_claim_enforcement", "compatible")
            capability = client.get("/api/places", headers=headers).json()["visitClaims"]
            assert capability == {"supported": True, "enforcement": "compatible"}

            # The immediately previous authenticated client can still create
            # progress while the claim-aware frontend rolls out.
            legacy_create = client.put(
                f"/api/visits/{place_id}", headers=headers, json={"visited": True}
            )
            assert legacy_create.status_code == 200, legacy_create.text
            assert client.put(
                f"/api/visits/{place_id}", headers=headers, json={"visited": False}
            ).status_code == 200

            # Guest creation never reopens during the compatibility window.
            guest_create = client.put(
                f"/api/visits/{place_id}",
                headers={"X-Collection-Key": "g" * 43},
                json={"visited": True},
            )
            assert guest_create.status_code == 409
            assert guest_create.json()["detail"]["code"] == "location_claim_required"

            monkeypatch.setattr(api.settings, "visit_claim_enforcement", "required")
            assert client.get("/api/places", headers=headers).json()["visitClaims"] == {
                "supported": True,
                "enforcement": "required",
            }
            enforced = client.put(
                f"/api/visits/{place_id}", headers=headers, json={"visited": True}
            )
            assert enforced.status_code == 409
            assert enforced.json()["detail"]["code"] == "location_claim_required"
    finally:
        cleanup()


def test_authenticated_claims_are_account_only_single_use_private_and_normalized(
    monkeypatch,
):
    if not os.environ.get("DATABASE_URL"):
        return
    cleanup()
    off_loop_calls = []
    original_normalize = api.normalize_photo

    def checked_normalize(payload):
        with pytest.raises(RuntimeError, match="no running event loop"):
            asyncio.get_running_loop()
        off_loop_calls.append("pillow")
        return original_normalize(payload)

    class CheckedStorage(MemoryObjectStorage):
        def put(self, key, content, content_type):
            with pytest.raises(RuntimeError, match="no running event loop"):
                asyncio.get_running_loop()
            off_loop_calls.append("storage-put")
            super().put(key, content, content_type)

        def get(self, key):
            with pytest.raises(RuntimeError, match="no running event loop"):
                asyncio.get_running_loop()
            off_loop_calls.append("storage-get")
            return super().get(key)

    monkeypatch.setattr(api, "normalize_photo", checked_normalize)
    api.set_photo_storage(CheckedStorage())
    try:
        with TestClient(api.app) as client:
            first = client.post(
                "/api/auth/register",
                json={"email": EMAILS[0], "password": "claims backend password"},
            )
            second = client.post(
                "/api/auth/register",
                json={"email": EMAILS[1], "password": "claims backend password"},
            )
            first_headers = bearer(first.json()["token"])
            second_headers = bearer(second.json()["token"])
            guest = client.post(
                "/api/claim-recommendations",
                headers={"X-Collection-Key": "g" * 43},
                json={"testFixtureId": "inside-goldstream"},
            )
            assert guest.status_code == 401
            recommendation, created = fixture_claim(client, first_headers)
            place_id = created["placeId"]
            replay = client.post(
                "/api/claims",
                headers=first_headers,
                json={
                    "recommendationToken": recommendation["recommendationToken"],
                    "expectedPlaceId": place_id,
                },
            )
            assert replay.status_code == 409
            assert replay.json()["detail"]["code"] == "claim_recommendation_replayed"
            assert client.get(
                f"/api/visits/{place_id}/photo", headers=second_headers
            ).status_code == 404

            uploaded = client.put(
                f"/api/visits/{place_id}/photo",
                headers=first_headers,
                files={"photo": ("visit.png", photo_bytes(), "image/png")},
            )
            assert uploaded.status_code == 200, uploaded.text
            assert uploaded.json()["photo"]["contentType"] == "image/jpeg"
            assert uploaded.json()["photo"]["byteLength"] > 0
            assert off_loop_calls == ["pillow", "storage-put"]
            saved = client.get(f"/api/visits/{place_id}/photo", headers=first_headers)
            assert saved.status_code == 200
            assert off_loop_calls == ["pillow", "storage-put", "storage-get"]
            assert saved.headers["cache-control"] == "private, no-store"
            assert saved.headers["x-content-type-options"] == "nosniff"
            assert Image.open(BytesIO(saved.content)).getexif() == {}

            deleted = client.delete(
                f"/api/visits/{place_id}/photo", headers=first_headers
            )
            assert deleted.status_code == 204
            assert client.get(
                f"/api/visits/{place_id}/photo", headers=first_headers
            ).status_code == 404
            assert client.put(
                f"/api/visits/{place_id}",
                headers=first_headers,
                json={"visited": False},
            ).status_code == 200
            assert client.post(
                "/api/claim-recommendations",
                headers=first_headers,
                json={"testFixtureId": "inside-goldstream"},
            ).status_code == 200
    finally:
        api.set_photo_storage(None)
        cleanup()


def test_two_preissued_tokens_for_one_account_have_one_winner():
    if not os.environ.get("DATABASE_URL"):
        return
    cleanup()
    try:
        with TestClient(api.app) as client:
            account = client.post(
                "/api/auth/register",
                json={"email": EMAILS[0], "password": "claims backend password"},
            )
            headers = bearer(account.json()["token"])
            first = client.post(
                "/api/claim-recommendations",
                headers=headers,
                json={"testFixtureId": "inside-saltspring"},
            ).json()
            second = client.post(
                "/api/claim-recommendations",
                headers=headers,
                json={"testFixtureId": "inside-saltspring"},
            ).json()

            def use(item):
                return client.post(
                    "/api/claims",
                    headers=headers,
                    json={
                        "recommendationToken": item["recommendationToken"],
                        "expectedPlaceId": item["candidate"]["placeId"],
                    },
                )

            with ThreadPoolExecutor(max_workers=2) as executor:
                responses = list(executor.map(use, (first, second)))
            assert sorted(response.status_code for response in responses) == [200, 409]
            assert next(
                response for response in responses if response.status_code == 409
            ).json()["detail"]["code"] == "claim_place_already_claimed"
    finally:
        cleanup()


def test_recommendation_grant_is_bound_to_the_requesting_session():
    if not os.environ.get("DATABASE_URL"):
        return
    cleanup()
    try:
        with TestClient(api.app) as client:
            registered = client.post(
                "/api/auth/register",
                json={"email": EMAILS[0], "password": "claims backend password"},
            ).json()
            session_a = registered["token"]
            session_b = client.post(
                "/api/auth/login",
                json={"email": EMAILS[0], "password": "claims backend password"},
            ).json()["token"]
            recommendation = client.post(
                "/api/claim-recommendations",
                headers=bearer(session_a),
                json={"testFixtureId": "inside-goldstream"},
            )
            assert recommendation.status_code == 200, recommendation.text
            recommendation_body = recommendation.json()
            place_id = recommendation_body["candidate"]["placeId"]

            with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
                stored_session_hash, consumed_at = conn.execute(
                    "SELECT session_hash, consumed_at FROM claim_recommendations "
                    "WHERE account_id = %s",
                    (registered["account"]["id"],),
                ).fetchone()
                assert stored_session_hash == hashlib.sha256(
                    session_a.encode("utf-8")
                ).hexdigest()
                assert stored_session_hash != session_a
                assert consumed_at is None

            cross_session = client.post(
                "/api/claims",
                headers=bearer(session_b),
                json={
                    "recommendationToken": recommendation_body[
                        "recommendationToken"
                    ],
                    "expectedPlaceId": place_id,
                },
            )
            assert cross_session.status_code == 404
            assert (
                cross_session.json()["detail"]["code"]
                == "claim_recommendation_not_found"
            )
            with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
                assert conn.execute(
                    "SELECT consumed_at FROM claim_recommendations "
                    "WHERE account_id = %s",
                    (registered["account"]["id"],),
                ).fetchone()[0] is None
                assert conn.execute(
                    "SELECT 1 FROM account_visit_claims "
                    "WHERE account_id = %s AND place_id = %s",
                    (registered["account"]["id"], place_id),
                ).fetchone() is None

            created = client.post(
                "/api/claims",
                headers=bearer(session_a),
                json={
                    "recommendationToken": recommendation_body[
                        "recommendationToken"
                    ],
                    "expectedPlaceId": place_id,
                },
            )
            assert created.status_code == 200, created.text
            replay = client.post(
                "/api/claims",
                headers=bearer(session_a),
                json={
                    "recommendationToken": recommendation_body[
                        "recommendationToken"
                    ],
                    "expectedPlaceId": place_id,
                },
            )
            assert replay.status_code == 409
            assert replay.json()["detail"]["code"] == "claim_recommendation_replayed"
    finally:
        cleanup()


def test_claim_fixture_runtime_guard_rejects_any_railway_environment(monkeypatch):
    if not os.environ.get("DATABASE_URL"):
        return
    cleanup()
    try:
        with TestClient(api.app) as client:
            registered = client.post(
                "/api/auth/register",
                json={"email": EMAILS[0], "password": "claims backend password"},
            ).json()
            monkeypatch.setattr(api.settings, "railway_environment_name", "pr-42")
            response = client.post(
                "/api/claim-recommendations",
                headers=bearer(registered["token"]),
                json={"testFixtureId": "inside-goldstream"},
            )
            assert response.status_code == 403
            assert response.json()["detail"]["code"] == "claim_test_mode_disabled"
    finally:
        cleanup()


def test_logout_serializes_with_claim_mutation_and_wins_before_return(
    monkeypatch,
):
    if not os.environ.get("DATABASE_URL"):
        return
    cleanup()
    try:
        with TestClient(api.app) as client:
            account = client.post(
                "/api/auth/register",
                json={"email": EMAILS[0], "password": "claims backend password"},
            ).json()
            headers = bearer(account["token"])
            recommendation = client.post(
                "/api/claim-recommendations",
                headers=headers,
                json={"testFixtureId": "inside-goldstream"},
            ).json()

            original_lock = api.lock_account_progress
            first_waiter = Event()
            second_waiter = Event()
            call_guard = Lock()
            call_count = 0

            def instrumented_lock(conn, account_id):
                nonlocal call_count
                with call_guard:
                    call_count += 1
                    current_call = call_count
                (first_waiter if current_call == 1 else second_waiter).set()
                return original_lock(conn, account_id)

            monkeypatch.setattr(api, "lock_account_progress", instrumented_lock)
            with psycopg.connect(os.environ["DATABASE_URL"]) as lock_conn:
                lock_conn.execute(
                    "SELECT id FROM accounts WHERE id = %s FOR UPDATE",
                    (account["account"]["id"],),
                )
                with ThreadPoolExecutor(max_workers=2) as executor:
                    logout_future = executor.submit(
                        client.post, "/api/auth/logout", headers=headers
                    )
                    if not first_waiter.wait(timeout=10):
                        lock_conn.rollback()
                        raise AssertionError("logout did not request the account lock")
                    claim_future = executor.submit(
                        client.post,
                        "/api/claims",
                        headers=headers,
                        json={
                            "recommendationToken": recommendation[
                                "recommendationToken"
                            ],
                            "expectedPlaceId": recommendation["candidate"][
                                "placeId"
                            ],
                        },
                    )
                    if not second_waiter.wait(timeout=10):
                        lock_conn.rollback()
                        raise AssertionError("claim did not request the account lock")
                    assert not logout_future.done()
                    assert not claim_future.done()
                    lock_conn.commit()
                    logout = logout_future.result(timeout=10)
                    claim = claim_future.result(timeout=10)

            assert logout.status_code == 204
            assert claim.status_code == 401
            with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
                assert conn.execute(
                    "SELECT 1 FROM account_visit_claims WHERE account_id = %s",
                    (account["account"]["id"],),
                ).fetchone() is None
    finally:
        cleanup()


def test_claim_recommendations_are_rate_limited_before_geometry(monkeypatch):
    if not os.environ.get("DATABASE_URL"):
        return
    cleanup()
    monkeypatch.setattr(api, "CLAIM_RECOMMENDATION_ACCOUNT_LIMIT", 1)
    try:
        with TestClient(api.app) as client:
            account = client.post(
                "/api/auth/register",
                json={"email": EMAILS[0], "password": "claims backend password"},
            )
            headers = bearer(account.json()["token"])
            first = client.post(
                "/api/claim-recommendations",
                headers=headers,
                json={"testFixtureId": "inside-goldstream"},
            )
            assert first.status_code == 200
            limited = client.post(
                "/api/claim-recommendations",
                headers=headers,
                json={"testFixtureId": "inside-goldstream"},
            )
            assert limited.status_code == 429
    finally:
        cleanup()


def test_photo_delete_commits_metadata_and_retries_provider_failure():
    if not os.environ.get("DATABASE_URL"):
        return

    class RecoveringStorage(MemoryObjectStorage):
        fail_deletes = True

        def delete(self, key: str) -> None:
            if self.fail_deletes:
                raise ObjectStorageError("provider unavailable")
            super().delete(key)

    cleanup()
    storage = RecoveringStorage()
    api.set_photo_storage(storage)
    try:
        with TestClient(api.app) as client:
            account = client.post(
                "/api/auth/register",
                json={"email": EMAILS[0], "password": "claims backend password"},
            ).json()
            headers = bearer(account["token"])
            _, created = fixture_claim(client, headers)
            place_id = created["placeId"]
            uploaded = client.put(
                f"/api/visits/{place_id}/photo",
                headers=headers,
                files={"photo": ("visit.png", photo_bytes(), "image/png")},
            )
            assert uploaded.status_code == 200, uploaded.text
            with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
                object_key = conn.execute(
                    "SELECT photo_object_key FROM account_visit_claims "
                    "WHERE account_id = %s AND place_id = %s",
                    (account["account"]["id"], place_id),
                ).fetchone()[0]

            deleted = client.delete(
                f"/api/visits/{place_id}/photo", headers=headers
            )
            assert deleted.status_code == 204
            with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
                assert conn.execute(
                    "SELECT photo_object_key FROM account_visit_claims "
                    "WHERE account_id = %s AND place_id = %s",
                    (account["account"]["id"], place_id),
                ).fetchone()[0] is None
                queued = conn.execute(
                    "SELECT attempt_count, next_attempt_at FROM photo_object_deletions "
                    "WHERE object_key = %s",
                    (object_key,),
                ).fetchone()
                assert queued is not None
                attempt_count, next_attempt_at = queued
                assert attempt_count == 1
                assert next_attempt_at > datetime.now(timezone.utc)
            assert storage.get(object_key)

            # The request tries the targeted object immediately and durably
            # backs it off. The one-shot retry job cannot select it again yet.
            assert api.process_photo_deletion_outbox() == 0
            with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
                attempt_count, next_attempt_at = conn.execute(
                    "SELECT attempt_count, next_attempt_at "
                    "FROM photo_object_deletions WHERE object_key = %s",
                    (object_key,),
                ).fetchone()
                assert attempt_count == 1
                assert next_attempt_at > datetime.now(timezone.utc)

            storage.fail_deletes = False
            # A failed oldest row is not immediately selected again; once due,
            # its idempotent delete succeeds and removes the tombstone.
            assert api.process_photo_deletion_outbox() == 0
            with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
                conn.execute(
                    "UPDATE photo_object_deletions SET next_attempt_at = NOW() "
                    "WHERE object_key = %s",
                    (object_key,),
                )
                conn.commit()
            assert api.process_photo_deletion_outbox() >= 1
            with pytest.raises(ObjectStorageNotFound):
                storage.get(object_key)
            with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
                assert conn.execute(
                    "SELECT 1 FROM photo_object_deletions WHERE object_key = %s",
                    (object_key,),
                ).fetchone() is None
    finally:
        storage.fail_deletes = False
        api.process_photo_deletion_outbox()
        api.set_photo_storage(None)
        cleanup()


def test_photo_get_releases_single_pool_connection_before_object_read_and_delete():
    if not os.environ.get("DATABASE_URL"):
        return

    read_started = Event()
    release_read = Event()

    class BlockingReadStorage(MemoryObjectStorage):
        block_reads = False

        def get(self, key: str) -> bytes:
            if self.block_reads:
                read_started.set()
                if not release_read.wait(timeout=10):
                    raise AssertionError("test did not release the blocked object read")
            return super().get(key)

    cleanup()
    storage = BlockingReadStorage()
    api.set_photo_storage(storage)
    pool = ConnectionPool(
        conninfo=os.environ["DATABASE_URL"],
        kwargs={"row_factory": dict_row},
        min_size=1,
        max_size=1,
        timeout=1,
        open=False,
    )
    pool.open()
    pool.wait()
    assert db._pool is None
    db._pool = pool
    try:
        with TestClient(api.app) as client:
            registered = client.post(
                "/api/auth/register",
                json={"email": EMAILS[0], "password": "claims backend password"},
            ).json()
            headers = bearer(registered["token"])
            _, created = fixture_claim(client, headers)
            place_id = created["placeId"]
            uploaded = client.put(
                f"/api/visits/{place_id}/photo",
                headers=headers,
                files={"photo": ("visit.png", photo_bytes(), "image/png")},
            )
            assert uploaded.status_code == 200, uploaded.text
            with pool.connection() as conn:
                object_key = conn.execute(
                    "SELECT photo_object_key FROM account_visit_claims "
                    "WHERE account_id = %s AND place_id = %s",
                    (registered["account"]["id"], place_id),
                ).fetchone()["photo_object_key"]

            storage.block_reads = True
            with ThreadPoolExecutor(max_workers=1) as executor:
                get_future = executor.submit(
                    client.get, f"/api/visits/{place_id}/photo", headers=headers
                )
                assert read_started.wait(timeout=10), "object read did not start"
                # The blocked provider call must not pin the pool's sole
                # connection; unrelated readiness DB work can still complete.
                ready = client.get("/ready")
                assert ready.status_code == 200, ready.text
                release_read.set()
                downloaded = get_future.result(timeout=10)
            assert downloaded.status_code == 200

            # DELETE must use the same single connection for authentication,
            # revalidation, metadata removal, and durable outbox enqueueing.
            deleted = client.delete(
                f"/api/visits/{place_id}/photo", headers=headers
            )
            assert deleted.status_code == 204, deleted.text
            with pool.connection() as conn:
                photo_key = conn.execute(
                    "SELECT photo_object_key FROM account_visit_claims "
                    "WHERE account_id = %s AND place_id = %s",
                    (registered["account"]["id"], place_id),
                ).fetchone()["photo_object_key"]
                queued = conn.execute(
                    "SELECT COUNT(*) AS count FROM photo_object_deletions "
                    "WHERE account_id = %s",
                    (registered["account"]["id"],),
                ).fetchone()["count"]
            assert photo_key is None
            assert queued == 0
            with pytest.raises(ObjectStorageNotFound):
                storage.get(object_key)
    finally:
        release_read.set()
        pool.close()
        if db._pool is pool:
            db._pool = None
        api.set_photo_storage(None)
        cleanup()

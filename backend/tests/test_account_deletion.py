from datetime import datetime, timedelta, timezone
import hashlib
from io import BytesIO
import os
from uuid import UUID, uuid4

import psycopg
import pytest
from fastapi.testclient import TestClient
from PIL import Image
from psycopg.rows import dict_row

import backend.app.main as api
from backend.app.account_deletion import account_deletion_receipt_hash
from backend.app.auth import login_scope, sha256_hex
from backend.app.object_storage import MemoryObjectStorage, ObjectStorageError, ObjectStorageNotFound


PLACE_ID = "provincial-goldstream-park"
PASSWORD = "account deletion test password"
TEST_EMAIL_PREFIX = "account-delete-test-"


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def database():
    return psycopg.connect(os.environ["DATABASE_URL"], row_factory=dict_row)


def new_email() -> str:
    return f"{TEST_EMAIL_PREFIX}{uuid4().hex}@example.com"


def register(client: TestClient, email: str) -> dict:
    response = client.post(
        "/api/auth/register",
        json={"email": email, "password": PASSWORD},
    )
    assert response.status_code == 201, response.text
    return response.json()


def photo_bytes() -> bytes:
    output = BytesIO()
    Image.new("RGB", (8, 8), "forestgreen").save(output, format="JPEG")
    return output.getvalue()


def seed_owned_rows(account_id: str, email: str, photo_key: str) -> dict[str, str]:
    subject = f"account-delete-subject-{uuid4().hex}"
    client_id = str(uuid4())
    recommendation_hash = "a" * 64
    boundary_version = "b" * 64
    action_token_hash = "c" * 64
    extra_session_hash = "d" * 64
    code_hash = "e" * 64
    mcp_token_hash = "f" * 64
    login_hash = login_scope(email)
    email_hash = sha256_hex(email)
    account_hash = sha256_hex(account_id)
    rate_action = f"account_delete_test_{uuid4().hex}"
    security_event = f"account_delete_test_{uuid4().hex}"
    global_rate_action = f"account_delete_global_{uuid4().hex}"

    with database() as conn:
        conn.execute(
            "INSERT INTO account_visits (account_id, place_id) VALUES (%s, %s)",
            (account_id, PLACE_ID),
        )
        conn.execute(
            """
            INSERT INTO offline_claim_grants (
                token_hash, account_id, boundary_version, issued_at, expires_at
            ) VALUES (%s, %s, %s, NOW(), NOW() + INTERVAL '30 days')
            """,
            ("8" * 64, account_id, boundary_version),
        )
        conn.execute(
            """
            INSERT INTO offline_claim_requests (
                account_id, request_id, request_fingerprint, confirmation
            ) VALUES (%s, %s, %s, '{}'::jsonb)
            """,
            (account_id, uuid4(), "9" * 64),
        )
        conn.execute(
            """
            INSERT INTO offline_claim_undo_tombstones (
                account_id, place_id, undone_at
            ) VALUES (%s, %s, NOW())
            """,
            (account_id, PLACE_ID),
        )
        conn.execute(
            """
            INSERT INTO account_visit_claims (
                account_id, place_id, recommendation_hash, captured_at,
                latitude, longitude, accuracy_m, boundary_version, match_kind,
                distance_m, photo_object_key, photo_mime, photo_width,
                photo_height, photo_byte_length, photo_sha256, photo_updated_at
            ) VALUES (
                %s, %s, %s, NOW(), 48.5001, -123.5001, 10, %s, 'exact', 0,
                %s, 'image/jpeg', 4, 4, 4, %s, NOW()
            )
            """,
            (
                account_id,
                PLACE_ID,
                recommendation_hash,
                boundary_version,
                photo_key,
                "0" * 64,
            ),
        )
        conn.execute(
            """
            INSERT INTO account_groups (account_id, name, is_wishlist)
            VALUES (%s, 'Delete test collection', FALSE)
            """,
            (account_id,),
        )
        conn.execute(
            """
            INSERT INTO account_action_tokens
                (token_hash, account_id, purpose, expires_at)
            VALUES (%s, %s, 'password_reset', NOW() + INTERVAL '1 hour')
            """,
            (action_token_hash, account_id),
        )
        conn.execute(
            """
            INSERT INTO account_sessions
                (token_hash, account_id, expires_at)
            VALUES (%s, %s, NOW() + INTERVAL '1 hour')
            """,
            (extra_session_hash, account_id),
        )
        conn.execute(
            """
            INSERT INTO account_oauth_identities
                (provider, subject, account_id, email_at_link)
            VALUES ('google', %s, %s, %s)
            """,
            (subject, account_id, email),
        )
        conn.execute(
            "INSERT INTO mcp_oauth_clients (client_id, metadata) VALUES (%s, %s)",
            (client_id, "{}"),
        )
        conn.execute(
            """
            INSERT INTO mcp_oauth_authorization_codes (
                code_hash, client_id, account_id, redirect_uri,
                redirect_uri_provided_explicitly, scopes, code_challenge,
                resource, expires_at
            ) VALUES (%s, %s, %s, 'https://example.com/callback', TRUE,
                      ARRAY['visits'], %s, 'https://parkdex.example/mcp',
                      NOW() + INTERVAL '1 hour')
            """,
            (code_hash, client_id, account_id, "g" * 43),
        )
        conn.execute(
            """
            INSERT INTO mcp_oauth_tokens (
                token_hash, token_kind, grant_id, family_id, client_id,
                account_id, scopes, resource, expires_at
            ) VALUES (%s, 'access', %s, %s, %s, %s, ARRAY['visits'],
                      'https://parkdex.example/mcp', NOW() + INTERVAL '1 hour')
            """,
            (mcp_token_hash, str(uuid4()), str(uuid4()), client_id, account_id),
        )
        conn.execute(
            """
            INSERT INTO claim_recommendations (
                token_hash, account_id, place_id, captured_at, latitude,
                longitude, accuracy_m, boundary_version, match_kind,
                distance_m, expires_at
            ) VALUES (%s, %s, %s, NOW(), 48.5001, -123.5001, 10, %s,
                      'exact', 0, NOW() + INTERVAL '60 seconds')
            """,
            ("1" * 64, account_id, PLACE_ID, boundary_version),
        )
        conn.execute(
            """
            INSERT INTO auth_login_attempts
                (scope_hash, failure_count, window_started_at)
            VALUES (%s, 1, NOW())
            ON CONFLICT (scope_hash) DO UPDATE SET failure_count = 1
            """,
            (login_hash,),
        )
        conn.execute(
            """
            INSERT INTO auth_rate_limits
                (action, scope_hash, attempt_count, window_started_at)
            VALUES (%s, %s, 1, NOW()), (%s, %s, 1, NOW())
            ON CONFLICT (action, scope_hash) DO UPDATE SET attempt_count = 1
            """,
            (rate_action, email_hash, rate_action, account_hash),
        )
        conn.execute(
            """
            INSERT INTO auth_security_events (event_type, scope_hash, outcome)
            VALUES (%s, %s, 'failure'), (%s, %s, 'failure')
            """,
            (security_event, email_hash, security_event, account_hash),
        )
        conn.execute(
            """
            INSERT INTO auth_rate_limits
                (action, scope_hash, attempt_count, window_started_at)
            VALUES (%s, %s, 1, NOW())
            """,
            (global_rate_action, sha256_hex("global")),
        )
        conn.commit()

    return {
        "subject": subject,
        "client_id": client_id,
        "rate_action": rate_action,
        "security_event": security_event,
        "global_rate_action": global_rate_action,
    }


def cleanup(email: str, photo_key: str, request_hashes: list[str], metadata: dict[str, str] | None = None) -> None:
    with database() as conn:
        conn.execute(
            "DELETE FROM photo_object_deletions WHERE object_key = %s",
            (photo_key,),
        )
        if request_hashes:
            conn.execute(
                "DELETE FROM account_deletion_receipts WHERE request_hash = ANY(%s)",
                (request_hashes,),
            )
        conn.execute("DELETE FROM accounts WHERE email = %s", (email,))
        if metadata:
            conn.execute(
                "DELETE FROM auth_rate_limits WHERE action = ANY(%s)",
                ([metadata["rate_action"], metadata["global_rate_action"]],),
            )
            conn.execute(
                "DELETE FROM auth_security_events WHERE event_type = %s",
                (metadata["security_event"],),
            )
        conn.commit()


def test_account_delete_removes_owned_rows_preserves_other_account_and_retries_exact_receipt():
    if not os.environ.get("DATABASE_URL"):
        pytest.skip("DATABASE_URL is required for account deletion integration tests")
    email = new_email()
    other_email = new_email()
    photo_key = f"postcards/account-delete-{uuid4().hex}.jpg"
    request_id = uuid4()
    request_hashes: list[str] = []
    storage = MemoryObjectStorage()
    storage.put(photo_key, b"jpeg", "image/jpeg")
    api.set_photo_storage(storage)
    try:
        with TestClient(api.app) as client:
            account = register(client, email)
            other = register(client, other_email)
            metadata = seed_owned_rows(account["account"]["id"], email, photo_key)
            headers = bearer(account["token"])
            request_hashes.append(account_deletion_receipt_hash(headers["Authorization"], request_id))

            deleted = client.request(
                "DELETE",
                "/api/account",
                headers=headers,
                json={"confirm": "DELETE_ACCOUNT", "requestId": str(request_id)},
            )
            assert deleted.status_code == 200, deleted.text
            assert deleted.json() == {"deleted": True, "photoCleanupPending": False}
            with pytest.raises(ObjectStorageNotFound):
                storage.get(photo_key)

            retry = client.request(
                "DELETE",
                "/api/account",
                headers=headers,
                json={"confirm": "DELETE_ACCOUNT", "requestId": str(request_id)},
            )
            assert retry.status_code == 200
            assert retry.json() == {"deleted": True, "photoCleanupPending": False}

            wrong_bearer = client.request(
                "DELETE",
                "/api/account",
                headers=bearer("x" * 43),
                json={"confirm": "DELETE_ACCOUNT", "requestId": str(request_id)},
            )
            assert wrong_bearer.status_code == 401

            still_live = client.get("/api/auth/me", headers=bearer(other["token"]))
            assert still_live.status_code == 200, still_live.text
            with database() as conn:
                assert conn.execute(
                    "SELECT 1 FROM accounts WHERE id = %s", (account["account"]["id"],)
                ).fetchone() is None
                for table in (
                    "account_sessions",
                    "offline_claim_grants",
                    "offline_claim_requests",
                    "offline_claim_undo_tombstones",
                    "account_visits",
                    "account_visit_claims",
                    "account_groups",
                    "account_action_tokens",
                    "account_oauth_identities",
                    "mcp_oauth_authorization_codes",
                    "mcp_oauth_tokens",
                    "claim_recommendations",
                ):
                    assert conn.execute(
                        f"SELECT 1 FROM {table} WHERE account_id = %s LIMIT 1",
                        (account["account"]["id"],),
                    ).fetchone() is None, table
                assert conn.execute(
                    "SELECT 1 FROM mcp_oauth_clients WHERE client_id = %s",
                    (metadata["client_id"],),
                ).fetchone() is not None
                assert conn.execute(
                    "SELECT 1 FROM auth_login_attempts WHERE scope_hash = %s",
                    (login_scope(email),),
                ).fetchone() is None
                assert conn.execute(
                    "SELECT 1 FROM auth_rate_limits WHERE action = %s",
                    (metadata["rate_action"],),
                ).fetchone() is None
                assert conn.execute(
                    "SELECT 1 FROM auth_security_events WHERE event_type = %s",
                    (metadata["security_event"],),
                ).fetchone() is None
                assert conn.execute(
                    "SELECT 1 FROM auth_rate_limits WHERE action = %s",
                    (metadata["global_rate_action"],),
                ).fetchone() is not None
    finally:
        api.set_photo_storage(None)
        cleanup(email, photo_key, request_hashes, locals().get("metadata"))
        cleanup(other_email, "postcards/nonexistent-account-delete.jpg", [], None)


def test_account_delete_keeps_photo_intent_for_manual_cleanup_and_updates_retry_status():
    if not os.environ.get("DATABASE_URL"):
        pytest.skip("DATABASE_URL is required for account deletion integration tests")
    email = new_email()
    photo_key = f"postcards/account-delete-failure-{uuid4().hex}.jpg"
    request_id = uuid4()
    request_hashes: list[str] = []

    class FailingStorage(MemoryObjectStorage):
        fail_deletes = True

        def delete(self, key: str) -> None:
            if self.fail_deletes:
                raise ObjectStorageError("provider unavailable")
            super().delete(key)

    storage = FailingStorage()
    storage.put(photo_key, b"jpeg", "image/jpeg")
    api.set_photo_storage(storage)
    try:
        with TestClient(api.app) as client:
            account = register(client, email)
            seed_owned_rows(account["account"]["id"], email, photo_key)
            headers = bearer(account["token"])
            request_hashes.append(account_deletion_receipt_hash(headers["Authorization"], request_id))
            deleted = client.request(
                "DELETE",
                "/api/account",
                headers=headers,
                json={"confirm": "DELETE_ACCOUNT", "requestId": str(request_id)},
            )
            assert deleted.status_code == 200, deleted.text
            assert deleted.json() == {"deleted": True, "photoCleanupPending": True}
            with database() as conn:
                queued = conn.execute(
                    """
                    SELECT account_id, account_deletion_request_hash
                    FROM photo_object_deletions WHERE object_key = %s
                    """,
                    (photo_key,),
                ).fetchone()
                assert queued["account_id"] is None
                assert queued["account_deletion_request_hash"] == request_hashes[0]
                conn.execute(
                    "UPDATE photo_object_deletions SET next_attempt_at = NOW() WHERE object_key = %s",
                    (photo_key,),
                )
                conn.commit()

            storage.fail_deletes = False
            assert api.process_photo_deletion_outbox(limit=1) == 1
            retry = client.request(
                "DELETE",
                "/api/account",
                headers=headers,
                json={"confirm": "DELETE_ACCOUNT", "requestId": str(request_id)},
            )
            assert retry.status_code == 200
            assert retry.json() == {"deleted": True, "photoCleanupPending": False}
            with pytest.raises(ObjectStorageNotFound):
                storage.get(photo_key)
    finally:
        storage.fail_deletes = False
        api.set_photo_storage(None)
        cleanup(email, photo_key, request_hashes)


def test_account_delete_requires_confirmation_and_rejects_expired_receipt():
    if not os.environ.get("DATABASE_URL"):
        pytest.skip("DATABASE_URL is required for account deletion integration tests")
    email = new_email()
    photo_key = f"postcards/account-delete-validation-{uuid4().hex}.jpg"
    request_id = uuid4()
    request_hashes: list[str] = []
    try:
        with TestClient(api.app) as client:
            account = register(client, email)
            headers = bearer(account["token"])
            invalid_confirmation = client.request(
                "DELETE",
                "/api/account",
                headers=headers,
                json={"confirm": "DELETE", "requestId": str(request_id)},
            )
            assert invalid_confirmation.status_code == 422
            missing_auth = client.request(
                "DELETE",
                "/api/account",
                json={"confirm": "DELETE_ACCOUNT", "requestId": str(request_id)},
            )
            assert missing_auth.status_code == 401

            deleted = client.request(
                "DELETE",
                "/api/account",
                headers=headers,
                json={"confirm": "DELETE_ACCOUNT", "requestId": str(request_id)},
            )
            assert deleted.status_code == 200, deleted.text
            request_hash = account_deletion_receipt_hash(headers["Authorization"], request_id)
            request_hashes.append(request_hash)
            with database() as conn:
                conn.execute(
                    """
                    UPDATE account_deletion_receipts
                    SET created_at = NOW() - INTERVAL '2 seconds',
                        expires_at = NOW() - INTERVAL '1 second'
                    WHERE request_hash = %s
                    """,
                    (request_hash,),
                )
                conn.commit()
            expired = client.request(
                "DELETE",
                "/api/account",
                headers=headers,
                json={"confirm": "DELETE_ACCOUNT", "requestId": str(request_id)},
            )
            assert expired.status_code == 401
    finally:
        api.set_photo_storage(None)
        cleanup(email, photo_key, request_hashes)


def test_upload_race_after_account_delete_keeps_orphan_cleanup_durable():
    if not os.environ.get("DATABASE_URL"):
        pytest.skip("DATABASE_URL is required for account deletion integration tests")
    email = new_email()
    photo_key = f"postcards/account-delete-upload-race-{uuid4().hex}.jpg"
    request_id = uuid4()
    request_hashes: list[str] = []
    storage_ready = {"client": None, "triggered": False, "request": None}

    class RaceStorage(MemoryObjectStorage):
        fail_deletes = True

        def put(self, key: str, content: bytes, content_type: str) -> None:
            super().put(key, content, content_type)
            if not storage_ready["triggered"]:
                storage_ready["triggered"] = True
                nested = storage_ready["client"].request(
                    "DELETE",
                    "/api/account",
                    headers=bearer(account["token"]),
                    json={"confirm": "DELETE_ACCOUNT", "requestId": str(request_id)},
                )
                storage_ready["request"] = nested

        def delete(self, key: str) -> None:
            if self.fail_deletes:
                raise ObjectStorageError("provider unavailable")
            super().delete(key)

    storage = RaceStorage()
    api.set_photo_storage(storage)
    try:
        with TestClient(api.app) as client:
            storage_ready["client"] = client
            account = register(client, email)
            seed_owned_rows(account["account"]["id"], email, photo_key)
            with database() as conn:
                conn.execute(
                    """
                    UPDATE account_visit_claims
                    SET photo_object_key = NULL, photo_mime = NULL,
                        photo_width = NULL, photo_height = NULL,
                        photo_byte_length = NULL, photo_sha256 = NULL,
                        photo_updated_at = NULL
                    WHERE account_id = %s
                    """,
                    (account["account"]["id"],),
                )
                conn.commit()
            request_hashes.append(
                account_deletion_receipt_hash(
                    bearer(account["token"])["Authorization"], request_id
                )
            )

            uploaded = client.put(
                f"/api/visits/{PLACE_ID}/photo",
                headers=bearer(account["token"]),
                files={"photo": ("visit.jpg", photo_bytes(), "image/jpeg")},
            )
            assert uploaded.status_code == 401, uploaded.text
            assert storage_ready["request"].status_code == 200
            assert storage_ready["request"].json() == {
                "deleted": True,
                "photoCleanupPending": False,
            }
            object_key = next(iter(storage.objects))
            with database() as conn:
                queued = conn.execute(
                    """
                    SELECT account_id, attempt_count
                    FROM photo_object_deletions WHERE object_key = %s
                    """,
                    (object_key,),
                ).fetchone()
                assert queued["account_id"] is None
                assert queued["attempt_count"] == 1
                conn.execute(
                    "UPDATE photo_object_deletions SET next_attempt_at = NOW() WHERE object_key = %s",
                    (object_key,),
                )
                conn.commit()

            storage.fail_deletes = False
            assert api.process_photo_deletion_outbox(limit=1) == 1
            with pytest.raises(ObjectStorageNotFound):
                storage.get(object_key)
    finally:
        storage.fail_deletes = False
        api.set_photo_storage(None)
        cleanup(email, photo_key, request_hashes)


def test_account_deletion_receipt_hash_never_accepts_malformed_bearer():
    request_id = UUID("00000000-0000-0000-0000-000000000001")
    assert account_deletion_receipt_hash(None, request_id) is None
    assert account_deletion_receipt_hash("Basic credentials", request_id) is None
    assert account_deletion_receipt_hash("Bearer short", request_id) is None
    assert account_deletion_receipt_hash(
        f"Bearer {'x' * 43}", request_id
    ) != account_deletion_receipt_hash(f"Bearer {'y' * 43}", request_id)

import hashlib
import os
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import parse_qs, urlparse
from uuid import uuid4

import httpx
import psycopg
from fastapi.testclient import TestClient
from google.auth.exceptions import GoogleAuthError

import backend.app.main as api
from backend.app.auth import pkce_challenge


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def clean(email: str) -> None:
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        conn.execute("DELETE FROM accounts WHERE email IN (%s, %s)", (email, email.replace("@gmail.com", "@googlemail.com")))
        conn.execute("DELETE FROM auth_rate_limits")
        conn.commit()


def enable_fake_email(monkeypatch, sent: list[tuple[str, str, str]]) -> None:
    monkeypatch.setattr(api.settings, "smtp_host", "smtp.test")
    monkeypatch.setattr(api, "send_auth_email", lambda settings, recipient, subject, text: sent.append((recipient, subject, text)))


def enable_fake_google(monkeypatch) -> None:
    monkeypatch.setattr(api.settings, "google_client_id", "client-id")
    monkeypatch.setattr(api.settings, "google_client_secret", "client-secret")
    monkeypatch.setattr(api.settings, "google_redirect_uri", "http://localhost:3000/auth/google/callback")


def start_google(client: TestClient, verifier: str = "v" * 43) -> tuple[str, str]:
    started = client.get("/api/auth/google/start", params={"codeChallenge": pkce_challenge(verifier)})
    assert started.status_code == 200
    query = parse_qs(urlparse(started.json()["authorizationUrl"]).query)
    return query["state"][0], query["nonce"][0]


def token_from_message(message: str, parameter: str) -> str:
    return parse_qs(urlparse(message.split()[-1]).fragment)[parameter][0]


def test_password_reset_is_generic_expiring_single_use_and_revokes_sessions(monkeypatch) -> None:
    email = "secure-reset@example.com"
    unknown = "unknown-reset@example.com"
    sent: list[tuple[str, str, str]] = []
    clean(email)
    enable_fake_email(monkeypatch, sent)
    try:
        with TestClient(api.app) as client:
            created = client.post("/api/auth/register", json={"email": email, "password": "old password value"}).json()
            registered = client.post("/register", json={
                "client_name": "Recovery test", "redirect_uris": ["http://127.0.0.1:17778/callback"],
                "token_endpoint_auth_method": "none", "grant_types": ["authorization_code", "refresh_token"],
                "response_types": ["code"], "scope": "mcp",
            })
            assert registered.status_code == 201
            client_id = registered.json()["client_id"]
            mcp_grant = str(uuid4())
            authorization_code = "pre-reset-authorization-code"
            verifier = "v" * 64
            with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
                conn.execute("INSERT INTO mcp_oauth_tokens (token_hash, token_kind, grant_id, family_id, client_id, account_id, scopes, resource, expires_at) SELECT %s, 'access', %s, %s, %s, id, ARRAY['mcp'], 'http://localhost:8000/mcp', NOW() + INTERVAL '1 hour' FROM accounts WHERE email = %s", (hashlib.sha256(b"reset-mcp-token").hexdigest(), mcp_grant, mcp_grant, client_id, email))
                conn.execute("INSERT INTO mcp_oauth_tokens (token_hash, token_kind, grant_id, family_id, client_id, account_id, scopes, resource, expires_at) SELECT %s, 'refresh', %s, %s, %s, id, ARRAY['mcp'], 'http://localhost:8000/mcp', NOW() + INTERVAL '30 days' FROM accounts WHERE email = %s", (hashlib.sha256(b"reset-mcp-refresh").hexdigest(), mcp_grant, mcp_grant, client_id, email))
                conn.execute(
                    """INSERT INTO mcp_oauth_authorization_codes
                       (code_hash, client_id, account_id, redirect_uri, redirect_uri_provided_explicitly, scopes, code_challenge, resource, expires_at)
                       SELECT %s, %s, id, 'http://127.0.0.1:17778/callback', TRUE, ARRAY['mcp'], %s, 'http://localhost:8000/mcp', NOW() + INTERVAL '5 minutes'
                       FROM accounts WHERE email = %s""",
                    (hashlib.sha256(authorization_code.encode()).hexdigest(), client_id, pkce_challenge(verifier), email),
                )
                conn.commit()
            known = client.post("/api/auth/password-reset/request", json={"email": email})
            missing = client.post("/api/auth/password-reset/request", json={"email": unknown})
            assert known.status_code == missing.status_code == 202
            assert known.json() == missing.json()
            assert len(sent) == 2  # registration verification plus the known account reset
            reset_token = token_from_message(sent[1][2].splitlines()[0], "resetToken")
            expired_token = "e" * 43
            with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
                conn.execute("INSERT INTO account_action_tokens (token_hash, account_id, purpose, created_at, expires_at) SELECT %s, id, 'password_reset', NOW() - INTERVAL '2 hours', NOW() - INTERVAL '1 hour' FROM accounts WHERE email = %s", (hashlib.sha256(expired_token.encode()).hexdigest(), email))
                conn.commit()
            assert client.post("/api/auth/password-reset/confirm", json={"token": expired_token, "newPassword": "new password value"}).status_code == 400
            assert client.post("/api/auth/password-reset/confirm", json={"token": reset_token, "newPassword": "new password value"}).status_code == 204
            assert client.post("/api/auth/password-reset/confirm", json={"token": reset_token, "newPassword": "another password value"}).status_code == 400
            assert client.get("/api/auth/me", headers=bearer(created["token"])).status_code == 401
            with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
                assert conn.execute("SELECT COUNT(*) FROM mcp_oauth_tokens WHERE grant_id = %s AND revoked_at IS NOT NULL", (mcp_grant,)).fetchone()[0] == 2
            stale_code = client.post("/token", data={
                "grant_type": "authorization_code", "client_id": client_id,
                "code": authorization_code, "code_verifier": verifier,
                "redirect_uri": "http://127.0.0.1:17778/callback", "resource": "http://localhost:8000/mcp",
            })
            assert stale_code.status_code == 400
            assert client.post("/api/auth/login", json={"email": email, "password": "new password value"}).status_code == 200
    finally:
        clean(email)


def test_action_token_can_only_win_one_concurrent_confirmation(monkeypatch) -> None:
    email = "token-race@example.com"
    sent: list[tuple[str, str, str]] = []
    clean(email)
    enable_fake_email(monkeypatch, sent)
    try:
        with TestClient(api.app) as client:
            client.post("/api/auth/register", json={"email": email, "password": "initial password value"})
            client.post("/api/auth/password-reset/request", json={"email": email})
            token = token_from_message(sent[-1][2].splitlines()[0], "resetToken")
            with ThreadPoolExecutor(max_workers=2) as executor:
                statuses = list(executor.map(lambda _: client.post("/api/auth/password-reset/confirm", json={"token": token, "newPassword": "concurrent password value"}).status_code, range(2)))
            assert sorted(statuses) == [204, 400]
    finally:
        clean(email)


def test_registration_limit_is_atomic_and_observable() -> None:
    email = "registration-limit@example.com"
    clean(email)
    try:
        with TestClient(api.app) as client:
            statuses = [client.post("/api/auth/register", json={"email": email, "password": "registration password"}).status_code for _ in range(6)]
            assert statuses == [201, 409, 409, 409, 409, 429]
        with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
            assert conn.execute("SELECT 1 FROM auth_security_events WHERE event_type = 'register_rate_limit' AND outcome = 'throttled'").fetchone()
    finally:
        clean(email)


def test_verification_resend_invalidates_old_token_and_change_revokes_all_sessions(monkeypatch) -> None:
    email = "verify-change@example.com"
    sent: list[tuple[str, str, str]] = []
    clean(email)
    enable_fake_email(monkeypatch, sent)
    try:
        with TestClient(api.app) as client:
            first = client.post("/api/auth/register", json={"email": email, "password": "current password value"}).json()
            second = client.post("/api/auth/login", json={"email": email, "password": "current password value"}).json()
            mcp_grant = str(uuid4())
            with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
                account_id = conn.execute("SELECT id FROM accounts WHERE email = %s", (email,)).fetchone()[0]
                client_id = str(uuid4())
                conn.execute("INSERT INTO mcp_oauth_clients (client_id, metadata) VALUES (%s, '{}')", (client_id,))
                conn.execute("INSERT INTO mcp_oauth_tokens (token_hash, token_kind, grant_id, family_id, client_id, account_id, scopes, resource, expires_at) VALUES (%s, 'access', %s, %s, %s, %s, ARRAY['mcp'], 'http://localhost:8000/mcp', NOW() + INTERVAL '1 hour')", (hashlib.sha256(b"change-mcp-token").hexdigest(), mcp_grant, mcp_grant, client_id, account_id))
                conn.execute("INSERT INTO mcp_oauth_tokens (token_hash, token_kind, grant_id, family_id, client_id, account_id, scopes, resource, expires_at) VALUES (%s, 'refresh', %s, %s, %s, %s, ARRAY['mcp'], 'http://localhost:8000/mcp', NOW() + INTERVAL '30 days')", (hashlib.sha256(b"change-mcp-refresh").hexdigest(), mcp_grant, mcp_grant, client_id, account_id))
                conn.commit()
            old_token = token_from_message(sent[-1][2], "verificationToken")
            assert client.post("/api/auth/email-verification/request", headers=bearer(first["token"])).status_code == 202
            new_token = token_from_message(sent[-1][2], "verificationToken")
            assert client.post("/api/auth/email-verification/confirm", json={"token": old_token}).status_code == 400
            assert client.post("/api/auth/email-verification/confirm", json={"token": new_token}).status_code == 204
            assert client.get("/api/auth/me", headers=bearer(first["token"])).json()["account"]["emailVerified"] is True
            assert client.post("/api/auth/password-change", headers=bearer(first["token"]), json={"currentPassword": "wrong", "newPassword": "replacement password"}).status_code == 401
            assert client.post("/api/auth/password-change", headers=bearer(first["token"]), json={"currentPassword": "current password value", "newPassword": "replacement password"}).status_code == 204
            assert client.get("/api/auth/me", headers=bearer(first["token"])).status_code == 401
            assert client.get("/api/auth/me", headers=bearer(second["token"])).status_code == 401
            with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
                assert conn.execute("SELECT COUNT(*) FROM mcp_oauth_tokens WHERE grant_id = %s AND revoked_at IS NOT NULL", (mcp_grant,)).fetchone()[0] == 2
    finally:
        clean(email)


def test_google_only_account_can_set_first_password_and_existing_password_cannot_be_overwritten() -> None:
    email = "google-only-password@example.com"
    clean(email)
    try:
        with TestClient(api.app) as client:
            created = client.post("/api/auth/register", json={"email": email, "password": "temporary password value"}).json()
            with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
                conn.execute("UPDATE accounts SET password_hash = NULL, email_verified_at = NOW() WHERE email = %s", (email,))
                conn.commit()
            assert client.get("/api/auth/me", headers=bearer(created["token"])).json()["account"]["hasPassword"] is False
            assert client.post("/api/auth/password-set", headers=bearer(created["token"]), json={"newPassword": "google account password"}).status_code == 204
            with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
                row = conn.execute("SELECT password_hash FROM accounts WHERE email = %s", (email,)).fetchone()
                assert row[0] and row[0].startswith("$argon2id$")
            logged_in = client.post("/api/auth/login", json={"email": email, "password": "google account password"}).json()
            assert client.post("/api/auth/password-set", headers=bearer(logged_in["token"]), json={"newPassword": "replacement password"}).status_code == 409
    finally:
        clean(email)


def test_google_pkce_state_and_unverified_gmail_linking_prevent_takeover(monkeypatch) -> None:
    email = "oauth-link@gmail.com"
    verifier = "v" * 43
    clean(email)
    monkeypatch.setattr(api.settings, "google_client_id", "client-id")
    monkeypatch.setattr(api.settings, "google_client_secret", "client-secret")
    monkeypatch.setattr(api.settings, "google_redirect_uri", "http://localhost:3000/auth/google/callback")
    try:
        with TestClient(api.app) as client:
            local = client.post("/api/auth/register", json={"email": email, "password": "possibly hostile password"}).json()
            account_id = local["account"]["id"]
            start = client.get("/api/auth/google/start", params={"codeChallenge": pkce_challenge(verifier)})
            query = parse_qs(urlparse(start.json()["authorizationUrl"]).query)
            state, nonce = query["state"][0], query["nonce"][0]
            monkeypatch.setattr(api, "exchange_and_verify", lambda settings, code, code_verifier: {"sub": "google-subject-1", "email": email, "email_verified": True, "nonce": nonce})
            malformed = client.post("/api/auth/google/callback", json={"code": "code", "state": state, "codeVerifier": "é" * 43})
            assert malformed.status_code == 422
            assert client.post("/api/auth/google/callback", json={"code": "code", "state": state, "codeVerifier": "x" * 43}).status_code == 400
            # A failed PKCE check consumes state, so the authorization response cannot be retried or replayed.
            assert client.post("/api/auth/google/callback", json={"code": "code", "state": state, "codeVerifier": verifier}).status_code == 400
            start = client.get("/api/auth/google/start", params={"codeChallenge": pkce_challenge(verifier)})
            query = parse_qs(urlparse(start.json()["authorizationUrl"]).query)
            state, nonce = query["state"][0], query["nonce"][0]
            result = client.post("/api/auth/google/callback", json={"code": "code", "state": state, "codeVerifier": verifier})
            assert result.status_code == 200
            assert result.json()["account"] == {"id": account_id, "email": email, "emailVerified": True, "hasPassword": False}
            assert client.get("/api/auth/me", headers=bearer(local["token"])).status_code == 401
            assert client.post("/api/auth/login", json={"email": email, "password": "possibly hostile password"}).status_code == 401
            with psycopg.connect(os.environ["DATABASE_URL"], row_factory=psycopg.rows.dict_row) as conn:
                row = conn.execute("SELECT password_hash, email_verified_at FROM accounts WHERE id = %s", (account_id,)).fetchone()
                assert row["password_hash"] is None
                assert row["email_verified_at"] is not None
            assert client.post("/api/auth/google/callback", json={"code": "code", "state": state, "codeVerifier": verifier}).status_code == 400
    finally:
        clean(email)


def test_concurrent_google_callbacks_link_once_and_preserve_verified_password(monkeypatch) -> None:
    email = "verified-oauth@gmail.com"
    password = "verified local password"
    verifier = "q" * 43
    clean(email)
    monkeypatch.setattr(api.settings, "google_client_id", "client-id")
    monkeypatch.setattr(api.settings, "google_client_secret", "client-secret")
    monkeypatch.setattr(api.settings, "google_redirect_uri", "http://localhost:3000/auth/google/callback")
    try:
        with TestClient(api.app) as client:
            local = client.post("/api/auth/register", json={"email": email, "password": password}).json()
            with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
                conn.execute("UPDATE accounts SET email_verified_at = NOW() WHERE id = %s", (local["account"]["id"],))
                conn.commit()
            callbacks = []
            nonces = {}
            for code in ("code-one", "code-two"):
                started = client.get("/api/auth/google/start", params={"codeChallenge": pkce_challenge(verifier)}).json()
                query = parse_qs(urlparse(started["authorizationUrl"]).query)
                nonces[code] = query["nonce"][0]
                callbacks.append({"code": code, "state": query["state"][0], "codeVerifier": verifier})
            monkeypatch.setattr(api, "exchange_and_verify", lambda settings, code, code_verifier: {"sub": "same-google-subject", "email": email, "email_verified": True, "nonce": nonces[code]})
            with ThreadPoolExecutor(max_workers=2) as executor:
                responses = list(executor.map(lambda body: client.post("/api/auth/google/callback", json=body), callbacks))
            assert [response.status_code for response in responses] == [200, 200]
            assert {response.json()["account"]["id"] for response in responses} == {local["account"]["id"]}
            assert all(response.json()["account"]["hasPassword"] is True for response in responses)
            assert client.post("/api/auth/login", json={"email": email, "password": password}).status_code == 200
            with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
                assert conn.execute("SELECT COUNT(*) FROM account_oauth_identities WHERE account_id = %s", (local["account"]["id"],)).fetchone()[0] == 1
    finally:
        clean(email)


def test_google_callback_failures_are_controlled_and_observable(monkeypatch) -> None:
    email = "oauth-errors@gmail.com"
    verifier = "v" * 43
    clean(email)
    enable_fake_google(monkeypatch)
    try:
        with TestClient(api.app) as client:
            failures = [
                httpx.ConnectError("provider unavailable"),
                GoogleAuthError("certificate fetch failed"),
                ValueError("invalid ID token"),
            ]
            for failure in failures:
                state, _ = start_google(client, verifier)

                def fail_exchange(settings, code, code_verifier, error=failure):
                    raise error

                monkeypatch.setattr(api, "exchange_and_verify", fail_exchange)
                response = client.post("/api/auth/google/callback", json={"code": "code", "state": state, "codeVerifier": verifier})
                assert response.status_code == 401
                assert response.json() == {"detail": "Google authentication failed"}

            state, nonce = start_google(client, verifier)
            monkeypatch.setattr(api, "exchange_and_verify", lambda settings, code, code_verifier: {"sub": "subject", "email": email, "email_verified": True, "nonce": "wrong-nonce"})
            assert client.post("/api/auth/google/callback", json={"code": "code", "state": state, "codeVerifier": verifier}).status_code == 401

            state, nonce = start_google(client, verifier)
            monkeypatch.setattr(api, "exchange_and_verify", lambda settings, code, code_verifier: {"sub": "subject", "email": email, "email_verified": False, "nonce": nonce})
            assert client.post("/api/auth/google/callback", json={"code": "code", "state": state, "codeVerifier": verifier}).status_code == 401

            state, _ = start_google(client, verifier)
            with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
                conn.execute("UPDATE oauth_authorization_states SET created_at = NOW() - INTERVAL '2 hours', expires_at = NOW() - INTERVAL '1 hour' WHERE state_hash = %s", (hashlib.sha256(state.encode()).hexdigest(),))
                conn.commit()
            expired = client.post("/api/auth/google/callback", json={"code": "code", "state": state, "codeVerifier": verifier})
            assert expired.status_code == 400
            assert client.post("/api/auth/google/callback", json={"code": "code", "state": state, "codeVerifier": verifier}).status_code == 400

        with psycopg.connect(os.environ["DATABASE_URL"], row_factory=psycopg.rows.dict_row) as conn:
            outcomes = [row["outcome"] for row in conn.execute("SELECT outcome FROM auth_security_events WHERE event_type = 'google_callback'").fetchall()]
            assert outcomes.count("token_exchange_failed") >= 3
            assert "invalid_nonce" in outcomes
            assert "unverified_identity" in outcomes
            assert outcomes.count("invalid_state_or_pkce") >= 2
    finally:
        clean(email)


def test_non_gmail_collision_uses_password_sign_in_without_linking(monkeypatch) -> None:
    email = "existing@workspace.example"
    password = "workspace password value"
    clean(email)
    enable_fake_google(monkeypatch)
    try:
        with TestClient(api.app) as client:
            local = client.post("/api/auth/register", json={"email": email, "password": password}).json()
            state, nonce = start_google(client)
            monkeypatch.setattr(api, "exchange_and_verify", lambda settings, code, code_verifier: {"sub": "workspace-subject", "email": email, "email_verified": True, "nonce": nonce})
            response = client.post("/api/auth/google/callback", json={"code": "code", "state": state, "codeVerifier": "v" * 43})
            assert response.status_code == 409
            assert response.json() == {"detail": "An account already uses this email. Sign in with email and password."}
            assert client.get("/api/auth/me", headers=bearer(local["token"])).status_code == 200
            assert client.post("/api/auth/login", json={"email": email, "password": password}).status_code == 200
        with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
            assert conn.execute("SELECT COUNT(*) FROM account_oauth_identities WHERE account_id = %s", (local["account"]["id"],)).fetchone()[0] == 0
            assert conn.execute("SELECT 1 FROM auth_security_events WHERE event_type = 'google_callback' AND outcome = 'non_gmail_collision'").fetchone()
    finally:
        clean(email)


def test_legacy_gmail_alias_collision_does_not_mutate_either_account(monkeypatch) -> None:
    gmail = "legacy-alias@gmail.com"
    googlemail = "legacy-alias@googlemail.com"
    verifier = "v" * 43
    clean(gmail)
    enable_fake_google(monkeypatch)
    first_hash = api.hash_password("first legacy password")
    second_hash = api.hash_password("second legacy password")
    try:
        with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
            conn.execute("INSERT INTO accounts (email, password_hash) VALUES (%s, %s), (%s, %s)", (gmail, first_hash, googlemail, second_hash))
            conn.commit()
        with TestClient(api.app) as client:
            state, nonce = start_google(client, verifier)
            monkeypatch.setattr(api, "exchange_and_verify", lambda settings, code, code_verifier: {"sub": "legacy-subject", "email": gmail, "email_verified": True, "nonce": nonce})
            response = client.post("/api/auth/google/callback", json={"code": "code", "state": state, "codeVerifier": verifier})
            assert response.status_code == 409
        with psycopg.connect(os.environ["DATABASE_URL"], row_factory=psycopg.rows.dict_row) as conn:
            rows = conn.execute("SELECT email, password_hash, email_verified_at FROM accounts WHERE email = ANY(%s) ORDER BY email", ([gmail, googlemail],)).fetchall()
            assert [(row["email"], row["password_hash"], row["email_verified_at"]) for row in rows] == [(gmail, first_hash, None), (googlemail, second_hash, None)]
            assert conn.execute("SELECT COUNT(*) AS count FROM account_oauth_identities WHERE subject = 'legacy-subject'").fetchone()["count"] == 0
            assert conn.execute("SELECT 1 FROM auth_security_events WHERE event_type = 'google_callback' AND outcome = 'multiple_email_matches'").fetchone()
    finally:
        clean(gmail)


def test_google_identity_conflicts_leave_existing_link_and_password_intact(monkeypatch) -> None:
    email = "identity-conflict@gmail.com"
    password = "verified conflict password"
    verifier = "v" * 43
    clean(email)
    enable_fake_google(monkeypatch)
    try:
        with TestClient(api.app) as client:
            local = client.post("/api/auth/register", json={"email": email, "password": password}).json()
            with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
                conn.execute("UPDATE accounts SET email_verified_at = NOW() WHERE id = %s", (local["account"]["id"],))
                conn.execute("INSERT INTO account_oauth_identities (provider, subject, account_id, email_at_link) VALUES ('google', 'original-subject', %s, %s)", (local["account"]["id"], email))
                original_hash = conn.execute("SELECT password_hash FROM accounts WHERE id = %s", (local["account"]["id"],)).fetchone()[0]
                conn.commit()
            state, nonce = start_google(client, verifier)
            monkeypatch.setattr(api, "exchange_and_verify", lambda settings, code, code_verifier: {"sub": "different-subject", "email": email, "email_verified": True, "nonce": nonce})
            response = client.post("/api/auth/google/callback", json={"code": "code", "state": state, "codeVerifier": verifier})
            assert response.status_code == 409
            assert client.get("/api/auth/me", headers=bearer(local["token"])).status_code == 200
        with psycopg.connect(os.environ["DATABASE_URL"], row_factory=psycopg.rows.dict_row) as conn:
            account = conn.execute("SELECT password_hash FROM accounts WHERE id = %s", (local["account"]["id"],)).fetchone()
            identity = conn.execute("SELECT subject FROM account_oauth_identities WHERE account_id = %s", (local["account"]["id"],)).fetchone()
            assert account["password_hash"] == original_hash
            assert identity["subject"] == "original-subject"
            assert conn.execute("SELECT 1 FROM auth_security_events WHERE event_type = 'google_callback' AND outcome = 'account_identity_conflict'").fetchone()
    finally:
        clean(email)


def test_linked_google_subject_rejects_a_different_email(monkeypatch) -> None:
    first_email = "subject-first@gmail.com"
    second_email = "subject-second@gmail.com"
    verifier = "v" * 43
    clean(first_email)
    clean(second_email)
    enable_fake_google(monkeypatch)
    try:
        with TestClient(api.app) as client:
            state, nonce = start_google(client, verifier)
            monkeypatch.setattr(api, "exchange_and_verify", lambda settings, code, code_verifier: {"sub": "stable-subject", "email": first_email, "email_verified": True, "nonce": nonce})
            first = client.post("/api/auth/google/callback", json={"code": "code", "state": state, "codeVerifier": verifier})
            assert first.status_code == 200
            state, nonce = start_google(client, verifier)
            monkeypatch.setattr(api, "exchange_and_verify", lambda settings, code, code_verifier: {"sub": "stable-subject", "email": second_email, "email_verified": True, "nonce": nonce})
            conflict = client.post("/api/auth/google/callback", json={"code": "code", "state": state, "codeVerifier": verifier})
            assert conflict.status_code == 409
        with psycopg.connect(os.environ["DATABASE_URL"], row_factory=psycopg.rows.dict_row) as conn:
            identity = conn.execute("SELECT a.email FROM account_oauth_identities o JOIN accounts a ON a.id = o.account_id WHERE o.subject = 'stable-subject'").fetchone()
            assert identity["email"] == first_email
            assert conn.execute("SELECT 1 FROM auth_security_events WHERE event_type = 'google_callback' AND outcome = 'linked_subject_email_conflict'").fetchone()
    finally:
        clean(first_email)
        clean(second_email)

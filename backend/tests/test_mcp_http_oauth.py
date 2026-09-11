import base64
import hashlib
import json
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4

import psycopg
from fastapi.testclient import TestClient

import backend.app.mcp_oauth as oauth
from backend.app.main import app


EMAIL = "hosted-mcp@example.com"
OTHER_EMAIL = "hosted-mcp-other@example.com"
PASSWORD = "hosted mcp password"


def test_public_oauth_pkce_streamable_http_and_revocation(monkeypatch) -> None:
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        conn.execute("DELETE FROM accounts WHERE email = ANY(%s)", ([EMAIL, OTHER_EMAIL],))
        conn.execute(
            "DELETE FROM auth_rate_limits WHERE action = 'register' AND scope_hash = ANY(%s)",
            ([hashlib.sha256(EMAIL.encode()).hexdigest(), hashlib.sha256(OTHER_EMAIL.encode()).hexdigest()],),
        )
        conn.commit()

    verifier = "v" * 64
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    with TestClient(app, base_url="http://localhost:8000", follow_redirects=False) as client:
        preflight = client.options(
            "/api/groups/example",
            headers={"Origin": "http://localhost:3000", "Access-Control-Request-Method": "PATCH"},
        )
        assert preflight.status_code == 200
        assert "PATCH" in preflight.headers["access-control-allow-methods"]
        assert client.post("/api/auth/register", json={"email": EMAIL, "password": PASSWORD}).status_code == 201

        metadata = client.get("/.well-known/oauth-authorization-server").json()
        assert metadata["issuer"] == "http://localhost:8000/"
        assert metadata["code_challenge_methods_supported"] == ["S256"]
        protected = client.get("/.well-known/oauth-protected-resource/mcp").json()
        assert protected["resource"] == "http://localhost:8000/mcp"

        unauthorized = client.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}})
        assert unauthorized.status_code == 401
        assert "resource_metadata=" in unauthorized.headers["www-authenticate"]

        registered = client.post("/register", json={
            "client_name": "Hosted MCP test",
            "redirect_uris": ["http://127.0.0.1:17777/callback"],
            "token_endpoint_auth_method": "none",
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "scope": "mcp",
        })
        assert registered.status_code == 201
        client_id = registered.json()["client_id"]

        authorization_params = {
            "client_id": client_id, "redirect_uri": "http://127.0.0.1:17777/callback",
            "response_type": "code", "code_challenge": challenge, "code_challenge_method": "S256",
            "scope": "mcp", "state": "state-value", "resource": "http://localhost:8000/mcp",
        }
        wrong_resource = client.get("/authorize", params={**authorization_params, "resource": "https://wrong.example/mcp"})
        assert wrong_resource.status_code == 302
        assert parse_qs(urlsplit(wrong_resource.headers["location"]).query)["error"] == ["invalid_target"]
        wrong_scope = client.get("/authorize", params={**authorization_params, "scope": "other"})
        assert wrong_scope.status_code == 302
        assert parse_qs(urlsplit(wrong_scope.headers["location"]).query)["error"] == ["invalid_scope"]
        assert client.get("/authorize", params={**authorization_params, "redirect_uri": "https://wrong.example/callback"}).status_code == 400
        authorization = client.get("/authorize", params=authorization_params)
        assert authorization.status_code == 302
        consent = client.get(authorization.headers["location"])
        assert consent.status_code == 200 and "Create one in Parkdex" in consent.text
        request_token = re.search(r"name=request value='([^']+)'", consent.text).group(1)
        csrf = re.search(r"name=csrf value='([^']+)'", consent.text).group(1)
        assert client.post("/oauth/consent", data={"request": request_token, "csrf": "wrong", "email": EMAIL, "password": PASSWORD, "decision": "allow"}).status_code == 400
        callback = client.post("/oauth/consent", data={"request": request_token, "csrf": csrf, "email": EMAIL, "password": PASSWORD, "decision": "allow"})
        assert callback.status_code == 303
        callback_params = parse_qs(urlsplit(callback.headers["location"]).query)
        assert callback_params["state"] == ["state-value"]
        assert callback_params["iss"] == ["http://localhost:8000/"]

        token_params = {
            "grant_type": "authorization_code", "client_id": client_id,
            "code": callback_params["code"][0], "code_verifier": verifier,
            "redirect_uri": "http://127.0.0.1:17777/callback", "resource": "http://localhost:8000/mcp",
        }
        assert client.post("/token", data={**token_params, "code_verifier": "x" * 64}).status_code == 400
        tokens = client.post("/token", data=token_params)
        assert tokens.status_code == 200
        assert client.post("/token", data={
            "grant_type": "authorization_code", "client_id": client_id,
            "code": callback_params["code"][0], "code_verifier": verifier,
            "redirect_uri": "http://127.0.0.1:17777/callback", "resource": "http://localhost:8000/mcp",
        }).status_code == 400
        access_token = tokens.json()["access_token"]
        headers = {"Authorization": f"Bearer {access_token}", "Accept": "application/json, text/event-stream"}
        initialized = client.post("/mcp", headers=headers, json={"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "test", "version": "1"}}})
        assert initialized.status_code == 200
        listed = client.post("/mcp", headers=headers, json={"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
        names = {tool["name"] for tool in listed.json()["result"]["tools"]}
        assert names == {"search_places", "get_place_details", "list_groups", "get_group", "create_group", "rename_group", "delete_group", "add_places_to_group", "remove_places_from_group", "get_wishlist"}
        groups = client.post("/mcp", headers=headers, json={"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "list_groups", "arguments": {}}})
        assert groups.status_code == 200 and groups.json()["result"]["isError"] is False
        groups_payload = json.loads(groups.json()["result"]["content"][0]["text"])
        assert groups_payload["isWishlist"] is True
        assert "is_wishlist" not in groups_payload

        created_group = client.post("/mcp", headers=headers, json={"jsonrpc": "2.0", "id": 31, "method": "tools/call", "params": {"name": "create_group", "arguments": {"name": "Private MCP group"}}})
        created_payload = json.loads(created_group.json()["result"]["content"][0]["text"])
        assert created_payload["name"] == "Private MCP group" and "placeIds" in created_payload
        second = client.post("/api/auth/register", json={"email": OTHER_EMAIL, "password": "hosted mcp other password"})
        assert second.status_code == 201
        second_token = "second-account-mcp-access"
        second_grant = uuid4()
        with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
            second_account_id = conn.execute("SELECT id FROM accounts WHERE email = %s", (OTHER_EMAIL,)).fetchone()[0]
            conn.execute(
                """INSERT INTO mcp_oauth_tokens
                   (token_hash, token_kind, grant_id, family_id, client_id, account_id, scopes, resource, expires_at)
                   VALUES (%s, 'access', %s, %s, %s, %s, ARRAY['mcp'], 'http://localhost:8000/mcp', NOW() + INTERVAL '1 hour')""",
                (hashlib.sha256(second_token.encode()).hexdigest(), second_grant, second_grant, client_id, second_account_id),
            )
            conn.commit()
        second_headers = {"Authorization": f"Bearer {second_token}", "Accept": "application/json, text/event-stream"}
        isolated = client.post("/mcp", headers=second_headers, json={"jsonrpc": "2.0", "id": 32, "method": "tools/call", "params": {"name": "get_group", "arguments": {"group_id": created_payload["id"]}}})
        assert isolated.status_code == 200 and isolated.json()["result"]["isError"] is True
        with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
            conn.execute("UPDATE mcp_oauth_tokens SET created_at = NOW() - INTERVAL '2 seconds', expires_at = NOW() - INTERVAL '1 second' WHERE token_hash = %s", (hashlib.sha256(second_token.encode()).hexdigest(),))
            conn.commit()
        assert client.post("/mcp", headers=second_headers, json={"jsonrpc": "2.0", "id": 33, "method": "tools/list", "params": {}}).status_code == 401

        old_refresh = tokens.json()["refresh_token"]
        rotated = client.post("/token", data={
            "grant_type": "refresh_token", "client_id": client_id,
            "refresh_token": old_refresh, "scope": "mcp", "resource": "http://localhost:8000/mcp",
        })
        assert rotated.status_code == 200
        replay = client.post("/token", data={
            "grant_type": "refresh_token", "client_id": client_id,
            "refresh_token": old_refresh, "scope": "mcp", "resource": "http://localhost:8000/mcp",
        })
        assert replay.status_code == 400
        assert client.post("/mcp", headers={"Authorization": f"Bearer {rotated.json()['access_token']}", "Accept": "application/json, text/event-stream"}, json={"jsonrpc": "2.0", "id": 99, "method": "tools/list", "params": {}}).status_code == 401

        revoked = client.post("/revoke", data={"token": access_token, "client_id": client_id, "client_secret": ""})
        assert revoked.status_code == 200
        assert client.post("/mcp", headers=headers, json={"jsonrpc": "2.0", "id": 4, "method": "tools/list", "params": {}}).status_code == 401

        oversized = "x" * 16_385
        assert client.post("/oauth/consent", data={"request": oversized}).status_code == 413
        assert client.post("/register", content=oversized, headers={"Content-Type": "application/json"}).status_code == 413

        too_many_redirects = client.post("/register", json={
            "client_name": "Bounded client", "redirect_uris": [f"http://127.0.0.1:{18000 + i}/callback" for i in range(11)],
            "token_endpoint_auth_method": "none", "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"], "scope": "mcp",
        })
        assert too_many_redirects.status_code == 400

        stale_client_id = str(uuid4())
        with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
            conn.execute(
                "INSERT INTO mcp_oauth_clients (client_id, metadata, last_used_at) VALUES (%s, '{}', NOW() - INTERVAL '91 days')",
                (stale_client_id,),
            )
            conn.commit()
        cleanup_trigger = client.post("/register", json={
            "client_name": "Cleanup trigger", "redirect_uris": ["http://127.0.0.1:19001/callback"],
            "token_endpoint_auth_method": "none", "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"], "scope": "mcp",
        })
        assert cleanup_trigger.status_code == 201
        with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
            assert conn.execute("SELECT 1 FROM mcp_oauth_clients WHERE client_id = %s", (stale_client_id,)).fetchone() is None

        with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
            client_count = conn.execute("SELECT COUNT(*) FROM mcp_oauth_clients").fetchone()[0]
        monkeypatch.setattr(oauth, "MAX_DCR_CLIENTS", client_count)
        capacity_registration = client.post("/register", json={
            "client_name": "Capacity client", "redirect_uris": ["http://127.0.0.1:19002/callback"],
            "token_endpoint_auth_method": "none", "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"], "scope": "mcp",
        })
        assert capacity_registration.status_code == 201
        with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
            assert conn.execute("SELECT COUNT(*) FROM mcp_oauth_clients").fetchone()[0] == client_count

        with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
            conn.execute(
                """INSERT INTO auth_rate_limits (action, scope_hash, attempt_count, window_started_at)
                   VALUES ('mcp_dcr', %s, %s, NOW())
                   ON CONFLICT (action, scope_hash) DO UPDATE SET attempt_count = %s, window_started_at = NOW()""",
                (hashlib.sha256(b"global").hexdigest(), oauth.MAX_DCR_REGISTRATIONS_PER_HOUR, oauth.MAX_DCR_REGISTRATIONS_PER_HOUR),
            )
            event_count = conn.execute("SELECT COUNT(*) FROM auth_security_events WHERE event_type = 'mcp_dcr_rate_limit'").fetchone()[0]
            conn.commit()
        for _ in range(5):
            rate_limited = client.post("/register", json={
                "client_name": "Rate-limited client", "redirect_uris": ["http://127.0.0.1:19000/callback"],
                "token_endpoint_auth_method": "none", "grant_types": ["authorization_code", "refresh_token"],
                "response_types": ["code"], "scope": "mcp",
            })
            assert rate_limited.status_code == 400
            assert rate_limited.json()["error_description"] == "Registration rate limit exceeded"
        with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
            assert conn.execute("SELECT COUNT(*) FROM auth_security_events WHERE event_type = 'mcp_dcr_rate_limit'").fetchone()[0] == event_count

    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        stored = " ".join(row[0] for row in conn.execute("SELECT token_hash FROM mcp_oauth_tokens").fetchall())
        assert access_token not in stored
        conn.execute("DELETE FROM accounts WHERE email = ANY(%s)", ([EMAIL, OTHER_EMAIL],))
        conn.execute("DELETE FROM auth_rate_limits WHERE action = 'mcp_dcr' AND scope_hash = %s", (hashlib.sha256(b"global").hexdigest(),))
        conn.commit()


def test_refresh_exchange_cannot_escape_account_recovery_lock() -> None:
    email = "mcp-recovery-race@example.com"
    refresh_token = "mcp-refresh-before-recovery"
    grant_id = uuid4()
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        conn.execute("DELETE FROM accounts WHERE email = %s", (email,))
        conn.execute("DELETE FROM auth_rate_limits WHERE action = 'register' AND scope_hash = %s", (hashlib.sha256(email.encode()).hexdigest(),))
        conn.commit()
    try:
        with TestClient(app, base_url="http://localhost:8000", follow_redirects=False) as client:
            account = client.post("/api/auth/register", json={"email": email, "password": "recovery race password"}).json()["account"]
            registered = client.post("/register", json={
                "client_name": "Recovery race", "redirect_uris": ["http://127.0.0.1:17779/callback"],
                "token_endpoint_auth_method": "none", "grant_types": ["authorization_code", "refresh_token"],
                "response_types": ["code"], "scope": "mcp",
            })
            assert registered.status_code == 201
            client_id = registered.json()["client_id"]
            with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
                conn.execute(
                    """INSERT INTO mcp_oauth_tokens
                       (token_hash, token_kind, grant_id, family_id, client_id, account_id, scopes, resource, expires_at)
                       VALUES (%s, 'refresh', %s, %s, %s, %s, ARRAY['mcp'], 'http://localhost:8000/mcp', NOW() + INTERVAL '30 days')""",
                    (hashlib.sha256(refresh_token.encode()).hexdigest(), grant_id, grant_id, client_id, account["id"]),
                )
                conn.commit()

            with psycopg.connect(os.environ["DATABASE_URL"]) as recovery_conn:
                recovery_conn.execute("SELECT id FROM accounts WHERE id = %s FOR UPDATE", (account["id"],))
                with ThreadPoolExecutor(max_workers=1) as executor:
                    exchange = executor.submit(lambda: client.post("/token", data={
                        "grant_type": "refresh_token", "client_id": client_id,
                        "refresh_token": refresh_token, "scope": "mcp", "resource": "http://localhost:8000/mcp",
                    }))
                    deadline = time.monotonic() + 5
                    waiting = False
                    while time.monotonic() < deadline:
                        with psycopg.connect(os.environ["DATABASE_URL"]) as observer:
                            waiting = observer.execute(
                                """SELECT EXISTS (
                                       SELECT 1 FROM pg_stat_activity
                                       WHERE datname = current_database() AND wait_event_type = 'Lock'
                                         AND query LIKE 'SELECT id FROM accounts WHERE id = % FOR UPDATE%'
                                   )"""
                            ).fetchone()[0]
                        if waiting:
                            break
                        time.sleep(0.02)
                    assert waiting, "refresh exchange never waited on the account recovery lock"
                    recovery_conn.execute("UPDATE mcp_oauth_authorization_codes SET used_at = NOW() WHERE account_id = %s AND used_at IS NULL", (account["id"],))
                    recovery_conn.execute("UPDATE mcp_oauth_tokens SET revoked_at = NOW() WHERE account_id = %s AND revoked_at IS NULL", (account["id"],))
                    recovery_conn.commit()
                    assert exchange.result(timeout=5).status_code == 400
            with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
                assert conn.execute("SELECT COUNT(*) FROM mcp_oauth_tokens WHERE account_id = %s AND revoked_at IS NULL", (account["id"],)).fetchone()[0] == 0
    finally:
        with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
            conn.execute("DELETE FROM accounts WHERE email = %s", (email,))
            conn.execute("DELETE FROM auth_rate_limits WHERE action = 'register' AND scope_hash = %s", (hashlib.sha256(email.encode()).hexdigest(),))
            conn.commit()

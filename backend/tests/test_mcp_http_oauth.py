import base64
import hashlib
import os
import re
from urllib.parse import parse_qs, urlsplit

import psycopg
from fastapi.testclient import TestClient

from backend.app.main import app


EMAIL = "hosted-mcp@example.com"
PASSWORD = "hosted mcp password"


def test_public_oauth_pkce_streamable_http_and_revocation() -> None:
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        conn.execute("DELETE FROM accounts WHERE email = %s", (EMAIL,))
        conn.execute("DELETE FROM auth_rate_limits WHERE action = 'register' AND scope_hash = %s", (hashlib.sha256(EMAIL.encode()).hexdigest(),))
        conn.commit()

    verifier = "v" * 64
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    with TestClient(app, base_url="http://localhost:8000", follow_redirects=False) as client:
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

        authorization = client.get("/authorize", params={
            "client_id": client_id, "redirect_uri": "http://127.0.0.1:17777/callback",
            "response_type": "code", "code_challenge": challenge, "code_challenge_method": "S256",
            "scope": "mcp", "state": "state-value", "resource": "http://localhost:8000/mcp",
        })
        assert authorization.status_code == 302
        consent = client.get(authorization.headers["location"])
        assert consent.status_code == 200 and "Create one in Parkdex" in consent.text
        request_token = re.search(r"name=request value='([^']+)'", consent.text).group(1)
        csrf = re.search(r"name=csrf value='([^']+)'", consent.text).group(1)
        callback = client.post("/oauth/consent", data={"request": request_token, "csrf": csrf, "email": EMAIL, "password": PASSWORD, "decision": "allow"})
        assert callback.status_code == 303
        callback_params = parse_qs(urlsplit(callback.headers["location"]).query)
        assert callback_params["state"] == ["state-value"]
        assert callback_params["iss"] == ["http://localhost:8000/"]

        tokens = client.post("/token", data={
            "grant_type": "authorization_code", "client_id": client_id,
            "code": callback_params["code"][0], "code_verifier": verifier,
            "redirect_uri": "http://127.0.0.1:17777/callback", "resource": "http://localhost:8000/mcp",
        })
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

        revoked = client.post("/revoke", data={"token": access_token, "client_id": client_id, "client_secret": ""})
        assert revoked.status_code == 200
        assert client.post("/mcp", headers=headers, json={"jsonrpc": "2.0", "id": 4, "method": "tools/list", "params": {}}).status_code == 401

    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        stored = " ".join(row[0] for row in conn.execute("SELECT token_hash FROM mcp_oauth_tokens").fetchall())
        assert access_token not in stored

import asyncio
import pytest
import httpx
from mcp import Client

from backend.app.mcp_server import ParkdexClient, keyring_user, logout_session, mcp, normalize_origin, session_token


def test_mcp_origin_requires_https_except_loopback() -> None:
    assert normalize_origin("https://Parkdex.app/") == "https://parkdex.app"
    assert normalize_origin("http://localhost:8000/") == "http://localhost:8000"
    for value in (
        "http://parkdex.app",
        "https://user:password@parkdex.app",
        "https://parkdex.app/path",
        "https://parkdex.app/#fragment",
    ):
        with pytest.raises(ValueError):
            normalize_origin(value)


def test_session_key_is_scoped_to_origin_and_email(monkeypatch) -> None:
    values = {
        keyring_user("https://parkdex.app", "one@example.com"): "token-one",
        keyring_user("https://staging.parkdex.app", "one@example.com"): "token-two",
    }
    monkeypatch.delenv("PARKDEX_SESSION_TOKEN", raising=False)
    monkeypatch.setenv("PARKDEX_ACCOUNT_EMAIL", "one@example.com")
    monkeypatch.setattr("backend.app.mcp_server.keyring.get_password", lambda service, user: values.get(user))
    assert session_token("https://parkdex.app") == "token-one"
    assert session_token("https://staging.parkdex.app") == "token-two"


def test_mcp_client_refuses_redirects_without_following(monkeypatch) -> None:
    client = ParkdexClient("https://parkdex.app", "session-token")

    class RedirectingTransport:
        def request(self, method, path, **kwargs):
            return httpx.Response(
                302,
                headers={"location": "https://evil.example/collect"},
                request=httpx.Request(method, "https://parkdex.app/api/groups"),
            )

    client._client = RedirectingTransport()
    try:
        with pytest.raises(RuntimeError, match="redirect"):
            client.request("GET", "/api/groups")
    finally:
        monkeypatch.setattr(client, "_client", type("Closed", (), {"close": lambda self: None})())
        client.close()


def test_mcp_tool_schemas_publish_filters_and_bounds() -> None:
    async def schemas() -> dict:
        async with Client(mcp) as client:
            result = await client.list_tools()
            return {tool.name: tool.input_schema for tool in result.tools}

    tools = asyncio.run(schemas())
    search = tools["search_places"]["properties"]
    assert search["type"]["anyOf"][0]["enum"] == ["national", "provincial", "regional", "island"]
    assert search["latitude"]["anyOf"][0] == {"maximum": 90.0, "minimum": -90.0, "type": "number"}
    assert search["radius_km"]["anyOf"][0]["exclusiveMinimum"] == 0.0
    assert search["limit"]["minimum"] == 1
    assert search["limit"]["maximum"] == 100
    assert tools["add_places_to_group"]["properties"]["place_ids"]["maxItems"] == 100


def test_logout_removes_scoped_keyring_entry_when_server_revocation_fails(monkeypatch) -> None:
    deleted: list[tuple[str, str]] = []

    class FailingClient:
        def __init__(self, origin: str, token: str):
            pass

        def request(self, method: str, path: str):
            raise RuntimeError("offline")

        def close(self):
            pass

    monkeypatch.setattr("backend.app.mcp_server.session_token", lambda origin, email: "token")
    monkeypatch.setattr("backend.app.mcp_server.ParkdexClient", FailingClient)
    monkeypatch.setattr(
        "backend.app.mcp_server.keyring.delete_password",
        lambda service, user: deleted.append((service, user)),
    )
    with pytest.raises(RuntimeError, match="removed locally"):
        logout_session("https://parkdex.app", "one@example.com")
    assert deleted == [("parkdex-mcp-session", "https://parkdex.app|one@example.com")]

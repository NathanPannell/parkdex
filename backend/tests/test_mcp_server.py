import pytest
import httpx

from backend.app.mcp_server import ParkdexClient, keyring_user, normalize_origin, session_token


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

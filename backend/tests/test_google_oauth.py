import httpx
import pytest

from backend.app import google_oauth
from backend.app.settings import Settings


class TokenResponse:
    def __init__(self, payload: dict):
        self.payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict:
        return self.payload


def oauth_settings() -> Settings:
    return Settings(
        _env_file=None,
        GOOGLE_CLIENT_ID="configured-audience",
        GOOGLE_CLIENT_SECRET="client-secret",
        GOOGLE_REDIRECT_URI="https://parkdex.example/auth/google/callback",
    )


def test_exchange_delegates_id_token_validation_with_configured_audience(monkeypatch) -> None:
    captured = {}
    monkeypatch.setattr(google_oauth.httpx, "post", lambda *args, **kwargs: TokenResponse({"id_token": "signed-token"}))

    def verify(raw_token, request, audience):
        captured.update(token=raw_token, audience=audience)
        return {"sub": "subject"}

    monkeypatch.setattr(google_oauth.id_token, "verify_oauth2_token", verify)
    assert google_oauth.exchange_and_verify(oauth_settings(), "code", "v" * 43) == {"sub": "subject"}
    assert captured == {"token": "signed-token", "audience": "configured-audience"}


def test_exchange_rejects_missing_id_token(monkeypatch) -> None:
    monkeypatch.setattr(google_oauth.httpx, "post", lambda *args, **kwargs: TokenResponse({}))
    with pytest.raises(ValueError, match="did not return an ID token"):
        google_oauth.exchange_and_verify(oauth_settings(), "code", "v" * 43)


def test_exchange_propagates_provider_http_failure(monkeypatch) -> None:
    def fail(*args, **kwargs):
        raise httpx.ConnectError("provider unavailable")

    monkeypatch.setattr(google_oauth.httpx, "post", fail)
    with pytest.raises(httpx.ConnectError):
        google_oauth.exchange_and_verify(oauth_settings(), "code", "v" * 43)

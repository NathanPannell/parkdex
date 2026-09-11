import httpx
import pytest

from backend.app.email_delivery import EmailDeliveryError, email_delivery_configured, send_auth_email
from backend.app.settings import Settings


def test_resend_delivery_uses_https_api_and_configured_sender(monkeypatch) -> None:
    calls: list[dict] = []

    def fake_post(url, **kwargs):
        calls.append({"url": url, **kwargs})
        return httpx.Response(200, request=httpx.Request("POST", url))

    monkeypatch.setattr(httpx, "post", fake_post)
    settings = Settings(
        EMAIL_PROVIDER="resend",
        RESEND_API_KEY="re_test_key",
        RESEND_API_URL="https://api.resend.test/emails",
        RESEND_FROM="Parkdex <test@example.com>",
    )

    send_auth_email(settings, "explorer@example.com", "Verify your Parkdex email", "Use this link")

    assert calls == [{
        "url": "https://api.resend.test/emails",
        "headers": {"Authorization": "Bearer re_test_key"},
        "json": {
            "from": "Parkdex <test@example.com>",
            "to": ["explorer@example.com"],
            "subject": "Verify your Parkdex email",
            "text": "Use this link",
        },
        "timeout": 10,
    }]


def test_resend_provider_failures_have_safe_errors(monkeypatch) -> None:
    def fake_post(*args, **kwargs):
        request = httpx.Request("POST", args[0])
        raise httpx.ConnectError("request failed for secret@example.com", request=request)

    monkeypatch.setattr(httpx, "post", fake_post)
    settings = Settings(EMAIL_PROVIDER="resend", RESEND_API_KEY="re_test_key", RESEND_FROM="Parkdex <test@example.com>")

    try:
        send_auth_email(settings, "secret@example.com", "Subject", "token-link")
    except EmailDeliveryError as exc:
        assert str(exc) == "Email provider request failed"
        assert "secret@example.com" not in str(exc)
        assert "token-link" not in str(exc)
    else:
        raise AssertionError("expected safe provider error")


def test_resend_rejection_has_a_safe_error(monkeypatch) -> None:
    def fake_post(url, **kwargs):
        return httpx.Response(422, request=httpx.Request("POST", url), text='{"message":"recipient rejected"}')

    monkeypatch.setattr(httpx, "post", fake_post)
    settings = Settings(EMAIL_PROVIDER="resend", RESEND_API_KEY="re_test_key", RESEND_FROM="Parkdex <test@example.com>")

    try:
        send_auth_email(settings, "secret@example.com", "Subject", "token-link")
    except EmailDeliveryError as exc:
        assert str(exc) == "Email provider request failed"
    else:
        raise AssertionError("expected safe provider error")


@pytest.mark.parametrize("url", ["http://api.resend.test/emails", "https://", "https:///emails", "https:emails"])
def test_resend_api_url_must_be_a_real_https_url(url: str) -> None:
    settings = Settings(
        EMAIL_PROVIDER="resend",
        RESEND_API_KEY="re_test_key",
        RESEND_FROM="Parkdex <test@example.com>",
        RESEND_API_URL=url,
    )

    assert not email_delivery_configured(settings)
    with pytest.raises(RuntimeError, match="must use HTTPS"):
        send_auth_email(settings, "secret@example.com", "Subject", "token-link")


def test_provider_must_be_configured_explicitly() -> None:
    assert not email_delivery_configured(Settings(EMAIL_PROVIDER="resend"))
    assert email_delivery_configured(Settings(EMAIL_PROVIDER="smtp", SMTP_HOST="smtp.test"))

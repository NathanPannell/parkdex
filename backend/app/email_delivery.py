import smtplib
import ssl
from email.message import EmailMessage
from urllib.parse import urlparse

import httpx

from backend.app.settings import Settings


class EmailDeliveryError(RuntimeError):
    """A provider failure safe to expose through the application boundary."""


def ensure_email_delivery(settings: Settings) -> None:
    if settings.email_provider == "resend":
        if not settings.resend_api_key or not settings.resend_from:
            raise RuntimeError("Resend email delivery is not configured")
        parsed_url = urlparse(settings.resend_api_url)
        if parsed_url.scheme != "https" or not parsed_url.hostname:
            raise RuntimeError("Resend API URL must use HTTPS")
        return
    if not settings.smtp_host:
        raise RuntimeError("SMTP email delivery is not configured")


def email_delivery_configured(settings: Settings) -> bool:
    try:
        ensure_email_delivery(settings)
    except RuntimeError:
        return False
    return True


def send_auth_email(settings: Settings, recipient: str, subject: str, text: str) -> None:
    ensure_email_delivery(settings)
    if settings.email_provider == "resend":
        try:
            response = httpx.post(
                settings.resend_api_url,
                headers={"Authorization": f"Bearer {settings.resend_api_key}"},
                json={"from": settings.resend_from, "to": [recipient], "subject": subject, "text": text},
                timeout=10,
            )
            response.raise_for_status()
        except httpx.HTTPError as exc:
            raise EmailDeliveryError("Email provider request failed") from exc
        return
    message = EmailMessage()
    message["From"] = settings.smtp_from
    message["To"] = recipient
    message["Subject"] = subject
    message.set_content(text)
    with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=10) as smtp:
        if settings.smtp_use_tls:
            smtp.starttls(context=ssl.create_default_context())
        if settings.smtp_username:
            smtp.login(settings.smtp_username, settings.smtp_password or "")
        smtp.send_message(message)

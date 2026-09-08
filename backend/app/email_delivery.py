import smtplib
import ssl
from email.message import EmailMessage

from backend.app.settings import Settings


def ensure_email_delivery(settings: Settings) -> None:
    if not settings.smtp_host:
        raise RuntimeError("Email delivery is not configured")


def send_auth_email(settings: Settings, recipient: str, subject: str, text: str) -> None:
    ensure_email_delivery(settings)
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

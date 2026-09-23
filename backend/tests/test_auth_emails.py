from backend.app.auth_emails import password_reset_email, verification_email


def test_verification_email_is_branded_multipart_content() -> None:
    url = "https://web.parkdex.app/#verificationToken=test-token"

    email = verification_email(url)

    assert email.subject == "Confirm your Parkdex email"
    assert email.text == f"""PARKDEX

Confirm your email

Welcome to Parkdex. Confirm this email address to finish setting up your account and keep your park progress connected to you.

Confirm email:
{url}

Link details
This link expires in 1 hour and can be used once. Requesting another verification email invalidates earlier unused links.

Didn't create a Parkdex account? You can safely ignore this email.

— Parkdex
A completionist map of Vancouver Island
"""
    assert "\n\n\n" not in email.text
    assert f'href="{url}"' in email.html
    assert ">Confirm email</a>" in email.html
    assert "Button not working?" in email.html
    assert "ACCOUNT SETUP" in email.html
    assert 'aria-hidden="true"' in email.html


def test_password_reset_email_is_clear_about_ignored_requests() -> None:
    url = "https://web.parkdex.app/#resetToken=test-token"

    email = password_reset_email(url)

    assert email.subject == "Reset your Parkdex password"
    assert email.text == f"""PARKDEX

Choose a new password

We received a request to reset the password for your Parkdex account. Use the secure link below to choose a new one.

Reset password:
{url}

Link details
This link expires in 1 hour and can be used once. Requesting a new reset email invalidates earlier unused links.

Security note
Choosing a new password signs out active sessions on this account.

Didn't request a password reset? You can ignore this email. Your password will not change unless you use the link and choose a new one.

— Parkdex
A completionist map of Vancouver Island
"""
    assert f'href="{url}"' in email.html
    assert ">Reset password</a>" in email.html
    assert "ACCOUNT SECURITY" in email.html
    assert "v:roundrect" in email.html


def test_auth_email_escapes_action_url_in_html() -> None:
    url = 'https://web.parkdex.app/#resetToken=test&next="unsafe"'

    email = password_reset_email(url)

    assert url in email.text
    assert 'href="https://web.parkdex.app/#resetToken=test&amp;next=&quot;unsafe&quot;"' in email.html
    assert 'href="https://web.parkdex.app/#resetToken=test&next="unsafe""' not in email.html

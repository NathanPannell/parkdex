# Branded auth email evidence

These screenshots use local sample links and contain no live recipient, credential, or action token.

- `before-verification.png` and `before-password-reset.png` show the previous plain-text bodies.
- `after-verification-desktop.png` and `after-password-reset-desktop.png` show the multipart HTML bodies at desktop email width.
- `after-verification-mobile.png` and `after-password-reset-mobile.png` show the responsive bodies at a 390 px mobile viewport.
- `before-oauth-consent-desktop.png` and `after-oauth-consent-desktop.png` compare the OAuth consent page at a 900 px desktop viewport.
- `before-oauth-consent-mobile.png` and `after-oauth-consent-mobile.png` compare the previous fixed-width page with the refined responsive layout at the 500 px narrow breakpoint.
- `before-oauth-error-desktop.png` and `after-oauth-error-desktop.png` compare the expired-request recovery state.

The email previews are rendered directly from `backend.app.auth_emails`. The OAuth evidence was captured from local servers running the exact pre-change and post-change revisions against disposable local authorization requests; no live account credentials or reusable tokens are present in the screenshots.

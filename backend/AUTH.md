# Account API

Account sessions are opaque 256-bit bearer tokens stored only as SHA-256 digests. They expire after 30 days. Logout revokes the current session; password reset and password change revoke every session for that account. Passwords use Argon2id with OWASP's 19 MiB, two-pass, single-lane minimum and new passwords must contain 12–128 characters.

`GET /api/auth/config` returns `{googleEnabled,emailEnabled}`. Clients should hide or disable an integration when its value is false. Direct email and Google requests return `503` when the corresponding integration is unavailable.

## Passwords and email verification

- `POST /api/auth/register` accepts `{email,password}` and returns the normal auth result. New accounts have `account.emailVerified: false`.
- `POST /api/auth/login` accepts `{email,password}`.
- `POST /api/auth/password-reset/request` accepts `{email}` and always returns the same `202` response for a syntactically valid address. Delivery runs after the response only for a matching account, so the endpoint neither reveals account existence nor sends unsolicited reset messages to arbitrary addresses. The token expires after one hour and is single use.
- `POST /api/auth/password-reset/confirm` accepts `{token,newPassword}` and returns `204`.
- `POST /api/auth/password-change` requires a bearer token and accepts `{currentPassword,newPassword}`. It returns `204` and revokes all sessions.
- `POST /api/auth/email-verification/request` requires a bearer token and returns `202`.
- `POST /api/auth/email-verification/confirm` accepts `{token}` and returns `204`. Resending invalidates earlier unused tokens.

Email links use `${APP_PUBLIC_URL}/#resetToken=...` and `${APP_PUBLIC_URL}/#verificationToken=...`; fragments keep credentials out of HTTP access logs and referrers, and the client clears them immediately. Configure `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_FROM`, and `SMTP_USE_TLS`. STARTTLS uses certificate verification. Tokens are stored only as hashes and never logged by the backend. Features that require a verified address must use the server-provided `emailVerified` value rather than a client-side claim.

When SMTP is not configured, email request endpoints return `503`. Registration email is best effort and registration still succeeds if delivery fails; the authenticated resend endpoint can retry. Password-reset delivery runs after its generic `202` response, so a later SMTP failure cannot change that response. The failure is recorded with a hashed recipient scope, no token, and the user may request another message within the documented rate limit. No live-provider delivery is exercised by the automated suite.

## Google OpenID Connect

The browser generates a 43–128 character PKCE verifier and its unpadded base64url SHA-256 challenge. It calls `GET /api/auth/google/start?codeChallenge=...`, which returns `{authorizationUrl}`. Google redirects to `GOOGLE_REDIRECT_URI` with `code` and `state`; the browser then sends `{code,state,codeVerifier}` to `POST /api/auth/google/callback`.

Each authorization is bound to a hashed, single-use, ten-minute state, an OIDC nonce, and its PKCE challenge. The backend exchanges the code directly, verifies the ID token signature, issuer, audience, expiry, nonce, and `email_verified` claim, then keys the identity on Google's stable `sub`. This follows Google's [OpenID Connect guidance](https://developers.google.com/identity/openid-connect/openid-connect) and [OIDC endpoint reference](https://developers.google.com/identity/openid-connect/reference); Google's [PKCE documentation](https://developers.google.com/identity/protocols/oauth2/native-app) defines the S256 transformation and verifier requirements.

Configure `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and the exact `GOOGLE_REDIRECT_URI`. Staging should use `https://staging.parkdex.app/auth/google/callback`; production should use `https://parkdex.app/auth/google/callback`. Preview builds intentionally report Google and email as disabled unless isolated credentials are supplied.

Verified `gmail.com` and `googlemail.com` aliases automatically link to the single matching password account. A verified password account keeps its password. An unverified matching account retains progress, but all sessions and action tokens are revoked and its password is removed before Google is linked, preventing a pre-registered password from retaining access. Existing non-Gmail accounts continue to use email-and-password sign-in; Google linking is not offered for those collisions. Transactions serialize registration and linking by canonical email and Google subject.

## Abuse protection and events

Login allows five failures per normalized email in 15 minutes. Registration allows five attempts per normalized email per hour and 500 total attempts per 15 minutes. Password reset and verification allow three requests per address or account per 15 minutes. Google authorization creation is capped at 1,000 per 15 minutes. Reservations are atomic, so concurrent requests cannot bypass a limit.

The database records hashed scopes, event type, outcome, and timestamp in `auth_security_events`; it does not record raw emails or tokens. Rate-limited and failed OAuth callbacks are observable there. Public MCP client registration uses a high global circuit breaker, a fixed client-row cap with inactive-client eviction, and no per-rejection event writes; events older than 90 days are removed during MCP cleanup. These application limits complement a trusted ingress rate limit. Parkdex does not trust client-supplied forwarding headers or use Railway's shared proxy address as a per-user identity.

Anonymous progress continues to use `X-Collection-Key`. Authenticated requests use `Authorization: Bearer <token>`. Send one identity header at a time, except for the explicit `POST /api/account/import-guest` merge.

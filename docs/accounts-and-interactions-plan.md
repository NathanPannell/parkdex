# Accounts and interaction proposal

This is a proposal, not implemented functionality. The approved implementation in this branch is server content loading with local SQLite/private files on Android. Account UI will be designed separately. Interaction logging must wait for approval of the event list below.

## Protect earned progress first

An app update or content release must preserve earned badges without requiring an account. Keep claim IDs, stable park IDs, original claim times, and photos separate from downloaded content. Preserve a park's display information and artwork when a later catalogue retires it. Do not re-evaluate an old claim against a new boundary. Content cleanup must never clear personal claim or photo storage.

Accounts add recovery after reinstall, a lost phone, or a device change. Authentication alone is insufficient: the app also needs authenticated claim backup, photo backup, restore, and an idempotent merge of existing local progress. Raw interaction logs are never the source of truth for earned claims.

## Start with three explicit events

| Event | Trigger | Event context |
| --- | --- | --- |
| `park_viewed` | Open a park detail view; do not emit again on a React render | Park ID and entry point such as map, nearby list, or collection |
| `directions_opened` | Request an external directions link | Park ID, provider, selected travel mode, and entry point. This proves a request to open directions, not arrival or navigation completion. |
| `park_claimed` | A claim is successfully saved | Park ID, unique claim ID, first claim or repeat visit if the app supports repeat visits |

Common context: unique event ID, randomly generated install ID, session ID, client occurrence time, server receipt time, event schema version, app version/build, content release ID, and app environment. The event ID allows retries without double counting. No names, email addresses, exact coordinates, photos, tokens, or free text. Any future association with an account ID needs an explicit identity policy; do not silently put personal account fields into analytics.

Keep raw interactions for 90 days. There is no logging opt-out in the requested product behavior. Use a small set of explicit calls, not a global click listener. Never block navigation or a successful claim on telemetry delivery. Claim sync and interaction delivery are separate concerns. `trip_started` and `share_completed` can be considered later if a concrete product question needs them.

## Keep Kip accounts separate

The old FastAPI service already supports email/password, Argon2id password hashes, verification emails, password reset, rate-limited login, opaque sessions, and Google identities. It has email login, not username login. Prefer a display name plus email/password initially; true username login needs a separate unique identifier and recovery rules.

The operator chose independent Kip accounts. Port the tested legacy authentication behavior into Kip's Vercel backend and keep users, credentials, provider identities, sessions, and progress in Kip's Neon database. Do not depend on the old Parkdex service at runtime or silently copy password/session rows. Kip's backend must authenticate each request; the client cannot choose its own trusted account ID.

Existing Parkdex credentials will not automatically work in Kip. Any later import of old visits or account linking needs an explicit migration flow with ownership verification. That import is separate from preserving and backing up the existing local Kip testers' collections.

All 122 current Kip park IDs exist in the inspected legacy 198-ID route catalogue. Import visits by exact IDs, never by similar names. The other legacy IDs need an explicit policy before importing. Kip's local claims and IndexedDB photos do not use the legacy guest-import format and require a new import endpoint.

## Technical work needed for accounts

1. **Identity model:** immutable internal account ID, separate Google provider/subject identity, email credential, optional display name, verification state, and account deletion. Do not key progress or Google linking by email. Correct the legacy check that rejects an already linked Google subject when its email changes.
2. **Native Google sign-in:** use Android Credential Manager through a Capacitor bridge and a server endpoint that verifies Google ID tokens. Configure Android OAuth clients for each package/signing certificate, including the Play app signing certificate and field/debug builds, plus the web client ID used as the server audience. Validate signature, issuer, audience, expiry, verified email and a one-time nonce. Do not open Google authorization inside the app's WebView.
3. **Session handling:** store mobile credentials in Android Keystore-backed secure storage; support revocation and a deliberate renewal policy. The old service currently has 30-day sessions and no refresh endpoint.
4. **Email and links:** reuse the verified email sender/templates and password-reset protections. Add verified Android App Links and Capacitor link handling where verification/reset should return to Kip. Configure separate staging and production redirect targets.
5. **Durable progress:** authenticated idempotent claim upload/download, immutable claim history, conflict-safe union when linking an existing local collection, and an acknowledged sync cursor. Keep local progress until the server confirms persistence. A catalogue update cannot invalidate a previously earned claim.
6. **Photos:** keep the current phone copy and upload backups to private storage if photo recovery is part of the account promise. Use authenticated access or short-lived URLs, never the public content CDN. Retry independently of claim metadata.
7. **Deletion and recovery:** delete personal Kip rows/photos and revoke sessions when a Kip account is deleted. Keep analytics retention separate from claim retention.
8. **Migration for testers:** upgrade in place using the same Android package/signing identity, preserve current local keys, import with stable claim UUIDs, and verify reinstall/second-device restore before promising backup.

Claude's UI handoff should cover sign-in, create account, Google sign-in, email verification, reset, linking an existing guest collection, backup pending/offline/error/success, and account deletion. The backend can be specified and tested before those screens are designed.

## References

- Legacy implementation: `parkdex/backend/AUTH.md`, `backend/app/auth.py`, `backend/app/main.py`, and migration `0008_secure_account_authentication.sql` in the sibling legacy repository.
- [Android Credential Manager and Google sign-in](https://developer.android.com/identity/sign-in/credential-manager-siwg-implementation)
- [Google OAuth policy on embedded user agents](https://developers.google.com/identity/protocols/oauth2/policies)
- [Google OpenID Connect identity rules](https://developers.google.com/identity/openid-connect/openid-connect)
- [Android App Links](https://developer.android.com/training/app-links/about)

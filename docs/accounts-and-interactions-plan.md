# Accounts, progress backup, and interactions

This document records the approved product scope and the implementation in this branch. Functional account screens using Parkdex's current styling are approved; a later visual redesign is optional. The detailed API and data contract is in [accounts-implementation-contract.md](accounts-implementation-contract.md).

The branch implements independent Parkdex accounts, account-scoped claim and photo backup, restore, and exactly three anonymous interaction events. Provider configuration and deployed acceptance are separate release steps. Source code and local checks do not establish that Google, Cloudflare, or a deployed preview is ready.

## Accounts and personal progress

Parkdex accounts use this app's own identity and progress records. Legacy Parkdex credentials and sessions are not imported, and the old Parkdex service is not a runtime dependency. Email and password registration and sign-in are implemented, along with verification and password reset flows. Google sign-in and linking have web and Android code paths that become available only when their OAuth configuration is supplied. Web sessions use secure cookies and CSRF checks. Android sessions use the native Keystore bridge.

The functional Account screen covers account creation and sign-in, conditional Google sign-in, password reset and email verification, Google linking for signed-in users, a compact last-backup timestamp, sign-out, and account deletion with reauthentication and a typed confirmation. Backup and local badge attachment require no separate card or button. A deletion response carries a receipt and can remain pending until personal data cleanup is confirmed. Email and Google availability are driven by server configuration, so a disabled provider remains unavailable in the screen.

Unassigned device progress automatically belongs to the first verified account that signs in. An atomic local reservation prevents another account from acquiring it before backup. Reserved recovery copies are hidden from the guest collection and removed individually after the server acknowledges the claim and supported photo; unsupported photos remain in the account's local collection. Claims retain stable UUIDs and upload idempotently. A successful local save is durable before the app reports the claim or emits an interaction event. Switching accounts does not expose or move another account's cached progress. The claim/photo APIs require `X-Kip-Account-ID` to match the authenticated session, which rejects requests left over from a stale account tab.

Claim and photo transfers run automatically while the app is foregrounded. Android uses confirmed Wi-Fi and pauses when Wi-Fi is lost. The web app uses any online connection, including browsers without physical connection-type support, and pauses when offline. Transfers resume on connectivity or foreground events, and new claims trigger backup. Public map and content downloads retain their own connection policy. Sign-in remains available on other connections. The last successful outgoing backup time persists per account and never advances for a failed attempt or a restore-only pass. There is no polling service or manual backup button.

Claims and photos are separate from downloaded catalogue content. Each claim retains its stable park ID, original claim time, and frozen park snapshot. A retired park therefore remains visible in the earned collection. When its original scene art is needed, the app retrieves it from the claim's immutable content release, verifies it against that release's manifest and file hash, and caches it under the release and scene identity. If the device is offline, the claim stays visible while the matching art waits to restore. Multiple historical claim records for one park remain in progress history while the badge display continues to show one earned badge for that park.

Personal photos use the private photo API and a Cloudflare/R2 service boundary. This does not make provider setup complete: actual Cloudflare resources, secret wiring, and deployed private-photo acceptance still require the owned preview workflow. Photos are not stored in the public content CDN.

## Approved interaction events

The only approved event types are `park_viewed`, `directions_opened`, and `park_claimed`. Calls are attached to those explicit product actions. There is no global click listener, and the product has no interaction logging opt-out. `park_viewed` means a park detail view was opened, not that the user visited the park. `directions_opened` means an external directions link was requested, not that navigation or arrival was completed. `park_claimed` is emitted only after the local claim transaction succeeds. Interaction events are never used to create or recover earned progress.

Every event has this common context: an event UUID, a random installation UUID, a session UUID, client occurrence time, schema version, app version and build, content release ID, app environment, and stable park ID. The server adds the receipt time. The schema is strict and typed:

| Event | Trigger | Event-specific context |
| --- | --- | --- |
| `park_viewed` | Open a park detail view | `entryPoint`: `map`, `nearby`, or `collection` |
| `directions_opened` | Request an external maps link | `entryPoint` as above; `provider`: `google_maps` or `apple_maps`; `travelMode`: `driving`, `walking`, `bicycling`, or `transit` |
| `park_claimed` | Save a claim locally | Claim UUID and `claimStatus`: `first` or `repeat` |

The event allowlist contains no account ID, email, name, IP address, coordinates, photo, token, URL, referrer, or free text. The event table has no account foreign key. The API accepts bounded batches and uses the event UUID for idempotency. Replaying the same ID and payload is a duplicate; reusing it with changed content is a conflict. Request addresses are not written to events. Separate rate limiting uses a keyed hash with expiry.

The client stores events in a bounded IndexedDB outbox with a 500-event cap and a 90-day age limit. It retries with the same event UUID, sends at most 50 events per batch, and bounds each flush to five batches. Delivery is attempted while the app is foregrounded or when connectivity returns. There is no always-on polling or automatic retry service. Event delivery does not block navigation or claim completion.

Raw server events are retained for 90 days from server receipt time. A bounded daily purge deletes older rows and reports any remaining expired backlog; the purge endpoint is protected by `KIP_RETENTION_SECRET`. A missed purge can be resumed explicitly. The retention schedule exists to meet the approved 90-day rule, not to run a general retry worker.

## Release and verification boundaries

The account and interaction source includes targeted tests and disposable PostgreSQL QA scripts. Deployed API and browser acceptance must run against the exact owned Vercel Preview deployment and commit SHA. Android in-place update, link handling, secure session, and restore journeys also require device verification. None of those deployed checks should be inferred from local tests.

Google OAuth client configuration, Android package and signing-certificate registration, Play App Signing identity, outbound email delivery, Cloudflare/R2 resource configuration, and preview secret wiring remain external setup. The current app-link and signer details, including the missing Play App Signing fingerprint, are documented in [android-app-links.md](android-app-links.md). Do not report Google or private-photo provider flows as ready until the exact environment is configured and verified.

# Application state and offline visits

The application layer owns data selection, navigation, account transitions, and asynchronous work. React views receive state and call commands. Add a feature's state transitions to its application controller instead of embedding API calls or retry rules in a component.

## Ownership

| Concern | Application boundary |
| --- | --- |
| Search, navigation, account lifecycle, reset coordination | `use-parkdex-application.ts` and account controller |
| Account and guest persistence, identity epochs, visit synchronization | `use-field-journal.ts` |
| Map data, visible geometry, park names, postcard loading | `map-presentation.ts` and `use-map-presentation.ts` |
| Claim, camera consent, reconciliation, photo delivery | `claim-workflow.ts`, `claim-recovery.ts`, and headless claim controllers |
| Recent public place content | `place-cache.ts` |
| Offline boundary checks and durable deferred claims | `offline-geometry.ts` and `offline-claims.ts` |
| Transient errors | `application-notifications.ts` |

The map renders supplied features and reports selection or viewport events. It does not decide which catalogue data to fetch or which account's progress to show. Every place remains an individual pin. Label candidates come from the application layer; the renderer handles visual text collisions.

## Storage policy

The durable public catalogue contains a lightweight search and marker index. Complete place bundles retain the 20 most recently opened detail views, including sourced information, the full detail photo when available, and the precise claim boundary. Reading a thumbnail does not increase recency. Eviction removes the whole public bundle.

Browser bundles use IndexedDB. Android bundles use app-private Filesystem storage with a small manifest. Android builds omit the preloaded photo library and large map geometry files. Public content and map imagery are fetched on demand; display geometry remains transient session data. Credentials, progress, unsynchronized claims, and private photo retry records have separate lifecycles and are never evicted by the public content limit.

## Offline claim protocol

1. An authenticated online session obtains an account-bound, expiring grant from `POST /api/offline-claim-grants`. Viewing a place obtains its canonical geometry and details from `GET /api/places/{id}/offline-bundle`.
2. Offline claiming requires a fresh, precise location inside a cached canonical polygon. Bounding boxes and simplified display outlines are never claim evidence. Polygon holes are excluded.
3. The application durably writes a stable request ID, the captured fix, grant reference, place identity, and photo recovery state before reporting a pending visit. Pending visits are separate from server-confirmed progress.
4. Reconnection, foreground recovery, or an explicit retry drains the account's queue. `POST /api/offline-claims` verifies the original fix against the grant's time interval and the current canonical boundary. A catalogue revision alone does not discard queued evidence: the original fix must still be inside the current polygon. Synchronization does not request a new location.
5. The API persists an idempotent receipt. A lost response can be retried with the same request ID. Reusing the ID with different evidence is rejected. Confirmed claims then deliver accepted private photos using the existing photo retry store.

Account transitions fence old asynchronous completions. Progress reset revokes offline grants and invalidates receipts so delayed requests cannot restore reset visits. Account deletion removes account-owned grants and receipts. Retry storage failures remain actionable and never become false upload success.

An interrupted online create has a separate durable reconciliation marker. Retry checks whether that create succeeded before attempting another visit. Account changes hide another owner's recovery data without deleting their pending photo. Explicit discard, progress reset, and account deletion own destructive cleanup.

Undoing a visit persists the removal intent before canceling its offline queue entry. The server invalidates existing receipts and rejects older saved fixes for that place after an undo. A later fresh visit can still be claimed. Removing a photo cancels its local upload retry before requesting server removal. Dismissing rejected attempts preserves unrelated work and photo drafts.

## Errors and recovery

Application operations report transient failures through the shared notification service. Its dismissible toast lasts five seconds. A toast is presentation only: pending work, rejected claims, and photo recovery remain in durable state after it disappears. Do not add a background polling service for these queues; retry at application lifecycle events or explicit user commands.

## Validation boundaries

Pure geometry tests cover holes, multipolygons, edges, malformed data, accuracy, and stale fixes. Storage tests cover recency, eviction, reload, failed writes, and concurrent clear. Workflow tests cover photo consent, lost responses, reset, and account changes. API tests run against an isolated database for grants, idempotency, and destructive lifecycle behavior. Deployed browser tests and the separate exact-APK Android field gate remain required for their respective delivery claims.

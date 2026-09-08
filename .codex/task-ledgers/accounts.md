# Account and progress persistence

Goal: add secure email/password accounts while preserving anonymous collections,
including account-owned visits and the two explicit trail completion checkoffs.

Completed:

- Added Argon2id password hashing and normalized unique account emails.
- Added 30-day random bearer sessions stored only as SHA-256 token digests, with
  expiry checks and logout revocation.
- Added persistent email and client-address login throttles with generic failures.
- Isolated account visits and trails from guest-key visits and trails.
- Added idempotent authenticated guest-progress import.
- Added register, login, logout, me, account/guest visit, and account/guest trail APIs.
- Applied migration 0006 on the disposable local `everypark_accounts` database.
- Verified all 17 backend tests pass, including isolation, import, expiry, revocation,
  hashing, throttling, and preservation of the anonymous API.

Decision: badges remain derived from persisted progress. The backend stores explicit
trail completion for `west_coast_trail` and `juan_de_fuca_trail` because those cannot
be inferred from park visits.

Local integration database: PostgreSQL on localhost:5434, database
`everypark_accounts`. The API is running on port 8000 in session `14311`.

Final auth review correction: login now reserves one of five attempts atomically in
a short transaction and releases the database connection before Argon2. Registration
also hashes before pool checkout. The 19-test backend suite includes an event-gated
case proving `/ready` remains responsive while all five password checks are blocked.

Frontend integration support completed:

- Added `useFieldJournal` to own catalogue, guest, account, visit, trail, import,
  authentication, offline, and browser-storage state.
- Persisted per-identity visit/trail outboxes and serialized writes per item.
- Guarded late responses with identity epochs and locked mutations during transitions.
- Preserved legacy raw guest keys and raw bearer tokens across reloads.
- Kept cached account identity on network failure and clear it only on an explicit 401.
- Scoped guest import acknowledgements by account and guest progress revision.
- Fixed review findings so login immediately replays a persisted account outbox and
  guest import waits for current account writes before applying its merged snapshot.
- Verified 14 focused hook/storage/outbox tests, focused lint, and full typecheck.

Next action: integrated application quality review and browser verification by root.

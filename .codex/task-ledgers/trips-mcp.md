# Trips + authenticated MCP

## Goal and success condition

Ship one PR to `staging` adding private account-owned groups shared between the Parkdex app and a standards-based authenticated MCP server. Ordinary named groups represent trips; every account also has one protected singleton Wishlist. A signed-in user can create, rename, delete, and add/remove deduplicated places; selecting a group highlights all its places on the map. MCP supports authenticated place discovery/details and the same group/wishlist lifecycle, with privacy isolation and a runnable origin-to-group example.

## Scope decisions

- Branch: `feat/trips-mcp`, worktree: `C:/repo/parkdex-worktrees/trips-mcp`, based on fresh `origin/staging` at `92ba867`.
- Groups require an authenticated account; guest/claim and visit mutation semantics remain unchanged.
- Persist one canonical group model. Ordinary groups can be renamed/deleted; the Wishlist is a per-account singleton that can be read and have membership updated but cannot be renamed/deleted. Compatibility trip aliases are optional and must not duplicate storage.
- Existing login identifier is email plus password. MCP uses an interactive `getpass` setup to exchange those credentials for the existing revocable account session; only that session token is retained in OS keyring storage, scoped by normalized API origin and account email.
- MCP transport is official-SDK stdio. The local process boundary is the MCP security boundary; each MCP tool call reaches the Parkdex REST API with the existing bearer session. There is no hosted MCP endpoint in this PR and no OAuth password grant.
- Geographic distance will be kilometers, nearest-first, with bounded cursor/offset pagination.
- No route optimization, social sharing, or MCP visit checkoff.
- PRs #18 and #20 remain open and unmerged; this branch will not bundle their diffs.
- Trips use migration `0011`; held PR #20 reserves `0009` and `0010`. The migrator records filenames independently, so those lower-numbered migrations can still apply later; integration must preserve all applied files and checksums.
- UI extends the established Home `Operate` surface and existing field-guide visual system; code-first implementation.

## Work streams

- Backend persistence and REST/MCP auth/tool surface.
- Frontend trip management, map multi-selection, and state coverage.
- Local integration tests, independent security/quality review, documentation, PR delivery.

## Evidence and milestones

- 2026-09-10: fetched `origin/staging`, created isolated worktree and branch at `92ba867`.
- 2026-09-10: read root/frontend AGENTS instructions, PRODUCT/DESIGN/Home surface context, and Impeccable craft floor.
- 2026-09-10: architecture audit confirmed raw-SQL FastAPI, account sessions hashed in PostgreSQL, platform-aware frontend token storage, and direct conflicts with PR #20/#18 in shared shell/auth files.
- 2026-09-10: official MCP documentation review selected stdio for local agent use; remote Streamable HTTP authorization would require an OAuth 2.1 resource-server/authorization-server flow and is intentionally out of scope.
- 2026-09-10: user expanded scope before integration to unified Groups + Wishlist. Workers were redirected before commit; verification now includes singleton concurrency, ownership, account-switch isolation, one-click Wishlist, Add-to-group picker, and MCP/UI synchronization.
- 2026-09-10: backend implemented migration `0011_create_account_groups.sql` (canonical `account_groups`/`account_group_places` tables with partial unique Wishlist index), authenticated REST search/details, groups/Wishlist CRUD and membership endpoints, plus compatibility `/api/trips` aliases.
- 2026-09-10: backend implemented official MCP Python SDK v2.2.0 `MCPServer` stdio tools for groups, Wishlist, trips aliases, place search/details, origin/radius pagination, interactive email/password setup via existing login, scoped OS keyring sessions, env-token fallback, and revocable logout.
- 2026-09-10: local isolated PostgreSQL migration and `backend/tests/test_trips_api.py` passed; focused MCP/origin tests passed; full backend suite passed 35 tests before final Wishlist test adjustment and focused suite passed 2 tests afterward. Frontend changes visible in this shared worktree are concurrent and excluded from backend commit.
- 2026-09-10: frontend Groups/Wishlist implementation committed as `60a5e8b07c93380b9b298ff327b993d948274d5e`; uses journal-owned authenticated requests, account identity epochs, settled `/api/groups` membership payloads, grouped map marker state/camera fitting, and no browser token persistence. Frontend typecheck, lint, focused 29-test run, production build, and Impeccable detector passed.
- 2026-09-10: integrated backend commit `b650818` atop frontend `60a5e8b`; renamed the unapplied migration to truthful `0011_create_account_groups.sql`, clarified group/Wishlist errors and copy, reserved the special Wishlist name, rejected radius without origin, and kept trip aliases ordinary-group-only.
- 2026-09-10: added a true MCP stdio subprocess round trip against a locally served API, covering origin/type/unvisited search, details, deduplicated group/Wishlist mutations, REST agreement, protocol error handling, and second-account denial. Added concurrent Wishlist singleton and stale account list/mutation tests.
- 2026-09-10: integration-focused verification passed 8 backend/MCP tests in a fresh owned database that was dropped afterward, plus 6 frontend group/client race tests and frontend typecheck.
- 2026-09-10: full local CI passed at `2e627901bf198700de37e30c3de0a127529f8369`: 42 backend tests, 116 frontend tests across 24 files, lint, typecheck, production build, data validation, boundary checks, workflow contracts, and deploy-helper contracts. The disposable CI database was dropped automatically.
- 2026-09-10: local browser acceptance passed on desktop and 390x844 mobile. Created a multi-place group, focused all members on the map, saved to Wishlist in one click, added through the group picker, confirmed a second account saw only its singleton Wishlist, then created `MCP coast picks` through a real authenticated stdio MCP subprocess and saw it after UI refresh. Browser console warnings/errors: none. The owned browser database and both local servers were removed afterward.
- 2026-09-10: fresh design finish review found rename validation was not rendered beside its form. Fixed the accessible inline alert association, 44px mobile action targets, and long-name wrapping; re-review passed.
- 2026-09-10: independent backend audit identified snake-case REST input compatibility and IPv6 loopback normalization gaps. Added `placeIds`/`place_ids` input aliases, bracket-safe IPv6 origin normalization, and regression tests; focused MCP tests passed 6/6.
- 2026-09-10: independent quality review identified two account-transition gaps. Authenticated Groups requests now expire only the captured current account on 401, and identity changes reset group mutation busy state while stale completions remain ignored. Added focused regressions; 13/13 journal/group hook tests and typecheck passed. Group listing also skips a row deleted between its ID snapshot and detail fetch instead of returning a 500.

## Dependencies and blockers

- Coordinate with local deployment work before any preview; do not disrupt PR #20 preview.
- Local deployment lifecycle task reports provider Apply is not yet generally cleared; use local browser verification only unless that changes.
- Docker Desktop is unavailable, but PostgreSQL is already listening locally on port 5432.

## Next action

Complete the independent quality review, run full local CI at the final commit, then push and open one PR to `staging` without merging or deploying it.

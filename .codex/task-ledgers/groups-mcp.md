# Groups + public authenticated MCP

## Goal and success condition

Update PR #28 so Groups are the only collection concept across the app, REST API, code, tests, and MCP. Wishlist is one protected per-account Group. Host a public Streamable HTTP MCP endpoint on the existing Railway API service, with standards-compliant OAuth 2.1 authorization-code + PKCE authentication for any Parkdex account.

## Decisions and constraints

- Branch `feat/trips-mcp` and PR #28 remain the delivery vehicle; the legacy branch label is not product surface.
- Remove all legacy collection aliases, tool names, routes, types, filenames, CSS identifiers, copy, and documentation. Only Group and Wishlist-as-Group remain.
- The public MCP endpoint is `/mcp` on the Railway API origin and uses the official Python MCP SDK Streamable HTTP transport.
- Follow the MCP authorization specification: protected-resource metadata, authorization-server metadata, dynamic client registration, authorization-code flow, PKCE S256, exact resource/redirect/client/scope binding, one-time codes, hashed opaque access tokens, and per-request account authorization.
- Reuse Parkdex account credentials only at the hosted authorization page. Never expose passwords to MCP clients or store them in authorization records.
- Preserve local stdio only if it remains useful and does not reintroduce legacy naming; public Streamable HTTP is the primary documented configuration.
- No visit mutation, route optimization, social sharing, merge, staging deployment, or production change.
- PRs #18 and #20 remain held and unmerged. Coordinate the isolated PR #28 preview with the separate deployment owner only after the revised head is fully tested.

## Evidence and milestones

- Initial Groups/Wishlist implementation, ownership isolation, singleton concurrency, map focus, account-switch safety, local stdio protocol integration, desktop/mobile browser acceptance, design review, and independent quality review passed before this revision.
- Initial full local CI passed with 43 backend and 118 frontend tests plus lint, typecheck, build, data/boundary validation, and deployment/workflow contracts.
- 2026-09-10: user revised scope to public Railway-hosted MCP and Groups-only terminology; PR #28 merge hold was reinstated.
- 2026-09-10: official OpenAI documentation confirms public servers require a stable HTTPS Streamable HTTP endpoint and user-specific private/write tools require OAuth 2.1 with protected-resource discovery, authorization-server discovery, PKCE S256, resource binding, and per-request token verification.
- 2026-09-10: delegated independent hosted-MCP architecture analysis, backend OAuth/Streamable HTTP implementation, and frontend Groups-only conversion with non-overlapping ownership.
- 2026-09-10: notified the preview deployment owner that the published PR head is stale and must not be deployed; final tested SHA will be sent after revision.
- 2026-09-10: frontend terminology conversion passed 117 tests, lint, typecheck, and interface checks; repository-wide legacy collection routes, types, helpers, filenames, UI copy, and documentation were removed.
- 2026-09-10: hosted MCP focused test passed discovery, unauthenticated challenge, dynamic registration, PKCE login/consent, single-use code exchange, Streamable HTTP initialization/tool calls, hashed-token storage, and revocation.
- 2026-09-10: merged current `origin/staging` at `ce80152aa5cda66b9422e3838d6e0cfc2fe9f1e2` and configured preview/staging/production Railway API services with exact `API_PUBLIC_URL` and `MCP_PUBLIC_URL` values.
- 2026-09-10: hardened hosted OAuth with refresh-family replay revocation, account password-change/reset grant revocation, bounded and rate-limited DCR, stale-client cleanup, bounded OAuth request bodies, and a first-password flow for Google-created accounts.
- 2026-09-10: focused disposable-database verification passed 17 tests covering OAuth discovery/DCR, consent and CSRF, PKCE failure/success, code and refresh replay, access/refresh revocation, expiry, resource/scope/redirect binding, cross-account isolation, exact public tool surface and output casing, Groups/Wishlist invariants, and stdio compatibility.
- 2026-09-10: independent review found account-recovery/token-exchange races, outstanding pre-recovery codes, DCR write amplification/capacity risk, and missing cross-origin PATCH. The revised implementation now takes the account lock before consuming codes or refresh grants, invalidates codes during every credential-recovery path, suppresses throttled DCR event writes, caps and evicts inactive DCR clients, retains security events for 90 days, and permits/tests PATCH preflight.
- 2026-09-10: expanded disposable-database suite passed 18 tests, including a deterministic refresh/recovery lock race, stale-code rejection after password reset, bounded DCR event growth/capacity, and Group rename preflight.
- 2026-09-10: refreshed the mobile-first Groups UX with Wishlist-first indexing, separate group detail screens, spacious place cards, a Spotify-style add-to-group picker, grouped bottom navigation, and a group-only fullscreen map mode; merged current `origin/staging` Resend delivery changes at `b17752b`.

## Active verification plan

- Repository-wide case-insensitive scan for legacy collection terminology, including filenames and public routes/tools.
- OAuth metadata, DCR, authorization redirect validation, PKCE success/failure, code replay, token expiry/revocation, audience/scope, cross-account ownership, and unauthenticated challenge tests.
- True Streamable HTTP MCP client round trip against a local server and owned disposable PostgreSQL database.
- Full local CI at the exact revised commit, independent security/quality review, PR body/title refresh, push, then isolated preview handoff and browser verification.

## Next action

Run the exact merged-head validation, push the PR revision, redeploy the isolated preview, and complete fresh browser and independent black-box review before updating the PR evidence.

# Issues 62–74 deployment

## Goal and owner

Deploy the root-approved exact PR head to persistent staging for review without merging or moving the staging/main Git refs. Reservations issue #14 is excluded. Deployment and task-owned temporary resource cleanup owner: `/root/staging_deploy` (Astra Ultra). Root owns application implementation, independent reviews, final browser gate, PR evidence, and Telegram notification.

The user subsequently requested that issues #76–#82 be included in PR #75, then deployed to staging and merged. #77 is the verification/release acceptance issue. This supersedes the earlier “keep PR open/no merge” instruction after all release gates pass.

## Readiness — 2026-09-12

- Read repository deployment documentation, current workflow, prior staging records, and full-stack-delivery existing-project/credential guidance.
- The GitHub staging workflow resolves latest staging; local Staging `-Apply` is intentionally disabled. Direct provider upload of a checked PR source is required to honor deployment without merge; reuse the existing deployment commands with explicit staging IDs and verify exact source metadata.
- Provider credentials are readable from protected local storage and authenticated read-only Railway/Vercel access passed. One initial preflight was rejected by automatic approval review for overly broad GitHub variable-value output. Safer retry returned only GitHub names and provider identity/status metadata; no credential was exposed and no resource changed.
- Railway project `0999e6e0-d2ae-4b48-b516-55d53dba7cb5` (`every-park`), staging environment `369b82da-1be4-4aea-898a-c5050c4985f7`, API service `b30d9ca5-fc77-4427-a955-b020a7ec3cf8`, worker service `99c62f81-d2bb-40db-911d-d8a4a1d05d8f`.
- Production environment `7670d90a-6422-4ed6-816d-7ef243f00ec2` is excluded from all writes.
- Vercel project `prj_rlXCBkiQRg2PmBQNc2cCWb7uftHR` (`every-park`), organization `team_CJ0RWNsNJK6vDQy2raakV6cZ`. Preview deployments are protected; custom staging domain is public.
- Existing alias `https://staging.parkdex.app` points to `dpl_GCbbgrmd3u9WxuUSVJq3u3Yyc8zR`, raw URL `https://every-park-8734y1jfs-nathanpannells-projects.vercel.app`.
- Existing API `https://api-staging-882c.up.railway.app` reports ready at base `d863b9492db35916e6274afda3c946dc68cd7a62`, 11 migrations, Google/email enabled.
- No provider resources have been created or changed by this task.

## Intended release procedure

1. Receive exact checked candidate SHA and PR number from root; verify clean source and remote PR identity.
2. Use an owned exact-source checkout/export, preserve existing staging database and application secrets, inspect existing staging provider build settings, and stamp only release/source metadata.
3. Upload source to explicit existing staging API/worker IDs as required; bind provider deployment messages to exact source. Verify migrations, readiness, worker catalogue heartbeat and canonical public integration endpoints.
4. Deploy frontend preview with exact release metadata and staging API URL, preserve/extend staging CORS for the raw deployment origin if needed, and move only `staging.parkdex.app` alias.
5. Verify exact frontend/API/worker/provider metadata, browser-origin preflight, and hand exact URL/SHA to root for independent browser review. Root sends a single Telegram only after that gate.
6. Leave the review deployment active. Record exact task-created deployment/source/fixture identities; clean temporary source and synthetic test data after use. Never delete shared projects/services/staging database or preexisting deployments.

## Authentication review strategy

Prior staging records prove the Google/email integration works and a synthetic-account database/session strategy is available. Prefer a fresh task-owned synthetic account/session for account/group browser checks; never reset a user password or send reset email to the user's mailbox. Existing user browser session must remain untouched. Any safe fixture session will stay outside tracked files and output; record only fixture identifiers and cleanup result.

## Next action

Await root's exact checked candidate for the expanded #62–#82 scope. After the independent-review fix cycle, the builder reports frontend 188/188, backend 64/64, lint, typecheck, production build, deterministic reset-lock and rollback coverage, deterministic percentage animation/reduced-motion coverage, and a clean design-detector pass. Root still owns review, exact commit/PR evidence, deployment, fresh browser review, merge, and the single final Telegram notification.

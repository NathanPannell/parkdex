# Parkdex workflow

- Create feature branches from `staging` and target feature pull requests to `staging`.
- Run the complete local suite before pushing, then open the feature pull request as a draft. Use this path only for same-repository branches authored or reviewed by the trusted operator/agent; it is not a sandbox for external code. From a separate clean checkout at the current `origin/staging`, run `scripts/preview-pr.ps1 -PullRequest <number> -Apply`; do not invoke the low-level release command directly.
- The deploying agent owns the exact preview journal, browser-tests the immutable preview URL, and runs `scripts/teardown-preview-pr.ps1 -PullRequest <number> -Apply`. Do not merge until teardown has verified the Vercel deployment, Railway environment, and Neon branch absent and the PR head is unchanged.
- Preview environments receive no persistent application or provider credentials. Railway receives only isolated preview database credentials and public/release values. Google OAuth and outbound email are intentionally unavailable; test guest, catalogue, collection, and affected non-OAuth journeys instead. Never add project variables to Vercel's Preview environment.
- Protect `staging` and `main` from direct pushes. Only the first Actions run created by a merge push to either branch may queue the one-job, no-polling deployment body; do not add manual, pull-request, scheduled, or rerunnable deployment paths.
- Treat a successful workflow as queued, not live, and do not begin another release to that environment until the release agent verifies the exact SHA and release ID.
- Promote a tested `staging` release by merging `staging` into `main` during the requested off-hours window. The release agent waits locally for Railway and Vercel, promotes the verified frontend, smoke-tests `parkdex.app`, records the result, and stops.
- Keep staging and production long-lived and isolated. Do not recreate Neon branches, Railway environments, or stable domains during ordinary releases. Keep migrations additive and N/N-1 compatible; never automatically roll back Neon.
- Preserve legacy browser storage keys and API compatibility when changing branding or progress data.
- Keep frontend static imports within `frontend/`; load repository-root test fixtures at test runtime.

# Parkdex workflow

- Create feature branches from `staging` and target feature pull requests to `staging`.
- After local validation and code review, deploy the exact attested PR head from a clean, current local `staging` checkout to the persistent `staging` resources. Wait locally for provider convergence, assign the verified Vercel build to `staging.parkdex.app`, browser-test it, then merge the unchanged PR into `staging`.
- Protect `staging` and `main` from direct pushes. Only the first Actions run created by a merge push to either branch may queue the one-job, no-polling deployment body; do not add manual, pull-request, scheduled, or rerunnable deployment paths.
- Treat a successful workflow as queued, not live, and do not begin another release to that environment until the release agent verifies the exact SHA and release ID.
- Promote a tested `staging` release by merging `staging` into `main` during the requested off-hours window. The release agent waits locally for Railway and Vercel, promotes the verified frontend, smoke-tests `parkdex.app`, records the result, and stops.
- Keep staging and production long-lived and isolated. Do not recreate Neon branches, Railway environments, or stable domains during ordinary releases. Keep migrations additive and N/N-1 compatible; never automatically roll back Neon.
- Preserve legacy browser storage keys and API compatibility when changing branding or progress data.
- Keep frontend static imports within `frontend/`; load repository-root test fixtures at test runtime.

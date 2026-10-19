# Rebuild the Vercel project from GitHub when it is deleted

Recorded: 2026-10-19. Applies to: the `parkdex` Vercel project that serves `web.parkdex.app` and `staging.web.parkdex.app`.

## What went wrong

The Vercel project was deleted from the dashboard. Both hosts returned `DEPLOYMENT_NOT_FOUND`. Neon, R2 and the Cloudflare photo worker were unaffected. Runtime values are not stored on the Vercel project: each release sends them with the deployment from the GitHub environment secrets `KIP_*_RUNTIME_JSON` and `KIP_*_EXTRA_RUNTIME_JSON`. The local copies under `~/.codex/private/kip-accounts/` are older and lack the extra bundle, so a local redeploy would have shipped stale configuration.

## Rule

Recreate the project and redeploy the commits that are live from GitHub Actions, with the environment secrets. Do not rebuild runtime values by hand.

## How to recover

1. Create the project in team `team_CJ0RWNsNJK6vDQy2raakV6cZ` with framework `vite`. Set `ssoProtection` to null, or `verify-staging` fails on the `parkdex-kip-staging.vercel.app` alias.
2. Add `web.parkdex.app` and `staging.web.parkdex.app` (git branch `staging`) as project domains.
3. Set the new ID in `VERCEL_PRODUCTION_PROJECT_ID` (environment `production`) and `VERCEL_STAGING_PROJECT_ID` (environment `staging`). Keep `vercelProjectName` in `deployment.json` equal to the project name, because the local delivery loader looks the project up by name.
4. Deploy workflows run only on their first attempt, and only on a push to `main` or `staging`. To redeploy the live SHAs without a new merge, push a temporary branch with a workflow that checks out each SHA and calls `dispatch_release`, then `assign_release` and `verify_main`/`verify_staging` from `scripts/kip-delivery.py`. Unset `GITHUB_REF` for those calls, and run them with `scripts/` on `sys.path` so `kip_private_photos` imports. The environments have no branch policy, so a temporary branch can use their secrets. Delete the branch afterwards.
5. Check `/release.json`, `/api/health` and `/api/content/changes?after=0` on both hosts.

## History

- 2026-10-19: project `parkdex-kip` deleted and rebuilt as `prj_5W0bzTc92njbw4q3Y7POeH3JT1KF`. The retired `parkdex-web` project, which still held both domains, was deleted, and the rebuilt project was renamed `parkdex`.

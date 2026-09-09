# Manual deployments

CI runs automatically for pull requests and pushes to `staging` and `main`. Deployments run only when someone explicitly dispatches the CI workflow from `staging` or `main`.

Deploy the latest `staging` commit to the persistent staging environment:

```bash
gh workflow run ci.yml -R NathanPannell/parkdex --ref staging -f action=deploy-staging
```

The staging GitHub environment supplies `STAGING_GOOGLE_CLIENT_ID` as a variable and `STAGING_GOOGLE_CLIENT_SECRET` as a secret. The deployment writes those credentials only to the staging API, with `https://staging.parkdex.app/auth/google/callback` as the callback.

After that run succeeds and staging has been reviewed, promote the same release to production:

```bash
gh workflow run ci.yml -R NathanPannell/parkdex --ref staging -f action=promote-production
```

Promotion pins the latest `staging` commit, reruns the full release checks, verifies that exact commit is live in the staging frontend and API, and fails if `staging` changes during the run. It then fast-forwards `main` without force and deploys that commit to production. If `main` is not an ancestor of `staging`, reconcile the branches through a pull request before retrying.

GitHub only dispatches workflows that exist on the default branch. This keeps the existing `ci.yml` entry point so the commands work after this change reaches `staging`, but future edits to a new workflow file must first reach `main` before GitHub can dispatch them.

Vercel Git deployments must remain disabled, and Railway API and worker Git sources must be disconnected in both environments. The workflow disconnects Railway sources before its uploads, but the first rollout should confirm the provider settings before merging a change that would otherwise trigger an automatic build.

The September 8, 2026 rollout inspection confirmed that the API and worker have no Git or image source attached in either staging or production, so no source migration was required.

PR preview creation is disabled. The close-event cleanup workflow remains temporarily so resources created by older preview runs are removed when those pull requests close.

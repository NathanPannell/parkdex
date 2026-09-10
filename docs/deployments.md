# Manual deployments

Routine validation runs locally against an exact commit and can publish a separate `local-ci` commit status. Hosted validation is an explicit checkpoint; pull requests and pushes do not start the heavy CI, Android, preview, or deployment paths automatically.

Run the local suites from a clean checkout:

```bash
node scripts/local-ci.mjs --sha "$(git rev-parse HEAD)" --suite all
node scripts/merge-candidate.mjs --base origin/staging --head HEAD
```

The local runner removes provider credentials from child processes, uses local PostgreSQL, writes a sanitized attestation outside the repository, and never changes a GitHub check by itself. This is credential separation, not a security sandbox: same-user code can still read local credential files, so run it only against reviewed commits and keep untrusted feature PRs out of credentialed release sessions. Publish a status separately only after reviewing the attestation, using a credential that is not present in the test process:

```bash
export PARKDEX_STATUS_TOKEN='[set outside the test process]'
node scripts/github-status.mjs \
  --repository NathanPannell/parkdex \
  --sha "$(git rev-parse HEAD)" \
  --state success \
  --description "Local exact-SHA validation passed" \
  --target-url https://github.com/NathanPannell/parkdex/actions
```

Run the hosted checkpoint only for an explicit review milestone:

```bash
gh workflow run hosted-checkpoint.yml -R NathanPannell/parkdex --ref staging \
  -f commit_sha="$(git rev-parse HEAD)" -f reason='ready for review'
```

The local release wrapper is dry-run by default and refuses dirty or stale checkouts. Review its exact-SHA plan first; use `-Apply` only with the provider credentials and namespace you intend to create:

```powershell
pwsh -File scripts/local-release.ps1 -Mode Preview -PullRequest 20
```

Preview creation is not automatic. The close-event cleanup workflow remains enabled so resources created by older preview runs are removed when those pull requests close.

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

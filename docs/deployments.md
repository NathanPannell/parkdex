# Manual deployments

Routine validation runs locally against an exact commit and can publish a separate `local-ci` commit status. Hosted validation is an explicit checkpoint; pull requests and pushes do not start the heavy CI, Android, preview, or deployment paths automatically.

Run exact-commit validation from a clean feature checkout. Run merge validation only through the scripts in a separate clean checkout whose `HEAD` is the current `origin/staging`; the command rejects a feature-controlled harness:

```bash
node scripts/local-ci.mjs --sha "$(git rev-parse HEAD)" --suite all
FEATURE_REF=<feature-branch>
FEATURE_SHA="$(git rev-parse "origin/$FEATURE_REF")"
node scripts/merge-candidate.mjs --base origin/staging --head "$FEATURE_SHA" --head-ref "$FEATURE_REF" --suite all
```

The local runner removes provider credentials from child processes, uses local PostgreSQL, writes a sanitized attestation outside the repository, and never changes a GitHub check by itself. This is credential separation, not a security sandbox: same-user code can still read local credential files, so run it only against reviewed commits and keep untrusted feature PRs out of credentialed release sessions. Publish a status separately only after reviewing the attestation, using a credential that is not present in the test process:

```bash
export PARKDEX_STATUS_TOKEN='[set outside the test process]'
node scripts/github-status.mjs \
  --repository NathanPannell/parkdex \
  --sha "$FEATURE_SHA" \
  --head-ref <feature-branch> \
  --state success \
  --attestation <external-attestation-path> \
  --target-url https://github.com/NathanPannell/parkdex/actions
```

Run the hosted checkpoint only for an explicit review milestone:

```bash
gh workflow run hosted-checkpoint.yml -R NathanPannell/parkdex --ref staging \
  -f commit_sha="$(git rev-parse HEAD)" -f reason='ready for review'
```

The local preview path uses a unique `lp-pr-<number>-<sha>-<release>` namespace within Railway's conservative 30-character lowercase alphanumeric-and-hyphen subset, creates an empty Railway environment, instantiates only the two verified project services with a sanitized variable-free patch, and uses a fresh database inside a schema-only Neon branch so migrations and deterministic catalogue seed data run without parent application data. Owned resources are journaled outside the repository before later mutations; deployment, API, worker, protected Vercel content, source, release, and provider identities are verified.

Preview `-Apply` must run from a clean checkout at the freshly fetched `origin/staging`. It requires an explicit full source SHA, open PR targeting `staging`, remote head name, and successful full merge-candidate attestation produced by that trusted staging validator. The runner rechecks the attestation, nested evidence hash, current merge tree, remote branch, and PR identity before provider access. The attestation is the reviewed-source gate; an open PR alone is not authorization. Because same-user reviewed source can still read local credential files, `-Apply` is also the operator's explicit deployment decision and must not be used for untrusted code.

```powershell
$featureRef = '<feature-branch>'
$pullRequest = 123
$featureSha = git rev-parse "origin/$featureRef"
$evidence = Join-Path $env:TEMP "parkdex-merge-candidate-$featureSha.json"
node scripts/merge-candidate.mjs --base origin/staging --head $featureSha --head-ref $featureRef --suite all --output $evidence
pwsh -File scripts/local-release.ps1 -Mode Preview -PullRequest $pullRequest -CommitSha $featureSha -HeadRef $featureRef -AttestationPath $evidence -Apply

# Cleanup remains journal-owned even after the PR closes or its head changes.
$journal = 'C:\Users\me\AppData\Local\Parkdex\release-journal\<release-id>.json'
pwsh -File scripts/local-release.ps1 -Mode Cleanup -StatePath $journal -Apply
```

The isolated proof exercised Neon initialization, Railway/Vercel creation, both service deployments, exact API/worker identity, catalogue isolation, a real-browser map/search/place-details journey, and authoritative cleanup. A Windows shell-boundary failure required the final verification steps to be completed manually on that exact release; the corrected native Node wrapper and protected `vercel curl` path were then accepted from the combined live evidence plus focused synthetic tests, not a second end-to-end provider run.

Successful publication accepts only full merge-candidate evidence and rechecks the remote feature head, current staging base, merge tree, nested evidence hash, and trusted staging copies of the validator and publisher. Its status context includes the staging SHA, so an older success is not a claim about a later staging base; it is informational rather than a fixed branch-protection check.

Local staging `-Apply` remains disabled because the persistent staging mutation path was not covered by the isolated preview proof. Use the reviewed manual GitHub staging workflow below; it targets the existing exact `staging` Railway environment and never creates or copies one. Production remains reachable only through its separate manual promotion gate.

Preview creation is not automatic. The close-event workflow has no access to external release journals, so it makes no provider calls and fails visibly until the authorized coordinator completes exact journal-owned cleanup and verifies every recorded resource absent.

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

GitHub only dispatches workflows that exist on the default branch. This keeps the existing `ci.yml` entry point so the commands work after this change reaches `staging`, but future edits to a new workflow file must first reach `main` before GitHub can dispatch them. A staging-only cleanup-hook change is therefore prepared but inactive until a separately authorized promotion reaches the default branch.

Vercel Git deployments must remain disabled, and Railway API and worker Git sources must be disconnected in both environments. The workflow disconnects Railway sources before its uploads, but the first rollout should confirm the provider settings before merging a change that would otherwise trigger an automatic build.

The September 8, 2026 rollout inspection confirmed that the API and worker have no Git or image source attached in either staging or production, so no source migration was required.

Automatic PR preview creation remains disabled. Explicit attested local previews use their external journal for cleanup; the close-event workflow reports that coordinator-owned cleanup as unresolved rather than guessing provider identities or claiming success.

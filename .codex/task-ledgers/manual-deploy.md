# Manual deployment workflow

Goal: make every staging and production deployment an explicit workflow dispatch, minimize polling, and provide a guarded staging-to-production promotion.

Success condition: CI never deploys on push or pull request; a dispatch deploys one pinned latest `staging` SHA to staging; promotion verifies that exact staged release, fast-forwards `main` without force, and deploys the same SHA to production.

Completed:

- Replaced push-triggered staging/production jobs with `deploy-staging` and `promote-production` dispatch actions in the existing `ci.yml` entry point.
- Kept automatic backend/frontend CI and moved manual release tests to one exact pinned staging checkout.
- Replaced Railway deployment-list polling with parallel `railway up --ci` provider status subscriptions plus a single exact-message assertion.
- Removed automatic PR preview creation and retained close-event cleanup for existing preview resources.
- Added exact Vercel metadata and public page verification and documented operator commands and rollout limits.
- Root disabled the remote `PREVIEWS_ENABLED` repository variable on 2026-09-08; no deployment was run.

Decisions and evidence:

- Dispatch resolves `refs/heads/staging` through GitHub regardless of the selected allowed workflow ref and checks it again before mutation.
- Staging deployment and promotion share one non-cancelling concurrency group, so promotion cannot inspect staging during a staging deploy.
- Promotion requires current `main` to be an ancestor of the staged SHA and updates it with `force=false`; branch protection remains authoritative.
- The feature branch incorporates current `main` ancestry so future merge into `staging` supports the initial fast-forward promotion.
- Vercel repository configuration already has `git.deploymentEnabled: false`.
- Live Railway source state could not be read with the available credentials. The workflow disconnects both sources, and rollout documentation requires a one-time provider check before merge.
- GitHub dispatch requires the workflow path on the default branch. Reusing the already-present `ci.yml` avoids a new-path bootstrap limitation.

Verification completed:

- `actionlint` v1.7.7 passed both workflows.
- Deployment helper mocks passed exact Railway success/missing/failure cases, exact Vercel SHA and readiness rejection, asset checks, and transient API commit readiness.
- Three workflow contract tests passed, and `git diff --check` found no errors.

Independent quality review passed with no blocking findings. PR #15 targets staging; GitHub backend/frontend checks passed on e8ad7ee, and the final alias-retry change 034e71e passed helper tests and is under GitHub CI. No live deployment was run; the first manual staging dispatch after merge remains the provider integration check.

Delivery: https://github.com/NathanPannell/parkdex/pull/15. Implementation and review are complete; await the user-controlled merge into staging, then use the documented manual deployment and promotion commands. Neither staging nor main was merged or deployed by this task.


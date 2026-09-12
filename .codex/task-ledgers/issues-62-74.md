# Issues 62–74 delivery

## Goal and acceptance
- Implement open issues #62, #63, #64, #65, #66, #67, #69, #70, #71, #72, #73, #74 in one PR into `staging` and deploy its exact candidate to `https://staging.parkdex.app`.
- User explicitly excludes #14. #68 is closed/retracted and requests no code change.
- Keep PR open for review; no automatic merge or production promotion.
- All subagents use GPT-6 Astra Ultra, as explicitly requested.
- Complete repository checks, independent code review, and fresh desktop/mobile browser review. Attach candidate screenshots to PR and send one Telegram after verification.

## Workspace and ownership
- Repository: `NathanPannell/parkdex`.
- Working checkout: `C:/repo/every-tree/parkdex-issues-20260912` (fresh clone; the prior nested worktree points to a removed Git directory and was left untouched).
- Base: `staging`, `d863b94`.
- Branch: `fix/issues-62-74`.
- Root: scope, integration, final evidence, PR, notification.
- `issue_plan`: bounded plan and acceptance mapping.
- `staging_deploy`: deployment preparation, execution after checked candidate, resource lifecycle.
- `issue_builder`: sole implementation/data/test owner; independent reviewers assigned after checks.

## Decisions
- Preserve existing visual identity and app behavior while addressing reported defects.
- Use verified official visitor information for #65; reservations are out of scope.
- Deploy exact PR head to persistent staging using existing provider setup; existing workflow pins staging branch, so direct deployment may be needed to avoid merging.
- Preserve record IDs, saved progress, private group boundaries, and independent map/Places filters.

## Completed and evidence
- Read repository instructions, issue bodies and comments, skills, and private learning-log eligibility rules.
- Verified 12 open in-scope issues; #68 closed/retracted; #14 explicitly excluded.
- Created clean staging clone and feature branch.
- Repository/frontend dependency installations completed. Python test imports and local PostgreSQL connection verified. Git Bash available for required shell helper tests.
- Root inspected current staging screenshot: preserve cream panels, forest text/actions, lime accents, existing map/navigation balance.
- Direct PR-source staging deployment is feasible through existing provider upload path; no git branch merge required.
- Planner handoff: `C:/repo/every-tree/issue-batch-plan.md`, all 12 acceptance criteria mapped.
- Independent browser script prepared: `C:/repo/every-tree/issues-62-74-browser-script.md`.
- Deployment preflight passed with no provider mutations; synthetic staging auth fixture can support tests without reset/verification emails.
- Builder completed core navigation/detail/focus changes, compact layout, photo rules, and append-only canonical-name migration.
- Focused evidence: 78 behavior tests pass; lint, typecheck, Impeccable detector, boundary/display/exploration checks pass. Full clean-commit suite is next.
- Final visitor evidence: 175 identity-verified destinations (117 provincial, 2 national, 54 regional, 2 islands). Sooke River Park and 22 islands remain explicitly unverified; no guessed links. Mapping integrated in frontend.
- Canonical-name migration includes a database regression test proving existing visits/group membership retain the original place ID.
- Deployer created an owned synthetic QA fixture with no email; ordinary API login/read passed. Protected credential handoff to the root browser was unavailable, so live review will use existing signed-in session plus only clearly named task-owned QA groups, and root's separate guest browser. No user account/credential changes.
- Hourly coordinator task `01a08383-5fdd-7240-9510-13cb440a81db` notified of sole ownership and agreed scope. Final report owed there.

## Blockers and next action
- No product blockers. Source research complete; builder preparing candidate commit and required full checks.
- Deployer awaiting checked commit and PR. Independent reviewers pending candidate checks.
- Private logs checked: no qualifying new entry or reusable-guidance correction at this milestone.

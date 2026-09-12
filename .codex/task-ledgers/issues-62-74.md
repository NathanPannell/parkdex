# Issues 62–82 delivery (PR #75)

## Goal and acceptance
- Implement open issues #62, #63, #64, #65, #66, #67, #69, #70, #71, #72, #73, #74 in one PR into `staging` and deploy its exact candidate to `https://staging.parkdex.app`.
- User explicitly excludes #14. #68 is closed/retracted and requests no code change.
- Keep PR open for review; no automatic merge or production promotion.
- All subagents use GPT-6 Astra Ultra, as explicitly requested.
- Complete repository checks, independent code review, and fresh desktop/mobile browser review. Attach candidate screenshots to PR and send one Telegram after verification.
- Fold newly filed issues #76–#82 into draft PR #75. Issue #77 is the release-verification meta-issue; product work is #76 and #78–#82. The user now authorizes staging deployment and merge after the gates pass.

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
- #76: long group list/detail names wrap within their container while rename/delete/save actions retain 44px targets at 320px and 390px widths.
- #78: account reset deletes visits, trail completions, ordinary groups, and Wishlist memberships in one transaction, recreates one empty Wishlist, and preserves the account, authentication records/sessions, audit records, guest data, and other accounts. Every HTTP and direct in-process MCP group write locks the same account row as reset. A database-backed race test proves reset waits for an already-started MCP-style group mutation and then removes it.
- #78 frontend: group state is cleared and reloaded only after reset succeeds; a failed reset preserves the cache and surfaces its error.
- #79: Places search is always expanded in the bottom dock and retains an in-place clear action.
- #80: a global, always-present chunky percentage reports catalogue-intersected visited progress to one decimal, with no visible label or gauge. Progress is held at the prior bounded count until the last newly earned badge is claimed, then the number counts to its target; reduced motion settles immediately. Intermediate animation frames are `aria-hidden`, while the progressbar exposes only the last settled percentage/count and stays within 0–100 even when cached visit IDs are stale.
- #81: mobile Locate and collapsed Search are fixed 44px squares; mode columns reserve their space and keep “Find places” unbroken, with icon-over-label presentation at the narrowest width.
- #82: the active Regional chip uses white text on `#8a4300` with state still communicated by selection semantics.
- Candidate verification: frontend focused issue tests 72/72; frontend full suite 186/186; frontend lint and typecheck pass; Next 16.3.4 production build passes. Backend focused issue tests 3/3 and full suite 63/63 pass in owned temporary PostgreSQL databases, which were dropped afterward. The Impeccable detector found one layout-width transition; it was changed to transform-based animation. `git diff --check` passes.
- Independent-review fix cycle: removed the percentage label/gauge, added deterministic animation and reduced-motion behavior tests plus stale-ID/ARIA bounds coverage, instrumented the reset concurrency test with a lock-attempt barrier, and added a forced Wishlist-recreation failure proving the entire reset transaction rolls back visits, trails, ordinary groups, Wishlist membership, and the original Wishlist identity together. Focused review tests pass (frontend 71/71, backend 2/2); refreshed full suites pass (frontend 188/188, backend 64/64); lint, typecheck, and the Next 16.3.4 production build pass; the post-fix Impeccable detector reports no findings.
- Browser-review responsive fix: moved the single global percentage out of the wrapping header and feature-panel stacking contexts into a top-level map-stage overlay. It is pinned to the safe-area-aware top-right above every standard view and group-map mode, while the mobile header reserves its full 92px width. DOM and CSS regressions cover one-instance rendering across Map, Places, Groups, Badges, Account, and group-map navigation plus positioning, stacking, safe areas, and reserved header space.
- Browser-review fix evidence: focused UI tests pass (73/73 across `app/globals.test.ts` and `components/every-park-app.test.tsx`); frontend lint and typecheck pass; the Next 16.3.4 production build passes; the single post-fix Impeccable detector run reports `[]`; and `git diff --check` passes with only the checkout's existing LF-to-CRLF warnings.

## Blockers and next action
- No product blockers. Builder candidate for #76–#82 is ready for independent review and root integration.
- Root should inspect the diff, commit/push the exact candidate, run merge-candidate validation, route any findings back to the builder, and then continue deployment/browser/review/merge gates.
- Private logs checked: no qualifying new entry or reusable-guidance correction at this milestone.

# Catalogue photo coverage pass 2

## Goal

Search every remaining catalogue photo gap using expanded aliases, Wikimedia Commons category and coordinate searches, Openverse commercial-license results, and direct file-level Flickr license checks. Add only place-specific, visually usable photos with explicit CC0, public-domain, CC BY, or CC BY-SA rights and documented location evidence, then open a staging-targeted PR for review without merging or deploying it.

## Baseline

- Branch: `feat/catalogue-photo-coverage-pass2`, based on `origin/staging` commit `fed432c` (merged PR #39).
- Catalogue: 198 places: 2 national, 117 provincial, 55 regional, 24 islands.
- Verified photos: 107 / 198: 2 national, 60 provincial, 21 regional, 24 islands.
- Park coverage: 83 / 174 (47.7%); island coverage: 24 / 24.
- Owned partition: all 57 remaining provincial gaps.
- Partner partition: remaining regional gaps, researched separately under `C:/repo/parkdex-photo-research/regional-pass2`.

## Constraints and decisions

- Search each owned gap systematically; retain queries, attempted sources, accepted evidence, and the reason for every remaining gap.
- Search Commons exact names, documented aliases and features, categories, and coordinate neighborhoods before Openverse and direct Flickr license pages.
- Do not accept nearby-place substitutes, generic scenery without park-specific evidence, NC/ND or unclear licenses, all-rights-reserved files, generated imagery, paid sources, or photos requiring outreach.
- Preserve the existing manifest attribution fields and 320 px / 64 KB thumbnail plus 960 px / 425 KB detail budgets without upscaling.
- Independently verify and visually inspect every partner candidate before integration.
- Preserve `main` and the PR #18/#20 holds; target only `staging`, with no merge or deployment before root review.

## Progress

- Fresh isolated worktree created at `C:/repo/parkdex-worktrees/catalogue-photos-pass2`.
- Confirmed the merged first pass is present and exactly 57 provincial entries remain uncovered.
- Prior exact-name results and withheld decisions loaded from the first-pass reports.
- Official alias constraints recorded for Hathayim / Von Donop and Hwsalu-Utsum / the southern part of Eagle Heights ridge.
- Completed and manually reviewed a first batch of 14 provincial gaps. All 14 were withheld with individual reasons in `.codex/photo-search-report-provincial-pass2.md`; Flores Island initially passed but was removed after independent review found that its island-level caption did not prove the scene was inside the partial-island park.
- Independently reviewed both regional handoffs. Brooks Point coordinates fall inside the official park polygon and its Commons metadata records CC BY 2.0; Stoney Hill's current Flickr caption, CC BY 2.0 link, official CVRD view description, and image subject all match.
- Integrated five optimized photo sets: Brooks Point, Stoney Hill, Mansons Landing, Morden Colliery Historic, and Spider Lake. Coverage is now 112 / 198: 2 national, 63 provincial, 23 regional, 24 islands; park coverage is 88 / 174 (50.6%).
- The focused first batch is committed locally as `c4a1374`. An attempted push was rejected by automatic approval review; root is handling the scoped push using the user's earlier staging authorization.

## Next action

Run the focused manifest and asset-budget checks for the three-candidate residual delta, create a second contact sheet, and commit it for root review. Continue integrating any further verified residual candidates as the independent Openverse/Flickr pass reports them.

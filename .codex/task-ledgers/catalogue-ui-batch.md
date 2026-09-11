# Catalogue UI batch: issues 40–47

## Goal and base

- Implement issues #40–#47 on `feat/catalogue-ui-batch`, based on `origin/staging` `69ee27a`.
- Target `staging` only. Do not touch `main`, PR #18, PR #20, or backlog #14.
- Preserve Parkdex's established field-guide visual system and legacy storage/API behavior.

## Acceptance matrix

| Issue | Required behavior | Owner |
| --- | --- | --- |
| #40 | One desktop nav; remove nav counts/groups and tinted desktop nav backing; equal utility controls; mobile dock clearance | this branch |
| #41 | Exhaustive keyword suggestions; Enter, glass, or chevron applies/collapses without clearing; active-filter yellow indicator | this branch |
| #42 | Account visited-place shelves and modal rows show catalogue photos when available | this branch |
| #43 | Mobile detail hides utility; compact title and layout with 2/3 image and 1/3 stacked claim/wishlist/group icon actions; no lower actions; 10% map margin | detail/CSS here; map fit partner |
| #44 | Name-only group creation; inline title rename; styled delete confirmation; place search plus map-add flow; accessible dark map button; member titles open map credits; no inline photo credits; active-tab reset | this branch |
| #45 | Mobile-only reset-map control visible after broad camera movement/group fit, hidden for selected place | map partner; CSS here |
| #46 | Near You contains unvisited places only; full wrapping names; distance beside category/region; revised explanatory copy | this branch |
| #47 | Remove Browse by collection; no forced tab scrollbar; collections closed initially; search filters within collections and combines with toggles; rename headings and remove subtitles | this branch |

## Shared map contract

- `park-map.tsx` requires no new props. Its existing `selectedId` identifies a focused place.
- The map worker owns measured place-sheet fit padding, overview-camera reset state, `.map-reset-button` markup, and focused map tests.
- This branch owns `.map-reset-button` mobile styling and does not edit `park-map.tsx`.

## Baseline evidence

- Root browser inspection confirmed both desktop navbars render together, the desktop header nav has a tinted inner background and counts, and the locate control is smaller/top-aligned.
- Issue screenshots and current source confirm mobile search loses its filter on collapse, collection search replaces collection context, group creation requires initial places, delete uses `window.confirm`, and account place shelves fall back to pin circles.

## Verification plan

- Meaningful component tests for persistent map search, exhaustive results, nav reset, account photos, compact detail actions, group flows, near-you metadata, and collection behavior.
- Existing focused map tests from the map worker plus typecheck/build.
- One batched browser inspection at desktop and mobile widths with isolated synthetic browser state, followed by one correction/confirmation round if needed.
- Run the Impeccable detector once after UI edits.

## Implementation checkpoint

- #40–#47 UI behavior is implemented across the app shell, account shelf, detail card, groups, Nearby, and collections; the map worker's measured fit/reset behavior is integrated.
- The focused component and map suite passes 39/39; TypeScript and targeted ESLint pass. The production build passes with webpack. Turbopack cannot traverse the worktree's external dependency junction, an environment-only limitation.
- Impeccable detector returned no findings for the changed UI targets.
- Baseline evidence is tracked under `docs/evidence/issues40-47/before`; authenticated #42/#44/#47 baseline states remain issue-authored because the public guest cannot access them.
- Active: browser after-state capture at 1440×900, 390×844, and 320px; authenticated workflows require a bounded local fixture or safe staging API connection before final review.

## Final review corrections

- Mobile offline and sync notices now sit above the map utility, and map search/filter results reserve the utility's full open height.
- An already-active Map tab sends an explicit overview-reset request; closing a selected place does not reset the camera. Small selected boundaries may use the map's actual maximum zoom while retaining the measured fit padding.
- `docs/evidence/issues40-47/after/fixture-review.cjs` runs a stateful, isolated authenticated browser fixture with synthetic account and group data; it produces photo and group-flow screenshots without accessing shared user data or staging credentials.
- Focused app/map tests pass 40/40, TypeScript passes, targeted ESLint passes, and the Impeccable detector reports no findings. Browser reviewer retest is active for the map-reset, small-boundary, notice, search-clearance, Nearby, and group/account flows.
- The reviewer confirmed the group screen hides inline photo attribution while its title-to-map path keeps attribution available; the styled confirmation and map actions remain intact.

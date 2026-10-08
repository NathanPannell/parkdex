# Verify a new claim while signed in

Recorded: before 2026-10-07. Applies to: claims, accounts, progress hydration and sync.

## What went wrong

Changes to claims and account sync were checked with guest claims that were attached to an account later. That path skips the signed-in claim flow and the sync refresh that follows it. Duplicated claims and missing celebrations or photos after a refresh could therefore pass review.

## Rule

For any change to claims, accounts or progress hydration, make a new claim while signed in with backup active. Watch the full celebration and photo after the sync refresh that follows. Confirm that one deliberate claim produces exactly one stored claim.

## How to check

On the preview, sign in with backup on, claim one park, and wait for the sync refresh. Confirm the celebration and photo still show, and that the account has one new claim row for that park. A guest claim attached later does not count.

## History

- 2026-10-07: moved from the workspace AGENTS.md.

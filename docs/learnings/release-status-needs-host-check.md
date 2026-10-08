# A merged PR is not a release

Recorded: before 2026-10-07. Applies to: answering "is it live?" for staging or production.

## What went wrong

Features were reported as available because their PR had merged and the deploy workflow had succeeded. The workflow only dispatches, though. Alias assignment and browser verification come later, and the stable host could still be serving an older release.

## Rule

Before saying a feature is available, read the stable host's release and API revision signals, and check the requested UI there. If alias assignment or browser verification is still pending, say so. This applies even when another session owns the delivery.

## How to check

Fetch `/release.json` and `/api/health` on the stable host and compare the SHA with the merge SHA. Then open the feature on that host.

## History

- 2026-10-07: moved from the workspace AGENTS.md.

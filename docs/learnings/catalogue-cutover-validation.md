# Validate every park through claim and backup before a catalogue cutover

Recorded: before 2026-10-07. Applies to: catalogue releases that add park categories or field values.

## What went wrong

A catalogue release can render correctly and pass the public content API while its new field values still fail validation elsewhere. They can fail the app's local claim snapshot validation or the account API contract. The failure then shows up only when someone claims that park or restores a backup.

## Rule

Before publishing, validate every release park against both the local claim snapshot validation and the account API contract. Then make a real claim of the release's completed badge, and carry it through local save, signed-in backup and restore.

## How to check

Run the snapshot and account contract validators over the full release catalogue. Then on the preview, claim the completed badge, confirm the backup while signed in, and restore it on a fresh install. Rendering the image and a passing content API are not enough.

## History

- 2026-10-07: moved from the workspace AGENTS.md.

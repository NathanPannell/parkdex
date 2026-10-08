# Import complete park geometry, not one source feature

Recorded: before 2026-10-07. Applies to: park boundary imports (`docs/legacy-park-import.md`, `scripts/import_legacy_parks.py`).

## What went wrong

The legacy catalogue API exposes a single `sourceId` per park. Many parks are made of several source features, secondary regions and holes. An import based on that one ID produced a valid, nonempty polygon that was still missing parts of the park. Check-ins in those parts failed.

## Rule

Use the legacy app's complete displayed geometry and source grouping. For every selected park, compare these by stable ID: source feature IDs, polygon count, hole count and spatial coverage. Preserve every region and hole, and keep reproducible import provenance.

## How to check

Run the import comparison and confirm that feature IDs, polygon counts, hole counts and coverage all match for every park. Test a location check inside a secondary region and inside a hole. A valid nonempty polygon alone does not prove the boundary is complete.

## History

- 2026-10-07: moved from the workspace AGENTS.md.

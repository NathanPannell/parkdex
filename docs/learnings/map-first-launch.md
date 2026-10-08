# Test map changes on a fresh install with slow or blocked tiles

Recorded: before 2026-10-07. Applies to: map downloads, tile packaging and map startup (`src/lib/offlineTiles.ts`, `src/lib/mapStartup.ts`).

## What went wrong

Map changes were tested on devices that already had a populated tile cache, or with a download that eventually succeeded. On a real first launch with slow or blocked detailed tiles, the map could be blank or need a reload before it became useful.

## Rule

Test a fresh install with no downloaded map files, and with detailed tiles deliberately delayed or blocked. A useful basemap must appear with the first park pins and stay visible offline. It must gain detail without a reload or a camera reset.

## How to check

Clear app data or use a new emulator, then block or throttle the tile host. Open the app and confirm the basemap and pins appear. Go offline and confirm the map stays. Restore the network and confirm detail fills in without reloading or moving the camera.

## History

- 2026-10-07: moved from the workspace AGENTS.md.

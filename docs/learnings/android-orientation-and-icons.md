# Check rotation and adaptive icon masks, not just signing

Recorded: before 2026-10-07. Applies to: Android orientation settings and launcher icons (`android/app/src/main`).

## What went wrong

Signing and archive checks passed while the visible app was still wrong. One problem was a pre-rounded app tile placed inside the adaptive icon, which looks wrong under device masks. The other was orientation that did not hold after a rotation.

## Rule

Keep the main activity portrait after a device rotation. Build adaptive icons from a separate full-bleed background and a transparent foreground. Never put a pre-rounded tile inside the adaptive icon.

## How to check

On an emulator or device, rotate with the app open and confirm it stays portrait. Inspect the launcher icon under circle, squircle and rounded-square masks. Signing and archive checks do not replace these visual checks.

## History

- 2026-10-07: moved from the workspace AGENTS.md.

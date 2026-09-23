# PR 107 Android field evidence

These crops compare the tester-reported Android build with the staging-connected emulator build from this branch.

## One-step Bell Park claim

- `claim-flow-before.jpg`: tester evidence from the prior build, stuck in the separate postcard finishing state.
- `claim-flow-after.jpg`: authenticated emulator at Bell Park, showing automatic geofence recognition and the single `Claim + photo` action.

## Bounded location feedback

- `location-feedback-before.jpg`: tester evidence from the prior build while location state was unclear.
- `location-feedback-after.jpg`: emulator with the device location provider disabled, showing the short-lived field diagnostic and its `Details` action.

The release gate supplies the machine-readable native Camera, multipart upload, postcard readback, reset, repeated cold-start, motion, provider recovery, and staging R2 evidence. The screenshots are supporting UI evidence, not substitutes for those oracles.

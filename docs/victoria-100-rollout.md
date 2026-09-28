# Victoria 100-park authoring rollout

This rollout replaces the active public catalogue with the curated 100 parks near Victoria, preserving personal collections and immutable earned artwork. The initial catalogue contains skeleton records for all 100 parks. Beacon Hill Park receives the first completed badge, then one queued park is researched and published each hour.

The existing Changes API delivers public catalogue edits. Badge images remain immutable R2 objects. A normal publication verifies the uploaded badge before updating the park and its asset descriptor in one Neon transaction. This workflow does not republish complete catalogue files or map data for each park.

The source queue is the previously reviewed ordered list, `victoria-top-100-staging-2026-09-27.json`. Its exact park IDs are retained. Travel estimates are approximate and measured from Victoria City Hall. Boundaries must come from the actual staging source records, not invented circles around pins.

The hourly authoring process must inspect at least five distinct Google Images references for the selected park, verify factual description sources, and follow the `park-badges` skill's `flat-cartoon-v1` style, actual-reference input rules, three initial compositions and at most two correction rounds. Save research, prompts, inputs, candidates, thumbnail review and the selected image with each run.

Only one queue item may be owned by a run. Publication and queue completion must be repeat-safe so interruptions cannot publish the wrong image or process a second park during the same hourly run. Failures retain evidence for recovery. Personal account data, claim snapshots, photos and previously registered R2 scene descriptors are outside the active catalogue replacement.

This rollout targets staging. The separate production promotion remains an explicit release decision.

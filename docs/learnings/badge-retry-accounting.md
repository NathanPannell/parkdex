# Reconcile every call before granting or using a badge retry

Recorded: before 2026-10-07. Applies to: badge art retries and style-held reviews.

## What went wrong

Retry allowances were checked only against canonical records. A canonical record kept for a historical QA hash can describe only the first call, so later calls in revision-specific receipts and approval handoffs were missed. A later candidate's verdict could also be applied to an earlier image. The set of badges to retry was also built from a fixed list of status names, which missed some held badges.

## Rule

- Before granting or consuming a retry, reconcile actual calls across revision-specific receipts, approval handoffs and canonical records.
- Keep reviewed image hashes and selected image paths explicit, so each verdict is tied to one image.
- For "retry every style-held badge", derive the set from all current material style holds, including independent dissent and unselected attempts. Do not filter by a fixed list of status names. Preserve conflicting reviews, and verify the actual unused allowance before rendering.

## How to check

For each badge, list every call ID with its hash and verdict, and confirm the remaining allowance before you start a render.

## History

- 2026-10-07: moved from the workspace AGENTS.md. Per-park badge art is being retired.

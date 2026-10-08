# Round the coloured header cell itself in Gmail HTML

Recorded: before 2026-10-07. Applies to: branded HTML emails and drafts composed in Gmail (`worker/emails.ts`).

## What went wrong

Gmail did not clip a coloured header to the rounded corners of the outer table. The header's top corners rendered square over the rounded card.

## Rule

Put the border radius on the coloured header cell itself, not only on the outer table.

## How to check

Paste or send the email, then open the saved draft or received message in Gmail. Inspect both top corners visually before delivery.

## History

- 2026-10-07: moved from the workspace AGENTS.md.

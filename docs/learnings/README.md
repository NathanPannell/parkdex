# Learnings

Each file records one lesson: what went wrong, the rule that came out of it, and how to check it. They are short so they can be shared on their own.

AGENTS.md says how the repository works. A learning says why a rule exists. When a learning can be checked by a script, add the check to `scripts/kip-delivery.py ci-checks` (or a test it runs). Note the check in the learning so the rule enforces itself.

## Adding a learning

1. Create `docs/learnings/<topic>.md` using the template below.
2. Add one row to the Learnings table in `AGENTS.md`, naming the area it applies to.
3. If a later lesson changes the rule, edit the existing file and add a dated line under "History". Do not create a second file.

```markdown
# <Short title>

Recorded: YYYY-MM-DD. Applies to: <area or files>.

## What went wrong

<Two or three sentences. What happened and why it was missed.>

## Rule

<What to do now, stated as an instruction.>

## How to check

<The command, test or manual step that proves the rule was followed.>

## History

- YYYY-MM-DD: created.
```

Files moved from the workspace AGENTS.md on 2026-10-07 do not record their original dates.

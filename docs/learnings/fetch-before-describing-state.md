# Fetch before describing what the project has

Recorded: 2026-10-07. Applies to: planning, status answers and architecture summaries.

## What went wrong

A roadmap was planned from the canonical checkout, which was 144 commits behind `origin/staging` and had uncommitted changes. The plan said there was no production environment, no park proposals and no social features. In fact production was live at `web.parkdex.app`, long-press park proposals had shipped, and a friends leaderboard PR was open.

## Rule

Before describing the current state, run `git fetch origin` and read from `origin/staging` (or `origin/main` for production), not the local branch. Also list open PRs. Shared checkouts are often behind because many agents work in separate worktrees.

## How to check

`git status --short --branch` shows no `behind` count for the branch you read, and `gh pr list` has been checked for in-flight work.

## History

- 2026-10-07: created.

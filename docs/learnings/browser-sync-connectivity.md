# Test sync with normal connectivity and without the Network Information API

Recorded: before 2026-10-07. Applies to: browser content downloads, account backup and photo upload.

## What went wrong

A browser sync fix passed only with a temporary Wi-Fi override. Desktop browsers without the Network Information API were never tested. Photos saved before the account migration also stayed queued forever, and this was accepted because newly captured photos uploaded fine.

## Rule

Verify content downloads and account backup separately, once with normal browser connectivity and once with no Network Information API. Include existing local photos from before the account migration, including the supported recovery of old demo images.

## How to check

Run both journeys in a desktop browser without forcing a connection type. A Wi-Fi override does not count. Seed old local photos first, and confirm they upload or recover. A permanently queued legacy photo is a failure.

## History

- 2026-10-07: moved from the workspace AGENTS.md.

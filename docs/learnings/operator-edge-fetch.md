# Worker modules in the operator dashboard hit Edge fetch limits

Recorded: 2026-10-12. Applies to: anything in `operator/server/` that calls `fetch`, directly or through a `worker/` module it imports.

## What went wrong

The operator dashboard runs as a Vercel Edge Function. Edge refuses some `RequestInit` fields with a TypeError before any request is sent: `cache`, `keepalive`, `priority` and `redirect: "error"`.

This bit us twice:
- **Updates page (#135):** its R2 and CDN reads used `cache` and `redirect: "error"`. Fixed with `r2.ts`'s outbound helper.
- **Account deletion (#166):** `worker/accounts/photos.ts` sends every photo service call with `redirect: "error"`. That is fine in the app's Node API. From the dashboard it threw on every call, and `deleteAccountData` caught the error and recorded a failed attempt. So every deletion stayed in "Deletions in progress" and never reached the photo service. Accounts with no photos showed "None yet", because there were no photo rows to record an error on. PostHog queries had the same option.

## Rule

- Any `fetch` that can run in the dashboard sends only `redirect: "manual"` (or none), with no `cache`, `keepalive` or `priority`. Treat a 3xx or `opaqueredirect` as a failure, so a redirect is never followed.
- When the dashboard calls a `worker/` module that fetches, pass it `edgeSafeFetch` from `operator/server/analytics/deletion.ts`, or a wrapper like it. Do not change the worker module's options for the Node API's sake.
- Cover each new outbound path with a test through `strictEdgeFetch` (`operator/server/app/fakeCloud.ts`), and assert `violations` is empty. A catch further down can hide the TypeError.

## How to check

The tests in `operator/server/analytics/deletion.test.ts` and `posthog.test.ts`, and the Updates tests, all run through `strictEdgeFetch`.

## History

- 2026-10-09: Updates page (#135).
- 2026-10-12: account deletion and PostHog (#166).

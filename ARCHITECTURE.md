# Deployment architecture

## Persistent environments

Staging and production have the same long-lived topology and the same queue-only deployment implementation:

```text
Vercel frontend ──HTTPS──> Railway API ──pooled SQL──> Neon branch
       /mcp + OAuth proxy ────────┘
                          API migrations ──direct SQL──> Neon branch
```

Production uses `parkdex.app`, its production Railway environment, and the Neon `main` branch. Staging uses `staging.parkdex.app`, its isolated Railway environment, and the persistent Neon `staging` branch. The public MCP identities are `https://parkdex.app/mcp` and `https://staging.parkdex.app/mcp`; Vercel proxies the MCP transport and root OAuth/discovery routes to each environment's stable Railway API. Railway service domains and Neon connection strings remain fixed during ordinary releases.

## Android client

The Android app is a Capacitor shell containing a mobile-only static export of the same Next.js interface deployed to Vercel:

```text
Capacitor Android app ──HTTPS──> Railway API ──pooled SQL──> Neon branch
        bundled Next.js UI
```

The normal web build remains server-capable. `PARKDEX_ANDROID_BUILD=1` enables static export and unoptimized local images only for the bundled Android build. The first internal APK targets the persistent staging API and uses email/password authentication; native OAuth callbacks, secure credential storage, device capabilities, geofencing, release signing, and store distribution are separate milestones.

Android builds and emulator verification run locally. Repository workflows do not build or publish Android artifacts.

## Release behavior

`.github/workflows/deploy-release.yml` is the sole GitHub deployment implementation. Protected-branch merge pushes to `staging` and `main` provide an exact Git SHA and environment name; there are no manual, pull-request, scheduled, or rerunnable Actions deployment paths. One GitHub-hosted job stamps the SHA and release ID, then concurrently runs a detached Railway API upload and a no-wait staged Vercel Production deployment. It waits only for those client submissions to finish, not for provider builds or health.

Before merge, an agent creates an isolated preview of the exact draft-PR head from a clean checkout at the current remote `staging` revision. The local preview path first validates the synthetic merge candidate, then creates a schema-only Neon branch and database, an empty Railway environment containing only the API, and an immutable Vercel Preview deployment. A durable external journal binds every resource to the PR, head SHA, and release ID.

The agent browser-tests that immutable URL, tears the preview down, and waits for authoritative absence inventories from Vercel, Railway, and Neon. Only then may the unchanged PR merge into `staging`; the merge push queues the normal persistent staging deployment. No GitHub Actions job creates, tests, or deletes PR previews.

Preview environments receive no persistent application or provider credentials. Railway receives only the isolated database credentials and public/release values needed by that preview, and the Vercel project must have no configured Preview environment variables. Vercel platform system variables may still exist, so this lifecycle is limited to same-repository branches authored or reviewed by the trusted operator/agent; it is not an adversarial-code sandbox. Google OAuth and outbound email are intentionally unavailable in previews. Persistent staging and production retain their own OAuth, email, database, and domain configuration.

Both Vercel targets use `--prod --skip-domain`, so the provider build path is identical. After external verification, the release agent assigns only the target's exact domain: `staging.parkdex.app` for staging or `parkdex.app` for production. The staging domain is deliberately not a Git branch domain so Hobby deployment protection leaves MCP public. Because both stable domains are production-domain aliases in one Vercel project, project-wide promote/rollback operations are prohibited; production assignment must also prove the staging alias stayed unchanged. Vercel and Railway Git auto-deployments stay disabled to prevent duplicate releases.

A queue acknowledgment is not evidence that a release is live. Outside GitHub Actions, the release agent verifies the exact Railway API release, `/ready`, migration readability, Vercel metadata, the stable frontend revision, and a real-browser journey.

## Compatibility during convergence

API, frontend, and database updates can become active in any order. Every release must therefore preserve N/N-1 compatibility:

- Add schema before code needs it; remove obsolete schema only in a later release.
- Keep old and new API request/response shapes compatible during the rollout.
- Never use an unattended destructive migration.

The API invokes `python -m backend.app.migrate` as a Railway pre-deploy command and receives `DATABASE_URL_UNPOOLED`. The migrator's advisory lock serializes concurrent attempts, and its checksums make already-applied migrations no-ops.

## Release ownership and recovery

Only one release may be in flight per environment. GitHub Actions concurrency prevents overlapping submission jobs, while the release agent prevents a second release until provider convergence is resolved.

After a failure, retry the same SHA once when the cause is a diagnosed transient or narrowly scoped deployment problem. Otherwise freeze releases and prepare a last-known-good code rollback plan. Provider rollback never implies database rollback, and persistent Neon branches, Railway environments, and stable domains are not teardown targets.

See [Independent staging and production deployments](docs/deployments.md) for the operational sequence.

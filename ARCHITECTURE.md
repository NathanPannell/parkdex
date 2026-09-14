# Deployment architecture

## Persistent environments

Staging and production have the same long-lived topology and the same queue-only deployment implementation:

```text
Vercel frontend ──HTTPS──> Railway API ──pooled SQL──> Neon branch
       /mcp + OAuth proxy ────────┘
                         Railway worker ────────────> Neon branch
                         API + worker migrations ──> direct Neon connection
```

Production uses `parkdex.app`, its production Railway environment, and the Neon `main` branch. Staging uses `staging.parkdex.app`, its isolated Railway environment, and the persistent Neon `staging` branch. The public MCP identities are `https://parkdex.app/mcp` and `https://staging.parkdex.app/mcp`; Vercel proxies the MCP transport and root OAuth/discovery routes to each environment's stable Railway API. Railway service domains and Neon connection strings remain fixed during ordinary releases.

## Release behavior

`.github/workflows/deploy-release.yml` is the sole GitHub deployment implementation. Protected-branch merge pushes to `staging` and `main` provide an exact Git SHA and environment name; there are no manual, pull-request, scheduled, or rerunnable Actions deployment paths. One GitHub-hosted job stamps the SHA and release ID, then concurrently runs detached Railway uploads for the API and worker and a no-wait staged Vercel Production deployment. It waits only for those client submissions to finish, not for provider builds or health.

Before merge, an agent deploys the exact reviewed and locally attested pull-request head from a clean checkout at the current remote `staging` revision. That local path uses the same persistent staging resources and release identity, waits outside GitHub Actions for convergence, and never rewrites stable database, domain, OAuth, or service configuration.

Both Vercel targets use `--prod --skip-domain`, so the provider build path is identical. After external verification, the release agent assigns the staging deployment to `staging.parkdex.app` or promotes the production deployment to `parkdex.app`. Vercel and Railway Git auto-deployments stay disabled to prevent duplicate releases.

A queue acknowledgment is not evidence that a release is live. Outside GitHub Actions, the release agent verifies the exact Railway API and worker releases, `/ready`, migration readability, Vercel metadata, the stable frontend revision, and a real-browser journey.

## Compatibility during convergence

API, worker, frontend, and database updates can become active in any order. Every release must therefore preserve N/N-1 compatibility:

- Add schema before code needs it; remove obsolete schema only in a later release.
- Keep old and new API request/response shapes compatible during the rollout.
- Keep the worker compatible with both schema versions.
- Never use an unattended destructive migration.

The API and worker both invoke `python -m backend.app.migrate` as a Railway pre-deploy command and both receive `DATABASE_URL_UNPOOLED`. The migrator's advisory lock serializes concurrent attempts, and its checksums make already-applied migrations no-ops.

## Release ownership and recovery

Only one release may be in flight per environment. GitHub Actions concurrency prevents overlapping submission jobs, while the release agent prevents a second release until provider convergence is resolved.

After a failure, retry the same SHA once when the cause is a diagnosed transient or narrowly scoped deployment problem. Otherwise freeze releases and prepare a last-known-good code rollback plan. Provider rollback never implies database rollback, and persistent Neon branches, Railway environments, and stable domains are not teardown targets.

See [Independent staging and production deployments](docs/deployments.md) for the operational sequence.

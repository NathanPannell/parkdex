# Deployment architecture

## Production

```text
Vercel frontend ──HTTPS──> Railway API ──pooled SQL──> Neon production
                         Railway worker ──pooled SQL──> Neon production
                         API migrations ──direct SQL──> Neon production
```

GitHub Actions owns production deployment after CI. It stamps both Railway services with the commit SHA, deploys them, waits until `/ready` reports that exact SHA and a readable migration table, then deploys Vercel once with the resulting API URL. It writes the actual Vercel production URLs into Railway's exact CORS allowlist, then redeploys the API.

The production allowlist always retains `https://parkdex.app` and `https://www.parkdex.app` alongside the generated Vercel origins. A manual production job can run only when the workflow ref is `main` and the operator selects the production target.

## Staging

```text
staging.parkdex.app ──HTTPS──> Railway API (staging) ──pooled SQL──> Neon staging
                              Railway worker ─────────pooled SQL──> Neon staging
                              API migrations ─────────direct SQL──> Neon staging
```

The Neon branch and Railway environment are long-lived and separate from production. The Neon branch has no expiration; its compute scales to zero after five idle minutes to control cost. Pushes to `staging` deploy that exact commit automatically. A manual CI run from a reviewed feature ref can provide the initial feature deployment; the next push to `staging` replaces it normally. CI checks and deployment always use the same checked-out ref.

The workflow disconnects inherited Railway Git sources so a `main` push cannot auto-deploy to staging. It uploads the checked-out source to both Railway services, waits for the exact deployment marker and `/ready` commit, then creates a Vercel preview deployment and moves the stable `staging.parkdex.app` alias to it. Railway trusts only that alias and the current generated staging deployment URL.

## Pull request N

```text
Vercel preview ──HTTPS──> Railway API (pr-N) ──pooled SQL──> Neon preview/pr-N
                          Railway worker (pr-N) ──pooled SQL──> same branch
                          API migrations ──direct SQL────────> same branch
```

The workflow creates or reuses deterministic `pr-N` resources. It gives the pooled URL to both services and the direct migration URL only to the API. Vercel Git auto-deployment is disabled, so the workflow creates exactly one frontend preview after the matching API is ready. It then writes that exact preview URL into Railway's CORS allowlist before a final API redeploy.

On close or merge, GitHub Actions deletes the namespaced `pr-N` Railway environment, `preview/pr-N` Neon branch, and recorded Vercel deployment. An explicit namespace check prevents that job from targeting staging. Neon preview branches also expire after seven days as a leak backstop. Fork PRs do not deploy. Same-repository previews deploy only when both the PR author and workflow actor match `TRUSTED_PREVIEW_ACTOR`, the GitHub user that ran the bootstrap.

## Credentials and ownership

The local bootstrap identity uses broad credentials only long enough to create one project per provider. It then stores repository automation tokens in GitHub secrets, provider IDs in GitHub variables, and runtime database URLs directly in Railway. Production, staging, and preview reuse the existing provider project and service IDs while keeping environment-specific database URLs in Railway. Broad bootstrap credentials and database URLs are never committed.

`DATABASE_URL` is the pooled runtime connection in production and staging; each Railway environment stores its own value. `PREVIEW_DATABASE_URL` is the pooled preview connection. The corresponding `*_UNPOOLED` variables are direct migration connections. A preview refuses to fall back to production credentials.

## Recovery rules

Re-running a failed workflow is safe because staging and PR names are deterministic and migrations are append-only, checksummed, and advisory-locked. A Railway restart reuses the current image; it is not proof that new code deployed. Trust `/ready` only when its `commit` equals the requested Git SHA.

A browser CORS warning paired with HTTP 500 usually means the API failed before middleware produced a normal response. Inspect Railway API and migration logs first, then verify the preview database variables, direct migration URL, and exact `FRONTEND_ORIGINS` value.

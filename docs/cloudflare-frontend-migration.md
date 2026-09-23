# Cloudflare frontend migration

Parkdex can move its frontend to Cloudflare Pages without transferring the `parkdex.app` registration away from Vercel. The registrar and the authoritative DNS/hosting provider are independent. Production remains on Vercel until the Pages deployments, DNS zone, and stable app hostnames have been verified. The apex and `staging.parkdex.app` belong to the landing site; the app origins are `web.parkdex.app` and `staging.web.parkdex.app`.

## Target topology

Use two Git-integrated Pages projects so staging and production have independent production deployments and rollback histories:

| Environment | Pages project | Production branch | Stable hostname |
| --- | --- | --- | --- |
| staging | `parkdex-staging` | `staging` | `staging.web.parkdex.app` |
| production | `parkdex-production` | `main` | `web.parkdex.app` |

The production app origin is `web.parkdex.app`; the target MCP OAuth issuer remains `parkdex.app` so configured clients can retain their identity. Keep `www.parkdex.app` on the landing site and redirect it to the apex while preserving the complete path and query string. The landing origins also need to forward old account-link fragments and provide the guest-progress handoff before users continue at the app origin. Before DNS cutover, verify the no-domain landing deployment serves environment-specific JSON metadata at `/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource/mcp` with the exact legacy issuer/resource values and JSON content types. Vercel does not support rewrites for `/.well-known`; route the other seven paths (`/authorize`, `/token`, `/register`, `/revoke`, `/oauth/consent`, `/mcp`, and `/mcp/*`) to the matching Railway API. Treat the preserved issuer/resource topology as unverified until those checks pass.

The frontend is a Next.js static export in `frontend/out`. Cloudflare uses `npm run build:cloudflare`, which sets `NEXT_PUBLIC_API_BASE_URL=.` and stamps the provider's exact Git SHA. Browser API requests remain same-origin; a scoped Pages Function forwards `/api/*`, MCP, and OAuth traffic to each project's `API_BASE_URL` environment variable. This makes immutable `pages.dev` previews testable without adding every preview hostname to Railway CORS. Always use the npm scripts; calling `next build` directly skips the MapLibre worker copy and the post-build Pages contract check.

Pages project settings are deliberately provider-managed instead of being read from a shared `frontend/wrangler.jsonc`. A shared deployable Wrangler file cannot safely describe two production-class Pages projects because its top-level variables would be applied to both. The intended project settings live in `deploy/cloudflare-pages.json`: each project gets only its own production `API_BASE_URL`, previews remain disabled, Functions fail closed, and the compatibility date is pinned. Keep credentials in Cloudflare's encrypted secret store; the API origins in this manifest are public routing configuration.

## Verified local commands

```powershell
Set-Location frontend
npm ci
npm test
npm run lint
npm run typecheck
npm run build:cloudflare
npm start -- --port 8788
```

The post-build check verifies the callback page, Cloudflare headers, MapLibre worker, GeoJSON data, and a representative image. The generated HTML contains `parkdex-release` and `parkdex-commit` metadata for exact-revision verification.

## Deployment mechanics

Cloudflare Pages cannot promote a preview deployment to production. Preserve Parkdex's verify-before-cutover behavior through branch controls and exact-revision verification:

1. Connect `parkdex-staging` to the repository with `staging` as its production branch, the staging API origin as its production `API_BASE_URL`, and preview deployments disabled.
2. Connect `parkdex-production` with `main` as its production branch, the production API origin as its production `API_BASE_URL`, and preview deployments disabled.
3. For each candidate, verify the immutable `pages.dev` URL, project/branch/commit metadata, `parkdex-artifact.json`, the API proxy, and the browser journey.
4. Merge through the protected branch flow, then verify the new stable staging or production deployment before any DNS change.
5. Retain the prior production deployment as the rollback target.

During provider bootstrap only, `parkdex-staging` temporarily uses `chore/cloudflare-frontend` as its production branch so the Cloudflare-specific build command exists before the feature is merged. Change it to `staging` immediately after the migration PR lands. Keep the existing isolated Railway/Vercel preview lifecycle during the migration; ordinary Pages previews cannot safely share a persistent staging API with unmerged code.

Do not replace the existing Vercel release workflow until both Pages projects and this artifact flow have been exercised successfully.

## DNS cutover checklist

1. Keep Vercel serving the frontend and export every current DNS record.
2. Add `parkdex.app` to Cloudflare and manually reconcile the scan with the Vercel inventory. Preserve MX, SPF, DKIM, CAA, API, and authentication-related records.
3. Deploy and verify both Pages projects on `pages.dev` before changing DNS.
4. Check DNSSEC at the parent. If a Vercel-era DS record exists, remove it and wait for its TTL to expire before changing nameservers; a stale DS record can make the domain return `SERVFAIL`.
5. In Vercel's registrar settings, replace the Vercel nameservers with the two nameservers assigned by Cloudflare. Keep frontend DNS records pointing to Vercel during the initial delegation verification.
6. Verify public delegation, certificates, mail records, API resolution, and the existing Vercel-hosted site.
7. Cut only `staging.web.parkdex.app` to `parkdex-staging` and browser-test the map, assets, account/API traffic, callback error path, console, and network. Keep `staging.parkdex.app` on the landing site.
8. After staging soaks, cut `web.parkdex.app` to `parkdex-production` and keep the apex on the landing site. Exercise an OAuth cancellation or successful sign-in and verify the public MCP metadata and transport root through the landing proxy.
9. Retain the Vercel project and its known-good deployment for 7–14 days before removing aliases or deployment credentials.

Registrar transfer is optional and intentionally excluded from the hosting cutover.

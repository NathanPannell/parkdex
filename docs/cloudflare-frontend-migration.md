# Cloudflare frontend migration

Parkdex can move its frontend to Cloudflare Pages without transferring the `parkdex.app` registration away from Vercel. The registrar and the authoritative DNS/hosting provider are independent. Production remains on Vercel until the Pages deployments, DNS zone, and stable hostnames have been verified.

## Target topology

Use two Direct Upload Pages projects so staging and production have independent production deployments and rollback histories:

| Environment | Pages project | Production branch | Stable hostname |
| --- | --- | --- | --- |
| staging | `parkdex-staging` | `staging` | `staging.parkdex.app` |
| production | `parkdex-production` | `main` | `parkdex.app` |

The apex `parkdex.app` is the canonical production site and OAuth issuer. Redirect `www.parkdex.app` permanently to the apex while preserving the complete path and query string. This keeps the browser's PKCE state, the registered Google callback, and the MCP/OAuth issuer on one origin.

The frontend is a Next.js static export in `frontend/out`. Cloudflare uses `npm run build:cloudflare`, which sets `NEXT_PUBLIC_API_BASE_URL=.` and stamps the provider's exact Git SHA. Browser API requests remain same-origin; a scoped Pages Function forwards `/api/*`, MCP, and OAuth traffic to each project's `API_BASE_URL` environment variable. This makes immutable `pages.dev` previews testable without adding every preview hostname to Railway CORS. Always use the npm scripts; calling `next build` directly skips the MapLibre worker copy and the post-build Pages contract check.

## Verified local commands

```powershell
Set-Location frontend
$env:NEXT_PUBLIC_API_BASE_URL = '.'
$env:NEXT_PUBLIC_RELEASE_VERSION = '<release-version>'
$env:NEXT_PUBLIC_COMMIT_SHA = '<full-git-sha>'
$env:NEXT_PUBLIC_COMMIT_DATE = '<iso-8601-commit-date>'
npm ci
npm test
npm run lint
npm run typecheck
npm run build
npm start -- --port 8788
```

The post-build check verifies the callback page, Cloudflare headers, MapLibre worker, GeoJSON data, and a representative image. The generated HTML contains `parkdex-release` and `parkdex-commit` metadata for exact-revision verification.

## Deployment mechanics

Cloudflare Pages cannot promote a preview deployment to production. Preserve Parkdex's verify-before-cutover behavior by building once and treating `frontend/out` as an immutable artifact:

1. Compute and record an artifact digest.
2. Upload the artifact to a unique preview branch with `--commit-hash`, `--commit-dirty=false`, and a release ID in `--commit-message`.
3. Verify the immutable `pages.dev` URL, its project/branch/commit metadata, the embedded HTML revision, the API CORS path, and the browser journey.
4. Re-upload the exact same artifact to the environment project's production branch.
5. Verify the stable hostname and retain the prior production deployment as the rollback target.

Do not replace the existing Vercel release workflow until both Pages projects and this artifact flow have been exercised successfully.

## DNS cutover checklist

1. Keep Vercel serving the frontend and export every current DNS record.
2. Add `parkdex.app` to Cloudflare and manually reconcile the scan with the Vercel inventory. Preserve MX, SPF, DKIM, CAA, API, and authentication-related records.
3. Deploy and verify both Pages projects on `pages.dev` before changing DNS.
4. Check DNSSEC at the parent. If a Vercel-era DS record exists, remove it and wait for its TTL to expire before changing nameservers; a stale DS record can make the domain return `SERVFAIL`.
5. In Vercel's registrar settings, replace the Vercel nameservers with the two nameservers assigned by Cloudflare. Keep frontend DNS records pointing to Vercel during the initial delegation verification.
6. Verify public delegation, certificates, mail records, API resolution, and the existing Vercel-hosted site.
7. Cut only `staging.parkdex.app` to `parkdex-staging` and browser-test the map, assets, account/API traffic, callback error path, console, and network.
8. After staging soaks, cut the apex to `parkdex-production` and enable the `www`-to-apex redirect rule with path and query preservation. Exercise an OAuth cancellation or successful sign-in and verify the public MCP metadata and transport root.
9. Retain the Vercel project and its known-good deployment for 7–14 days before removing aliases or deployment credentials.

Registrar transfer is optional and intentionally excluded from the hosting cutover.

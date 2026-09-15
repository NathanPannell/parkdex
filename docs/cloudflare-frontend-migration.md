# Cloudflare frontend migration

Parkdex can move its frontend to Cloudflare Pages without transferring the `parkdex.app` registration away from Vercel. The registrar and the authoritative DNS/hosting provider are independent. Production remains on Vercel until the Pages deployments, DNS zone, and stable hostnames have been verified.

## Target topology

Use two Direct Upload Pages projects so staging and production have independent production deployments and rollback histories:

| Environment | Pages project | Production branch | Stable hostname |
| --- | --- | --- | --- |
| staging | `parkdex-staging` | `staging` | `staging.parkdex.app` |
| production | `parkdex-production` | `main` | `www.parkdex.app` |

The apex `parkdex.app` must continue to redirect permanently to `https://www.parkdex.app`, preserving the complete path and query string. This is required for the existing Google OAuth flow: the registered callback arrives at the apex, while the PKCE browser session originates on `www`.

The frontend is a Next.js static export in `frontend/out`. `NEXT_PUBLIC_API_BASE_URL`, release version, Git SHA, and commit date are build-time values. Always use `npm run build`; calling `next build` directly skips the MapLibre worker copy and the post-build Pages contract check.

## Verified local commands

```powershell
Set-Location frontend
$env:NEXT_PUBLIC_API_BASE_URL = 'https://api-staging-882c.up.railway.app'
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
8. After staging soaks, cut `www` to `parkdex-production` and enable the apex redirect rule with path and query preservation. Exercise an OAuth cancellation or successful sign-in.
9. Retain the Vercel project and its known-good deployment for 7–14 days before removing aliases or deployment credentials.

Registrar transfer is optional and intentionally excluded from the hosting cutover.

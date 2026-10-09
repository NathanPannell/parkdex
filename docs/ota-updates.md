# Over-the-air web bundle updates

Android builds can take a new web bundle (JavaScript, CSS and bundled assets) without a Play release. Native code, plugins and permissions still need Play. Web pages at `web.parkdex.app` never load the updater.

## How it works

- **Plugin.** `@capgo/capacitor-updater` 8.52.1, self-hosted. Capgo cloud is never used: stats and channel URLs are empty, and JavaScript cannot change the channel.
- **Channels.** `staging` and `production`. The channel is baked into each native build by `scripts/cap-sync.mjs`:
  - `npm run android:sync`, `android:apk` and `android:aab` use `staging`.
  - `npm run android:sync:production` and `android:aab:production` use `production`.
  - A plain `npx cap sync` has no channel and turns update checks off.
- **Endpoint.** The plugin posts its device info to `POST /api/updates` on the channel's host: `staging.web.parkdex.app` or `web.parkdex.app` (`worker/appUpdates.ts`).
  - The endpoint reads `https://kip-assets.parkdex.app/app-bundles/channels/<channel>/current.json`.
  - If the build is inside the pointer's native build range and runs another version, the endpoint answers `{ version, url, checksum }`. Otherwise it answers `{ kind: "up_to_date" }`.
  - A malformed pointer, or one for the other channel, is refused with a 503. No device ever sees it.
- **Bundles.** Zips are immutable at `app-bundles/<sha256>.zip`. The plugin checks the SHA-256 after download.
- **Applying.** The plugin only downloads (`autoUpdate: "onlyDownload"`). `src/lib/ota.ts` switches to the downloaded bundle at the next cold start, before the first render. It also switches when the app returns after 30 minutes or more in the background.
  - It never switches on a normal background trip. Applying then would reload the page while the camera, Google sign-in or the share sheet has the app backgrounded.
- **Rollback.** The app calls `notifyAppReady()` once the providers and the first screen have rendered.
  - If a bundle never gets there within the plugin's timeout (15 s, or 30 s after a reload), the plugin goes back to the last good bundle.
  - The app remembers that version and never switches to it again, even though the plugin downloads it again while the pointer still names it.
  - A native update from Play deletes every downloaded bundle (`resetWhenUpdate`).

### What a bundle changes

- `__APP_BUILD__` is the bundle's source commit, so interaction events show the code that actually ran.
- Feedback reports show `<versionCode> bundle <version>`.
- The update gate and app config use the native version code, which a bundle never changes. Update rules work as before.
- Onboarding does not replay for a new bundle. It still replays for a new or reinstalled package.

## Pointer format

```json
{
  "schema": "parkdex.app-bundle-channel/v1",
  "channel": "staging",
  "generation": 1,
  "version": "0b68799-2f554cf6",
  "bundleUrl": "https://kip-assets.parkdex.app/app-bundles/<sha256>.zip",
  "sha256": "<sha256 of the zip>",
  "byteSize": 11955431,
  "minimumNativeBuild": 12,
  "maximumNativeBuild": 12,
  "sourceCommit": "<40-character commit>",
  "publishedAt": "2026-10-07T12:00:00.000Z"
}
```

- **Minimum native build.** Set it to the oldest version code whose native plugins the bundle needs.
- **Maximum native build.** Set it to the newest version code the bundle was tested with. It stops an older bundle from replacing the newer built-in code of a later Play build. Raise it in a new publication once that build is checked.

## Publishing

The publisher builds the channel's web bundle (`build:field` or `build:field:production`). It runs `scripts/check-content-package.mjs`, writes a deterministic zip and writes `current.json` under `.codex/app-bundles/<channel>/`. Without `--apply` it uploads nothing.

```bash
node scripts/publish-app-bundle.mjs --channel staging --min-native-build 12
```

Apply from a clean checkout at the commit you want to ship. `--apply` refuses uncommitted changes.

1. **One time: deploy the CDN Worker.** It must serve the new `app-bundles/` paths. See `docs/cloud-content.md`:

   ```powershell
   node --test cloudflare/content-worker.test.mjs
   node scripts/build-content-worker.mjs
   ```

   Then run `npx wrangler pages deploy ../.codex/cdn-dist --project-name parkdex-kip-content --branch staging --commit-hash <sha>` from `cloudflare/`, with `CLOUDFLARE_ACCOUNT_ID` set.

2. **Publish.** The loader must pass these R2 S3 credentials for bucket `parkdex-kip-content`: `R2_ACCOUNT_ID`, `R2_BUCKET=parkdex-kip-content`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and, for temporary credentials, `R2_SESSION_TOKEN`.

   ```bash
   node scripts/publish-app-bundle.mjs --channel staging --min-native-build 12 --apply --expected-generation 0
   ```

   For later publications, pass the current generation and its ETag:

   ```bash
   node scripts/publish-app-bundle.mjs --channel staging --min-native-build 12 --apply --expected-generation 1 --expected-etag '"<etag>"'
   ```

   The script uploads the zip with `If-None-Match: *` and checks it through the CDN. Then it moves the pointer with `If-None-Match: *` (first publication) or `If-Match: <etag>`.

   Add `--record` (with an optional `--note "<why>"`) to write the publish history row the operator dashboard shows (`kip_app_config.ota_publishes`, migration `app_config_003`). It needs `OTA_HISTORY_DATABASE_URL`, the production database, because both channels are recorded there. The row is written after the pointer moves and is unique per move, so a failed history write is reported and the publication stands. Record every publication: the dashboard can only repoint a channel at a bundle whose native build needs it knows.

3. **Verify.** Fetch the pointer from `kip-assets.parkdex.app`. Then post a check to the endpoint:

   ```bash
   curl -s -X POST -H 'content-type: application/json' -d '{"platform":"android","app_id":"app.parkdex","defaultChannel":"staging","version_code":"12","version_name":"builtin"}' https://staging.web.parkdex.app/api/updates
   ```

**Rollback.** Publish the previous good commit again. The same commit builds the same zip, so the upload is a no-op and only the pointer moves.

## Operator dashboard

`operator.parkdex.app/app/updates` shows both channels, the bundles in R2 and the publish history, and can move a pointer without a build.

- **Publish and roll back.** It points a channel at a zip that is already in R2: a rollback, or staging's bundle promoted to production. Cloudflare's REST object PUT has no conditional header, so the dashboard reads the pointer from R2 and requires the generation (and ETag) the operator saw, re-reads it just before writing `generation + 1`, then reads it back through R2 and through the CDN (a `Range` request, which skips the worker's 60 second cache). It refuses a bundle that is not in R2, a bundle with no publish record, and a minimum native build below the highest minimum the bundle was ever published with. A readback that finds another pointer is a 409 and is recorded as a conflict.
- **New bundles** still come from this script on the operator's machine; the page shows the commands with the current generation and ETag filled in.
- **Setup checklist.** A pointer GET answers 404 both when nothing is published and when the CDN worker predates `app-bundles/`. The checklist tells them apart: it HEADs a zip that R2 has, or, with no zip yet, POSTs to the pointer path. A worker that routes the path answers `405` with `Allow: GET, HEAD`; an older one answers `Allow: GET, HEAD, OPTIONS`.
- The dashboard needs `CLOUDFLARE_API_TOKEN` (R2 read and write on `parkdex-kip-content`) and `CLOUDFLARE_ACCOUNT_ID`; `ASSETS_BUCKET` overrides the bucket.

## Local QA

- **Local origin.** `APP_BUNDLE_ORIGIN=http://localhost:<port>` makes both the API and the publisher use a local file server. It is refused with `--apply`.
- **Local endpoint.** `PARKDEX_UPDATE_URL=http://localhost:<port>/api/updates` during `npm run android:sync` points a debug build at a local endpoint. Use `adb reverse` to reach it.
- **Cleartext.** Local QA also needs a temporary `usesCleartextTraffic="true"` in the manifest. Never commit it.
- **Clean up.** Debug installs with the same version code keep downloaded bundles. Afterwards, call `CapacitorUpdater.reset()` and delete the bundles in the debug app.

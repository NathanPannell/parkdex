# Build configuration and feature flags

Every app build checks in with the production API on launch. The tables live in Neon main, so production is the single source of truth.

## How it works

- `GET https://web.parkdex.app/api/app-config?platform=<android|ios>&build=<build>&env=<production|staging>` returns the build's `apiPointer`, `flags` and update status. Builds 9 and newer send `env`, the server they were built for. Builds 8 and earlier send none and count as production.
- **iOS builds** check in as `platform=ios` with `build` set to the TestFlight run number, the part of `CFBundleVersion` (`<run>.<attempt>`) before the dot. The `ios/0` row, seeded by `app_config_004_ios.sql`, is the default for every iOS build: friends on, crews and badges off, as for Android 19, and a null pointer, so each build keeps the server it was built for. So a new TestFlight build needs no row of its own. Add one (Builds page, platform iOS, the run number) only to give a single build different flags or a pointer. The migration only inserts the row when it is missing and never overwrites it, so it reaches production Neon with the next staging-to-main release; until then a production iOS build gets `flags: {}` and runs on its built-in defaults (friends off).
- **Update rules are global per environment** (`kip_app_config.update_rules`) and hold Android version codes, so they apply to Android only; iOS builds always get `update: "none"`. A build below its environment's minimum gets a blocking "Update on Google Play" screen; below the latest it gets a dismissable nudge. A build's environment is its API pointer if one is set, otherwise the server it was built for. Update prompts apply as soon as the check-in answers, and a required update is remembered offline. Unversioned web builds (build 0) never get one.
- **The API pointer and flags are set per build** (`kip_app_config.builds`). Build `0` is the default for every build of a platform; a specific build overrides it, flag by flag. A null pointer on a build's own row keeps the server it was built for.
- The pointer moves a native build's whole backend, not only content: accounts, backups, feedback, interactions and park content all use `web.parkdex.app` or `staging.web.parkdex.app`. It takes effect on the next launch. When it changes, the app signs the player out of the old server first, because accounts belong to one server; progress saved on the device is kept. Web pages ignore it and always use their own host.
- Flags are free-form: any name of letters, digits and underscores starting with a letter, up to 64 per build. The server stores and sends them all. **Flags apply as soon as the check-in answers**, without a relaunch: screens read them with `useFeatureFlag` and `useRemoteFlag` (`src/lib/appConfig.ts`), which re-render when an answer changes them. Only the pointer waits for the next launch. Builds keep every flag they receive (`remoteFlag(name)`), and read the ones they know: `parkProposals` (default on; off hides "Become a founder" in the map menu and "Become the founder" on the park sheet), `friends` (default off; on shows the Friends tab on the leaderboard, adding friends by QR code and friend links, [friends.md](friends.md)), and `badges` (default off; on shows the badge shelf in My Dex, badge unlocks on visit results, Kip's badge tip and the patches sewn on flags, [badges.md](badges.md)). Builds from #175 on no longer read `rankProgression` (collector ranks are gone, [badges.md](badges.md)). Bundles from 2026-10-22 on no longer read `crews`: crews are retired ([crews.md](crews.md)), and only installed builds' own bundles still show crew UI while it is on. The server keeps listing both flags for those builds.
- Responses carry `analytics: { posthogKey, posthogHost }` when the server has `POSTHOG_PROJECT_KEY`, else `null`. The app starts PostHog as soon as it sees a key ([analytics.md](analytics.md)).
- Responses still carry `contentChannel` (`main` for a production pointer, `staging` for staging), which is all builds 8 and earlier understand. Those builds switch only park content, as before.

## Operator dashboard

Edit the update rules and build rows on the Builds page of the operator dashboard ([operator/README.md](../operator/README.md)). Native builds read production's tables, so keep the dashboard's database toggle on Production when changing them.

## Park proposals

Players tap the pin button next to feedback on the map, drop a pin (or use their location), optionally trace a rough outline with a finger, and name the park. `POST /api/park-proposals` stores it in `kip_proposals.parks` on the server the build talks to, limited to 10 per hour per network. Proposals never touch park content responses, so installed builds are unaffected. Review them on the Proposals page of the operator dashboard: filter by status, open the pin in Google Maps, download the pin and outline as GeoJSON, and mark each one reviewing, accepted or declined.

## Builds

- `npm run android:aab` builds a staging build (`.env.field`): content and accounts on staging.
- `npm run android:aab:production` builds a production build (`.env.production-field`): content and accounts on production.
- Set `PARKDEX_ANDROID_VERSION_CODE` for each release; that number is the `build` the page refers to.
- For a signed Play bundle on the operator's Windows machine, run `npm run android:sync:production`, then `android/Build-SignedBundle.ps1 -VersionCode <n> -VersionName <name>`. It loads the upload key and its saved password from `%USERPROFILE%\.codex\private\parkdex-android\play-upload-v1`, sets the signing variables for that run only, and writes `android/app/build/outputs/bundle/release/app-release.aab`. Add the new version code's `kip_app_config.builds` row on the Builds page before the Play release goes out.
- Web bundle updates between Play releases go over the air on the build's channel and never change its version code, so update rules still apply to the native build. See [ota-updates.md](ota-updates.md).

## Adding a flag

Add it to `FEATURE_FLAGS` in `worker/appConfig.ts` and `FEATURE_FLAG_DEFAULTS` in `src/lib/appConfig.ts` (a test keeps them in step), then read it with `useFeatureFlag("name")` in components, so the screen follows a check-in that changes it (`isFeatureEnabled("name")` outside React).

## Schema

`database/migrations/app_config_001_init.sql` creates `kip_app_config.builds` and `database/migrations/park_proposals_001_init.sql` creates `kip_proposals`. Both are additive and are applied by the normal staging and production release workflows (`independentMigrationPaths` in `deployment.json`).

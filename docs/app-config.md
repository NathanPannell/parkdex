# Build configuration and feature flags

Every app build checks in with the production API to learn which content database it reads and which features are on. The table lives in Neon main, so production is the single source of truth.

## How it works

- `GET https://web.parkdex.app/api/app-config?platform=android&build=<versionCode>` returns `{ contentChannel, flags }` for that build. Build `0` is the platform default; a specific build overrides it flag by flag. No row means the build keeps its built-in defaults.
- The app reads its saved answer before it renders (`src/lib/appConfig.ts`), then checks in again at startup and on resume. A fresh answer takes effect on the next launch, so content and flags never switch mid-session. Offline or on first launch, the build uses its own defaults.
- `contentChannel` switches only park content (catalogue, art, change feed) between `staging.web.parkdex.app` and `web.parkdex.app`. Accounts, backups, feedback and photos always stay on the server the build was made for. Web pages ignore it and always read their own host.
- Flags: `rankProgression` (default on). Off opens every rarity and hides the rank card, map rank line, park-sheet rarity guide and onboarding rank step.
- `parkProposals` (default on). Off hides the "Propose a park" map button.

## Update prompts

Set `minimumBuild` and `latestBuild` on the default row (or a specific build). An Android build below the minimum gets a blocking "Update on Google Play" screen; below the latest it gets a dismissable nudge. Unlike content and flags, these apply as soon as the check-in answers, and a required update is remembered offline. Raise the minimum only before shipping an API change older builds can't handle.

## Operator dashboard

Add, edit or remove build rows on the Builds page of the operator dashboard ([operator/README.md](../operator/README.md)). It edits the table of whichever database its deployment points at; native builds read the production table.

## Park proposals

Players tap the pin button next to feedback on the map, drop a pin (or use their location), optionally trace a rough outline with a finger, and name the park. `POST /api/park-proposals` stores it in `kip_proposals.parks` on the server the build talks to, limited to 10 per hour per network. Proposals never touch park content responses, so installed builds are unaffected. Review them on the Proposals page of the operator dashboard: filter by status, open the pin in Google Maps, download the pin and outline as GeoJSON, and mark each one reviewing, accepted or declined.

## Builds

- `npm run android:aab` builds a staging build (`.env.field`): content and accounts on staging.
- `npm run android:aab:production` builds a production build (`.env.production-field`): content and accounts on production.
- Set `PARKDEX_ANDROID_VERSION_CODE` for each release; that number is the `build` the page refers to.

## Adding a flag

Add it to `FEATURE_FLAGS` in `worker/appConfig.ts` and `FEATURE_FLAG_DEFAULTS` in `src/lib/appConfig.ts` (a test keeps them in step), then read it with `isFeatureEnabled("name")`.

## Schema

`database/migrations/app_config_001_init.sql` creates `kip_app_config.builds` and `database/migrations/park_proposals_001_init.sql` creates `kip_proposals`. Both are additive and are applied by the normal staging and production release workflows (`independentMigrationPaths` in `deployment.json`).

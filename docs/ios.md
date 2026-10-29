# iOS

Parkdex has a Capacitor iOS project in `ios/`. It is generated and edited on Windows and compiled only on GitHub Actions macOS runners. Nobody needs a Mac with a checkout: builds reach an iPhone through TestFlight.

## The project

- `ios/App` is the Xcode project from `npx cap add ios`. Plugins come through Swift Package Manager (`ios/App/CapApp-SPM/Package.swift`, written by `cap sync`). There is no CocoaPods.
- Bundle ID `app.parkdex`, iPhone only (`TARGETED_DEVICE_FAMILY = 1`), portrait only, iOS 15 or later.
- Parkdex's own native plugins live in the app target, as they do on Android, and `ParkdexBridgeViewController` registers them:
  - `NativeIdentityPlugin.swift`: Sign in with Apple (`AuthenticationServices`, the server's nonce passed through unchanged), Google sign-in through `ASWebAuthenticationSession` with PKCE and the iOS OAuth client the server names (never the WebView), and the session token in the Keychain (`KeychainSessionStore.swift`). iOS keeps Keychain items when the app is deleted, so a UserDefaults marker drops a leftover session on a fresh install, as Android does.
  - `WifiContentTransportPlugin.swift`: content downloads and account backup with the Android plugin's rules (approved hosts only, no redirects, size limits, detailed map chunks on Wi-Fi only, scoped claim and photo routes).
  - `NativeInstallInfoPlugin.swift`: the install identity onboarding uses, and the build number for app config.
- `ios/App/App/App.entitlements`: Sign in with Apple, and Associated Domains for `web.parkdex.app` and `staging.web.parkdex.app`. Friend links (`/friend/…`) and account email links (`/account`) open the app through `/.well-known/apple-app-site-association`, which the API serves once `APPLE_TEAM_ID` is set.
- `ios/App/App/Info.plist` holds the purpose strings for every permission the plugins reference: camera, photo library (read and add), and location. The app only ever asks for location while in use. The "always" string is there because the location library can run in the background, and App Store upload rejects a binary that references it without a string. Parkdex takes park photos with the camera and never offers the photo library; the read string says so.
- `ios/App/App/PrivacyInfo.xcprivacy` is the privacy manifest. It declares the required-reason APIs of plugins that ship no manifest of their own (UserDefaults, file timestamps, disk space) and the data Parkdex collects, which must match the App Privacy answers below. Check it when a plugin is added or upgraded:

  ```bash
  grep -rlE "UserDefaults|attributesOfItem|creationDate|modificationDate|systemUptime|systemFreeSize|volumeAvailableCapacity" node_modules/@capacitor/*/ios node_modules/@capgo/*/ios node_modules/@capacitor-community/*/ios ios/App/App/*.swift
  ```

- The app icon and launch splash come from `python scripts/build-ios-assets.py`: the same full-bleed opaque tile as the web apple-touch-icon, and `assets/splash.png`.
- Over-the-air updates are off on iOS. `/api/updates` only serves Android version codes, so `capacitor.config.ts` keeps the updater with `autoUpdate: "off"` for iOS syncs. Every iOS change ships as a TestFlight or App Store build.

## How iOS differs from Android at runtime

- **Sign-in.** The account screen shows "Sign in with Apple" above "Continue with Google" wherever Google appears: sign-in, backing up a guest, linking from Account & backup, and verifying before deletion (App Store guideline 4.8). Accounts can hold Apple, Google and a password together; see "Sign in with Apple" in `docs/accounts-implementation-contract.md`. Google appears only once the server has `GOOGLE_IOS_CLIENT_ID`.
- **Account deletion** (guideline 5.1.1(v)) is in the app: Account & backup > Delete Parkdex account. Deleting an account revokes its Apple tokens once the Sign in with Apple key is configured on the server.
- **App config.** iOS builds check in as `platform=ios` with `build` set to the TestFlight run number (the part of `CFBundleVersion` before the dot). The `ios/0` row is the default for every iOS build: friends on, crews and badges off, the same as Android 19. It is seeded by `app_config_004_ios.sql` and reaches production Neon with the next staging-to-main release; until then a production iOS build gets `flags: {}` and runs on its built-in defaults, which keep friends off. Add a per-build row (operator Builds page, platform iOS) only to give one build different flags. iOS builds never get an update prompt: update rules hold Android version codes.
- **Which server.** Every build checks in with `web.parkdex.app`. A `staging` TestFlight build signs in and syncs with `staging.web.parkdex.app`; a `production` one with `web.parkdex.app`. Sign in with Apple and the iOS Google client work only on servers that have the server-side iOS code, so a production TestFlight build needs it released to main first.

## Commands

```bash
npm run ios:sync              # staging field build, synced into ios/ (OTA off)
npm run ios:sync:production   # production field build, synced into ios/
python scripts/build-ios-assets.py
npm run ios:screenshots       # App Store screenshots; run npm run build first, needs the e2e Postgres
```

`ios:sync` mirrors `android:sync`: a field build, `node scripts/cap-sync.mjs ios <channel>`, then the content package check against `ios/App/App/public`. Commit any change it makes under `ios/`. CI fails when the committed project differs from what `cap sync` writes.

## CI

- **PR checks.** The `iOS simulator build` job runs `npm run ios:sync` and an unsigned `xcodebuild build` for the iOS simulator on `macos-26`. It needs no Apple account. It runs only when a PR changes `ios/`, `package.json`, `package-lock.json`, `capacitor.config.ts`, `scripts/cap-sync.mjs`, `scripts/check-content-package.mjs`, `scripts/ios-*.sh` or the iOS workflows (the `iOS changes` job decides), because macOS minutes cost ten times Linux minutes. A skipped job counts as passing. PR checks run only for PRs into `main`.
- **iOS simulator check** (`.github/workflows/ios-simulator.yml`). Run it by pushing a tag `ios-simulator/<label>` at any commit, for example to check a PR into `staging`, where PR checks do not run. It does the simulator build, launches the app on the runner's 6.9-inch iPhone simulator and fails if the app is not still running after 40 seconds (the screenshot is in the `ios-simulator-launch` artifact), then archives the Release build for a device and runs the TestFlight entitlement signing. About 12 macOS minutes.

  ```bash
  git tag ios-simulator/my-check HEAD
  ```

  ```bash
  git push origin ios-simulator/my-check
  ```

- **TestFlight.** `.github/workflows/ios-testflight.yml` runs only when started by hand. It archives unsigned, ad-hoc signs the archived app with `App.entitlements` (`scripts/ios-sign-archive.sh`; export keeps only the entitlements of the archived signature), then exports with the team's cloud-managed distribution certificate through the App Store Connect API key. It first exports an IPA locally and fails unless that IPA carries Sign in with Apple and Associated Domains (`scripts/ios-check-entitlements.sh`), then exports again to upload. No certificate, profile or registered device is involved. A run costs about 15 macOS minutes (about 150 of the free plan's 2,000 monthly minutes).

## Apple-side setup

Do these once, in order. Steps 1 to 9 need the Apple Developer Program; step 10 (the Google client) does not and can be done today.

1. **Enroll** in the Apple Developer Program at developer.apple.com/programs ($99 USD a year). Wait for the enrollment to be approved.
2. **Note the team ID.** developer.apple.com > Account > Membership details > Team ID (10 characters).
3. **Register the App ID with two capabilities.** developer.apple.com > Certificates, Identifiers & Profiles > Identifiers > + > App IDs > App. Description `Parkdex`, Bundle ID **Explicit** `app.parkdex`. Under Capabilities tick **Sign in with Apple** (leave it as a primary App ID) and **Associated Domains**. Save. If the App ID already exists, open it, tick both, and save; cloud signing picks the change up on the next run.
4. **Create the Sign in with Apple key.** Certificates, Identifiers & Profiles > Keys > +. Name it `Parkdex Sign in with Apple`, tick **Sign in with Apple**, Configure > Primary App ID `app.parkdex`, Save, Continue, Register. Download the `.p8` (Apple allows one download) and note the key ID. This key is not the App Store Connect API key from step 7; it lets the server revoke Apple tokens when an account is deleted.
5. **Register the email domain with Apple's private relay.** Certificates, Identifiers & Profiles > Services > Sign in with Apple for Email Communication > Configure > + under Email Sources. Add the domain of `AUTH_EMAIL_FROM` (and the address itself). Without this, mail to Hide My Email addresses (`…@privaterelay.appleid.com`) is dropped. Resend's SPF and DKIM for that domain must already pass, which they do for the existing account emails.
6. **Create the app record.** App Store Connect > Apps > + > New App. Platform iOS, name `Parkdex`, primary language English (Canada), bundle ID `app.parkdex`, SKU `parkdex`, full access.
7. **Create the App Store Connect API key.** App Store Connect > Users and Access > Integrations > App Store Connect API > Team Keys > +. Name it `GitHub Actions TestFlight` and give it the **Admin** role.
   - Admin, not App Manager: Xcode's cloud signing creates and uses the cloud-managed distribution certificate, and keys with the App Manager or Developer role fail at export with "Cloud signing permission error". A key's role cannot be changed later.
   - Download the `.p8` file. Apple lets you download it only once. Note the key ID next to it and the issuer ID above the list.
8. **Add four repository secrets** at GitHub > NathanPannell/parkdex > Settings > Secrets and variables > Actions > New repository secret:

   | Secret | Value |
   | --- | --- |
   | `APP_STORE_CONNECT_ISSUER_ID` | The issuer ID (a UUID) from the Integrations page. |
   | `APP_STORE_CONNECT_KEY_ID` | The 10-character key ID from step 7. |
   | `APP_STORE_CONNECT_API_KEY_P8` | The whole contents of `AuthKey_<key id>.p8` from step 7, including the BEGIN and END lines. |
   | `APPLE_TEAM_ID` | The 10-character team ID. |

   Delete the downloaded `.p8` once it is stored. Never commit it (`ios/.gitignore` ignores `*.p8`).
9. **Give the API servers the Apple values.** Add these keys to the `KIP_STAGING_EXTRA_RUNTIME_JSON` and `KIP_PRODUCTION_EXTRA_RUNTIME_JSON` environment secrets (GitHub > Settings > Environments). The delivery harness checks their shape, and the next deploy of each branch passes them to Vercel:

   | Key | Value | What it turns on |
   | --- | --- | --- |
   | `APPLE_TEAM_ID` | The team ID | `/.well-known/apple-app-site-association`, so friend and account links open the app. |
   | `APPLE_SIGN_IN_KEY_ID` | The key ID from step 4 | Together with the next one: Apple token revocation on account deletion. |
   | `APPLE_SIGN_IN_PRIVATE_KEY` | The whole `.p8` from step 4, newlines as `\n` | |
   | `GOOGLE_IOS_CLIENT_ID` | From step 10 | The Google button on iOS. |

   Sign in with Apple itself needs none of them, and every one is optional: without the key, deleting an account skips revocation and records `apple_revoke`/`not_configured`. Accounts deleted before the key existed cannot be revoked later, so add the key before App Review.
10. **Create the iOS Google OAuth client** (needs only the Google Cloud project, not Apple). Google Cloud console > the project that holds the existing web client (`GOOGLE_WEB_CLIENT_ID`) > APIs & Services > Credentials > Create credentials > OAuth client ID > Application type **iOS**, name `Parkdex iOS`, bundle ID `app.parkdex`. Leave the App Store ID and team ID empty, or add the team ID once known. The client ID (`…apps.googleusercontent.com`) is public; it goes into `GOOGLE_IOS_CLIENT_ID` for both environments. No redirect URI or secret is needed: the app uses the reversed client ID scheme, which `ASWebAuthenticationSession` catches itself.
11. **Add yourself as a tester.** App Store Connect > the app > TestFlight > Internal Testing > + to create a group, then add your Apple ID. Install the TestFlight app on the iPhone and accept the invite.

Until all four repository secrets exist, a TestFlight run stops in its first (Linux) job with the notice "TestFlight upload skipped" and builds nothing.

## First TestFlight build

Once steps 1 to 11 are done:

1. Check that `staging` has every iOS change and that the staging API has the Apple values: `https://staging.web.parkdex.app/.well-known/apple-app-site-association` must return JSON naming `<team id>.app.parkdex`.
2. Optionally rehearse without Apple: push an `ios-simulator/<label>` tag at `origin/staging` (see CI).
3. Tag the staging commit for a **staging** build (it signs in against `staging.web.parkdex.app`, which already has the server code):

   ```bash
   git fetch origin
   ```

   ```bash
   git tag ios-testflight/staging/1 origin/staging
   ```

   ```bash
   git push origin ios-testflight/staging/1
   ```

4. Watch Actions > iOS TestFlight. The run summary shows the version (1.0.0), the build (`<run number>.1`) and the commit. A failure at "check the entitlements" means the App ID lacks a capability (step 3).
5. Wait for App Store Connect to process the build (usually under 30 minutes), then install it from TestFlight and run the on-device checklist below.
6. A **production** build (`ios-testflight/production/<label>`, or Run workflow with channel `production` once the file is on `main`) needs the server side released to `main` first, because production builds sign in against `web.parkdex.app`. That release also seeds the production `ios/0` app config row.

The build number is `<run number>.<attempt>`, so every run uploads a higher one. The marketing version is the project's `MARKETING_VERSION` (1.0.0) unless the run sets one. Raise it after a version is approved for the App Store.

The project sets `ITSAppUsesNonExemptEncryption` to false, so builds skip the export compliance question. Parkdex encrypts only through HTTPS. The SQLite plugin links SQLCipher, but the app opens every database with `no-encryption`. If the app ever encrypts its database, change the key and answer the export compliance questions again.

### On a real iPhone only

These cannot run on a simulator or in CI:

- Sign in with Apple end to end, including Hide My Email, the name on first sign-in, and signing in again (no email in the token).
- Google sign-in through the system sheet with the iOS client.
- Linking Apple to a Google or password account, and backing up a guest with Apple.
- Deleting an Apple account: the receipt completes, and Settings > Apple ID > Sign-In & Security > Sign in with Apple no longer lists Parkdex (only with the server key from step 4).
- The saved session after a restart, and that deleting and reinstalling the app starts signed out.
- Friend links and account email links opening the app (universal links need the signed app and the live `apple-app-site-association`).
- Content downloads and photo backup over Wi-Fi and mobile data, and detailed map chunks being refused on mobile data (iOS refuses them at once rather than waiting for Wi-Fi as Android does).
- Location permission and planting a flag inside a park; the camera for park photos and friend codes.

## App Review

### App Privacy answers

App Store Connect > the app > App Privacy. Data is collected, nothing is used for tracking, and every type is linked to the person (accounts and guests both have an account ID). This matches `PrivacyInfo.xcprivacy`:

| Category > type | Purposes | Why |
| --- | --- | --- |
| Contact Info > Email Address | App Functionality | Account sign-in and recovery; Google and Apple share it at sign-in. |
| Contact Info > Name | App Functionality | The optional display name, also from Google or Apple's first sign-in. |
| Location > Precise Location | App Functionality | Showing you on the map and checking a visit is inside a park. |
| Location > Coarse Location | Analytics | PostHog places events by IP address. |
| User Content > Photos or Videos | App Functionality | Founders' park photos. |
| User Content > Customer Support | App Functionality | Feedback reports and their optional reply address. |
| User Content > Other User Content | App Functionality | The @handle, flag, park proposals and feedback text. |
| Identifiers > User ID | App Functionality, Analytics | The account ID. |
| Identifiers > Device ID | App Functionality, Analytics | The installation ID on requests and analytics. |
| Usage Data > Product Interaction | Analytics | PostHog autocapture and session replay, inputs masked. |
| Diagnostics > Other Diagnostic Data | App Functionality, Analytics | App version, build and platform on feedback and requests. |

Privacy policy URL `https://parkdex.app/privacy/`. Before submitting, add Sign in with Apple to it next to Google sign-in (the policy lives in the landing site repository). Support URL `https://parkdex.app/support/`. The account deletion page `https://parkdex.app/delete-account/` exists as well, but the in-app path is what guideline 5.1.1(v) needs.

### Screenshots (6.9-inch)

`npm run build`, then `npm run ios:screenshots` (with the e2e `PG*` variables set). It writes five 1320 x 2868 PNGs to `shots/app-store-6.9/` from the production web build in WebKit, the engine of the app's web view, at the 6.9-inch iPhone's 440 x 956 points and 3x scale: the onboarding card, parks near you on the map, a park page, My Dex, and the leaderboard with sample players. Upload them under the 6.9-inch display size; App Store Connect scales them for smaller iPhones. They show no status bar, which the App Store accepts. Swap in on-device screenshots later if wanted (Volume up + side button on a 6.9-inch iPhone gives the same size).

### Review notes

Paste something like this into App Review Information > Notes:

> Parkdex is a park-collecting game for Vancouver Island, BC. You can browse the map, parks, park pages, My Dex and the leaderboard from anywhere. Planting a flag needs you to be physically inside a park on Vancouver Island, so it can't be tried from outside the region. Sign in with Apple, Google or email, or tap "Let's go!" to play as a guest. Account deletion is under Settings > Account & backup > Delete Parkdex account.

Planting a flag needs a real visit, so a reviewer outside Vancouver Island can't test the core action. If App Review rejects under guideline 2.1 for that, reply with a short screen recording of a visit, or add a review-only demo location.

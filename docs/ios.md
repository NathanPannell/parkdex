# iOS

Parkdex has a Capacitor iOS project in `ios/`. It is generated and edited on Windows and compiled only on GitHub Actions macOS runners. Nobody needs a Mac with a checkout: builds reach an iPhone through TestFlight.

## The project

- `ios/App` is the Xcode project from `npx cap add ios`. Plugins come through Swift Package Manager (`ios/App/CapApp-SPM/Package.swift`, written by `cap sync`). There is no CocoaPods.
- Bundle ID `app.parkdex`, iPhone only (`TARGETED_DEVICE_FAMILY = 1`), portrait only, iOS 15 or later.
- `ios/App/App/Info.plist` holds the purpose strings for every permission the plugins reference: camera, photo library (read and add), and location. The app only ever asks for location while in use. The "always" string is there because the location library can run in the background, and App Store upload rejects a binary that references it without a string.
- `ios/App/App/PrivacyInfo.xcprivacy` is the privacy manifest. It declares the required-reason APIs of plugins that ship no manifest of their own (UserDefaults, file timestamps, disk space) and the data Parkdex collects. Check it when a plugin is added or upgraded:

  ```bash
  grep -rlE "UserDefaults|attributesOfItem|creationDate|modificationDate|systemUptime|systemFreeSize|volumeAvailableCapacity" node_modules/@capacitor/*/ios node_modules/@capgo/*/ios node_modules/@capacitor-community/*/ios
  ```

- The app icon and launch splash come from `python scripts/build-ios-assets.py`: the same full-bleed opaque tile as the web apple-touch-icon, and `assets/splash.png`.
- Over-the-air updates are off on iOS. `/api/updates` only serves Android version codes, so `capacitor.config.ts` keeps the updater with `autoUpdate: "off"` for iOS syncs. Every iOS change ships as a TestFlight or App Store build.

## Commands

```bash
npm run ios:sync              # staging field build, synced into ios/ (OTA off)
npm run ios:sync:production   # production field build, synced into ios/
python scripts/build-ios-assets.py
```

`ios:sync` mirrors `android:sync`: a field build, `node scripts/cap-sync.mjs ios <channel>`, then the content package check against `ios/App/App/public`. Commit any change it makes under `ios/`. CI fails when the committed project differs from what `cap sync` writes.

## CI

- **PR checks.** The `iOS simulator build` job runs `npm run ios:sync` and an unsigned `xcodebuild build` for the iOS simulator on `macos-26`. It needs no Apple account. It runs only when a PR changes `ios/`, `package.json`, `package-lock.json`, `capacitor.config.ts`, `scripts/cap-sync.mjs`, `scripts/check-content-package.mjs` or the iOS workflows (the `iOS changes` job decides), because macOS minutes cost ten times Linux minutes. A skipped job counts as passing.
- **TestFlight.** `.github/workflows/ios-testflight.yml` runs only when started by hand. It archives unsigned, then signs at export with the team's cloud-managed distribution certificate through the App Store Connect API key, and uploads. No certificate, profile or registered device is involved. A run costs about 15 macOS minutes (about 150 of the free plan's 2,000 monthly minutes).

## One-time Apple setup

Do these once, in order.

1. **Enroll** in the Apple Developer Program at developer.apple.com/programs ($99 USD a year). Wait for the enrollment to be approved.
2. **Note the team ID.** developer.apple.com > Account > Membership details > Team ID (10 characters).
3. **Register the bundle ID.** developer.apple.com > Certificates, Identifiers & Profiles > Identifiers > + > App IDs > App. Description `Parkdex`, Bundle ID **Explicit** `app.parkdex`. No extra capabilities are needed.
4. **Create the app record.** App Store Connect > Apps > + > New App. Platform iOS, name `Parkdex`, primary language English (Canada), bundle ID `app.parkdex`, SKU `parkdex`, full access.
5. **Create the API key.** App Store Connect > Users and Access > Integrations > App Store Connect API > Team Keys > +. Name it `GitHub Actions TestFlight` and give it the **Admin** role.
   - Admin, not App Manager: Xcode's cloud signing creates and uses the cloud-managed distribution certificate, and keys with the App Manager or Developer role fail at export with "Cloud signing permission error". A key's role cannot be changed later.
   - Download the `.p8` file. Apple lets you download it only once. Note the key ID next to it and the issuer ID above the list.
6. **Add four repository secrets** at GitHub > NathanPannell/parkdex > Settings > Secrets and variables > Actions > New repository secret:

   | Secret | Value |
   | --- | --- |
   | `APP_STORE_CONNECT_ISSUER_ID` | The issuer ID (a UUID) from the Integrations page. |
   | `APP_STORE_CONNECT_KEY_ID` | The 10-character key ID. |
   | `APP_STORE_CONNECT_API_KEY_P8` | The whole contents of `AuthKey_<key id>.p8`, including the BEGIN and END lines. |
   | `APPLE_TEAM_ID` | The 10-character team ID. |

   Delete the downloaded `.p8` once it is stored. Never commit it (`ios/.gitignore` ignores `*.p8`).
7. **Add yourself as a tester.** App Store Connect > the app > TestFlight > Internal Testing > + to create a group, then add your Apple ID. Install the TestFlight app on the iPhone and accept the invite.

Until all four secrets exist, a TestFlight run stops in its first (Linux) job with the notice "TestFlight upload skipped" and builds nothing.

## Cut a TestFlight build

Pick the commit and the channel. `production` uses `build:field:production` (the app talks to `web.parkdex.app`); `staging` uses `build:field` (`staging.web.parkdex.app`).

- **From the Actions tab** (works once `ios-testflight.yml` is on `main`, the default branch): Actions > iOS TestFlight > Run workflow. Choose the branch, the channel and, when needed, a new marketing version such as `1.0.1`. From the command line:

  ```bash
  gh workflow run ios-testflight.yml --ref main -f channel=production
  ```

- **With a tag** (works from any branch, including `staging` before the iOS project reaches `main`). The tag names the channel; the label after it only has to be new:

  ```bash
  git tag ios-testflight/staging/1 origin/staging
  ```

  ```bash
  git push origin ios-testflight/staging/1
  ```

The build number is `<run number>.<attempt>`, so every run uploads a higher one. The marketing version is the project's `MARKETING_VERSION` (1.0.0) unless the run sets one. Raise it after a version is approved for the App Store. The run summary shows the version, build and commit. App Store Connect then processes the build, usually within 30 minutes, and TestFlight offers it to the internal group.

The project sets `ITSAppUsesNonExemptEncryption` to false (HTTPS only), so builds skip the export compliance question.

## Before App Review

These are not needed for TestFlight internal testing, but they are for a public release:

- **Sign in with Apple (guideline 4.8).** Accounts use Google sign-in. An App Store app that offers a third-party login must also offer Sign in with Apple or an equivalent privacy-focused login. Today iOS builds show no Google button and cannot keep a session (next point), so this lands with the iOS sign-in work.
- **Android-only native features.** The web layer gates these on `Capacitor.getPlatform() === "android"`, and their native plugins exist only in `android/`:
  - Sign-in and the saved session (`NativeIdentity`, `src/lib/accounts/nativeIdentity.ts`).
  - Content downloads and account backup (`WifiContentTransport`, `src/lib/content/transport.ts`, `src/lib/accounts/accountBackupTransport.ts`). iOS builds run on the content bundled into the build and never sync.
  - The update gate and build info (`src/lib/appConfig.ts`), and the package install identity (`NativeInstallInfo`).
  - Friend links: Android App Links. iOS needs the Associated Domains capability and an `apple-app-site-association` file.

  A reviewer who cannot sign in or back up may reject the app as incomplete (guideline 2.1), so port these, or give iOS a web-transport fallback, before submitting.
- **App privacy answers.** In App Store Connect > App Privacy, declare the same data types as `PrivacyInfo.xcprivacy`: email address, user ID, precise location, photos, other user content (feedback) and product interaction (PostHog analytics). None is used for tracking.
- **Screenshots** for 6.9-inch iPhones, a privacy policy URL, and a support URL.

# Parkdex for Android

Parkdex uses Capacitor to bundle the existing Next.js interface into a native Android shell. The website and Android app share the same React components, TypeScript modules, API contracts, and data model.

This first build is an internal staging app. It supports the existing guest and email/password journeys plus the field-facing native capabilities needed by visit claims. Google sign-in and App Links/OAuth remain web-only in this scope. Background geofences, background location, notifications, release signing, and store distribution are intentionally deferred.

## Local requirements

- Node.js 22 or newer
- Android Studio and JDK 21 (the current Android Studio bundle may ship a newer JDK that this Gradle toolchain does not support)
- Android SDK Platform 36, Build Tools, Platform Tools, and an API 36 emulator image
- Hardware virtualization enabled for the emulator

Docker is not required for the Android build. It remains useful when running the FastAPI service and database locally.

Set `JAVA_HOME` to the JDK 21 directory in the shell that runs Gradle. In Android Studio, select that same installation under **Settings → Build, Execution, Deployment → Build Tools → Gradle → Gradle JDK**.

## Build and run

From `frontend/`:

```powershell
npm ci
npm run android:sync
npm run android:open
```

Choose an emulator in Android Studio and run the `app` configuration. To assemble an APK without opening the IDE:

```powershell
.\android\gradlew.bat -p android --no-daemon :app:assembleDebug
```

The resulting APK is written to `frontend/android/app/build/outputs/apk/debug/app-debug.apk`.

Debug builds install as `app.parkdex.debug` and display as **Parkdex (Staging)**, so they can coexist with the future store-signed `app.parkdex` release and cannot be mistaken for production.

With an emulator or device connected, build and run the app-scoped instrumentation smoke test with:

```powershell
.\android\gradlew.bat -p android --no-daemon :app:connectedDebugAndroidTest
```

Keep Gradle tasks scoped to `:app`. Unqualified Android-test tasks also configure generated Capacitor library test variants that do not contain Parkdex tests.

## Field build gate

Do not hand a field tester an APK produced only by the Gradle command above. From the repository root, run the repository-owned gate against an explicitly named emulator:

```powershell
$env:PARKDEX_QA_ACCOUNT_EMAIL = "your-staging-qa-account@example.com"
$env:PARKDEX_RAILWAY_PROJECT_DIR = "C:\repo\parkdex-workspace\parkdex"
npm run android:field-gate -- --serial emulator-5554
```

The full field gate requires `PARKDEX_QA_ACCOUNT_EMAIL` and an absolute `PARKDEX_RAILWAY_PROJECT_DIR` (or `--railway-project-dir`) pointing to a checkout already linked to the Parkdex Railway project. It validates the reviewed stable project, staging environment, and API service IDs with `railway status`, records only those non-secret IDs, runs Railway from that checkout, and invokes this branch's R2 contract by absolute path. A different project with the same `staging` and `api` names is rejected. It fails before field readiness if either authenticated journey is unavailable. The gate refuses physical-device serials, passes the serial explicitly to every ADB and Gradle operation, syncs the Android bundle, assembles it, runs the connected instrumentation suite, then freshly installs and clears `app.parkdex.debug` on that emulator. It runs ten cold-start Goldstream Park location trials by default, failing if any trial takes longer than 30 seconds. The gate uses the canonical `provincial-goldstream-park` record and its reviewed representative point inside the published boundary. Because emulator geo fixes are edge-triggered, the runner replays the same coordinate every two seconds while waiting, without resetting the launch-time deadline. It applies the same bounded replay to movement and provider-recovery checks. Use `--trials` and `--timeout-ms` to adjust those values during gate development; the defaults are the field-build acceptance threshold. `--skip-photo-journey` and `--skip-r2-contract` are available only for runner development and mark the attestation as `fieldReady: false`.

The gate writes its JSON attestation and an immutable copy of the candidate APK outside the repository. It always overrides inherited build variables with the reviewed staging API (`https://api-staging-882c.up.railway.app`), staging catalogue, and enabled field diagnostics, then records those public values in the attestation. The staging catalogue uses the canonical park data and an empty field-test overlay. `fieldReady: true` is emitted only when those values match, the worktree remains clean, and the HEAD, Git tree, and APK SHA-256 remain unchanged after sync, connected tests, immediately before install, and after the device journeys. The emulator is reinstalled from that external candidate, not from a Gradle output that a later task could replace. Field readiness also requires the default full photo journey, staging R2 contract, ten location trials, and default time budgets. On failure, a sibling evidence directory contains redacted logcat and UI hierarchy text. Screenshots are captured only after app data is cleared; authenticated photo and generic setup failures omit screenshots to avoid retaining account data. A failed automatic QA reset or R2 contract marks the attestation as requiring manual staging cleanup. The current MapLibre user pin is canvas-rendered and is not exposed to UIAutomator, so the gate uses the populated Goldstream Park Nearby result as its location-ready oracle. A future native diagnostic accessibility marker can replace that fallback without changing the runner.

When camera, claim, or photo upload code changed, keep the emulator signed into a dedicated clean staging QA account and set its non-secret expected email for the gate process:

```powershell
$env:PARKDEX_QA_ACCOUNT_EMAIL = "your-staging-qa-account@example.com"
$env:PARKDEX_RAILWAY_PROJECT_DIR = "C:\repo\parkdex-workspace\parkdex"
npm run android:field-gate -- --serial emulator-5554
```

Before the fresh-install location trials, the gate replaces the APK without clearing that QA session, verifies the expected account, captures and accepts the emulator camera scene, creates the Goldstream Park claim, requires the uploaded private image to render from the postcard endpoint, then resets progress and verifies the postcard is gone. The email is used only as an account-safety assertion and is omitted from the attestation. If this affected journey cannot run, the APK is not field-ready.

The full field gate runs the real staging R2 contract through the existing authenticated Railway environment without printing its credentials. To rerun only that contract during diagnosis, use:

```powershell
railway run --environment staging --service api python scripts/r2-contract.py
```

The R2 contract creates one random private object, verifies its bytes, deletes it, confirms that it is missing, and guarantees a cleanup attempt on failure. Its output contains only status, byte count, timing values, and a generic error type.

`npm run build:android` defaults to the persistent staging API and staging catalogue scope. The staging overlay is empty, so the bundle uses the same canonical park catalogue as a production build. Set `NEXT_PUBLIC_API_BASE_URL` to another HTTPS origin before the command to override it. The value must not contain credentials, a path, query, or fragment. Set `PARKDEX_CATALOGUE_SCOPE=canonical` explicitly when producing a canonical Android bundle.

The MCP metadata handlers use the `route.web.ts` extension. The normal web build includes that extension; the Android build excludes it because request-time route handlers and rewrites cannot be bundled into a static export.

## Staging origin

Bundled Capacitor content uses the secure WebView origin `https://localhost`. The staging API's `FRONTEND_ORIGINS` setting must include both `https://staging.parkdex.app` and `https://localhost` before the installed app can read or update staging data. Keep this as provider configuration rather than hardcoding it into FastAPI.

## Native field behavior

- `@capacitor/geolocation` requests foreground `ACCESS_COARSE_LOCATION` and `ACCESS_FINE_LOCATION`. Android approximate permission is accepted and its reported accuracy is preserved; denial, disabled services, and timeouts map to clear UI states. The app does not request background location or register silent geofences. Boundary eligibility remains foreground and server-authoritative.
- `@capacitor/camera` uses the rear camera's `takePhoto` API with orientation correction and a 2048-pixel bound. Captures are returned as uploadable `File` objects, are not saved to the gallery, and do not request broad media permissions. A successful `App` `appRestoredResult` is queued so a process-death camera result is consumed by the next photo request. Once the user confirms a photo, it is copied to the app-private Capacitor Filesystem `Data` directory before the claim request, closing both the ambiguous-response and failed-upload windows. It can be retried after navigation or an app restart; it is keyed to the account id, removed on success/discard, and cleared when that account signs out or changes. If filesystem cleanup is temporarily unavailable, the previous owner key is retained in the running app and a visible retry action remains until cleanup succeeds; a server-confirmed photo similarly retries local-copy removal without offering a duplicate upload.
- The Android Back listener gives the React UI a cancelable `parkdex:back` event first, then navigates browser history or minimizes the root activity. Capacitor System Bars uses native inset handling and the app viewport is `cover`; existing layout offsets use the safe-area insets.
- Journal and outbox values use Capacitor Preferences. Photo retry bytes never use Preferences; they use the app-private Filesystem `Data` directory. Account bearer tokens and the guest collection key are routed through the allow-listed `SecureCredentials` plugin, which encrypts values with AES-GCM under a non-exportable Android Keystore key and stores the ciphertext in `getNoBackupFilesDir()`. Android backup and device-transfer rules exclude app data. Legacy browser keys are migrated only after a read-back verification.
- The FileProvider exposes only the camera capture directory under the app's external `Pictures/` files path. No broad external-storage or gallery path is configured.

The native bridge is initialized only for `PARKDEX_ANDROID_BUILD=1`; normal Next.js server/static builds keep browser storage, browser location, and the web file-input camera path.

## Source control

Commit the Capacitor configuration, Android project, Gradle wrapper, manifest, and application resources. Do not commit `local.properties`, `.gradle/`, build outputs, copied web assets, APK/AAB files, SDK paths, signing keys, or secrets.

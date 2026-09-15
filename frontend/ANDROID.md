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

`npm run build:android` defaults to the persistent staging API. Set `NEXT_PUBLIC_API_BASE_URL` to another HTTPS origin before the command to override it. The value must not contain credentials, a path, query, or fragment.

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

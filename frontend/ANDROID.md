# Parkdex for Android

The Android app wraps the same React client that runs on the web. The normal `npm run build` remains the Vercel build; `npm run build:android` produces a static Next.js export in `out/` with image optimization disabled for the bundled WebView.

## Local workflow

Capacitor 8 requires Node.js 22 or newer, Android Studio 2025.2.1 or newer, Android SDK Platform 36, and JDK 17 or newer. This project uses minSdk 24, targetSdk 36, Android Gradle Plugin 8.13, and Gradle 8.14.3.

From `frontend/`:

```text
npm ci
npm run android:sync
npm run android:open
```

`android:sync` builds the bundled frontend and copies it into the generated Android project. It defaults to the isolated staging API at `https://api-staging-882c.up.railway.app`; set `NEXT_PUBLIC_API_BASE_URL` to another HTTPS nonproduction API only for an intentional manual preview build whose server already permits `https://localhost`. Never put secrets in `NEXT_PUBLIC_*` variables because they are embedded in the app.

The command-line debug build is `./gradlew assembleDebug` from `frontend/android/`. The APK is written to `frontend/android/app/build/outputs/apk/debug/app-debug.apk`.

## Native behavior

- The WebView uses the local secure origin `https://localhost`; the staging API must allow that exact CORS origin.
- Location requests use foreground coarse and precise permissions. Parkdex still works when permission is denied or GPS hardware is absent.
- Captured visit photos remain private app input and are not saved to the gallery.
- Android back first gives the React UI a chance to close its active sheet or dialog, then navigates back or minimizes the root app.
- Lightweight journal data uses Capacitor Preferences. Account tokens, guest collection keys, and OAuth verifiers use the Android Keystore-backed `SecureCredentials` plugin.
- Google sign-in opens the system browser and accepts only the verified staging callback. Its stable staging signing certificate and App Link setup are documented in `docs/android-staging-signing.md`.

The map requires WebGL2 because Parkdex uses MapLibre GL JS 6. Test the map on physical low-end devices as well as an emulator; Capacitor's API 24 floor does not guarantee suitable graphics drivers.

## Emulator smoke test

After installing the debug APK and launching `app.parkdex/.MainActivity` on an emulator, run `node scripts/android-smoke.mjs` from `frontend/`. The script connects directly to the debug WebView through ADB and Chrome DevTools Protocol using Node.js 24's built-in WebSocket client, so it adds no Playwright or browser automation dependency. Its default `isolated` mode fulfills a small catalogue inside DevTools without mutating a deployed API, opens the fixture through the guest search UI, seeds a legacy guest visit through the real Capacitor Preferences bridge, then takes the API offline. It confirms that the shared journal restores the visit in the UI before and after an Android force-stop. This keeps the smoke aligned with location claims, which cannot be fabricated through a guest UI journey.

Set `ANDROID_SMOKE_MODE=online` only when intentionally exercising an isolated preview API whose CORS policy permits `https://localhost`. Online mode verifies the rendered app and records network diagnostics without writing visits or credentials.

The guarded `preview-online` mode is reserved for the PR 20 combined preview. Build the APK with `NEXT_PUBLIC_API_BASE_URL=https://api-pr-20-<deployment-id>.up.railway.app`, `NEXT_PUBLIC_COMMIT_SHA=<full-validation-sha>`, and `NEXT_PUBLIC_CLAIM_TEST_MODE=true`, then run it with the same origin in `ANDROID_SMOKE_API_BASE_URL`, SHA in `ANDROID_SMOKE_EXPECTED_SHA`, and `ANDROID_SMOKE_CLAIM_FIXTURE=inside-goldstream`. Before any test mutation, the script requires the API `/ready` commit and the visible Account release footer to match that SHA. It rejects every other host, uses no DevTools network mocks, grants the emulator coarse location only, and records a Goldstream geo fix through the real Capacitor location path as separate location evidence. The named test fixture then creates a real guest claim through the visible UI and requires an HTTP 200 claim response. The script creates a disposable preview account, explicitly imports the guest claim, masks its generated identity in screenshots, force-stops the app, and requires the imported Goldstream postcard plus authenticated `/api/auth/me` restoration. The temporary preview deployment owns the resulting synthetic account; the production and staging APIs are never accepted by this mode.

`local-runtime` runs the same unmocked identity, location, fixture claim, guest import, and restart checks against a disposable backend and PostgreSQL service on the CI host. The APK endpoint must be exactly `https://10.0.2.2:8443`, while `ANDROID_SMOKE_READY_URL` must be exactly `https://127.0.0.1:8443`; both use the job-generated TLS certificate through their platform-specific debug trust setup. `ANDROID_SMOKE_EXPECTED_SHA` and `ANDROID_SMOKE_CLAIM_FIXTURE=inside-goldstream` remain mandatory. The script rejects any other endpoint pair, and the normal APK network security policy is not weakened. The runner enables Android location services and repeats the emulator geo fix while the real Capacitor request is pending. If the emulator reports a known timeout or unavailable delivery, diagnostics record the sanitized UI error and permission state, save WebView and native screenshots, and continue with the separately labeled server fixture claim. Permission denial and unclassified plugin errors fail the smoke. Native camera capture is outside this smoke; browser validation separately covers claim photo upload and postcard photo behavior.

Screenshots and sanitized console categories, exception counts, HTTP status codes, and network URLs without query strings are written to `frontend/android-smoke-artifacts/`. Console payloads are never stored because Capacitor debug output can contain credentials. The default journey does not use credentials. A future authenticated variant must use a synthetic account against an isolated preview API; never supply personal or production credentials.

Official references: [Capacitor environment setup](https://capacitorjs.com/docs/getting-started/environment-setup), [Android support](https://capacitorjs.com/docs/android), [configuration](https://capacitorjs.com/docs/config), [geolocation](https://capacitorjs.com/docs/apis/geolocation), [camera](https://capacitorjs.com/docs/apis/camera), [system bars](https://capacitorjs.com/docs/apis/system-bars), [storage](https://capacitorjs.com/docs/guides/storage), [security](https://capacitorjs.com/docs/guides/security), [deep links](https://capacitorjs.com/docs/guides/deep-links), and [Next.js static export](https://nextjs.org/docs/app/guides/static-exports).

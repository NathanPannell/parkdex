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

After installing the debug APK and launching `app.parkdex/.MainActivity` on an emulator, run `node scripts/android-smoke.mjs` from `frontend/`. The script connects directly to the debug WebView through ADB and Chrome DevTools Protocol using Node.js 24's built-in WebSocket client, so it adds no Playwright or browser automation dependency. It verifies that Parkdex renders, marks an unseen park as visited as a guest, force-stops and relaunches the app, and confirms the visit persists.

Screenshots and captured console, exception, HTTP, and network diagnostics are written to `frontend/android-smoke-artifacts/`. The default journey does not use credentials and should target the staging or isolated preview API baked into the APK. A future authenticated variant must use a synthetic account against an isolated preview API; never supply personal or production credentials.

Official references: [Capacitor environment setup](https://capacitorjs.com/docs/getting-started/environment-setup), [Android support](https://capacitorjs.com/docs/android), [configuration](https://capacitorjs.com/docs/config), [geolocation](https://capacitorjs.com/docs/apis/geolocation), [camera](https://capacitorjs.com/docs/apis/camera), [system bars](https://capacitorjs.com/docs/apis/system-bars), [storage](https://capacitorjs.com/docs/guides/storage), [security](https://capacitorjs.com/docs/guides/security), [deep links](https://capacitorjs.com/docs/guides/deep-links), and [Next.js static export](https://nextjs.org/docs/app/guides/static-exports).

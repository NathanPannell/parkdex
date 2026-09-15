# Parkdex for Android

Parkdex uses Capacitor to bundle the existing Next.js interface into a native Android shell. The website and Android app share the same React components, TypeScript modules, API contracts, and data model.

This first build is an internal staging app. It supports the existing guest and email/password journeys. Google sign-in, native location, App Links, native secure credential storage, camera access, geofencing, release signing, and store distribution are intentionally deferred.

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

## Staging origin

Bundled Capacitor content uses the secure WebView origin `https://localhost`. The staging API's `FRONTEND_ORIGINS` setting must include both `https://staging.parkdex.app` and `https://localhost` before the installed app can read or update staging data. Keep this as provider configuration rather than hardcoding it into FastAPI.

## Source control

Commit the Capacitor configuration, Android project, Gradle wrapper, manifest, and application resources. Do not commit `local.properties`, `.gradle/`, build outputs, copied web assets, APK/AAB files, SDK paths, signing keys, or secrets.

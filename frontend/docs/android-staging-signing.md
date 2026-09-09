# Staging Android debug signing

The debug APK uses a stable, staging-only certificate so Android can verify the App Link at `staging.parkdex.app`. The private JKS file remains outside the repository. GitHub Actions receives it through `ANDROID_STAGING_DEBUG_KEYSTORE_BASE64`, `ANDROID_STAGING_DEBUG_KEYSTORE_PASSWORD`, and `ANDROID_STAGING_DEBUG_KEY_PASSWORD`.

The workflow decodes the JKS in the runner temporary directory and exposes only `PARKDEX_ANDROID_KEYSTORE_FILE`, `PARKDEX_ANDROID_KEYSTORE_PASSWORD`, `PARKDEX_ANDROID_KEY_ALIAS`, and `PARKDEX_ANDROID_KEY_PASSWORD` to Gradle. Local builds without those variables retain Android's normal debug signing.

`frontend/public/.well-known/assetlinks.json` contains this staging certificate fingerprint and `app.parkdex`. Production signing and production App Links require a separate release certificate and are intentionally not configured here.

The Android manifest links only `https://staging.parkdex.app/auth/google/callback`. The staging deployment must include this pull request before a device can verify that App Link; do not merge or deploy staging just to test this artifact.

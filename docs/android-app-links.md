# Android App Links and OAuth signing setup

Kip's confirmed staging host is `parkdex-kip-staging.vercel.app`. Debug and release builds declare HTTPS `/account` links on that host by default. `PARKDEX_AUTH_LINK_HOST` can override the default with the exact Kip Vercel preview hostname for preview QA. There is no confirmed Kip production host, so release builds stay on Kip staging until the host and association are provisioned. The legacy `web.parkdex.app` and `staging.web.parkdex.app` hosts must not be used for Kip account links or API requests.

`public/.well-known/assetlinks.json` contains measured signer associations for the debug package and the direct release APK signed with the upload key. The release helper produces the internal staging build with that upload key. Google Play replaces the upload signature on Play-delivered installs with the Play App Signing signature, so the upload fingerprint does not verify Play installs. Add the Play App Signing SHA-256 to the `app.parkdex` statement after retrieving it from Play Console. No production host or signer association is asserted here.

`signingReport` on 2026-09-27 reported these local fingerprints:

| Variant and certificate | Package | SHA-1 | SHA-256 |
| --- | --- | --- | --- |
| Debug signing certificate | `app.parkdex.debug` | `23:23:33:44:DB:35:5E:3B:13:AD:D9:5E:8A:7C:D4:B1:CE:BB:B7:84` | `CD:A2:DE:EC:33:11:2A:3D:99:2C:55:CF:2E:2F:48:FB:06:1D:E7:70:CE:F6:F1:40:0F:03:86:8B:49:75:74:6E` |
| Release upload certificate | `app.parkdex` | `B5:0A:C2:DD:DA:68:6F:0F:E3:58:C7:F8:41:5D:5A:C2:3D:D9:9D:06` | `5B:1D:AC:4D:C7:D4:7F:ED:6C:FC:B2:7B:BB:C1:33:BD:B3:EA:6A:DF:A7:86:89:73:FA:C2:02:28:E3:6D:BF:D9` |

Google Android OAuth clients also need the matching package and signing SHA-1 for debug and release signers. The public Google Web client ID is supplied by server auth config or `VITE_GOOGLE_WEB_CLIENT_ID`; it is not embedded in source. No client ID has been provided yet.

## Implementation and verification status

The Android manifest declares auto-verified HTTPS `/account` links for the configured auth-link host. Gradle defaults debug and release variants to the staging host and permits `PARKDEX_AUTH_LINK_HOST` for Kip preview hosts and owner-scoped Parkdex Vercel deployments matching `parkdex-<deployment>-nathanpannells-projects.vercel.app`. The focused Gradle manifest check covers this owner-scoped pattern. A hostname allowlist does not establish that `assetlinks.json` is deployed or OS-verified on any preview.

The Capacitor listener handles both `appUrlOpen` and the initial launch URL. It accepts an HTTPS `/account` action-token fragment on the exact configured origin and removes the token fragment from the WebView URL before passing the action to the auth flow. Parser tests pass. No device link dispatch or Android OS App Links verification has been run.

The local `assetlinks.json` parses and is included by Vite. No request has verified the file at the exact staging or preview host, and `pm verify-app-links` has not been run. A protected preview may prevent Android's verifier from reaching the association file. A source declaration or local JSON file does not prove that the host association is live.

The Credential Manager and ID-token exchange paths are implemented, but no Google Web client ID or matching Android OAuth clients have been supplied. Google sign-in and linking have not been exercised. The Play App Signing certificate is also not available, so the upload certificate association only covers a directly installed APK signed with that key, not a Play-delivered install. There is no confirmed Kip production host.

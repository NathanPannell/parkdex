#!/usr/bin/env bash
# Ad-hoc signs the app inside an unsigned Xcode archive with ios/App/App/App.entitlements.
#
# The TestFlight workflow archives with CODE_SIGNING_ALLOWED=NO (no development certificate or
# registered device exists) and signs at export with the cloud distribution certificate. Export
# keeps the entitlements of the archived app's signature, and an unsigned app has none, so without
# this step the uploaded build would lack Sign in with Apple and Associated Domains. The export
# re-signs everything signed here with the distribution identity.
#
# Usage: scripts/ios-sign-archive.sh <path to .xcarchive>
set -euo pipefail

archive="${1:?usage: ios-sign-archive.sh <archive>}"
entitlements="ios/App/App/App.entitlements"
app="$archive/Products/Applications/App.app"
[ -d "$app" ] || { echo "::error::No App.app in $archive"; exit 1; }

# codesign refuses to sign a bundle whose nested code is unsigned, so frameworks go first.
if [ -d "$app/Frameworks" ]; then
  find "$app/Frameworks" -mindepth 1 -maxdepth 1 \( -name "*.framework" -o -name "*.dylib" \) -print0 |
    while IFS= read -r -d '' item; do codesign --force --sign - --timestamp=none "$item"; done
fi
codesign --force --sign - --timestamp=none --generate-entitlement-der --entitlements "$entitlements" "$app"
"$(dirname "$0")/ios-check-entitlements.sh" "$app"

#!/usr/bin/env bash
# Fails unless a signed Parkdex app carries the entitlements App Review and universal links need.
# Usage: scripts/ios-check-entitlements.sh <path to App.app>
set -euo pipefail

app="${1:?usage: ios-check-entitlements.sh <App.app>}"
entitlements="$(codesign -d --entitlements :- "$app" 2>/dev/null || true)"
missing=()
for needle in "com.apple.developer.applesignin" "com.apple.developer.associated-domains" "applinks:web.parkdex.app" "applinks:staging.web.parkdex.app"; do
  grep -q "$needle" <<< "$entitlements" || missing+=("$needle")
done
if [ "${#missing[@]}" -gt 0 ]; then
  echo "::error::$app is missing entitlements: ${missing[*]}. The App ID app.parkdex needs the Sign in with Apple and Associated Domains capabilities (docs/ios.md)."
  exit 1
fi
echo "Entitlements present: Sign in with Apple, Associated Domains (web.parkdex.app, staging.web.parkdex.app)."

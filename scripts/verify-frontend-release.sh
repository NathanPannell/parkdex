#!/usr/bin/env bash
set -euo pipefail

url="${1:?frontend URL is required}"
expected_sha="${2:?expected commit SHA is required}"
page="$(mktemp)"
trap 'rm -f "$page"' EXIT

fetch() {
  if [[ "$url" == "https://staging.parkdex.app" && -n "${VERCEL_TOKEN:-}" ]]; then
    vercel curl / --deployment "$url" --cwd frontend --token "$VERCEL_TOKEN" \
      --scope "${VERCEL_ORG_ID:?VERCEL_ORG_ID is required}" \
      -- --fail --silent --show-error --output "$page"
  else
    curl --fail --silent --show-error --max-time 15 "$url/" --output "$page"
  fi
}

for delay in ${VERIFY_DELAYS:-0 2 4 8 12}; do
  (( delay == 0 )) || sleep "$delay"
  exact_release=true
  if [[ -n "${VERCEL_TOKEN:-}" ]]; then
    inspection="$(vercel inspect "$url" --json --token "$VERCEL_TOKEN" --scope "${VERCEL_ORG_ID:?VERCEL_ORG_ID is required}" 2>/dev/null || true)"
    [[ "$(jq -r '.readyState // empty' <<<"$inspection" 2>/dev/null)" == READY ]] || exact_release=false
    [[ "$(jq -r '.meta.githubCommitSha // empty' <<<"$inspection" 2>/dev/null)" == "$expected_sha" ]] || exact_release=false
  fi
  if [[ "$exact_release" == true ]] && fetch && grep -Fq "${expected_sha:0:7}" "$page"; then
    grep -q '<title>Parkdex' "$page"
    if [[ "$url" == "https://staging.parkdex.app" && -n "${VERCEL_TOKEN:-}" ]]; then
      for asset in maplibre-gl-worker.mjs maplibre-gl-shared.mjs; do
        vercel curl "/maplibre/$asset" --deployment "$url" --cwd frontend \
          --token "$VERCEL_TOKEN" --scope "$VERCEL_ORG_ID" -- --fail --silent --show-error --output /dev/null
      done
    else
      for asset in maplibre-gl-worker.mjs maplibre-gl-shared.mjs; do
        curl --fail --silent --show-error "$url/maplibre/$asset" --output /dev/null
      done
    fi
    exit 0
  fi
done

echo "Frontend at $url did not report release $expected_sha." >&2
exit 1

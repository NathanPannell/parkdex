#!/usr/bin/env bash
set -euo pipefail

url="${1:?frontend URL is required}"
expected_sha="${2:?expected commit SHA is required}"
[[ "$expected_sha" =~ ^[0-9a-f]{40}$ ]]
: "${VERCEL_TOKEN:?VERCEL_TOKEN is required for exact release verification}"
: "${VERCEL_ORG_ID:?VERCEL_ORG_ID is required}"
: "${VERCEL_PROJECT_ID:?VERCEL_PROJECT_ID is required}"
page="$(mktemp)"
trap 'rm -f "$page"' EXIT

fetch() {
  vercel curl / --deployment "$url" --cwd frontend --token "$VERCEL_TOKEN" \
    --scope "$VERCEL_ORG_ID" -- --fail --silent --show-error --output "$page"
}

for delay in ${VERIFY_DELAYS:-0 2 4 8 12}; do
  (( delay == 0 )) || sleep "$delay"
  exact_release=false
  if inspection="$(curl --fail --silent --show-error --max-time 15 \
    --header "Authorization: Bearer $VERCEL_TOKEN" \
    "https://api.vercel.com/v13/deployments/${url#https://}?teamId=$VERCEL_ORG_ID" \
    | jq -c '{readyState, sha: .meta.githubCommitSha, projectId}')"; then
    if [[ "$(jq -r '.readyState // empty' <<<"$inspection")" == READY ]] && \
       [[ "$(jq -r '.sha // empty' <<<"$inspection")" == "$expected_sha" ]] && \
       [[ "$(jq -r '.projectId // empty' <<<"$inspection")" == "$VERCEL_PROJECT_ID" ]]; then
      exact_release=true
    fi
  fi
  if [[ "$exact_release" == true ]] && fetch && grep -Fq "${expected_sha:0:7}" "$page"; then
    grep -q '<title>Parkdex' "$page"
    for asset in maplibre-gl-worker.mjs maplibre-gl-shared.mjs; do
      vercel curl "/maplibre/$asset" --deployment "$url" --cwd frontend \
        --token "$VERCEL_TOKEN" --scope "$VERCEL_ORG_ID" \
        -- --fail --silent --show-error --output /dev/null
    done
    exit 0
  fi
done

echo "Frontend at $url did not report release $expected_sha." >&2
exit 1

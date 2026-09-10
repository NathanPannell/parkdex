#!/usr/bin/env bash
set -euo pipefail

url="${1:?frontend URL is required}"
expected_sha="${2:?expected commit SHA is required}"
[[ "$expected_sha" =~ ^[0-9a-f]{40}$ ]]

if [[ -n "${VERCEL_TOKEN:-}" ]]; then
  : "${VERCEL_ORG_ID:?VERCEL_ORG_ID is required}"
  : "${VERCEL_PROJECT_ID:?VERCEL_PROJECT_ID is required}"
  page="$(mktemp)"
  trap 'rm -f "$page"' EXIT
  for delay in ${VERIFY_DELAYS:-0 2 4 8 12}; do
    (( delay == 0 )) || sleep "$delay"
    exact_release=false
    if inspection="$(curl --fail --silent --show-error --max-time 15 \
      --header "Authorization: Bearer $VERCEL_TOKEN" \
      "https://api.vercel.com/v13/deployments/${url#https://}?teamId=$VERCEL_ORG_ID" \
      | jq -c '{readyState, sha: .meta.githubCommitSha, projectId, url}')"; then
      deployment_host="$(jq -r '.url // empty' <<<"$inspection")"
      if [[ "$(jq -r '.readyState // empty' <<<"$inspection")" == READY ]] && \
         [[ "$(jq -r '.sha // empty' <<<"$inspection")" == "$expected_sha" ]] && \
         [[ "$(jq -r '.projectId // empty' <<<"$inspection")" == "$VERCEL_PROJECT_ID" ]] && \
         [[ "$deployment_host" =~ ^[a-zA-Z0-9][a-zA-Z0-9-]*\.vercel\.app$ ]]; then
        deployment_url="https://$deployment_host"
        exact_release=true
      fi
    fi
    if [[ "$exact_release" == true ]] && vercel curl / --deployment "$deployment_url" --cwd frontend --token "$VERCEL_TOKEN" --scope "$VERCEL_ORG_ID" -- --fail --silent --show-error --output "$page"; then
      grep -q '<title>Parkdex' "$page"
      for asset in maplibre-gl-worker.mjs maplibre-gl-shared.mjs; do
        vercel curl "/maplibre/$asset" --deployment "$deployment_url" --cwd frontend --token "$VERCEL_TOKEN" --scope "$VERCEL_ORG_ID" -- --fail --silent --show-error --output /dev/null
      done
      exit 0
    fi
  done
  echo "Frontend at $url did not report release $expected_sha." >&2
  exit 1
fi

: "${VERCEL_SCOPE:?VERCEL_SCOPE is required}"
: "${VERCEL_PROJECT_NAME:?VERCEL_PROJECT_NAME is required}"
: "${VERCEL_PROJECT_ID:?VERCEL_PROJECT_ID is required}"
: "${EXPECTED_RELEASE_ID:?EXPECTED_RELEASE_ID is required}"
: "${EXPECTED_PREVIEW_ENVIRONMENT:?EXPECTED_PREVIEW_ENVIRONMENT is required}"
[[ "$(jq -r '.projectId // empty' frontend/.vercel/project.json)" == "$VERCEL_PROJECT_ID" ]]
matching_urls="$(vercel list "$VERCEL_PROJECT_NAME" \
  --meta "githubCommitSha=$expected_sha" \
  --meta "parkdexReleaseId=$EXPECTED_RELEASE_ID" \
  --meta "parkdexEnvironment=$EXPECTED_PREVIEW_ENVIRONMENT" \
  --yes --scope "$VERCEL_SCOPE" 2>/dev/null \
  | grep -oE '[a-zA-Z0-9][a-zA-Z0-9-]*\.vercel\.app' | sort -u)"
[[ "$(grep -c . <<<"$matching_urls")" == 1 ]]
[[ "https://$matching_urls" == "$url" ]]
page="$(mktemp)"
trap 'rm -f "$page"' EXIT

fetch() {
  vercel curl / --deployment "$deployment_url" --cwd frontend \
    --scope "$VERCEL_SCOPE" -- --fail --silent --show-error --output "$page"
}

for delay in ${VERIFY_DELAYS:-0 2 4 8 12}; do
  (( delay == 0 )) || sleep "$delay"
  exact_release=false
  if inspection="$(vercel inspect "$url" --json --scope "$VERCEL_SCOPE" 2>/dev/null)"; then
    deployment_host="$(jq -r '.url // empty' <<<"$inspection")"
    if [[ "$(jq -r '.readyState // empty' <<<"$inspection")" == READY ]] && \
       [[ "$(jq -r '.name // empty' <<<"$inspection")" == "$VERCEL_PROJECT_NAME" ]] && \
       [[ "$deployment_host" =~ ^[a-zA-Z0-9][a-zA-Z0-9-]*\.vercel\.app$ ]]; then
      deployment_url="https://$deployment_host"
      exact_release=true
    fi
  fi
  if [[ "$exact_release" == true ]] && fetch; then
    grep -q '<title>Parkdex' "$page"
    for asset in maplibre-gl-worker.mjs maplibre-gl-shared.mjs; do
      vercel curl "/maplibre/$asset" --deployment "$deployment_url" --cwd frontend \
        --scope "$VERCEL_SCOPE" \
        -- --fail --silent --show-error --output /dev/null
    done
    exit 0
  fi
done

echo "Frontend at $url did not report release $expected_sha." >&2
exit 1

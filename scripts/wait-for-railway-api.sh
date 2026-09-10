#!/usr/bin/env bash
set -euo pipefail

: "${RAILWAY_PROJECT_ID:?RAILWAY_PROJECT_ID is required}"
: "${RAILWAY_API_SERVICE_ID:?RAILWAY_API_SERVICE_ID is required}"
: "${RAILWAY_ENVIRONMENT:?RAILWAY_ENVIRONMENT is required}"
: "${EXPECTED_COMMIT_SHA:?EXPECTED_COMMIT_SHA is required}"

resolve_domain() {
  domains_json="$(railway domain list \
    --project "$RAILWAY_PROJECT_ID" \
    --environment "$RAILWAY_ENVIRONMENT" \
    --service "$RAILWAY_API_SERVICE_ID" \
    --json 2>/dev/null || true)"
  jq -r '.. | strings | select(test("\\.up\\.railway\\.app$"))' <<<"$domains_json" | head -n 1
}

domain="$(resolve_domain)"
if [[ -z "$domain" ]]; then
  railway domain --port 8080 \
    --project "$RAILWAY_PROJECT_ID" \
    --environment "$RAILWAY_ENVIRONMENT" \
    --service "$RAILWAY_API_SERVICE_ID" \
    --json >/dev/null
  for delay in 2 4 8 12; do
    sleep "$delay"
    domain="$(resolve_domain)"
    [[ -z "$domain" ]] || break
  done
fi

if [[ -z "$domain" ]]; then
  echo "No Railway-provided API domain appeared." >&2
  exit 1
fi

api_url="https://${domain}"
for delay in 0 2 4 8 12 20 30 30 30 30 30 30; do
  (( delay == 0 )) || sleep "$delay"
  response="$(curl --fail --silent --show-error --max-time 10 "${api_url}/ready" 2>/dev/null || true)"
  release_ok=true
  if [[ -n "${EXPECTED_RELEASE_ID:-}" ]]; then
    [[ "$(jq -r '.release // empty' <<<"$response" 2>/dev/null)" == "$EXPECTED_RELEASE_ID" ]] || release_ok=false
  fi
  if [[ "$(jq -r '.status // empty' <<<"$response" 2>/dev/null)" == "ready" ]] && \
     [[ "$(jq -r '.commit // empty' <<<"$response" 2>/dev/null)" == "$EXPECTED_COMMIT_SHA" ]] && \
     [[ "$release_ok" == true ]]; then
    echo "api_url=${api_url}" >> "$GITHUB_OUTPUT"
    exit 0
  fi
done

echo "Railway API never reported ready for commit ${EXPECTED_COMMIT_SHA} release ${EXPECTED_RELEASE_ID:-any} at ${api_url}" >&2
exit 1

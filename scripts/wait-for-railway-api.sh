#!/usr/bin/env bash
set -euo pipefail

: "${RAILWAY_PROJECT_ID:?RAILWAY_PROJECT_ID is required}"
: "${RAILWAY_API_SERVICE_ID:?RAILWAY_API_SERVICE_ID is required}"
: "${RAILWAY_ENVIRONMENT:?RAILWAY_ENVIRONMENT is required}"
: "${EXPECTED_COMMIT_SHA:?EXPECTED_COMMIT_SHA is required}"

domain=""
for attempt in $(seq 1 30); do
  domains_json="$(railway domain list \
    --project "$RAILWAY_PROJECT_ID" \
    --environment "$RAILWAY_ENVIRONMENT" \
    --service "$RAILWAY_API_SERVICE_ID" \
    --json 2>/dev/null || true)"
  domain="$(jq -r '.. | strings | select(test("\\.up\\.railway\\.app$"))' <<<"$domains_json" | head -n 1)"
  if [[ -n "$domain" ]]; then
    break
  fi
  if [[ "$attempt" == "3" ]]; then
    railway domain --port 8080 \
      --project "$RAILWAY_PROJECT_ID" \
      --environment "$RAILWAY_ENVIRONMENT" \
      --service "$RAILWAY_API_SERVICE_ID" \
      --json >/dev/null 2>&1 || true
  fi
  sleep 10
done

if [[ -z "$domain" ]]; then
  echo "No Railway-provided API domain appeared." >&2
  exit 1
fi

api_url="https://${domain}"
for _ in $(seq 1 60); do
  response="$(curl --fail --silent --show-error --max-time 10 "${api_url}/ready" 2>/dev/null || true)"
  if [[ "$(jq -r '.status // empty' <<<"$response" 2>/dev/null)" == "ready" ]] && \
     [[ "$(jq -r '.commit // empty' <<<"$response" 2>/dev/null)" == "$EXPECTED_COMMIT_SHA" ]]; then
    echo "api_url=${api_url}" >> "$GITHUB_OUTPUT"
    exit 0
  fi
  sleep 10
done

echo "Railway API never reported ready for commit ${EXPECTED_COMMIT_SHA} at ${api_url}" >&2
exit 1

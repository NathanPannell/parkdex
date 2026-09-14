#!/usr/bin/env bash
set -euo pipefail

: "${EXPECTED_COMMIT_SHA:?EXPECTED_COMMIT_SHA is required}"
: "${RAILWAY_PROJECT_ID:?RAILWAY_PROJECT_ID is required}"
: "${RAILWAY_ENVIRONMENT:?RAILWAY_ENVIRONMENT is required}"
: "${RAILWAY_API_SERVICE_ID:?RAILWAY_API_SERVICE_ID is required}"

deadline=$((SECONDS + 600))
while (( SECONDS < deadline )); do
  deployments="$(railway deployment list --json --service "$RAILWAY_API_SERVICE_ID" --environment "$RAILWAY_ENVIRONMENT" --project "$RAILWAY_PROJECT_ID")"
  status="$(jq -r --arg sha "$EXPECTED_COMMIT_SHA" '[.[] | select(.meta.commitHash == $sha)][0].status // "PENDING"' <<<"$deployments")"
  case "$status" in
    SUCCESS)
    echo "Railway API source deployment matches the expected commit."
    exit 0
    ;;
    FAILED|CRASHED|REMOVED)
      echo "Railway API source deployment for the expected commit ended with status $status." >&2
      exit 1
      ;;
  esac
  sleep 10
done

echo "Timed out waiting for Railway source deployments to match the expected commit." >&2
exit 1

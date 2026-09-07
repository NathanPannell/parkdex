#!/usr/bin/env bash
set -euo pipefail

: "${EXPECTED_COMMIT_SHA:?EXPECTED_COMMIT_SHA is required}"
: "${EXPECTED_PREVIEW_DEPLOYMENT_MESSAGE:?EXPECTED_PREVIEW_DEPLOYMENT_MESSAGE is required}"
: "${RAILWAY_PROJECT_ID:?RAILWAY_PROJECT_ID is required}"
: "${PREVIEW_ENVIRONMENT:?PREVIEW_ENVIRONMENT is required}"
: "${RAILWAY_API_SERVICE_ID:?RAILWAY_API_SERVICE_ID is required}"
: "${RAILWAY_WORKER_SERVICE_ID:?RAILWAY_WORKER_SERVICE_ID is required}"

message="$EXPECTED_PREVIEW_DEPLOYMENT_MESSAGE"
deadline=$((SECONDS + 600))
while (( SECONDS < deadline )); do
  ready=0
  for service in "$RAILWAY_API_SERVICE_ID" "$RAILWAY_WORKER_SERVICE_ID"; do
    deployments="$(railway deployment list --json --service "$service" --environment "$PREVIEW_ENVIRONMENT" --project "$RAILWAY_PROJECT_ID")"
    status="$(jq -r --arg message "$message" '[.[] | select(.meta.cliMessage == $message)][0].status // "PENDING"' <<<"$deployments")"
    case "$status" in
      SUCCESS) ready=$((ready + 1)) ;;
      FAILED|CRASHED|REMOVED|SKIPPED)
        echo "Railway preview source deployment ended with status $status." >&2
        exit 1
        ;;
    esac
  done

  if (( ready == 2 )); then
    echo "Railway API and worker deployed the expected preview source."
    exit 0
  fi
  sleep 10
done

echo "Timed out waiting for Railway preview source deployments." >&2
exit 1

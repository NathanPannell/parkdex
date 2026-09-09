#!/usr/bin/env bash
set -euo pipefail

message="${1:?deployment message is required}"
: "${RAILWAY_PROJECT_ID:?RAILWAY_PROJECT_ID is required}"
: "${RAILWAY_ENVIRONMENT:?RAILWAY_ENVIRONMENT is required}"
: "${RAILWAY_API_SERVICE_ID:?RAILWAY_API_SERVICE_ID is required}"
: "${RAILWAY_WORKER_SERVICE_ID:?RAILWAY_WORKER_SERVICE_ID is required}"

for service in "$RAILWAY_API_SERVICE_ID" "$RAILWAY_WORKER_SERVICE_ID"; do
  deployments="$(railway deployment list --json --service "$service" --environment "$RAILWAY_ENVIRONMENT" --project "$RAILWAY_PROJECT_ID")"
  status="$(jq -r --arg message "$message" '[.[] | select(.meta.cliMessage == $message)][0].status // "MISSING"' <<<"$deployments")"
  if [[ "$status" != SUCCESS ]]; then
    echo "Railway service $service deployment '$message' has status $status." >&2
    exit 1
  fi
done

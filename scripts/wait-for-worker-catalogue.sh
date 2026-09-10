#!/usr/bin/env bash
set -euo pipefail

: "${RAILWAY_PROJECT_ID:?RAILWAY_PROJECT_ID is required}"
: "${RAILWAY_WORKER_SERVICE_ID:?RAILWAY_WORKER_SERVICE_ID is required}"
: "${RAILWAY_ENVIRONMENT:?RAILWAY_ENVIRONMENT is required}"
: "${EXPECTED_COMMIT_SHA:?EXPECTED_COMMIT_SHA is required}"

for delay in ${WORKER_VERIFY_DELAYS:-0 2 4 8 12 20 30 30 30}; do
  (( delay == 0 )) || sleep "$delay"
  logs="$(railway logs \
    --project "$RAILWAY_PROJECT_ID" \
    --environment "$RAILWAY_ENVIRONMENT" \
    --service "$RAILWAY_WORKER_SERVICE_ID" \
    --lines 200 2>/dev/null || true)"
  if [[ -n "${EXPECTED_RELEASE_ID:-}" ]]; then
    matching_logs="$(grep -E "(Every Park|Parkdex) catalogue ready commit=${EXPECTED_COMMIT_SHA} release=${EXPECTED_RELEASE_ID} places=" <<<"$logs" || true)"
  else
    matching_logs="$(grep -E "(Every Park|Parkdex) catalogue ready commit=${EXPECTED_COMMIT_SHA}( release=[^ ]+)? places=" <<<"$logs" || true)"
  fi
  if grep -Eq 'places=[1-9][0-9]*($|[^0-9])' <<<"$matching_logs"; then
    echo 'Worker catalogue database read verified.'
    exit 0
  fi
done

echo 'Worker did not report a non-empty catalogue database read.' >&2
exit 1

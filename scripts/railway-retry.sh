#!/usr/bin/env bash

railway_retry() {
  local stdin_payload="$1"
  shift
  local attempt output status wait_seconds

  for attempt in 1 2 3; do
    set +e
    output="$(printf '%s' "$stdin_payload" | railway "$@" 2>&1)"
    status=$?
    set -e
    if [[ "$status" -eq 0 ]]; then
      [[ -z "$output" ]] || printf '%s\n' "$output"
      return 0
    fi

    wait_seconds=0
    if grep -Eqi 'rate.?limit|too many requests' <<<"$output"; then
      wait_seconds=600
    elif grep -Eqi 'temporarily unavailable|timed? out|connection reset|HTTP (502|503|504)' <<<"$output"; then
      wait_seconds=60
    fi
    if [[ "$attempt" -eq 3 || "$wait_seconds" -eq 0 ]]; then
      printf '%s\n' "$output" >&2
      return "$status"
    fi
    echo "Transient Railway failure; retrying in ${wait_seconds}s (attempt $((attempt + 1))/3)." >&2
    sleep "$wait_seconds"
  done
}

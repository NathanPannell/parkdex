#!/usr/bin/env bash
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT

cat > "$test_dir/railway" <<'MOCK'
#!/usr/bin/env bash
if [[ "$1 $2" == "deployment list" ]]; then
  printf '[{"meta":{"cliMessage":"expected message"},"status":"%s"}]\n' "${MOCK_RAILWAY_STATUS:-SUCCESS}"
elif [[ "$1 $2" == "domain list" ]]; then
  printf '["test.up.railway.app"]\n'
else
  exit 1
fi
MOCK

cat > "$test_dir/vercel" <<'MOCK'
#!/usr/bin/env bash
if [[ "$1" == curl ]]; then
  [[ " $* " == *" -- --fail --silent --show-error --output "* ]] || exit 2
  path="$2"
  output=''
  while (( $# )); do
    [[ "$1" != --output ]] || { output="$2"; break; }
    shift
  done
  if [[ "$path" == / ]]; then
    [[ "${MOCK_FETCH_FAILURE:-false}" != true ]] || exit 1
    printf '<title>Parkdex</title>%s\n' "${MOCK_PAGE_SHA:0:7}" > "$output"
  else
    [[ "${MOCK_ASSET_FAILURE:-false}" != true ]] || exit 1
    printf 'export {};\n'
  fi
else
  exit 1
fi
MOCK

cat > "$test_dir/curl" <<'MOCK'
#!/usr/bin/env bash
if [[ "$*" == *api.vercel.com/v13/deployments/* ]]; then
  [[ "${MOCK_API_FAILURE:-false}" != true ]] || exit 22
  printf '{"readyState":"%s","meta":{"githubCommitSha":"%s"},"projectId":"%s"}\n' \
    "${MOCK_READY_STATE:-READY}" "${MOCK_FRONTEND_SHA}" "${MOCK_PROJECT_ID:-project}"
  exit 0
fi
count=0
[[ ! -f "$MOCK_CURL_COUNT" ]] || count="$(cat "$MOCK_CURL_COUNT")"
count=$((count + 1))
printf '%s' "$count" > "$MOCK_CURL_COUNT"
if (( count == 1 )); then
  printf '{"status":"ready","commit":"wrong"}\n'
else
  printf '{"status":"ready","commit":"%s"}\n' "$EXPECTED_COMMIT_SHA"
fi
MOCK
chmod +x "$test_dir/railway" "$test_dir/vercel" "$test_dir/curl"

export PATH="$test_dir:$PATH"
export RAILWAY_PROJECT_ID=p RAILWAY_ENVIRONMENT=staging
export RAILWAY_API_SERVICE_ID=api RAILWAY_WORKER_SERVICE_ID=worker

MOCK_RAILWAY_STATUS=SUCCESS bash "$repo/scripts/verify-railway-deployments.sh" 'expected message'
if MOCK_RAILWAY_STATUS=FAILED bash "$repo/scripts/verify-railway-deployments.sh" 'expected message' 2>/dev/null; then
  echo 'Failed Railway deployment was accepted.' >&2
  exit 1
fi
if MOCK_RAILWAY_STATUS=SUCCESS bash "$repo/scripts/verify-railway-deployments.sh" 'missing message' 2>/dev/null; then
  echo 'Missing Railway deployment was accepted.' >&2
  exit 1
fi

export VERCEL_TOKEN=test VERCEL_ORG_ID=org VERCEL_PROJECT_ID=project
export VERIFY_DELAYS=0
export MOCK_PAGE_SHA=abcdef0123456789012345678901234567890123
export MOCK_FRONTEND_SHA="$MOCK_PAGE_SHA" MOCK_READY_STATE=READY
bash "$repo/scripts/verify-frontend-release.sh" https://staging.parkdex.app "$MOCK_FRONTEND_SHA"
if MOCK_FRONTEND_SHA=abcdef0fffffffffffffffffffffffffffffffff \
  bash "$repo/scripts/verify-frontend-release.sh" https://staging.parkdex.app "$MOCK_PAGE_SHA" 2>/dev/null; then
  echo 'Frontend with only a matching short SHA was accepted.' >&2
  exit 1
fi
if MOCK_READY_STATE=ERROR bash "$repo/scripts/verify-frontend-release.sh" https://staging.parkdex.app "$MOCK_PAGE_SHA" 2>/dev/null; then
  echo 'Unready frontend was accepted.' >&2
  exit 1
fi

for failure in MOCK_API_FAILURE=true MOCK_FETCH_FAILURE=true MOCK_ASSET_FAILURE=true MOCK_FRONTEND_SHA= MOCK_PROJECT_ID=wrong; do
  if env "$failure" bash "$repo/scripts/verify-frontend-release.sh" https://staging.parkdex.app "$MOCK_PAGE_SHA" 2>/dev/null; then
    echo "Invalid frontend verification accepted: $failure" >&2
    exit 1
  fi
done
if env -u VERCEL_TOKEN bash "$repo/scripts/verify-frontend-release.sh" https://staging.parkdex.app "$MOCK_PAGE_SHA" 2>/dev/null; then
  echo 'Unauthenticated short-SHA fallback was accepted.' >&2
  exit 1
fi

unset VERCEL_TOKEN
export EXPECTED_COMMIT_SHA=abcdef0123456789012345678901234567890123
export MOCK_CURL_COUNT="$test_dir/curl-count" GITHUB_OUTPUT="$test_dir/github-output"
bash "$repo/scripts/wait-for-railway-api.sh"
grep -q '^api_url=https://test.up.railway.app$' "$GITHUB_OUTPUT"
[[ "$(cat "$MOCK_CURL_COUNT")" == 2 ]]

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
elif [[ "$1" == logs ]]; then
  printf 'Parkdex catalogue ready commit=%s release=%s places=1\n' "$EXPECTED_COMMIT_SHA" "${MOCK_RELEASE_ID:-local}"
else
  exit 1
fi
MOCK

cat > "$test_dir/vercel" <<'MOCK'
#!/usr/bin/env bash
if [[ "$1" == list ]]; then
  [[ " $* " == *" --meta githubCommitSha=${MOCK_FRONTEND_SHA} "* ]] || exit 0
  [[ " $* " == *" --meta parkdexReleaseId=${EXPECTED_RELEASE_ID} "* ]] || exit 0
  [[ " $* " == *" --meta parkdexEnvironment=${EXPECTED_PREVIEW_ENVIRONMENT} "* ]] || exit 0
  [[ "${MOCK_LIST_FAILURE:-false}" != true ]] || exit 1
  printf 'https://verified-release.vercel.app\n'
elif [[ "$1" == inspect ]]; then
  [[ "${MOCK_INSPECT_FAILURE:-false}" != true ]] || exit 1
  printf '{"id":"dpl_test","name":"%s","url":"%s","readyState":"%s"}\n' \
    "${MOCK_PROJECT_NAME:-every-park}" "${MOCK_DEPLOYMENT_URL:-verified-release.vercel.app}" "${MOCK_READY_STATE:-READY}"
elif [[ "$1" == curl ]]; then
  [[ " $* " == *" -- --fail --silent --show-error --output "* ]] || exit 2
  [[ " $* " == *" --deployment https://verified-release.vercel.app "* ]] || exit 2
  path="$2"
  output=''
  while (( $# )); do
    [[ "$1" != --output ]] || { output="$2"; break; }
    shift
  done
  if [[ "$path" == / ]]; then
    [[ "${MOCK_FETCH_FAILURE:-false}" != true ]] || exit 1
    printf '<title>Parkdex</title><main>Map</main>\n' > "$output"
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
  [[ " $* " == *" https://api.vercel.com/v13/deployments/staging.parkdex.app?teamId=org "* ]] || exit 2
  printf '{"readyState":"READY","meta":{"githubCommitSha":"%s"},"projectId":"project","url":"verified-release.vercel.app"}\n' "$MOCK_FRONTEND_SHA"
  exit 0
fi
count=0
[[ ! -f "$MOCK_CURL_COUNT" ]] || count="$(cat "$MOCK_CURL_COUNT")"
count=$((count + 1))
printf '%s' "$count" > "$MOCK_CURL_COUNT"
if (( count == 1 )); then
  printf '{"status":"ready","commit":"wrong"}\n'
else
  printf '{"status":"ready","commit":"%s","release":"%s"}\n' "$EXPECTED_COMMIT_SHA" "${MOCK_RELEASE_ID:-local}"
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

mkdir -p "$test_dir/work/frontend/.vercel"
printf '{"projectId":"project","orgId":"team_test"}\n' > "$test_dir/work/frontend/.vercel/project.json"
export VERCEL_SCOPE=scope VERCEL_PROJECT_NAME=every-park VERCEL_PROJECT_ID=project
export EXPECTED_RELEASE_ID=release-123 EXPECTED_PREVIEW_ENVIRONMENT=local-pr-1-abcdef012345-12345678
export VERIFY_DELAYS=0
export MOCK_PAGE_SHA=abcdef0123456789012345678901234567890123
export MOCK_FRONTEND_SHA="$MOCK_PAGE_SHA" MOCK_READY_STATE=READY
(cd "$test_dir/work" && bash "$repo/scripts/verify-frontend-release.sh" https://verified-release.vercel.app "$MOCK_FRONTEND_SHA")
env -u VERCEL_SCOPE -u VERCEL_PROJECT_NAME VERCEL_TOKEN=test VERCEL_ORG_ID=org \
  bash -c "cd '$test_dir/work' && bash '$repo/scripts/verify-frontend-release.sh' https://staging.parkdex.app '$MOCK_FRONTEND_SHA'"
if MOCK_FRONTEND_SHA=abcdef0fffffffffffffffffffffffffffffffff \
  bash -c "cd '$test_dir/work' && bash '$repo/scripts/verify-frontend-release.sh' https://verified-release.vercel.app '$MOCK_PAGE_SHA'" 2>/dev/null; then
  echo 'Frontend with only a matching short SHA was accepted.' >&2
  exit 1
fi
if MOCK_READY_STATE=ERROR bash -c "cd '$test_dir/work' && bash '$repo/scripts/verify-frontend-release.sh' https://verified-release.vercel.app '$MOCK_PAGE_SHA'" 2>/dev/null; then
  echo 'Unready frontend was accepted.' >&2
  exit 1
fi

for failure in MOCK_LIST_FAILURE=true MOCK_INSPECT_FAILURE=true MOCK_FETCH_FAILURE=true MOCK_ASSET_FAILURE=true MOCK_FRONTEND_SHA= MOCK_PROJECT_NAME=wrong MOCK_DEPLOYMENT_URL=staging.parkdex.app MOCK_DEPLOYMENT_URL=verified-release.vercel.app.evil.example; do
  if env "$failure" bash -c "cd '$test_dir/work' && bash '$repo/scripts/verify-frontend-release.sh' https://verified-release.vercel.app '$MOCK_PAGE_SHA'" 2>/dev/null; then
    echo "Invalid frontend verification accepted: $failure" >&2
    exit 1
  fi
done
if env VERCEL_PROJECT_ID=wrong bash -c "cd '$test_dir/work' && bash '$repo/scripts/verify-frontend-release.sh' https://verified-release.vercel.app '$MOCK_PAGE_SHA'" 2>/dev/null; then
  echo 'Wrong linked Vercel project was accepted.' >&2
  exit 1
fi

unset EXPECTED_RELEASE_ID EXPECTED_PREVIEW_ENVIRONMENT
export EXPECTED_COMMIT_SHA=abcdef0123456789012345678901234567890123
export MOCK_CURL_COUNT="$test_dir/curl-count" GITHUB_OUTPUT="$test_dir/github-output"
bash "$repo/scripts/wait-for-railway-api.sh"
grep -q '^api_url=https://test.up.railway.app$' "$GITHUB_OUTPUT"
[[ "$(cat "$MOCK_CURL_COUNT")" == 2 ]]

rm -f "$MOCK_CURL_COUNT" "$GITHUB_OUTPUT"
export EXPECTED_RELEASE_ID=release-123 MOCK_RELEASE_ID=release-123 WORKER_VERIFY_DELAYS=0
bash "$repo/scripts/wait-for-railway-api.sh"
bash "$repo/scripts/wait-for-worker-catalogue.sh"
if MOCK_RELEASE_ID=wrong bash "$repo/scripts/wait-for-worker-catalogue.sh" 2>/dev/null; then
  echo 'Worker with the wrong release id was accepted.' >&2
  exit 1
fi

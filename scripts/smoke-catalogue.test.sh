#!/usr/bin/env bash
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT

cat > "$test_dir/curl" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$MOCK_CALLS"
if [[ " $* " == *" --request PUT "* ]]; then
  [[ " $* " == *" --data {\"visited\":true} "* ]] || exit 2
  printf '{"detail":{"code":"%s","message":"A current location claim is required for a new visit"}}\n%s' \
    "${MOCK_REJECTION_CODE:-location_claim_required}" "${MOCK_REJECTION_STATUS:-409}"
else
  printf '{"places":[{"id":"fixture-place"}],"visitedIds":[]}'
fi
MOCK
chmod +x "$test_dir/curl"

export PATH="$test_dir:$PATH" MOCK_CALLS="$test_dir/calls"
API_URL=https://preview.example.test bash "$repo/scripts/smoke-catalogue.sh"

[[ "$(grep -c -- '--request PUT' "$MOCK_CALLS")" == 1 ]]
[[ "$(grep -c -- 'https://preview.example.test/api/places' "$MOCK_CALLS")" == 4 ]]
grep -q -- '--data {"visited":true}' "$MOCK_CALLS"
if grep -q -- '--data {"visited":false}' "$MOCK_CALLS"; then
  echo 'Catalogue smoke attempted a legacy cleanup mutation.' >&2
  exit 1
fi

if MOCK_REJECTION_STATUS=200 API_URL=https://preview.example.test \
  bash "$repo/scripts/smoke-catalogue.sh" >/dev/null 2>&1; then
  echo 'Catalogue smoke accepted a non-conflict visit response.' >&2
  exit 1
fi
if MOCK_REJECTION_CODE=unexpected_error API_URL=https://preview.example.test \
  bash "$repo/scripts/smoke-catalogue.sh" >/dev/null 2>&1; then
  echo 'Catalogue smoke accepted the wrong conflict code.' >&2
  exit 1
fi

echo 'Catalogue smoke contract test passed.'

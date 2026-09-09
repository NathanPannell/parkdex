#!/usr/bin/env bash
set -euo pipefail

: "${API_URL:?API_URL is required}"

collection_key="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\r\n')"
second_collection_key="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\r\n')"
[[ "${#collection_key}" == 43 ]] || { echo 'Generated collection key has an unexpected length.' >&2; exit 1; }
[[ "${#second_collection_key}" == 43 ]] || { echo 'Generated second collection key has an unexpected length.' >&2; exit 1; }

catalogue="$(curl --fail --silent --show-error --max-time 20 "${API_URL}/api/places")"
place_id="$(jq -er '.places | if length > 0 then .[0].id else error("empty catalogue") end' <<<"$catalogue")"

rejection="$(curl --silent --show-error --max-time 20 \
  --request PUT \
  --header 'Content-Type: application/json' \
  --header "X-Collection-Key: ${collection_key}" \
  --data '{"visited":true}' \
  --write-out $'\n%{http_code}' \
  "${API_URL}/api/visits/${place_id}")"
rejection_status="${rejection##*$'\n'}"
rejection_body="${rejection%$'\n'*}"
[[ "$rejection_status" == 409 ]] || {
  echo "Arbitrary new visit returned HTTP ${rejection_status}; expected 409." >&2
  exit 1
}
jq -e '.detail.code == "location_claim_required"' <<<"$rejection_body" >/dev/null

collection="$(curl --fail --silent --show-error --max-time 20 \
  --header "X-Collection-Key: ${collection_key}" \
  "${API_URL}/api/places")"
jq -e --arg id "$place_id" '.visitedIds | index($id) == null' <<<"$collection" >/dev/null

anonymous_collection="$(curl --fail --silent --show-error --max-time 20 "${API_URL}/api/places")"
jq -e --arg id "$place_id" '.visitedIds | index($id) == null' <<<"$anonymous_collection" >/dev/null

second_collection="$(curl --fail --silent --show-error --max-time 20 \
  --header "X-Collection-Key: ${second_collection_key}" \
  "${API_URL}/api/places")"
jq -e --arg id "$place_id" '.visitedIds | index($id) == null' <<<"$second_collection" >/dev/null

echo "Catalogue read/isolation and location-claim enforcement passed for one of $(jq '.places | length' <<<"$catalogue") places."

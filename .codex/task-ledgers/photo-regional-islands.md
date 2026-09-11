# Regional park and island photo research — 2026-09-11

Goal: search every missing regional park and island for defensible, commercially reusable photography, without editing the product manifest or assets. Success means every one of the 77 assigned places has a durable search record and is classified as verified-candidate, uncertain, or unmatched.

## Method and rules

- Derived the assigned set from the 198-place catalogue minus the existing photo manifest: 53 regional parks and 24 islands.
- Queried Wikimedia Commons by exact catalogue name and shortened alias. The first sweep hit HTTP 429s, so successful responses were cached, incomplete entries were retried with 0.9–1.1 second pacing and backoff, and indexed Commons search was used to distinguish throttling from a real empty result.
- Queried Openverse for residual gaps with `cc0,pdm,by,by-sa`, commercial-use, and photographic file filters. This recovered exact candidates for Flores Island, South Pender Island, Beachcomber Regional Park, and Elk/Beaver Lake Regional Park.
- Accepted only a named place or a documented feature within it, with CC0/public-domain/CC BY/CC BY-SA terms and clear creator/source/location evidence. Rejected NC, ND, uncertain licenses, maps, unrelated same-name locations, nearby generic scenery, and features whose relationship to the exact park parcel could not be proven.
- No assets were downloaded into the product, no manifest/product code was changed, and no account, purchase, provider resource, or person was contacted. Every candidate still requires the integration owner's independent metadata and visual check.

## Results

- Searched: **77/77** (24 islands, 53 regional parks).
- Verified candidates: **43** (all 24 islands, 19 regional parks).
- Uncertain candidates held out of integration: **5**.
- Unmatched with per-place reasons: **29**.

Verified regional candidates cover Albert Head Lagoon, Beachcomber, Benson Creek Falls, Elk/Beaver Lake, Englishman River, Francis/King, Island View Beach, Lone Tree Hill, Matheson Lake, Matthews Point, Mill Hill, Moorecroft, Mount Parke, Mount Work, Sandy Pool, Sea to Sea, Sooke Hills Wilderness, Thetis Lake, and Witty's Lagoon. All 24 assigned islands have a candidate; several are named features on the island rather than whole-island aerials, and that relationship is stated explicitly in the candidate evidence.

The five uncertain records are Mount Arrowsmith Massif (feature/parcel relationship), Mount Benson (Roberts Roost/parcel relationship), Nanaimo River (highway crossing/park relationship), Roche Cove (bridge/viewpoint/park relationship), and Sooke Potholes Regional Park (location is explicit, but the only result is a close-up insect that may misrepresent the place editorially).

The JSON is the authoritative handoff. It contains the required candidate fields, separate uncertain candidates, all 29 unmatched reasons, and a 77-entry search log with exact queries, sources, and outcome:

`C:/repo/parkdex-worktrees/catalogue-photos/.codex/photo-candidates-regional-islands.json`

Next: `/root/photo_delivery` independently verifies the landing-page metadata, current license, original image, visual subject, and crop suitability before selecting or integrating any record. Honest `Photo unavailable` fallbacks remain correct for every unmatched or rejected place.

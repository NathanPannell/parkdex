# Map and catalogue refresh

Goal: keep the map focused on Vancouver Island, tighten the active catalogue to Vancouver Island and supported major islands, and replace generic achievements with place-specific local challenges.

Success: instant cluster labels, 56px+ invisible marker targets, fixed category colours and yellow clusters; Vancouver Island is used only as focus geometry; retired places remain in the database; achievement counts ignore retired visit IDs; catalogue and boundary checks pass.

Decisions and evidence:
- Shared palette: island `#247BA0`, regional `#D97706`, provincial `#D84A3A`, national `#7C4DFF`, clusters `#F4C84A`, ink `#173D32`.
- Geographic audit compares every tracked boundary with the OSM boundary of Vancouver Island and each supported major island. Parks with no intersection are outside the product scope.
- Seed migrations retire absent IDs with `active = FALSE`; visit rows remain intact.
- Government of B.C., Parks Canada, and Environment and Climate Change Canada sources support the ecological themes; detailed links will live with the data notes.

Completed:
- Added instant marker label placement, 60px+ invisible place targets, larger cluster targets, the shared category palette, and uniform yellow clusters.
- Added an explicit Vancouver Island startup extent and a world-scale inverse focus mask with clear supported-island and excursion-park cutouts; the camera remains free to fit the whole island on portrait screens.
- Made source attribution start compact at bottom left while preserving its accessible native toggle and source links.
- Retired 21 catalogue records through migration 0007; missing IDs become inactive and their visit rows remain intact.
- Replaced generic category medals with exact-place wildlife and habitat challenges, documented primary-source themes, and made all counts ignore retired visits.
- Targeted frontend tests pass (marker style, camera fit, focus mask, achievements); data, seed, and canonical boundary validation pass.

Next: root agent performs the integrated browser check and opens the PR.

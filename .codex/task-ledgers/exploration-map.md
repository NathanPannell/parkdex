# Exploration map

Goal: make the map switch cleanly between discovering places and seeing an honest, motivating record of visited territory.

Completed:

- `discover` mode clusters and displays the filtered catalogue; `explored` mode displays visited dots and estimated coverage only.
- Estimated coverage unions 4 km visit footprints with rounded minimum-spanning links capped at 24 km. Distant clusters remain disconnected, and 0.8 km holes mark nearby unvisited catalogue places.
- The union avoids overlapping-opacity seams. This conservative method handles zero, one, two, and collinear visits without the large unexplored triangles that an alpha or convex hull can create.
- Current location renders as a high-contrast pointer; heading rotates it when the device supplies one.
- Authoritative park geometry remains the click/fit source. A generated display asset applies adaptive high-quality simplification, a 35–800 m round closing pass, and a net 15–180 m outward offset, followed by rounded map strokes. The stored source polygons remain unchanged.

Evidence:

- 18 focused geometry, generated-asset, dual-source readiness, and map-style tests pass.
- The generated 216-feature display asset passes checksum, ID-parity, nonempty-geometry, and representative expansion checks; it is 2.13 MB with adaptive coordinate precision.
- Every generated polygon part is topology-validated. Features that become invalid at six decimals retain seven or more decimals; canonical input hashing normalizes line endings for Windows/Linux parity.
- Boundary UI becomes ready only after both canonical interaction geometry and softened display geometry load; failure of either reports unavailable while place pins remain usable.
- Frontend typecheck passes.
- The combined canonical boundary check is awaiting regeneration of the pre-existing stale canonical fit index; the new display-asset check passes independently.

Next: integrated desktop/mobile browser review after the frontend adds the exploration legend styles and finishes app wiring.

Resize follow-up:

- A deployed phone-to-desktop check exposed a transient MapLibre fit warning. The padding math remained valid for each final layout, but the selection callback could measure desktop DOM padding while MapLibre still held the phone-size canvas transform.
- Selection fitting now synchronizes the map canvas with `map.resize()` and rejects padding that leaves less than 64 px of usable canvas before calling the camera. A focused regression test covers desktop padding against stale phone dimensions.

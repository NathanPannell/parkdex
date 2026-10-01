# Vancouver Island provincial and regional park import bundle

`database/imports/provincial-regional-20260929/` is a reproducible, review-only bundle for Vancouver Island and surrounding islands. It contains 270 selected parks: 134 provincial and 136 regional. The frozen 271-entry legacy island catalogue includes Allison Harbour Marine Park, but its mapped boundary is on the mainland Central Coast. The bundle records that single exclusion and its geographic rationale in `selection.json`; it does not infer scope from the catalogue's region label.

The staging revision 26 snapshot used for identity review contains 100 parks. The selected IDs overlap 26 existing parks and add 244 new parks, for an expected total of 344 if the reviewed plan is later applied. The importer will preserve existing park metadata and artwork except for explicitly reviewed rarity changes. The pinned rarity review covers all 270 selected IDs; 26 entries target existing parks, and 244 new-park entries provide reviewed presentation and access. The rev26 comparison identifies seven actual existing rarity changes, four of them on parks with existing scenes. The importer checks authoring rollout jobs for affected scene artwork before applying a change.

The four files consumed by the importer are:

- `boundaries.geojson` has one grouped feature per selected stable ID. It preserves legacy source feature IDs and source properties, and carries all polygons and holes from the normalized displayed geometry.
- `catalogue.json` contains all 270 selected legacy catalogue entries so the importer plans the complete selection, including existing parks.
- `rarity-review.json` contains exactly the 26 selected IDs already present in the pinned target snapshot. Each entry has a rarity and rationale.
- `new-park-review.json` contains exactly the 244 new IDs. Every presentation uses either bundled metadata or an explicit biome decision, a supported seed, and `scene: null`; there is no new badge artwork in this bundle. `sources/biome-review.json` contains the separately reviewed biome, rationale, source links, and uncertainty flag for all 149 new parks without bundled presentation metadata. The other 95 use bundled biome metadata. Any uncertain assignments remain flagged in that source review; they are presentation choices, not claims that an official source confirmed a habitat.

Access data is kept separate from park presentation. Ninety-four new parks use bundled drive estimates, 33 use reviewed route estimates, and 18 have a reviewed `accessUnknown` decision. The other 99 parks have no reviewed route, including Hesquiat Peninsula, whose old source row had all-null drives and a nonzero walk value. Their import review deliberately uses `accessUnknown: true`, `walkM: 0`, and eight null drive entries. It does not carry the unsupported walk value into the wire data or invent a route. Overall, 117 of the 244 new parks have unknown access. The importer keeps `accessUnknown` in review provenance and publishes the existing all-null drive representation for those parks.

The raw legacy boundary file and the normalized file are both pinned under `sources/`. The identity audit's frozen raw boundary ends at the closing brace without a terminal newline. The normalizer input is the same byte sequence plus one LF; the builder verifies this exact relationship. The normalizer uses planar-face even-odd ring union and documents each of the seven repaired invalid source geometries in `island-boundaries.normalization.json`. It preserves source feature order, grouped source IDs, and ring coverage. Use the normalized output only with its matching report and normalizer script; the manifest pins all three hashes.

East Sooke is the sole geometry preservation override. Its current revision 26 boundary has the same three polygons and no holes as the legacy source, but its more precise coordinates cover about 0.12% different area than the rounded legacy copy. The bundle retains the entire revision 26 geometry for this one feature and keeps the legacy source properties and GIS source IDs. The manifest records both geometry hashes, summaries, symmetric difference, and the reason. This preserves current coverage without claiming exact legacy geometry. The 269 other output geometries come from the normalized legacy source.

All new scene values are null. Existing parks retain their metadata and artwork apart from the seven rarity values that differ from the pinned revision 26 snapshot. No provider call, database write, upload, or production change is part of building this bundle.

## Rebuild and verify

The source inputs are copied into `sources/`, so rebuilding does not depend on mutable scratch files:

```powershell
python scripts/build_island_import.py --bundle-dir database/imports/provincial-regional-20260929
```

The builder verifies the frozen catalogue, identity audit, target snapshot, normalized geometry, rarity review, route review, biome review, and bundled metadata hashes. It also validates all 244 new park records against the importer contract, requires exact biome-review coverage for the 149 records without bundled metadata, requires strict ID separation between new and existing reviews, checks the unknown-access sentinel pairing, and rewrites the five import and selection files deterministically. `manifest.json` includes input hashes, output hashes, counts, geography, geometry totals, source splits, the explicit exclusion, and the East Sooke preservation record.

To verify byte-for-byte rebuilds and bundle semantics:

```powershell
python scripts/test_build_island_import.py
```

The importer remains a separate two-step review process. A read-only plan consumes the four files above, with each ID from `selection.json` passed once as `--park-id`; review the complete plan and its hash before any apply. The plan must be freshly generated against the intended database revision. Do not treat this bundle or a successful plan as publication approval.

# Park seed catalogue

`places.json` is a normalized, source-attributed collection of parks and selected major islands across British Columbia. It is a field-guide game catalogue, not a survey, ownership record, public-access guarantee, or navigation dataset. See [BC coverage and source notes](../docs/bc-park-expansion.md) for the authority roster, current regional-source coverage, and gaps.

## Record contract

Every record has `id`, `name`, `category`, `latitude`, `longitude`, `region`, `description`, `sourceUrl`, and `sourceName`. `sourceId` is included when the source exposes a stable identity. IDs use deterministic category-prefixed slugs. Categories are `national`, `provincial`, `regional`, and `island`.

Coordinates are representative map pins. Provincial and regional pins use an interior point in the largest published polygon. They are not entrances, parking areas, trailheads, or campsites. National park pins represent each destination. Island pins use the official approximate centres published by the BC Geographical Names Office.

For BC Geographical Names search results, the numeric tail in `p.uri` identifies the name page. `p.feature.id` is a different source identity and is stored as `sourceId`. The reviewed island manifest keeps both values and the associated OpenStreetMap relation ID.

## Provincewide scope

The 2026-09-24 catalogue audit contains seven national destinations, 693 provincial park records, 307 regional parks, and 37 islands. `coverage-audit.json` is the generated count report for the exact build snapshot.

- **National parks and reserves:** seven BC destinations from Parks Canada: Glacier, Gulf Islands, Gwaii Haanas, Kootenay, Mount Revelstoke, Pacific Rim, and Yoho. Each park or reserve is a single check-off.
- **Provincial parks:** current DataBC TANTALIS records filtered to the `PROVINCIAL PARK` designation. The 2026-09-24 source snapshot contains 693 records. Ecological reserves and protected areas under other designations are not relabelled provincial parks.
- **Regional parks:** authority-owned source feeds have precedence where available. The catalogue contains 307 records, including 252 additions from three authority feeds and the BC Local and Regional Greenspaces dataset, alongside 55 existing source-specific records. The provincewide greenspaces filter covers 22 of 27 regional districts; the full limits and four current combined-source gaps are documented in the [BC coverage notes](../docs/bc-park-expansion.md).
- **Major islands:** a curated set with official BC Geographical Names identities and separately reviewed OpenStreetMap outlines. The 13 reviewed additions are recorded in [`scripts/bc-major-islands.mjs`](../scripts/bc-major-islands.mjs). The catalogue has 37 island records and does not attempt to list every named island in BC.

The province has 27 regional districts. Parkdex also assigns the Northern Rockies Regional Municipality and unincorporated Stikine Region to browse areas, for 29 geographic coverage units. Northern Rockies is a municipality, and Stikine is not a local government authority. Individual municipal and First Nations parks are included only when a source supports their park identity and classification. Trails are not treated as parks.

## Source and boundary limits

Provincial park identities and polygons come from the official DataBC TANTALIS protected areas feed, using `ADMIN_AREA_SID` when present. National boundaries come from Natural Resources Canada's Canada Lands Survey System. Regional boundaries use the managing authority's GIS where available, then the BC Local and Regional Greenspaces WFS. DataBC publishes its layer under the [Open Government Licence - British Columbia](https://www2.gov.bc.ca/gov/content/data/open-data/open-government-licence-bc). Local authority GIS feeds can carry separate terms; check each source before redistribution. The consolidated layer is updated irregularly and its rows differ from GeoBC's separate ArcGIS publication. Source counts and ID discrepancies remain in the importer integration report for review. A zero-row district means the filter found no entry in that source snapshot, not that the district has no parks.

BC Geographical Names supplies official island names and approximate centres, not island outlines. Individually reviewed OpenStreetMap multipolygons supply island map geometry under the Open Database License. Attribute OpenStreetMap in displays and do not use volunteer outlines as official park boundaries, survey lines, property extents, or access evidence. Legal park plans and authority GIS take precedence for park boundaries.

`coverage-audit.json` records source counts, exclusions, coordinates, and polygon-pin checks. `boundary-audit.json` records the boundary count by source, source identifiers, geometry totals, and data size. Review both after any source update. The [regional integration report](source-imports/regional-greenspaces/integration-report.json) records WFS versus ArcGIS source differences, park-name grouping, exclusions, and district coverage.

## Region groups

The ten collection labels are defined in [`scripts/bc-regions.mjs`](../scripts/bc-regions.mjs) and listed with every regional district in [docs/bc-park-expansion.md](../docs/bc-park-expansion.md). They are for browsing. Source names retain the managing park authority. The GeoBC legal administrative layer covers 27 regional districts plus Stikine; Northern Rockies Regional Municipality is handled separately because it is outside the regional district polygon layer. Marine parks outside a district polygon are assigned to the nearest district coastline, with reviewed special cases where required.

The exploration map is a display-only completion estimate. It does not show ground travelled, ownership, access, or safe routes. Its territories are derived from the current BC focus map and catalogue places; see the generated geography audits for the deployed snapshot.

## Descriptions and visitor information

Visitor information and place descriptions are maintained in separate source catalogues under `frontend/lib`. A destination link is added only when it identifies the place and destination page. Descriptions record source page, section, and review date. When no official overview is available, the gap remains explicit or uses a short source-derived category description. Park names alone are not used to invent access details or visitor advice.

## Photos and licenses

Park GIS and open place data do not grant photo reuse rights. Photos require evidence that they depict the tracked place or an explicitly documented feature within it. Record the creator, source and original URLs, reuse license and license URL, location evidence, alt text, and any crop or conversion. Maintain local WebP variants with the size limits in [`frontend/public/places/README.md`](../frontend/public/places/README.md), and keep credits in [`CATALOGUE_CREDITS.md`](../frontend/public/places/CATALOGUE_CREDITS.md).

Use Commons or another free-license source when the location and license are clear. Use BC Parks, Parks Canada, municipal, regional, or First Nations photos only when the specific image includes a reuse license or explicit permission. An open park boundary dataset does not authorize reuse of its agency photographs. A park without a cleared photograph keeps the text-free placeholder. Generic landscape and species images must not be presented as a photograph of a named park.

## Rebuild and validation

From the repository root, run `node scripts/data-build.mjs`, then `node scripts/data-validate.mjs` to refresh and validate the source catalogue. Run `node scripts/boundary-build.mjs` to refresh park and island geometries from official services and reviewed OpenStreetMap relations. Run `node scripts/boundary-validate.mjs` for network-free geometry, identity, attribution, and audit consistency checks. These commands fetch live data during rebuilds, so record their generated snapshot date and compare the resulting audit files with the documented source gaps.

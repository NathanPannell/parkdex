# British Columbia park expansion

## Scope

Expand the Parkdex staging catalogue from Vancouver Island to all of British Columbia: provincial and national parks, regional district park authorities with defensible source coverage, major islands, boundaries, photos, and a concise list grouping.

## Baseline

- Branch `feat/bc-park-expansion` from `origin/staging` at `9644124a09c42cf2c033f8c07fb5255b1d675ea1`.
- Existing canonical catalogue: 198 places, comprising 2 national, 117 provincial, 55 regional, and 24 islands.
- Existing data and map focus are explicitly Vancouver Island scoped. Existing IDs and visits must remain stable.

## Plan and checkpoints

1. Inventory official BC regional districts, park lists, boundary feeds, image rights, and gaps.
2. Expand national/provincial imports and additive database bounds.
3. Add sourced local park coverage and explicit authority inventory.
4. Add major islands, broad list groups, and province-wide map support.
5. Build and validate catalogue, boundaries, routes, and imagery with performance budgets.
6. Full local suite, draft PR, isolated preview, deployed browser checks, staging merge and exact-SHA verification, preview teardown.

## Source principles

- A regional district is the BC-wide local-government equivalent; the province has 27. Municipalities are separate governments and their municipal parks are a distinct scope.
- Include only named parks with source-backed identity. Record missing boundary/photo coverage honestly; no synthetic visitor URLs or invented imagery.
- Preserve canonical IDs for existing places and use published polygon geometry where possible.

## Progress, 2026-09-23

- BC Parks and Parks Canada imports now produce 693 provincial and seven national records, with source polygons and preserved existing identities.
- The ten broad list headings, BC map camera and land mask, verified BC Parks visitor links, five new national photos, and thirteen reviewed major-island identities are implemented.
- Official Metro Vancouver, Central Okanagan, Fraser-Fort George, and province-wide greenspaces feeds have been researched and normalized. Regional park integration, complete data generation, and validation are in progress.
- The province-wide greenspaces WFS and its ArcGIS mirror disagree materially. The importer records counts and IDs; individual regional inventories take precedence.
- The baseline staging mobile list screenshot was captured. Preview, staging release, browser verification, and owned teardown are pending.

## Integration checkpoint

- Catalogue quality review now retains 1,030 places: 693 provincial, seven national, 293 regional, and 37 islands. The 293 regional records include 55 existing and 238 new entries from four official feeds.
- All 198 existing place IDs remain present. The route manifest preserves all 198 published slugs and assigns unique routes to the new records.
- The first 1,044-boundary build passed geometry and provenance validation. An audited source-ID exclusion list removed 14 unmistakable nonparks or ambiguous civic labels from the DataBC candidates; final 1,030-boundary generation is in progress.
- Provider preflight found authenticated local GitHub, Railway, Neon, and Vercel credentials and verified target project identities. No preview resources have been created yet.

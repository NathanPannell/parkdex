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

## Release journal

Pending implementation and provider audit.

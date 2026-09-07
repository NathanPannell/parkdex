# Every Park seed catalogue

`places.json` is a normalized, source-attributed v0 catalogue for Vancouver Island and a curated set of nearby Gulf, Discovery, west-coast, and northern islands. It is a game collection, not a legal-boundary or navigation dataset.

## Record contract

Every record has `id`, `name`, `category`, `latitude`, `longitude`, `region`, `description`, `sourceUrl`, and `sourceName`. `sourceId` is included when the authority exposes a stable identifier. IDs are deterministic category-prefixed slugs. Categories are `national`, `provincial`, `regional`, and `island`.

Coordinates are representative map pins. Provincial and regional pins use the area centroid of the largest official GIS polygon when it is inside the polygon and outside every hole; otherwise the builder chooses a verified interior point. They are not entrances, parking areas, or trailheads. Island pins are the official approximate centres published by the BC Geographical Names Office. Parks Canada pins are the representative points in its national park finder.

## Included coverage

- Two whole national park reserves: Pacific Rim and Gulf Islands. Their internal units are not separate check-offs.
- Provincial parks from the current DataBC TANTALIS WFS. Ecological reserves and protected areas whose designation is not `PROVINCIAL PARK` are excluded.
- Named regional parks from the CRD and RDN official GIS sources, plus Bere Point Regional Park from its RDMW page and the matching official BC Geographical Names point. Features named as trails, including Morden Colliery Regional Trail, are excluded from this parks-only collection.
- Four eligible unique CVRD regional parks. Chemainus River and Spectacle Lake are represented once under their provincial identities; Siddoo and Stocking/Heart Lake are excluded because the official layer marks them undeveloped with no public access.
- Twenty-five curated, officially named major or commonly visited islands. This is an explicit product collection, not every island or islet.

## Known limitations

Regional coverage is strongest for CRD, RDN, and CVRD. The ACRD official list is represented by Mount Arrowsmith Regional Park through the RDN shared-boundary dataset, but China Creek and the linear trail properties lack a clean authoritative representative-point feed. SRD's directory labels its current facilities by types such as nature park, community park, beach access, and trail rather than exposing a stable regional-park set. RDMW's second named regional park, Kwaksistah, has an official site map but no georeferenced location or stable GIS feed, so it is not assigned a guessed pin. Comox Valley established a regional parks service in 2022 and is still working through acquisition planning; its existing rural community parks are outside this regional-only category.

`coverage-audit.json` records counts, extents, polygon-pin containment verification, and every provincial park excluded by the geographic scope. Review it whenever source data changes. The Vancouver Island mask is intentionally paired with a reviewed inclusion allowlist for coastal and nearby-island parks. Region labels use a separate explicit island taxonomy so inclusion exceptions cannot relabel Vancouver Island parks as offshore islands.

## Rebuild

From the repository root, run `node scripts/data-build.mjs`, then `node scripts/data-validate.mjs`. The builder fetches current official DataBC, CRD, CVRD, RDN, and BC Geographical Names data. The RDN KMZ is unpacked in memory, so no third-party source archive is redistributed.

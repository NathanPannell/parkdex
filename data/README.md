# Every Park seed catalogue

`places.json` is a normalized, source-attributed v0 catalogue for Vancouver Island and a curated set of nearby Gulf, Discovery, west-coast, and northern islands. It is a game collection, not a survey, ownership, public-access, or navigation dataset.

## Record contract

Every record has `id`, `name`, `category`, `latitude`, `longitude`, `region`, `description`, `sourceUrl`, and `sourceName`. `sourceId` is included when the authority exposes a stable identifier. IDs are deterministic category-prefixed slugs. Categories are `national`, `provincial`, `regional`, and `island`.

Coordinates are representative map pins. Provincial and regional pins use the area centroid of the largest official GIS polygon when it is inside the polygon and outside every hole; otherwise the builder chooses a verified interior point. They are not entrances, parking areas, or trailheads. Island pins are the official approximate centres published by the BC Geographical Names Office. Parks Canada pins are the representative points in its national park finder.

## Included coverage

- Two whole national park reserves: Pacific Rim and Gulf Islands. Their internal units are not separate check-offs.
- Provincial parks from the current DataBC TANTALIS WFS. Ecological reserves and protected areas whose designation is not `PROVINCIAL PARK` are excluded.
- Named regional parks from the CRD and RDN official GIS sources, plus Bere Point Regional Park from its RDMW page and the matching official BC Geographical Names point. Features named as trails, including Morden Colliery Regional Trail, are excluded from this parks-only collection.
- Three eligible unique CVRD regional parks. Chemainus River and Spectacle Lake are represented once under their provincial identities; Bute Island is outside the supported-island footprint; Siddoo and Stocking/Heart Lake are excluded because the official layer marks them undeveloped with no public access.
- Twenty-four curated, officially named major or commonly visited islands. Vancouver Island supplies the collection's geographic frame and is not itself a check-off.

Bowen Island's Apodaca Park and North Thormanby Island's Buccaneer Bay Park are excluded as Howe Sound/Sunshine Coast features outside the Vancouver Island collection.

The geographic review compares each published park boundary with Vancouver Island and the 24 supported-island coastlines. Parks wholly on other offshore islands are retired from the active catalogue; the full list and reason are recorded in `coverage-audit.json`. Four familiar Vancouver Island day-trip destinations—Mitlenatch Island, Pirates Cove, Saysutshun/Newcastle Island, and Wallace Island—remain intentional park-level exceptions. Their published park footprints are also cut out of the map's gray focus mask.

## Known limitations

Regional coverage is strongest for CRD, RDN, and CVRD. The ACRD official list is represented by Mount Arrowsmith Regional Park through the RDN shared-boundary dataset, but China Creek and the linear trail properties lack a clean authoritative representative-point feed. SRD's directory labels its current facilities by types such as nature park, community park, beach access, and trail rather than exposing a stable regional-park set. RDMW's second named regional park, Kwaksistah, has an official site map but no georeferenced location or stable GIS feed, so it is not assigned a guessed pin. Comox Valley established a regional parks service in 2022 and is still working through acquisition planning; its existing rural community parks are outside this regional-only category.

The exploration map is a display-only completion estimate, not a record of ground travelled, access, or ownership. Its precomputed land partition assigns each location to the place with the lowest projected distance squared divided by category weight: national 4, major island 3, provincial 2, and regional 1. The partition is clipped to the same reviewed Vancouver Island, supported-island, and excursion footprint used by the map focus layer.

`coverage-audit.json` records counts, extents, polygon-pin containment verification, and every provincial park excluded by the geographic scope. Review it whenever source data changes. The Vancouver Island mask is intentionally paired with a reviewed inclusion allowlist for coastal and nearby-island parks. Region labels use separate explicit island and island-park taxonomies; the rebuild fails when an included offshore park has no named region assignment, so coordinate bands cannot silently relabel it.

## Boundary contract and sources

`boundaries.geojson` contains exactly one Polygon or MultiPolygon feature for every canonical place ID. Feature properties are `id`, `name`, `category`, `sourceName`, `sourceUrl`, and `sourceId`. Multipart parcels and interior holes are retained. Coordinates are WGS84 and are normally simplified to a tolerance of 0.00004 degrees for mobile delivery; the builder falls back to the valid full-precision source geometry if compaction would invalidate a polygon. `boundary-audit.json` records coverage, geometry totals, payload size, reviewed island source objects, and any upstream topology warning.

Provincial and regional boundaries come from the same official DataBC, CRD, CVRD, and RDN layers used by the catalogue builder. Pacific Rim and Gulf Islands use Natural Resources Canada's Canada Lands Survey System legislative boundary service. Those polygons show the legislated reserve extent; they do not determine ownership, permitted access, or safe travel. Bere Point uses its named OpenStreetMap park polygon because RDMW does not publish a geospatial boundary feed.

The 24 collectible island coastlines use individually reviewed, stable OpenStreetMap relation IDs matched to the canonical BC Geographical Names identities. A simplified Vancouver Island coastline is retained separately for the non-interactive map focus mask. These derived artifacts include data © OpenStreetMap contributors and are available under the Open Database License; applications displaying them must show OpenStreetMap attribution. See https://www.openstreetmap.org/copyright.

## Rebuild

From the repository root, run `node scripts/data-build.mjs`, then `node scripts/data-validate.mjs`. The builder fetches current official DataBC, CRD, CVRD, RDN, and BC Geographical Names data. The RDN KMZ is unpacked in memory, so no third-party source archive is redistributed.

Run `node scripts/boundary-build.mjs` to refresh the boundary artifact from the official GIS services, the federal legislative-boundary service, and the locked OpenStreetMap objects. Run `node scripts/boundary-validate.mjs` for the network-free CI check. It verifies exact catalogue coverage and identity, source attribution, finite closed WGS84 rings, strict topology, multipart national reserves, reviewed island IDs, pin containment where the catalogue contract supports it, part/hole preservation, audit consistency, and the 5 MB raw mobile budget.

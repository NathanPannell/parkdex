# British Columbia park coverage and source plan

Parkdex now uses a provincewide collection scope. The catalogue combines seven Parks Canada destinations, provincial park records from BC Parks and DataBC, and regional parks where a public authority source supplies an identifiable place. Regional coverage is not a complete inventory of every municipal or First Nations park, and every place retains its actual managing authority and source.

The latest catalogue audit, generated 2026-09-24, contains 693 provincial records, seven national destinations, 293 regional parks, and 37 islands, for 1,030 places total. The regional total is 238 additions from four feeds plus 55 existing source-specific records. The island total includes 13 reviewed additions beyond the previous 24. See [`data/coverage-audit.json`](../data/coverage-audit.json) for the generated category counts and [`scripts/bc-major-islands.mjs`](../scripts/bc-major-islands.mjs) for the island source IDs.

## Government structure and collection regions

British Columbia has [27 regional districts](https://www2.gov.bc.ca/gov/content/governments/local-governments/facts-framework/systems/regional-districts). The table groups all 27 into ten Parkdex browse areas. Names below follow the province's [regional district map roster](https://www2.gov.bc.ca/gov/content/governments/local-governments/facts-framework/local-government-maps/regional-district-maps) and GeoBC's [administrative boundaries layer](https://delivery.maps.gov.bc.ca/arcgis/rest/services/whse/bcgw_pub_whse_legal_admin_boundaries/MapServer/16).

| Parkdex browse area | Regional districts |
| --- | --- |
| Southern Vancouver Island | Regional District of Alberni-Clayoquot; Capital Regional District; Cowichan Valley Regional District; Regional District of Nanaimo |
| Northern Vancouver Island | Comox Valley Regional District; Strathcona Regional District; Regional District of Mount Waddington |
| South Coast | Fraser Valley Regional District; Metro Vancouver Regional District; qathet Regional District; Squamish-Lillooet Regional District; Sunshine Coast Regional District |
| Thompson & Okanagan | Regional District of Central Okanagan; Columbia-Shuswap Regional District; Regional District of North Okanagan; Regional District of Okanagan-Similkameen; Thompson-Nicola Regional District |
| Kootenays | Regional District of Central Kootenay; Regional District of East Kootenay; Regional District of Kootenay Boundary |
| Cariboo & Central Interior | Cariboo Regional District; Regional District of Fraser-Fort George |
| Central Coast | Central Coast Regional District |
| North Coast & Haida Gwaii | North Coast Regional District; Regional District of Kitimat-Stikine |
| Nechako | Regional District of Bulkley-Nechako |
| Northeast | Peace River Regional District |

Two additional geographic coverage units are not regional districts:

- **Northern Rockies Regional Municipality** is a municipality outside the regional district system. It is shown in the Northeast collection area. The legal regional district layer does not contain it.
- **Stikine Region** is unincorporated and governed by the Province. It is included in the Nechako collection area, but it is not a local government authority.

There are 29 coverage units in total: 27 regional districts, the Northern Rockies Regional Municipality, and Stikine Region. Do not describe them as 29 regional districts or 29 local authorities. The ten collection areas are browse labels, not legal boundaries or replacements for source authorities. Their design adapts the [BC Stats development regions](https://www2.gov.bc.ca/assets/gov/data/geographic/land-use/administrative-boundaries/census-boundaries/development-region/map_development_region_detailed.pdf), splitting Vancouver Island in two and grouping coastal and interior districts by familiar geography.

## Authority and boundary sources

| Category | Identity and visitor sources | Boundary source | Current coverage and limits |
| --- | --- | --- | --- |
| Provincial parks | [BC Parks A to Z](https://bcparks.ca/find-a-park/a-z-list/) and the [BC Parks / DataBC open dataset](https://catalogue.data.gov.bc.ca/dataset/parks-ecological-reserves-and-protected-areas) | [TANTALIS WFS](https://openmaps.gov.bc.ca/geo/pub/WHSE_TANTALIS.TA_PARK_ECORES_PA_SVW/ows), filtered to `PROTECTED_LANDS_DESIGNATION='PROVINCIAL PARK'` | The 2026-09-24 snapshot contains 693 source records. `ADMIN_AREA_SID` is the source identity. Ecological reserves and other protected-area designations stay out of the provincial park category. Some names describe individual sites or park units. |
| National parks and reserves | [Parks Canada park finder](https://parks.canada.ca/pn-np/recherche-parcs-parks-search) and the linked destination pages | [Natural Resources Canada legislative boundaries](https://open.canada.ca/data/en/dataset/9e1507cd-f25c-4c64-995b-6563bf9d65bd), Canada Lands Survey System | Seven BC destinations: Glacier, Gulf Islands, Gwaii Haanas, Kootenay, Mount Revelstoke, Pacific Rim, and Yoho. Gwaii Haanas also has marine and Haida Heritage Site identities; the catalogue has one national park reserve check-off. Legal plans take precedence over display geometry. |
| Regional parks | District park directories, authority GIS, and the province's [Local and Regional Greenspaces dataset](https://catalogue.data.gov.bc.ca/dataset/6a2fea1b-0cc4-4fc2-8017-eaf755d516da) | Prefer the managing authority's current park polygons. Use the DataBC greenspaces WFS where a local authority source is unavailable and identity is clear. | The catalogue contains 293 regional places: 24 Metro Vancouver, 30 Central Okanagan, 11 Fraser-Fort George, 173 eligible greenspaces records, and 55 existing source-specific records. The greenspaces WFS represents 22 of 27 regional districts. Its zero-record areas do not imply that those districts have no parks. |
| Major islands | [BC Geographical Names Office](https://apps.gov.bc.ca/pub/bcgnws/web/) for official name and approximate centre | Individually reviewed [OpenStreetMap island multipolygons](https://www.openstreetmap.org/copyright) | The 37 island records include 13 new reviewed additions in [`scripts/bc-major-islands.mjs`](../scripts/bc-major-islands.mjs). The BCGN name-page ID is the number in `p.uri`; its `p.feature.id` is a separate identity retained as the place `sourceId`. OpenStreetMap supplies map outlines, not legal or park boundaries. |

The [GeoBC legal administrative boundaries layer](https://delivery.maps.gov.bc.ca/arcgis/rest/services/whse/bcgw_pub_whse_legal_admin_boundaries/MapServer/16) is used to assign parks to collection regions. It includes the 27 regional districts and Stikine, but not Northern Rockies Regional Municipality. Marine parks outside a district land polygon are assigned to the nearest district coastline, with explicit island-area overrides where necessary. The digital district outlines are a reference for browsing, not a legal determination.

### Regional source audit

The provincial greenspaces WFS filter is `PARK_TYPE='Regional' AND PARK_PRIMARY_USE='Park'`. Its 2026-09-24 response returned 405 rows and normalized to 263 named candidates before the trail-only and eligibility review. GeoBC's separate ArcGIS layer 40 returned 380 rows, with only 18 `LOCAL_REG_GREENSPACE_ID` values shared with the WFS result. The importer uses WFS geometry and keeps layer 40 as an independent audit; the mismatch is recorded in [`data/source-imports/regional-greenspaces/integration-report.json`](../data/source-imports/regional-greenspaces/integration-report.json), not treated as pagination loss. DataBC publishes the greenspaces dataset under the [Open Government Licence - British Columbia](https://www2.gov.bc.ca/gov/content/data/open-data/open-government-licence-bc). Local authority GIS feeds retain their own service terms; check the actual terms before redistribution and preserve each source URL and object ID.

The current WFS snapshot has no filtered features for Bulkley-Nechako, Cariboo, Kitimat-Stikine, Mount Waddington, or North Coast. Mount Waddington has four existing district-sourced catalogue records. The first four remain source coverage gaps in the present audit, not evidence that there are no parks. The WFS update dates range from 2017-10-02 through 2026-03-16, so the consolidated layer is not a current certified inventory for every authority.

Local source precedence retains the existing Capital Regional District, Cowichan Valley, Nanaimo, and Mount Waddington records and stable IDs. Additional authority sources currently include Metro Vancouver's regional park boundary service, the Central Okanagan park GIS, and Fraser-Fort George's park GIS files. Local feeds are preferred when their source identity and boundary are clear. The greenspaces importer filters out trail-only records and retains its authority, source IDs, update date, and source website for review. Duplicate source polygons for one named park are grouped without erasing multipart geometry.

Regional park categories are not inferred from proximity alone. Municipal parks, First Nations parks, trails, and conservation areas need a clear place identity and a source that supports their classification before they become separate check-offs. A named regional boundary may also include multiple parcels or islands. A catalogue pin inside the polygon is a representative location, not a visitor entrance.

## Island identity and geometry

The island shortlist adds Graham and Moresby in Haida Gwaii, Bowen and Texada, and prominent or inhabited Central and North Coast islands. BCGN records are official name identities with approximate centre points; they do not contain coastlines. OpenStreetMap relations are usable map outlines, subject to Open Database License attribution, but are volunteer-maintained and are not surveyed parcel lines, park extents, access rights, or proof of public access. Do not use an island outline as a substitute for an official park polygon.

## Photos and reuse rights

Park and greenspace boundary datasets do not grant rights to photographs. Follow the [place photo policy](../frontend/public/places/README.md) and its [catalogue credit index](../frontend/public/places/CATALOGUE_CREDITS.md). Each image must show the named park or a feature documented inside its boundary. Record its creator, source page, original asset URL, license and license URL, location evidence, alt text, and any edits. Keep optimized local WebP files and both listing and detail variants.

Commons and other free-license sources are preferred when the exact place and reusable license can be confirmed. Official BC Parks, Parks Canada, regional district, municipal, or First Nations imagery is used only when the specific image carries a reusable license or explicit permission. Open park data does not make an agency's photos free to reuse. A missing cleared photograph uses the text-free placeholder; a generic scenery image must not imply it depicts that park.

## Release acceptance

- Each catalogue place has stable identity, source provenance, BC coordinates, a collection area, and an attributed Polygon or MultiPolygon boundary.
- Source totals and exclusions match the generated coverage and boundary audits after the full catalogue rebuild.
- Existing place IDs and saved visits remain intact through the additive migration.
- The collection list presents ten browse areas while preserving the place's managing authority.
- The exact preview and staging revisions pass map, search, collection, detail, boundary, and photo-credit browser checks.
- Preview resources are removed after staging verification, and the task ledger records the deployed SHA and cleanup status.

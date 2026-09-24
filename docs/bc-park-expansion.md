# British Columbia park coverage and source plan

## Government structure

British Columbia has [27 regional districts](https://www2.gov.bc.ca/gov/content/governments/local-governments/facts-framework/systems/regional-districts). They are the province-wide equivalent of the regional park authorities already represented on Vancouver Island. The [provincial district map](https://www2.gov.bc.ca/gov/content/governments/local-governments/facts-framework/local-government-maps/regional-district-maps) names all 27. The Stikine Region is unincorporated and is not a regional district. The Northern Rockies Regional Municipality is a municipality rather than one of the 27 regional districts. Individual municipal and First Nations parks are a separate inventory and are not silently relabelled as regional district parks.

| Parkdex browse area | Regional districts or other area |
| --- | --- |
| Southern Vancouver Island | Alberni-Clayoquot, Capital, Cowichan Valley, Nanaimo; southern Gulf and west coast islands |
| Northern Vancouver Island | Comox Valley, Mount Waddington, Strathcona; Discovery and northern islands |
| South Coast | Fraser Valley, Metro Vancouver, qathet, Squamish-Lillooet, Sunshine Coast |
| Thompson & Okanagan | Central Okanagan, Columbia-Shuswap, North Okanagan, Okanagan-Similkameen, Thompson-Nicola |
| Kootenays | Central Kootenay, East Kootenay, Kootenay Boundary |
| Cariboo & Central Interior | Cariboo, Fraser-Fort George |
| Central Coast | Central Coast and mainland coast parks outside the island browse areas |
| North Coast & Haida Gwaii | Kitimat-Stikine, North Coast; Haida Gwaii |
| Nechako | Bulkley-Nechako and the Stikine Region |
| Northeast | Peace River and Northern Rockies Regional Municipality |

The broad areas adapt the [BC Stats development-region map](https://www2.gov.bc.ca/assets/gov/data/geographic/land-use/administrative-boundaries/census-boundaries/development-region/map_development_region_detailed.pdf). We split its Vancouver Island-Coast area in two and place the Central Coast and qathet where they are easier to browse. These are collection headings, not legal boundaries or a replacement for the place's source authority.

## Park and boundary sources

| Scope | Identity and visitor source | Boundary source | Refresh and limits |
| --- | --- | --- | --- |
| Provincial parks | [BC Parks open data API](https://open.canada.ca/data/en/dataset/fb1c834b-5a59-44f4-8ed9-6585e826f88d) and [BC Parks A-Z list](https://bcparks.ca/find-a-park/a-z-list/) | [DataBC TANTALIS parks, ecological reserves and protected areas](https://catalogue.data.gov.bc.ca/dataset/parks-ecological-reserves-and-protected-areas), filtered to the published `PROVINCIAL PARK` designation | Use `ADMIN_AREA_SID` as stable source identity. A map pin is a representative point inside the largest published polygon, not an access point. Protected areas with another designation remain out of this category. |
| National parks and reserves | [Parks Canada park finder](https://parks.canada.ca/pn-np/recherche-parcs-parks-search) and each destination page | [Natural Resources Canada legislative boundaries](https://open.canada.ca/data/en/dataset/9e1507cd-f25c-4c64-995b-6563bf9d65bd) | Seven BC destinations: Glacier, Gulf Islands, Gwaii Haanas, Kootenay, Mount Revelstoke, Pacific Rim, Yoho. Gwaii Haanas has an additional marine and Haida Heritage Site identity; Parkdex uses one checkoff for the national park reserve. Legal plans take precedence over the map geometry. |
| Regional district parks | District park directories and [DataBC Local and Regional Greenspaces](https://catalogue.data.gov.bc.ca/dataset/6a2fea1b-0cc4-4fc2-8017-eaf755d516da) | Current district GIS where available, followed by the provincial [greenspaces polygon layer](https://delivery.maps.gov.bc.ca/arcgis/rest/services/whse/bcgw_pub_whse_basemapping/MapServer/40) | The consolidated layer is a useful BC-wide first pass, but its updates are irregular and its boundaries and park classifications come from multiple local governments. It is not proof that each district's current park list is complete. Use `PARK_TYPE=Regional` and `PARK_PRIMARY_USE=Park`, deduplicate parcels by authority and name, and review source changes before refreshing. |
| Major islands | [BC Geographical Names Office](https://apps.gov.bc.ca/pub/bcgnws/web/) | Individually reviewed [OpenStreetMap](https://www.openstreetmap.org/copyright) coastlines | Keep name identity separate from geometry. Attribute OpenStreetMap and its ODbL in the product. Islands are geographic collectibles, not claims of public access. |

The [legal regional district polygons](https://catalogue.data.gov.bc.ca/dataset/d1aff64e-dbfe-45a6-af97-582b7f6418b9) assign new provincial parks to browse areas. The digital polygons are an administrative reference, not a legal determination. Coastal parks outside a district land polygon use the nearest district coastline, with reviewed overrides for mainland parks inside an island-serving district.

### Local source priority

1. Existing CRD, CVRD, RDN and Mount Waddington source contracts retain their canonical IDs and saved visits.
2. [Metro Vancouver Regional Parks Boundaries](https://services6.arcgis.com/56eqCzQ5SZhBaDST/ArcGIS/rest/services/Regional_Parks_Boundaries/FeatureServer/11) is a current authority polygon feed.
3. The [Fraser-Fort George regional park GIS files](https://www.rdffg.bc.ca/services/environment/parks) and other reviewed district feeds take priority when their park identity and boundary are clear.
4. The province-wide local and regional greenspaces layer fills named regional-park gaps. Its `LICENCE_COMMENTS`, `WHEN_UPDATED`, authority, source ID, and website fields remain in the audit so updates can be reviewed.

## Photos

The greenspace and TANTALIS polygons do not supply licensed park photographs. Existing Parkdex photos use individually reviewed Commons and other free-license files with creator, license, original URL, exact-place evidence, and local WebP variants. New photos follow that same [asset policy](../frontend/public/places/README.md). A photo must depict the named place or an explicitly documented feature within it. BC Parks and Parks Canada site photography is not assumed reusable merely because their park data is open. A place without a cleared photo keeps the honest placeholder until a verified image is available.

## Release acceptance

- Every catalogue place has a source identity, BC coordinates, stable ID, browse area, and a sourced Polygon or MultiPolygon boundary.
- Existing place IDs and existing user visits remain intact after the additive seed migration.
- The collection list shows ten broad headings while authority filtering retains distinct regional district park managers.
- A real browser verifies map, search, collection, place detail, boundary, and photo credit behaviour on the exact preview revision and staging merge revision.
- Staging release, preview cleanup, and exact provider revisions are recorded in the task ledger.

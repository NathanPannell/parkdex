# British Columbia map land outline

`bc-land-focus.geojson` is a display-only land outline derived from Statistics
Canada's [2021 province and territory cartographic boundary layer](https://geo.statcan.gc.ca/geo_wa/rest/services/2021/Cartographic_boundary_files/MapServer/0).
The source feature is `PRUID = '59'`, returned as GeoJSON in WGS 84. It is
licensed under the [Open Government Licence - Canada](https://open.canada.ca/en/open-government-licence-canada).

The stored outline retains the mainland and offshore polygons at least
0.5 square kilometres in BC Albers projection (EPSG:3005). Source coordinates
were rounded to four decimal places for map display. The retained polygons
were repaired and unioned to remove tiny intersections caused by source
generalization. Catalogued park boundaries are added separately during mask
and exploration generation, so mapped parks on smaller islands remain visible.

This outline is for visual map focus and estimated exploration only. Park
boundaries and visit eligibility use the separately sourced canonical
`boundaries.geojson` asset.

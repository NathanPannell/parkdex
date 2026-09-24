# Map loading plan for all of BC

## Current cost

The staging catalogue has 1,030 places. `data/places.json` is about 59 KB after local gzip. The four map geometry assets are about 7.28 MB after local gzip: canonical boundaries 2.73 MB, display boundaries 2.67 MB, exploration territories 1.42 MB, and the BC focus mask 0.46 MB. These are local compression estimates, not observed CDN transfer sizes. The display boundaries and territories are already simplified, but the browser still receives whole-province geometry at every zoom. The map browser and Field Guide can also mount roughly 1,030 place rows at once.

## Recommended sequence

1. **Ship geometry by zoom and viewport.** Generate a versioned manifest and CDN-cacheable vector tiles from the existing canonical sources. Below zoom 7, show clusters and coarse territory or park outlines. At zooms 7 to 9, show simplified visible boundary tiles. At zoom 10 and above, load more detailed visible tiles. Preserve stable place IDs for visited styling and selection, and load canonical geometry for a selected park only when needed. Keep the current boundary index for fit-to-place and offline fallback. Validate tile seams, island coverage, boundary hit testing, and selected or visited states across zoom transitions. MapLibre supports vector tile sources in its [official API](https://maplibre.org/maplibre-gl-js/docs/API/classes/VectorTileSource/).
2. **Keep global discovery lightweight.** Retain a compact, complete summary index for search, region counts, badges, groups, and offline use. Fetch longer descriptions and provenance when a place opens. Render the map browser and Field Guide rows incrementally or with accessible windowing, preserving keyboard navigation and screen reader discovery.
3. **Add viewport point delivery only when measurements warrant it.** The current 1,030 point catalogue and client clustering are modest compared with the polygon payload. If marker processing later exceeds the interaction budget, add a padded bounding-box endpoint queried after map movement, abort stale requests, cache by viewport and zoom, and cluster server-side at low zoom. Keep global search independent of the viewport.

Initial targets to validate on a midrange mobile browser: under 300 KB compressed map-owned geometry at first view, under 50 KB per visible geometry tile, and no map network request during a drag. These are proposed budgets, not measured performance results. Track first useful map render, bytes, memory, pan latency, and cache hits on staging before choosing final thresholds.

## Craigslist comparison

Craigslist [scopes searches by location](https://www.craigslist.org/about/help/searching/how-to-search/location) and [category](https://www.craigslist.org/about/help/searching/how-to-search/category), and offers [list, gallery, and map displays](https://www.craigslist.org/about/help/searching/display). Query-first delivery is a useful product pattern for Parkdex. Craigslist does not publish its tile, bounding-box, clustering, or cache implementation in those help pages, so this plan does not assume its internals.

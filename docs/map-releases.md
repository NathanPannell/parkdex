# Detailed map releases

The detailed map is a Protomaps archive split into chunks on R2. New builds pin the map they use in `BUILD_MAP_POINTER` (`src/lib/content/contracts.ts`) instead of reading the map pointer from the content API. The app streams this archive straight from the CDN while online and reads saved map detail only when offline. It keeps only the detail for the view around the player; whole squares are offline downloads (#199). The server pointer stays on the 96 MB island archive. Builds installed before 2026-10-01 download the whole map they are given, so they must never receive a BC or combined archive.

## Current pin: BC and Nova Scotia

One archive covers both provinces. Its areas are the boxes in `CONTENT_BOUNDS`, which also gate nearby downloads and nearby art.

| Field | Value |
| --- | --- |
| Source | Protomaps build `20261012`, basemap `4.15.2` |
| Area | `scripts/map-region.geojson`, a MultiPolygon of two boxes, zooms 0-14 |
| BC box | `-139.1,48.2,-114.0,60.0` |
| Nova Scotia box | `-66.5,43.3,-59.6,47.1` |
| Archive | 1,443,700,560 bytes |
| Chunks | 2,754 chunks of 512 KB in `map/detail/` |
| Map squares | 1,179 in `public/map/cells.json` (1,080 BC, 99 Nova Scotia) |
| Version | `0e0bd01743049ab8d651aa0530ed8a492c238ab8ca9f8e266aaddc97b11734fd` |
| Inventory SHA-256 | `1801c6f834f5a556010ef991f7ad45fff76a00344a05b58164024d6f4ea76765` |

- **Styling.** BC was first extracted from build `20260925`, which Protomaps has since deleted. Build `20261012` has the same basemap version (`4.15.2`) and Planetiler commit, so the tiles have the same layers and the map looks the same. Only the OpenStreetMap data is newer.
- **Region.** go-pmtiles 1.31.2 accepts the MultiPolygon. Extracted on their own, the boxes hold 1,411,032 and 103,607 tiles. The combined region holds 1,514,637: the boxes share only two low-zoom tiles.
- **Glyphs.** The glyph descriptors reuse the immutable font objects from the island release, so only chunks and manifests were uploaded.
- **Folder.** Releases up to the BC-only map keep their chunks in `map/island/`. From this map they are in `map/detail/`. The app reads the folder from each release's chunk layout file, so it reads both.

The previous pin, the BC-only map `01a7e200fc12922215be78afd9800d8f9458369b077e9f7fea94b67497233f8d` (Protomaps `20260925`, 2,478 chunks in `map/island/`), stays on R2. Builds and web bundles from before this change keep using it.

## How the app uses more than one area

- `DETAIL_BOUNDS` (`src/lib/mapStyle.ts`) is one box around every area, because a MapLibre source takes one box.
- The tile protocol (`detailedAreaTile` in `src/lib/offlineTiles.ts`) answers detailed tiles between the areas as empty without reading the archive. The bundled Canada overview shows there, online and offline.
- `isPointInsideContentBounds` checks the visitor against each box before it downloads nearby map squares or art.

## Building a new map

1. Pick the Protomaps build. Daily builds are deleted after about a week, so check what exists in `https://build-metadata.protomaps.dev/builds.json`. To keep the look, use a build with the same basemap `version` as the current pin. A new basemap version needs a style check against `@protomaps/basemaps`.

2. Extract the region. Add a box to `scripts/map-region.geojson` and to `CONTENT_BOUNDS` for a new area. Check the tile count first with `--dry-run`.

```bash
pmtiles extract https://build.protomaps.com/<build>.pmtiles <work>/map.pmtiles --region=scripts/map-region.geojson --minzoom=0 --maxzoom=14
```

3. Split it and build the inventory. `--glyph-source` is a published map inventory whose glyph objects are reused. Chunks go in `map/detail/` unless `--folder` says otherwise.

```bash
python scripts/build-map-inventory.py --archive <work>/map.pmtiles --glyph-source <published map manifest.json> --output <work>/map-release
```

4. Upload it. The script needs `CLOUDFLARE_API_TOKEN`, which is in the Windows user environment. Existing keys with the same size are skipped, and a different size stops the upload. The inventory goes up last.

```bash
node scripts/upload-map-release.mjs --release-dir <work>/map-release --version <version>
```

5. Rebuild the map squares from the same archive:

```bash
node scripts/build-map-cells.mjs <work>/map.pmtiles 524288 <version>
```

6. Update `BUILD_MAP_POINTER` with the printed pointer. Update `BUILD_MAP_ARCHIVE` with the archive's `mapManifest` (`chunkBytes`, `count`, `size`), its folder and the font folder URL from its `map/manifest.json`, because the app streams that archive from the CDN at launch before park content loads. `src/lib/mapCells.test.ts` checks that these agree with `cells.json`.

## Delivering a new pin

A web update over the air is enough. The pin, the areas, the map squares and the code that reads them are all in the web bundle, and nothing native changes. Publish a staging bundle with `scripts/publish-app-bundle.mjs` (see `docs/ota-updates.md`). A new Play build is only needed when the same change also touches native code, plugins or permissions.

What a new pin changes on installed devices:

- **Release ID.** Every installed build's map release ID changes on its next start. Map detail around the player then downloads again from the new archive. Builds from the lean cache change (`docs/content-catalogue.md`) delete the old archive's files and inventory automatically after the update.
- **Saved squares.** Choosing map squares is hidden until offline downloads return (#199, `OFFLINE_DOWNLOADS` in `src/lib/content/contracts.ts`). Squares saved by earlier builds are forgotten and their files deleted after the update. With the flag on, squares saved for an old map are offered again in Download maps.
- **Server pointer.** Never point the content API's map pointer (`content_map`) at a BC or combined archive. Builds installed before 2026-10-01 read it and download the whole map.

Mention the new download in the tester notes for the release.

# Detailed map releases

The detailed map is a Protomaps archive split into chunks on R2. New builds pin the map they use in `BUILD_MAP_POINTER` (`src/lib/content/contracts.ts`) instead of reading the map pointer from the content API. The app streams this archive straight from the CDN while online and reads downloaded map squares only when offline. The server pointer stays on the 96 MB island archive. Builds installed before 2026-10-01 download the whole map they are given, so they must never receive the 1.3 GB BC archive.

## Current pin

| Field | Value |
| --- | --- |
| Source | Protomaps build `20260925` |
| Area | `--bbox=-139.1,48.2,-114.0,60.0` (all of BC), zooms 0-14 |
| Archive | 1,298,961,806 bytes |
| Chunks | 2,478 chunks of 512 KB |
| Version | `01a7e200fc12922215be78afd9800d8f9458369b077e9f7fea94b67497233f8d` |
| Inventory SHA-256 | `ef99db0a47f2614f5396f042642122b7241473322d84947a8e79ae3cb0595106` |

The glyph descriptors reuse the immutable font objects from the island release, so only chunks and manifests were uploaded.

## Building a new map

1. Extract the area:

```bash
.tools/go-pmtiles.exe extract https://build.protomaps.com/20260925.pmtiles .tools/bc.pmtiles --bbox=-139.1,48.2,-114.0,60.0 --minzoom=0 --maxzoom=14
```

2. Split it and build the inventory. `--glyph-source` is a published map inventory whose glyph objects are reused:

```bash
python scripts/build-map-inventory.py --archive .tools/bc.pmtiles --glyph-source <published map manifest.json> --output .tools/bc-map-release
```

3. Upload it with the delivery loader, which provides `CLOUDFLARE_API_TOKEN`. Existing keys with the same size are skipped, and a different size stops the upload. The inventory goes up last.

```bash
python C:\Users\n8tew\.codex\private\kip-delivery\with-delivery-env.py . -- node scripts/upload-map-release.mjs --release-dir .tools/bc-map-release --version <version>
```

4. Update `BUILD_MAP_POINTER` and `CONTENT_BOUNDS` with the printed pointer and the extract bbox. Update `BUILD_MAP_ARCHIVE` with the archive's `mapManifest` (`chunkBytes`, `count`, `size`) and the font folder URL from its `map/manifest.json`, because the app streams that archive from the CDN at launch before park content loads. Then ship a new build.

Changing the pin changes every installed build's release ID on its next start. Nearby squares then download again from the new archive.

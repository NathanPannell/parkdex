# Parkdex field app

A standalone, fully offline Android app for the core Parkdex loop on Vancouver Island:
pick a park on the map, go there, check in inside the park boundary, take a photo, claim
the badge, and share it. No accounts and no network sync: everything stays on the phone.

- Parks on Vancouver Island come from the downloaded content catalogue. Only parks with
  published badge art appear on the map, and the Dex starts empty.
- Collector ranks: visiting 2, 5 and 10 unique parks opens Uncommon, Rare and Legendary
  parks. See `docs/rarity-progression.md`.
- Older installed builds keep reading new content. Content API changes must be additive;
  see `docs/content-compatibility.md`.
- Maps: a bundled low-detail Protomaps base map of Canada (zoom 0 to 6). Detailed tiles
  (zoom 0 to 14) download for the area around the visitor, stream while online, and stay
  available offline once saved. See `docs/content-sync.md`.
- Kip the oystercatcher: generated pose images and an articulated rig (`public/art/kip/parts`).

## Setup

Requirements: Node 22+, Python 3 with Pillow, Go (for the pmtiles CLI), JDK 21, Android SDK 36.

```bash
npm install
```

```bash
GOBIN="$(pwd)/.tools" go install github.com/protomaps/go-pmtiles@latest
```

```bash
npm run map
```

`npm run map` extracts the island from a Protomaps daily build (96 MB, zoom 0 to 14),
splits it into 46 chunk files under `public/map/island/`, and fetches the glyph fonts
(not committed). Capacitor's local server ignores byte-range offsets, so
`src/lib/offlineTiles.ts` reads the archive by loading whole chunks; this keeps the APK
build to a few dozen files instead of tens of thousands of tiles. The bundled Canada base
map is rebuilt and checked against its pin with `scripts/build-map-overview.ps1`. `npm run data` rebuilds
`src/data/parks.json` and `public/boundaries.geojson` from `../parkdex/data`. `npm run drive`
precomputes driving routes (OSRM) from eight origin hubs around Victoria, Duncan and Nanaimo
to every park into `src/data/drive.json`; the app scales the nearest hub's route to the
visitor's position to estimate drive time offline. `npm run art`
resizes the generated source art in `art-source/` into the WebP files the app ships.

## Run in a browser

```bash
npm run dev
```

Opens at http://localhost:5190. The browser build keeps demo tools: the wand on the map
teleports you into the nearest park, and a trip can be simulated. `/#gallery` shows every badge.

## Android

```bash
npm run android:apk
```

This builds the field bundle (`VITE_FIELD=1`: real GPS only, no demo tools), syncs it into
the Capacitor project and assembles `android/app/build/outputs/apk/debug/app-debug.apk`.
The debug build installs as `app.parkdex.debug` ("Parkdex Field"). Release builds use `app.parkdex`.
A clean build takes about 2.5 minutes; incremental rebuilds about 35 seconds.

Set `sdk.dir` in `android/local.properties` to your Android SDK path before the first build.

## How check-in works

The app watches GPS with high accuracy. A visitor counts as inside a park when they are within
its boundary, or within their reported GPS accuracy of it (capped at 35 m). Claims live in
localStorage; photos live in IndexedDB.

## Friends and the weekly leaderboard

Signed-in players can add friends from Settings, then Friends. Each account has an
8-character friend code shown as a QR code; scanning uses the in-app camera (jsQR), and
codes added offline are queued on the phone and sent the next time the Friends screen
opens online. The board ranks unique parks claimed since Monday 00:00 Pacific. The API
lives under `/api/social` (`worker/social.ts`, schema `kip_social`) and the screen is
hidden unless the remote `friends` flag is on for the build (always shown in `npm run dev`).

## End-to-end check

With `npm run dev` running:

```bash
node scripts/journey.mjs
```

It walks the whole loop in headless Chrome and saves a screenshot per step to `shots/`.

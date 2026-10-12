# Parkdex field app

A flag game for British Columbia parks, on Android (Capacitor) and on the web at
web.parkdex.app. Stand inside a park to plant your flag, earn a point for each day it flies,
and take other players' parks. A player who photographs a park with no founder can become its
founder. See `docs/park-founders.md`.

Parks and maps work offline without an account. Planting a flag needs a signed-in account with
a handle and a connection, because every visit uses one server clock. Accounts use email and
password or Google; see `docs/accounts-implementation-contract.md`. Badge claims made before the
badge Dex was retired (#134) stay on the phone and back up to the account.

- Parks across BC come from the content catalogue. Municipal and community parks are hidden
  but kept. See `docs/content-catalogue.md` and `docs/park-visibility.md`.
- Older installed builds keep reading new content. Content API changes must be additive;
  see `docs/content-compatibility.md`.
- Maps: a bundled low-detail Protomaps base map of Canada (zoom 0 to 6). Detailed tiles
  (zoom 0 to 14) download for the area around the visitor, stream while online, and stay
  available offline once saved. See `docs/content-sync-contract.md` and `docs/map-releases.md`.
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

Opens at http://localhost:5190. The dev build keeps demo tools: Demo controls in the map menu
teleport you into the nearest park, and a trip can be simulated. Hosted builds (`npm run build`)
leave them out, because the server does not check where a visit came from. A local non-dev build
can opt in with `VITE_DEMO_TOOLS=1`; a Vercel build refuses that setting.

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
its boundary, or within their reported GPS accuracy of it (capped at 35 m). Claims and photos
are saved on the device first (IndexedDB) and backed up to the account when signed in.

## End-to-end check

With `npm run dev` running:

```bash
node scripts/journey.mjs
```

It walks the whole loop in headless Chrome and saves a screenshot per step to `shots/`.

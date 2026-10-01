# How park updates reach a phone

Neon holds the park catalogue. R2 holds the image and map bytes. The phone keeps its own durable copy for offline use.

## The first download

When the app is open with an internet connection, it calls `GET /api/content/snapshot` once. The response contains:

- A revision number, such as `42`.
- Park names, descriptions, rarity, coordinates and scene names.
- Park boundaries and the drive information used by the app.
- Descriptors for the active badge images: URL, SHA-256, size and type.
- The URL and hash of the separate map file manifest.

The app downloads missing badge images from their R2 URLs and verifies their bytes. It saves the complete catalogue and revision together and publishes the verified result once. Catalogue data, artwork, map metadata, glyphs, and account backup can use cellular data. Detailed map chunks for the area around the visitor, and detail streamed while they look at an area that is not downloaded, also use any connection. Other detailed map downloads require confirmed Wi-Fi. The app never downloads the whole detailed map on its own.

The snapshot contains public park content. Account details, visits and private photos continue to use their existing private APIs.

On Android, catalogue records live in SQLite and downloaded files live in the app's private data directory. On the web, the equivalent data is stored in IndexedDB. These are explicit offline stores; routine HTTP cache eviction is not the mechanism used to manage them. Uninstalling or clearing application data removes the saved copy.

The app includes a low-detail base map of Canada (zooms 0-6, about 9.5 MB). It appears with the first park pins while detailed map files download, remains available offline anywhere in the country, and stays in place as detail becomes usable. The map opens on the visitor's last known location at badge zoom, or frames British Columbia when no location is known.

Detailed coverage comes from three places: the 3x3 block of zoom-9 squares (about 50 km each) around the visitor, downloaded automatically and refreshed after they move about half a square; detail streamed while online for any area the visitor views; and chunks already saved on the device. Offline, areas without saved detail show the base map.

The app prepares its local overview archive and map worker during the splash and onboarding screens. Park markers are added after the overview has rendered, so creating the badge illustrations does not compete with the first basemap frame. This step does not wait for detailed tiles or labels. Preparing the archive and rendering it share the same local bytes.

## Opening an app with saved parks

The app checks its saved catalogue's source, structure, and required badge artwork before publishing it. Missing or invalid public content is repaired online without clearing personal visits, photos, or account state. A valid cached catalogue stays visible during an update. If no complete catalogue is usable, the bundled map remains behind a loading or retry message.

Only verified local files become available for rendering. Required scene downloads must finish before publication, while detailed maps remain optional. Account ranks and earned badges separately wait for the current owner's saved claims, so an account change cannot reuse another owner's progress.

Onboarding examples use bundled artwork and display-only park descriptions, independent of downloaded content. Completion is tied to the app build and, on Android, the package install/update identity. A fresh install or app update replays onboarding; an ordinary restart of the same installation does not.

## The next update check

If the phone has revision `42`, it calls:

```http
GET /api/content/changes?after=42&limit=50
```

The server returns complete committed batches after `42`. Each batch contains changed values, or deletion markers. The values are included in the response, so the app does not need to fetch every changed park again.

For example, a badge publication returns one batch containing the new image descriptor and the updated park record. The park record includes its full public fields, including its description, rarity and scene name. A metadata-only correction returns the changed park record without new image bytes.

The app then:

1. Folds every returned batch and subsequent page into an in-memory candidate.
2. Checks the final candidate and downloads only missing required images over any internet connection.
3. Verifies each file's size and hash, retaining artwork needed by earned badges.
4. Replaces the catalogue and revision in one local database transaction.
5. Publishes the complete cached result to the interface once. Download progress can update throughout.

An interrupted page or invalid required download does not advance the revision or replace the visible catalogue. The next check retries from the last complete update. Foreground online failures retry with backoff; reconnecting and returning to the app also resume recovery. If nothing has changed and required files are intact, the API returns an empty batch list and the app downloads no catalogue or image files.

When the server's retained change history no longer covers a phone's revision, the app takes a fresh catalogue snapshot. It still reuses image and map files whose hashes are already saved.

## Publishing one badge

The normal authoring flow is:

1. Upload one immutable WebP to R2.
2. Fetch its public URL and verify it.
3. In one Neon transaction, register its image descriptor and update the park row.

Database triggers automatically create the revision and change records. Direct SQL updates are captured too. There is no separate catalogue publication pointer to upload, and no full catalogue JSON file is generated for each edit.

The current CDN uses paths like `releases/<image hash>/art/badges/scenes/<scene>.webp`. Despite the folder name, publishing a badge adds one image object. The independent map manifest only changes when the map inventory changes.

See [content-authoring.md](content-authoring.md) for the publishing command and [content-sync-contract.md](content-sync-contract.md) for the wire format and consistency rules.

## Offline and Wi-Fi behavior

Saved parks remain usable offline. Essential content and account backup use any online connection on web and Android, including browsers without the Network Information API. Android binds detailed map requests to Wi-Fi unless the request is for nearby or streamed detail, which may use any validated network. Essential downloads pause only while offline or backgrounded; Wi-Fi-only map downloads also pause when Wi-Fi is lost.

The app reports physical Wi-Fi only when the platform confirms it. Browser connection speed and unknown connection types never count as Wi-Fi; they do not block essential content while the browser is online.

The app checks at startup, when it returns to the foreground, when connectivity returns, and when the visitor retries. Failed essential updates retry with backoff only while the app is open and online. Successful checks do not start a polling service.

The map header shows `Downloading update` while checking, preparing, or transferring an update. An essential-content error exposes a retry control. There is no persistent Wi-Fi waiting banner for optional detailed maps. An app with no usable catalogue shows a preparation or connection card over its bundled map; an app with valid saved parks keeps its map available.

Earned claims keep their original park snapshot, photo and content provenance. Their display adopts current catalogue artwork once its verified image is saved locally, including artwork published after a skeleton park was claimed. Until then, the previous image or placeholder remains. Removed parks fall back to their saved snapshot and retained artwork.

This migration retains previously verified badge files on the device. Safe removal can be added later once the app knows all personal claims have loaded.

## Rolling out the change

An installed Android app needs this new app build once to adopt the Changes API. Subsequent park edits arrive through the API without reinstalling the app. Older builds keep their existing release-channel behavior, so their immutable R2 files remain available.

# How park updates reach a phone

Neon holds the park catalogue. R2 holds the image and map bytes. The phone keeps its own durable copy for offline use.

## The first download

When the app is open on Wi-Fi, it calls `GET /api/content/snapshot` once. The response contains:

- A revision number, such as `42`.
- Park names, descriptions, rarity, coordinates and scene names.
- Park boundaries and the drive information used by the app.
- Descriptors for the active badge images: URL, SHA-256, size and type.
- The URL and hash of the separate map file manifest.

The app downloads missing badge images from their R2 URLs and verifies their bytes. It then saves the catalogue and revision together. Map files download afterward. An unfinished map download does not prevent the park catalogue from becoming available.

The snapshot contains public park content. Account details, visits and private photos continue to use their existing private APIs.

On Android, catalogue records live in SQLite and downloaded files live in the app's private data directory. On the web, the equivalent data is stored in IndexedDB. These are explicit offline stores; routine HTTP cache eviction is not the mechanism used to manage them. Uninstalling or clearing application data removes the saved copy.

The app includes a compact overview map of Vancouver Island. It appears with the first park pins while detailed map files download, remains available offline, and stays in place as downloaded detail becomes usable.

## Opening an app with saved parks

During the short orange splash, the app opens its saved catalogue and cached map inventory. It validates the catalogue's source and structure before publishing the saved parks to the map. Reading and checking every image or detailed map chunk happens afterward, alongside the normal update check. The opening map does not wait for either operation.

Only hash-verified local image and map files become available for rendering. Until those checks finish, the bundled overview remains visible and badge illustrations can use their placeholders. Account ranks and earned badges separately wait for the current owner's saved claims, so an account change cannot reuse another owner's progress.

## The next update check

If the phone has revision `42`, it calls:

```http
GET /api/content/changes?after=42&limit=50
```

The server returns complete committed batches after `42`. Each batch contains changed values, or deletion markers. The values are included in the response, so the app does not need to fetch every changed park again.

For example, a badge publication returns one batch containing the new image descriptor and the updated park record. The park record includes its full public fields, including its description, rarity and scene name. A metadata-only correction returns the changed park record without new image bytes.

The app then:

1. Checks which required image hashes it already has.
2. Downloads only missing image files over Wi-Fi.
3. Verifies each file's size and hash.
4. Applies the entire batch and advances its saved revision in one local database transaction.
5. Requests another page if the response says more batches remain.

An interrupted or invalid download does not advance the revision. The next check retries from the last completed batch. If nothing has changed, the API returns an empty batch list and the app downloads no catalogue or image files.

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

Saved parks remain usable offline. Web content checks and downloads use any online connection, including in browsers without the Network Information API. Android requires confirmed Wi-Fi and binds content requests to that network so they cannot fall back to cellular data. Content downloads pause while the browser is offline or Android loses Wi-Fi. Sign-in and explicit uploads retain their existing behavior.

The app reports physical Wi-Fi only when the platform confirms it. Browser connection speed and unknown connection types never count as Wi-Fi; they do not block content downloads while the browser is online.

The app checks at startup, when it returns to the foreground, when the browser comes online or Android Wi-Fi returns, and when the visitor retries. These checks run while the app is open. There is no hourly polling service on the phone or server.

The map header shows `Downloading update` while content file bytes are transferring. Update discovery, local file verification and paused downloads stay quiet. There is no Wi-Fi waiting banner. An app with no saved catalogue can still show its initial download or connection screen; an app with saved parks keeps its map available.

Earned claims keep their original park snapshot, photo and content provenance. Their display adopts current catalogue artwork once its verified image is saved locally, including artwork published after a skeleton park was claimed. Until then, the previous image or placeholder remains. Removed parks fall back to their saved snapshot and retained artwork.

This migration retains previously verified badge files on the device. Safe removal can be added later once the app knows all personal claims have loaded.

## Rolling out the change

An installed Android app needs this new app build once to adopt the Changes API. Subsequent park edits arrive through the API without reinstalling the app. Older builds keep their existing release-channel behavior, so their immutable R2 files remain available.

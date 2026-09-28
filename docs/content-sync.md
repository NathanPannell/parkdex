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

Saved parks remain usable offline. Content checks and downloads wait for Wi-Fi, including restored badge artwork, private collection photos, map chunks and map fonts. Android binds these downloads to the Wi-Fi network so an interrupted Wi-Fi connection cannot fall back to cellular data. Sign-in and explicit uploads retain their existing behavior.

The web app also requires an explicit Wi-Fi connection type. Some browsers expose only a connection speed estimate, which cannot distinguish Wi-Fi from cellular. Those browsers keep saved content available and wait instead of downloading updates. Android can identify and bind to the actual Wi-Fi network.

The app checks at startup, when it returns to the foreground, when Wi-Fi returns, and when the visitor retries. These checks run while the app is open. There is no hourly polling service on the phone or server.

The map header shows a small status indicator while checking, downloading or saving updates. It shows a waiting state when Wi-Fi is unavailable and an error state when an update fails.

Earned claims keep their original park snapshot and immutable badge identity. A later catalogue edit or park retirement does not replace the artwork already earned.

This migration retains previously verified badge files on the device. Safe removal can be added later once the app knows all personal claims have loaded.

## Rolling out the change

An installed Android app needs this new app build once to adopt the Changes API. Subsequent park edits arrive through the API without reinstalling the app. Older builds keep their existing release-channel behavior, so their immutable R2 files remain available.

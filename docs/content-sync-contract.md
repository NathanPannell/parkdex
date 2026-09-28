# Kip content sync contract

This contract describes the first Neon-backed content reader. It replaces hourly whole-catalogue R2 releases with a small on-demand API and immutable R2 assets. The migration starts with the existing 122 park records unchanged. Replacing that catalogue with the ranked 100, generating Beacon Hill's badge, and enabling an hourly schedule are later content operations.

## Authority and scope

- Neon staging is the authoring and runtime source for the staging park catalogue. Main has its own database and revision stream. The server chooses the environment from its deployment configuration; clients cannot select a different branch with a query parameter. A native main build must use the main content API origin or fail closed when that origin is not configured; it must never pair a main local cursor with the staging API default.
- `parks` keeps its existing **exact 13 public fields**. `scene: null` means coming soon. The client must not add source URLs, revision fields, or image URLs to a park object.
- `boundaries` keeps one GeoJSON Feature per park. Add a row per park for drive estimates and one settings row for the ordered hub list. Seed them from the existing drive file without changing baseline values. Badge asset descriptors may reuse `r2_objects`; only scene assets referenced by the active catalogue need appear in a snapshot.
- Keep the prior immutable R2 releases and `version_manifests` for rollback and earned artwork. New catalogue edits do not create a new R2 catalogue, boundary, drive, or map object.
- Claims, photos, and retained earned badge art are private client data. Catalogue replacement and cursor reset must not delete them.
- The existing CDN channel and release reader may coexist during client migration. Do not repoint older installed readers at a payload they cannot parse. Before the later 100-park reset, expand client category validation and labels to include `municipal` and `community`.

## Wire types

The API serves JSON at the current app host. Paths are `GET /api/content/snapshot` and `GET /api/content/changes?after=<revision>&limit=<n>`. The server returns `Cache-Control: no-store` for these DB-backed responses. Revisions are nonnegative JSON safe integers and are scoped to one database source. A client stores its cursor with its environment, normalized API origin/path, and schema version. A build pointed at another API source must fetch a fresh snapshot instead of replaying its old cursor, even if the new source reports the same revision number. This source switch preserves private claims, retained art, and hash-addressed local bytes.

```ts
type Park = { // exactly these 13 keys
  id: string; name: string; short: string; category: string; region: string;
  lat: number; lng: number; biome: string; shape: string; rarity: string;
  scene: string | null; seed: number; blurb: string;
};
type ContentFile = {
  path: string; key: string; url: string; sha256: string;
  byte_size: number; content_type: string;
};
type DriveEntry = { drive: ([number, number] | null)[]; walkM: number };
type DriveData = { hubs: { name: string; lng: number; lat: number }[];
                   parks: Record<string, DriveEntry> };
type MapPointer = {
  version: string; manifestUrl: string; manifestSha256: string;
};
type MapOnlyManifest = {
  schema: "parkdex.content-map/v1";
  version: string;
  mapManifest: { size: number; chunkBytes: number; count: number };
  files: ContentFile[];
};
type Snapshot = {
  schema: "parkdex.content-sync/v1";
  revision: number;
  parks: Park[];
  boundaries: GeoJSON.FeatureCollection;
  drive: DriveData;
  assets: ContentFile[]; // active scene assets, keyed locally by path and bytes by hash
  map: MapPointer | null;
};
type Change =
  | { entity: "park"; op: "upsert"; id: string; value: Park }
  | { entity: "boundary"; op: "upsert"; id: string; value: GeoJSON.Feature }
  | { entity: "drive"; op: "upsert"; id: string; value: DriveEntry }
  | { entity: "asset"; op: "upsert"; id: string; value: ContentFile }
  | { entity: "hubs"; op: "upsert"; id: "default"; value: DriveData["hubs"] }
  | { entity: "map"; op: "upsert"; id: "default"; value: MapPointer | null }
  | { entity: "park" | "boundary" | "drive" | "asset"; op: "delete"; id: string };
type Changes = {
  schema: "parkdex.content-sync/v1";
  fromRevision: number;
  throughRevision: number;
  headRevision: number;
  hasMore: boolean;
  batches: { revision: number; changes: Change[] }[];
};
```

For `asset`, `id` equals `ContentFile.path`, such as `art/badges/scenes/beacon-hill-flat-v1.webp`. The scene slug in `Park.scene` resolves to that logical path. A new image must get a new slug and immutable R2 key. Its physical key is `releases/<imageSha256>/art/badges/scenes/<slug>.webp`, with `imageSha256` equal to the verified WebP bytes' lowercase SHA-256; its URL is that key under `https://kip-assets.parkdex.app/`. This path works with the existing CDN Worker. `ContentFile.url` stays on the approved Kip CDN, and the client verifies its declared byte length and SHA-256 before using it. Existing baseline scene descriptors keep their old immutable release paths. The new reader must not require every file to live under one catalogue release ID.

The map pointer names a separate immutable **map-only** manifest in R2 at `releases/<version>/map/manifest.json`. Its exact JSON body is `MapOnlyManifest` above. `version` is the lowercase SHA-256 of compact, key-sorted UTF-8 JSON for `{mapManifest,files:[{path,sha256,byte_size},...]}`, with the files sorted by path. It is independent of park edits. `manifestSha256` hashes the exact public manifest bytes. The manifest has exactly one `map/island/manifest.json` file descriptor, exactly `count` sequential `map/island/NNN.bin` chunk descriptors, and the existing `map/fonts/...pbf` glyph descriptors. It has no park, badge, or product entries. The raw island manifest must agree with `mapManifest`; chunk byte sizes and hashes must match their descriptors.

The client requires `MapOnlyManifest.version === MapPointer.version` and `MapPointer.manifestUrl === https://kip-assets.parkdex.app/releases/<version>/map/manifest.json`. It verifies the manifest bytes before parsing and validates every descriptor against the approved CDN origin, safe map path family, expected MIME type, unique path, SHA-256, and positive byte size.

The descriptors keep the existing published immutable map object keys and URLs under the old release path. The new map-only manifest does **not** require its file descriptors to share its own `releases/<version>/` prefix. Migration uploads and verifies this small manifest once, then seeds a **non-null** map pointer in Neon before enabling the new API. Do not copy the 95 MB map. A later map update changes this pointer in Neon and emits a `map` change. No park edit changes it. The wire type permits `null` only as a defensive state during recovery; the initial staging migration must publish a verified map pointer.

## Snapshot and changes

`snapshot` reads the clock, parks, boundaries, drive rows, hubs, active scene descriptors, and map pointer in **one repeatable-read database transaction**. The response is one coherent revision. For the current small catalogue, return it in one response instead of paginating mutable tables across requests. Validate equal park, boundary, and drive ID sets before responding. An installed client can use this endpoint to migrate from the existing release-based store.

`changes` accepts `after >= 0` and caps `limit` at 50 **revision batches**, never individual rows. Each batch contains the final upsert or tombstone for every affected entity in one committed SQL transaction. Every park upsert with a non-null scene also carries an upsert of that scene's exact current immutable asset descriptor in the same batch, even when the descriptor was registered in an earlier transaction. This makes a later return to historical art resolvable without keeping inactive descriptors in the active client catalogue. Values are captured when the write commits; a delta must not fetch a later mutable park row by ID. A response reads its `headRevision` and batches in one consistent database snapshot. It includes revisions `(after, headRevision]` in ascending order. `throughRevision` is the final returned batch revision, or `headRevision` when there are no batches. `hasMore` is true when more committed batches remain at that snapshot's head. The next request uses `after=throughRevision`.

The change log is retained until an operator explicitly invokes the database-only `prune_content_changes()` function. Its default retention interval is 90 days; it removes whole revision batches and advances `content_clock.retention_floor` in one transaction. It is not scheduled. If `after` predates that replay floor, return HTTP 410 with `{ "schema":"parkdex.content-sync/v1", "resetRequired":true, "headRevision":123 }`. The client then takes a new snapshot and preserves private claims, photos, and retained earned scene bytes. A malformed or future cursor returns HTTP 400 without advancing the local cursor from that response; a verified fresh snapshot may replace a future cursor after an environment database reset. Server errors never move it. There is no server push or always-on poll.

## Revision allocation for all SQL writers

Add one transactional `content_clock` row and an append-only `content_changes` table. Database triggers on `parks`, `boundaries`, drive rows, relevant `r2_objects` scene assets, and content settings write changes for inserts, updates, and deletes. This captures operator SQL as well as API and publisher writes. No revision is created for an unchanged row or an enrichment job's private progress.

Content writers use `INSERT`, `UPDATE`, and `DELETE`. Revoke or reject `TRUNCATE` on these tables because it bypasses row-level delete triggers and would hide tombstones from clients.

The first content mutation in a transaction updates the one clock row with `revision = revision + 1` and holds its row lock until commit. Subsequent triggers in the same transaction reuse that revision, using transaction-local state. Trigger writes use `(revision, entity, id)` uniqueness so repeated writes to one row leave its final state, including a final tombstone. The row lock serializes content writers. **Do not use a PostgreSQL sequence value alone as the cursor:** one transaction can reserve revision 10, remain uncommitted, while revision 11 commits and reaches a client first. The client would then permanently miss 10. The transactional clock makes commit order and revision order agree.

The initial migration creates the clock and triggers and seeds route/settings rows in a controlled transaction. Existing baseline data stays unchanged. New clients obtain a snapshot as their baseline; they do not require replaying a fabricated history before it.

## Publishing one badge

1. Complete research and flat badge generation outside a database transaction. Preserve at least five verified original-image references and the skill's candidate and QA record in private authoring data.
2. Upload only the selected delivery WebP to a new immutable R2 key. Verify public GET bytes, SHA-256, size, and MIME before exposing its descriptor. If this fails, leave the park unchanged.
3. In one short Neon transaction, insert its asset descriptor and update that park's `blurb` and `scene`. Triggers emit one revision batch. A transaction failure leaves an unreferenced immutable object that can be reconciled or removed later; it never exposes a missing badge.
4. A repeated publisher run compares park ID, scene slug, and asset hash before writing. It must not emit a second logical update or generate another image after a successful commit.

The database must reject or withhold a park scene when its corresponding asset descriptor is missing. Deleting a referenced scene asset is likewise invalid. Old immutable assets remain available for earned badge restoration. The new API has no mutable channel pointer, so a Neon commit is the publication point for catalogue changes.

Because direct SQL edits also enter the revision stream, database constraints must reject invalid public enum values, unsafe badge asset URLs or hashes, and broken park-to-boundary or park-to-drive relationships at commit. The API still validates records before returning them. `TRUNCATE` is disallowed for tracked tables because it cannot emit row tombstones.

## Earned artwork across account restores

The pending account backup stores a frozen park snapshot plus `contentReleaseId` on each claim. Keep that field and its schema. For a new claim, the client gets the active scene's `ContentFile` from its verified local snapshot and stores the 64-hex version segment of `file.key = releases/<version>/art/badges/scenes/<scene>.webp` as `contentReleaseId`. The runtime exposes a per-park `getSceneAssetVersion(parkId)` lookup for claim creation. Do not save the row-sync snapshot's synthetic `releaseId` into a claim. Baseline scene descriptors return the legacy release ID; new hash-addressed scene descriptors return the WebP SHA-256. A claim's frozen `parkSnapshot.scene` supplies the scene slug. Existing claim creation and legacy snapshot-backfill callsites must use this per-scene version after the account work is integrated.

For reinstall or cache loss, add a public read-only `GET /api/content/scene?releaseId=<64hex>&scene=<slug>`. It returns `{ "schema":"parkdex.scene-asset/v1", "file": ContentFile }`, or 404 when no exact descriptor exists. The server matches **both** `r2_objects.logical_path = art/badges/scenes/<scene>.webp` and `object_key = releases/<releaseId>/art/badges/scenes/<scene>.webp`; it validates that the URL is the exact approved CDN URL for that key, MIME is `image/webp`, hash is 64-hex, and size is positive and bounded. Scene slugs and immutable asset rows must not be reused or removed when their park leaves the active catalogue. The client requests this descriptor only on Wi-Fi, verifies its path/key/URL and downloaded image hash/size, then stores descriptor and bytes as a retained earned-art root. For older claims whose descriptor is unavailable, retain the existing archived full-release manifest restoration path as a fallback. No new catalogue snapshot is uploaded to support restoration.

The collection displays the claim's frozen park snapshot and its exact scene version, even if the same park ID later receives different art. Claim creation freezes the park snapshot and scene version together so an update cannot pair different revisions.

## Client apply and Wi-Fi policy

On first launch without cached content, show a clear Wi-Fi required state. With cached content, keep showing it on cellular or offline. **No content network request may start without Wi-Fi**, including snapshot, changes, image, archived badge restoration, private claimed-photo restoration, map manifest, map chunks, glyphs, and initial bootstrap. Gate the request at the call site as well as the download scheduler, and cancel or defer in-flight requests when Wi-Fi disappears. Resume on foreground or Wi-Fi return with a cooldown/backoff and manual retry. No interval poll or background server is required.

On Wi-Fi, fetch snapshot or ordered change batches. After applying each whole batch in memory, keep only descriptors referenced by the final active park scenes in the catalogue inventory; immutable server asset rows remain for earned-art recovery. Before committing a batch that references a new badge scene, download the descriptor's file to a temporary private path, verify hash/size/MIME, and atomically install the file. Then apply the entire batch and cursor in one SQLite transaction. A failed image leaves the previous park, badge, and cursor visible; retry resumes at that revision. Do not split one server batch across local commits. For a full snapshot, stage required active scenes before swapping the local catalogue and cursor. Preserve locally retained claimed scenes and personal records even when their park is deleted or its same ID changes from one scene to another or to null.

After park metadata and badge assets are ready, fetch the separate map manifest and map chunks on Wi-Fi. A map download failure must not hold back catalogue or badge activation. Existing locally verified map bytes can be reused by hash. The app may display a partial map while tiles download, but must not mislabel an uncached area as fully available offline.

## Options considered

| Approach | Fit for one selected image and one park edit per hour |
| --- | --- |
| Whole catalogue release per edit | Reuses the current client but recopies/reverifies catalogue, all assets, and map paths each hour. The user declined this transfer and storage pattern. |
| Neon revision API with immutable R2 images | One image upload, one short database transaction, and small client deltas. This contract selects it for the 100-park scale. |
| Managed live sync service | Could provide subscriptions and conflict handling, but adds another operating surface and unnecessary continuous activity for a read-mostly catalogue with hourly edits. |

This migration does not itself reset the catalogue to 100 parks, create a badge, or start an hourly schedule. Those operations follow validation of the new reader and writer against the unchanged 122-park baseline.

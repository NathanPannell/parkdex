# Geofenced claims field evidence

## Before

The staging Android shell could browse Goldstream, but the place detail exposed the legacy manual visit toggle and had no location-confirmed claim or private postcard flow.

- [Map](before/emulator-map.png)
- [Find mode](before/emulator-find.png)
- [Search](before/emulator-search.png)
- [Goldstream detail](before/emulator-goldstream-detail.png)

## After

The rebuilt API 36 debug package starts successfully, requests foreground location with Android's precise/approximate control, and consumes a spoofed Goldstream-area GPS fix in the native WebView.

- [Rebuilt Android shell](after/emulator-rebuilt.png)
- [Foreground location permission](after/emulator-location-permission-rebuilt.png)
- [Spoofed Goldstream-area location](after/emulator-spoofed-location-rebuilt.png)

The last image was exercised against the pre-merge staging API, which does not yet allow Capacitor's `https://localhost` origin and therefore shows `Failed to fetch`. This branch adds that origin on the API. The complete same-origin local journey was also exercised against an isolated PostgreSQL database and private filesystem object-store adapter:

1. a fresh 8 m accuracy sample at `48.475557, -123.542431` returned an exact Goldstream recommendation;
2. the single-use recommendation created one account visit and postcard;
3. a WebP field image uploaded through the authenticated photo endpoint and returned a normalized 960 × 1280 JPEG with stripped metadata;
4. the private image rendered only in the signed-in account postcard;
5. with browser networking disabled, Goldstream was added to the cached Wishlist and shown as pending on-device work;
6. reconnecting drained the queue and persisted the Wishlist membership;
7. the browser console contained no warnings or errors.

Automated evidence at final integration: 172 backend tests, 315 frontend tests, production/static Android builds, and 7 API 36 instrumentation tests.

## Remaining physical-device acceptance

The emulator proves packaging, permission declarations, foreground location bridging, and spoofed-coordinate handling, but it is not a substitute for issue #84's release acceptance on real hardware. Before this draft can be released, run the signed-in claim journey outdoors with a physical Android device, take a fresh camera photo, verify restart/offline retry, and confirm the private postcard after reconnecting. Persistent staging must also have its private R2 bucket and Railway-only credentials configured before that photo run.

# Bundled onboarding artwork

Onboarding imports its sample badge scenes from `src/assets` and passes each one to `Badge` through `sceneHref`. The samples therefore render from the app package even when the content catalogue and downloaded badge files are unavailable.

| Park | Display-only sample ID | Bundled scene | Selected gallery version | SHA-256 |
| --- | --- | --- | --- | --- |
| Beacon Hill Park | `onboarding-beacon-hill` | `src/assets/onboarding-scene-beacon-hill.webp` | `beacon-hill/2026-09-28-v2-r1` | `ea1b734e7bf97379f4117fc689d324937c8661034ad90332031e3cc8fba3a596` |
| Goldstream Park | `onboarding-goldstream` | `src/assets/onboarding-scene-goldstream.webp` | `goldstream-park/2026-09-28-b-r1` | `ebf450a4fb8c821793f564afd83c67973e3cb6fc0c955af06082c5e14c2d2fdc` |
| Witty's Lagoon Regional Park | `onboarding-wittys-lagoon` | `src/assets/onboarding-scene-wittys-lagoon.webp` | `wittys-lagoon-regional-park/2026-09-29-a-r1` | `99eef746b9e4dd56f93fc3514245192208621fae7240ca7da8da1826d8ba9ef4` |

The selected files are byte-for-byte copies of `final-flat-cartoon.webp` from `C:\Users\n8tew\.codex\skills\park-badges\selected-badges`. `onboarding-go-map.webp` is the existing tracked Beacon Hill Park map illustration; its SHA-256 is `5cb37499802c6f84f100d5fa6c88c4e3ae5a3810efc94255ca9fb181056874a0`.

The sample park properties match the corresponding records in `database/imports/provincial-regional-20260929/sources/baseline-snapshot.json`: `municipal-city-of-victoria-1442`, `provincial-goldstream-park`, and `regional-witty-s-lagoon-regional-park`. Keep the `onboarding-*` IDs display-only so the sample objects never enter the live catalogue or a visitor's collection.

The package guard in `scripts/check-content-package.mjs` requires all three scenes, the Beacon Hill map illustration, Kip's onboarding poses, and the articulated Kip rig parts. When refreshing art, copy the newly selected gallery version into `src/assets`, update this table and the guard names if needed, then run `npm run build` and `node --test scripts/check-content-package.test.mjs`.

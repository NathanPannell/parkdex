# Approved Parkdex app icon

The app and web icon integration uses the owner-approved `Camas / soft gloss` package at `C:\repo\parkdex-workspace\output\parkdex-approved-icon-camas-soft-gloss-v1`. It is approved artwork round 03, item 02. The canonical master is the byte-identical RGB PNG `source/parkdex-camas-soft-gloss-approved.png` with SHA-256 `ef47228067bf67b53def4228236bf68963e95c5eaa6052248274e24051074f63`.

The package's `SHA256SUMS.txt` is the authoritative export inventory. Web exports were copied into `frontend/public/`, the package Android resources were merged selectively into `frontend/android/app/src/main/res/`, and the opaque Google Play icon was copied to `docs/brand/google-play-icon-512.png` for the future store handoff. Existing unrelated Android resources remain in place.

`frontend/app/layout.tsx` declares the favicon, Apple home-screen icon, and `/manifest.webmanifest`. The manifest uses the existing Parkdex forest theme (`#173d32`) and paper background (`#f6f0dc`), starts at `/`, runs as a standalone app, and keeps ordinary `any` icons separate from dedicated `maskable` icons.

The package's independent review and numeric validation passed before integration. Native build, installed launcher, and store submission checks remain owned by the app release workflow.

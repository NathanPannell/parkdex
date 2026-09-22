# Field Guide, Collections, and My Dex

Parkdex has three primary destinations on mobile and desktop:

- **Field Guide** combines the map and searchable list. Map progress shading is independent of the All, Visited, and Unvisited filter.
- **Collections** holds Wishlist and named sets of places. Existing group API routes, identifiers, and storage keys remain compatible.
- **My Dex** holds saved visit summaries, a horizontal postcard shelf, badges, and visited places. Shelves expand into vertically scrolling collections. Account controls, progress reset, and the welcome-flow replay are in Settings.

Place details can expand to fill the screen. Closing a detail opened from a list or collection restores its origin through browser history. Direct links remain usable.

The three-screen welcome flow introduces discovery, Collections, and Sealed Impressions. It appears once for a new guest without a deep link or existing progress. Guests can explore the Field Guide. Saving account-owned visits, photos, and Collections retains the existing authentication requirements.

Postcards retain their cream paper surface. The shelf supports native scrolling, previous/next controls, and explicit rotation/reset controls. Reduced motion disables rotation and pointer tilt.

Summary counts reflect the current data model: one saved visit record per place. They do not claim to count repeat visits. A confirmed visit without a photo still has a boundary postcard.

This change does not introduce account-free cloud sync, a new offline map download service, or repeat-visit history. Android field readiness requires a separate attestation of the exact integrated APK using the repository gate.

The approved Camas icon provenance and platform asset mapping are recorded in [approved-app-icon.md](approved-app-icon.md).

# Map boundary and refresh evidence

These cropped Chrome captures use a 1440 x 900 desktop viewport and a mobile viewport. The before images are from `staging.web.parkdex.app` before this change. The after images are from the same map journey against the branch frontend and an owned migrated local database.

| Change | Before | After |
| --- | --- | --- |
| Desktop boundary coverage | [Desktop before](before-desktop.png) | [Desktop after](after-local-desktop.png) |
| Mobile boundary coverage | [Mobile before](before-mobile.png) | [Mobile after](after-local-mobile.png) |
| Pins and polygons during a delayed zoom request | [Refresh before](before-pending-desktop.png) | [Refresh after](after-pending-desktop.png) |

[Boundary refresh held during a large pan](after-boundary-pending-desktop.png) shows the prior polygons still visible while the new boundary response is pending. [Unsampled boundary selection](clicked-local.png) shows Strathcona Park selected by clicking its polygon. Strathcona Park was absent from the 50 returned marker records for the initial viewport.

The local desktop response contained 50 marker records and 507 boundary features for the buffered viewport. Mobile contained 50 marker records and 608 boundary features. A full BC bounds request returned 1,030 boundary features. The owned local database and browser sessions used for capture were stopped and removed after capture.

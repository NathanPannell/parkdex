# Field Guide and My Dex visual evidence

The before images are retained staging captures from the Sealed Impressions and staging design audit evidence. The after images are cropped from the actual app at 390 × 844, using a disposable local account with six confirmed visits and no private photographs. Different record counts are intentional test data, not a migration comparison. The local Next.js indicator may appear in the navigation capture.

| Surface | Before | After |
| --- | --- | --- |
| Navigation and map | ![Previous five destinations and global header](navigation-before.png) | ![Field Guide map, independent visit filter, progress switch, and three destinations](navigation-after.png) |
| My Dex shelves | ![Previous account shelves](shelves-before.png) | ![Visit summaries and physical postcard shelf](shelves-after.png) |
| Collections | ![Previous group destination](collections-before.png) | ![Collections and readable Wishlist](collections-after.png) |
| Account organization | ![Content within the previous Account destination](settings-before.png) | ![Dedicated Settings inside My Dex](settings-after.png) |
| Place details | ![Previous compact place actions](details-before.png) | ![Full-screen cream place detail](details-after.png) |

The combined Field Guide list and three-screen onboarding are new arrangements:

| List search | Onboarding |
| --- | --- |
| ![Field Guide list search](list-after.png) | ![Welcome flow using real park geometry](onboarding-after.png) |

Local browser checks covered 320, 390, 768, and 1280 pixel widths; collection-to-map navigation; detail Close/Back/Forward; postcard rotation and expansion; Settings; and onboarding replay. At 768 pixels, the map search, category tray, and bottom navigation share exact 10-pixel side gutters. Deployed browser verification is reported separately in the pull request. These captures are not Android or private-photo storage attestations.

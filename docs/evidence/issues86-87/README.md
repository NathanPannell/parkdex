# Issues 86 and 87 visual evidence

Before captures show `staging` at `26b4027`. After captures show the merged release at `1bbc2e7` on `staging.parkdex.app`. Each desktop comparison is cropped to the changed interface; the mobile header crop records the 390 x 844 verification.

## Issue 86

- Before: the group picker omitted groups that already contained the selected place.
- After: all ordinary groups remain visible; filled and empty circle states expose membership without relying on color.
- Pair: `before/cropped-group-picker.png` and `after/cropped-group-picker.png`.

## Issue 87

- Before: completion percentage appeared as a detached white badge across every screen, and Places repeated percentage plus a tracked total.
- After: completion percentage is integrated into the My Map header only; Places shows one collected summary, the segmented bar, and category counts.
- Header pair: `before/cropped-map-header.png` and `after/cropped-map-header.png`.
- Places pair: `before/cropped-places-progress.png` and `after/cropped-places-progress.png`.
- Mobile after-state: `after/cropped-mobile-map-header.png`.

Chrome verification covered My Map, Find Places, Places, and the authenticated Elk Falls group picker. The browser console reported no warnings or errors.

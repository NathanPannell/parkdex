# Reviewed place photo import, 2026-09-24

The local reviewer recorded final decisions for all 299 shortlist leads: 106 approved and 193 rejected. The decisions remain in the local ignored reviewer state and were not copied into this repository. The shortlisted file fingerprint matched the saved review state before import.

The import added **96 photos for 81 places**. Fifteen of those places have a second photo in the detail gallery. The catalogue now has 221 photographed places out of 1,030, or 21.5%. The 192 new WebP variants total 15.9 MB. Each photo has a thumbnail at most 320 pixels wide and 64 KB, and a detail image at most 960 pixels wide and 425 KB.

For every imported image, the Commons or originating Flickr source record was rechecked for creator, reusable Creative Commons license, direct source image, and location evidence. Flickr's direct image links may be its large-size versions rather than the photographer's full-resolution originals. The [credit index](../frontend/public/places/CATALOGUE_CREDITS.md) links every source and license. The product credit follows the photo selected in a park's gallery.

## Approved leads withheld

These ten approvals remain in the local review record. They were not published because the source does not establish the tracked park as the photographed place or shows another park.

| Tracked place | Source subject | Reason |
| --- | --- | --- |
| Columbia Lake Park | [Upper Joffre Lake](https://www.flickr.com/photos/87690240@N03/48563239936) | Joffre Lakes Provincial Park is a different park. |
| Columbia Lake Park | [Emerald Lake](https://www.flickr.com/photos/87690240@N03/48737261156) | Emerald Lake is in Yoho National Park. |
| Shuswap Lake Park | [Nelson Beach Marine Park](https://www.flickr.com/photos/72703814@N00/4681655508) | The source title identifies a different park. |
| Christina Lake Park | Cascade Falls above Christina Lake | The source geotag is outside the park, and the [official park description](https://bcparks.ca/christina-lake-park/) does not identify the falls. |
| Erie Creek Park | Erie Creek near Salmo | The source geotag is outside the [park's small riverbank parcel](https://bcparks.ca/erie-creek-park/). |
| Khutzeymateen Park | Khutzeymateen Inlet | The [inlet conservancy](https://bcparks.ca/khutzeymateen-inlet-west-conservancy/) is separately designated from the park. |
| White Lake Park | White Lake | The source identifies the larger lake without locating the image in the [north-shore park parcel](https://bcparks.ca/white-lake-park/). |
| Monte Lake Park | Monte Lake scenery | The geotag is outside the [small park parcel](https://bcparks.ca/monte-lake-park/). |
| Nanaimo River Regional Park | Nanaimo River rapids | The source geotag is about 10 km outside the [regional park](https://rdn.bc.ca/nanaimo-river-regional-park-archive). |
| Descanso Bay Regional Park | Mount Benson | The image depicts a mountain outside the [oceanfront park](https://rdn.bc.ca/descanso-bay-regional-park). |

The reproducible local validation report is at `C:/repo/parkdex-workspace/parkdex-photo-review/.codex/photo-import-validation/validation-report.json`. This report is local because it contains the user's ignored review-state path. The imported manifest and credit index are the published provenance record.

# Place photos

These images depict the named park or a documented feature within its boundary. Source landing pages and available API metadata were rechecked on 2026-09-11 for the named location, creator, original file, and reusable license. When a source description names only a feature, the manifest links an official park page that documents the feature inside the park. The manifest records the location evidence and URL, alt text, source and original links, license link, and changes for every image.

Each photo has two local WebP variants. `*-thumb.webp` is at most 320 pixels wide and 64 KB for collection lists; the detail file is at most 960 pixels wide and 425 KB for place cards. Neither variant is upscaled. The interface may center-crop a variant to fit its responsive frame, and Next.js may negotiate a smaller encoded response for the device.

| Place | Wikimedia Commons source | Creator | License |
| --- | --- | --- | --- |
| Artlish Caves Park | [Artlish River Cave](https://commons.wikimedia.org/wiki/File:Artlish_River_Cave.jpg) | Ian mckenzie | [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/) |
| Pacific Rim National Park Reserve | [Long Beach](https://commons.wikimedia.org/wiki/File:Longbeach_prnp.jpg) | Michael Oswald | [Public domain](https://creativecommons.org/publicdomain/mark/1.0/) |
| Gulf Islands National Park Reserve | [Sunset on Sidney Island](https://commons.wikimedia.org/wiki/File:Trees_during_the_sunset_in_Gulf_Islands_National_Park_Reserve,_Sidney_Island,_BC,_Canada.jpg) | Michal Klajban | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) |
| Cape Scott Park | [Cape Scott Provincial Park](https://commons.wikimedia.org/wiki/File:Cape_Scott_Provincial_Park_(28693304363).jpg) | David Stanley | [CC BY 2.0](https://creativecommons.org/licenses/by/2.0/) |
| Strathcona Park | [Paradise Meadows](https://commons.wikimedia.org/wiki/File:Paradise_Meadows_Strathcona_Provincial_Park_02.jpg) | Susan Daly | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) |
| Juan de Fuca Park | [Marine Trail bridge](https://commons.wikimedia.org/wiki/File:JDFBridge.jpg) | Colin Stepney | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) |
| Goldstream Park | [Goldstream River](https://commons.wikimedia.org/wiki/File:Flow,_Goldstream_Provincial_Park.jpg) | Mike | [CC BY-SA 2.0](https://creativecommons.org/licenses/by-sa/2.0/) |
| Rathtrevor Beach Park | [Rathtrevor Beach](https://commons.wikimedia.org/wiki/File:Rathtrevor_Beach_Provincial_Park.jpg) | marneejill | [CC BY-SA 2.0](https://creativecommons.org/licenses/by-sa/2.0/) |
| Englishman River Falls Park | [Englishman River Falls](https://commons.wikimedia.org/wiki/File:Englishman_River_Falls_Provincial_Park.jpg) | LizinVictoria | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) |
| Little Qualicum Falls Park | [Little Qualicum Falls](https://commons.wikimedia.org/wiki/File:Little_Qualicum_Falls_Provincial_Park_(36676055632).jpg) | GoToVan | [CC BY 2.0](https://creativecommons.org/licenses/by/2.0/) |
| Elk Falls Park | [Elk Falls and suspension bridge](https://commons.wikimedia.org/wiki/File:Elk_Falls_and_the_swinging_bridge_(48822254148).jpg) | dvs | [CC BY 2.0](https://creativecommons.org/licenses/by/2.0/) |
| Carmanah Walbran Park | [Carmanah Walbran park sign](https://commons.wikimedia.org/wiki/File:Carmanah_walbran_park.jpg) | Adam Walker | [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/) |
| Horne Lake Caves Park | [Horne Lake lower cave](https://commons.wikimedia.org/wiki/File:Horne_lake_lower_cave.jpg) | Dave Bunnell | [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/) |
| Sooke Potholes Park | [Sooke Potholes](https://commons.wikimedia.org/wiki/File:Potholes-SPPP.jpg) | Ruth Hartnup | [CC BY 2.0](https://creativecommons.org/licenses/by/2.0/) |
| MacMillan Park | [Cathedral Grove](https://commons.wikimedia.org/wiki/File:CathedralGrove-VancouverIsland.jpg) | Aaron Carlson | [CC BY-SA 2.0](https://creativecommons.org/licenses/by-sa/2.0/) |
| Saysutshun (Newcastle Island Marine) Park | [Newcastle Island beach](https://commons.wikimedia.org/wiki/File:Newcastle_Island_beach_(28994072520).jpg) | Kristina D.C. Hoeppner | [CC BY-SA 2.0](https://creativecommons.org/licenses/by-sa/2.0/) |
| East Sooke Regional Park | [East Sooke Park](https://commons.wikimedia.org/wiki/File:East_Sooke_Park_BC.jpg) | Brandon Godfrey | [CC BY-SA 2.0](https://creativecommons.org/licenses/by-sa/2.0/) |
| Little Huson Cave Regional Park | [Natural Bridge](https://commons.wikimedia.org/wiki/File:Natural_Bridge_(28723312295).jpg) | David Stanley | [CC BY 2.0](https://creativecommons.org/licenses/by/2.0/) |

The [expanded catalogue credit index](./CATALOGUE_CREDITS.md) lists the photos added by the 2026-09-11 coverage pass. Parks without a verified, freely licensed image continue to use the explicit `Photo unavailable` treatment; the task ledger links the search report for all reviewed gaps.

To contribute a photo:

1. Use a source page that explicitly names the tracked park or a documented feature inside its boundary. Nearby scenery and inferred locations are not sufficient.
2. Confirm that the license permits local redistribution and presentation. Record the creator, source page, original asset URL, license name and URL, location evidence, descriptive alt text, and every resize, conversion, or crop.
3. Create both WebP variants within the width and file-size budgets above. Do not overwrite or repurpose badge assets in `public/badges`.
4. Add the record to `lib/place-images.ts` and run `npm test -- place-images` from `frontend`. The integrity checks reject unknown IDs, duplicate or missing paths, oversized files, incomplete provenance, and unsupported licenses.

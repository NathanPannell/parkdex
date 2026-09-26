You are generating art assets for the Parkdex UI mockup at `C:\repo\parkdex-workspace\parkdex-badge-mockup`. Parkdex is a mobile app where people collect a digital badge for each real BC park they physically visit. The mascot is Kip, a Black Oystercatcher.

Scope: only create image and SVG asset files plus one manifest. Do not edit any file under `src/`, `scripts/`, or config files. The app animates everything in code (springs, bobbing, squash and stretch, wing flaps, blinking, bill talking, holo foil, confetti), so the assets must be clean, separable, and consistently registered. Keep all files inside `parkdex-badge-mockup/public/` as listed below. Do not create folders anywhere else.

## Global art direction

- Flat vector sticker style. Thick, consistent dark outline in #14231C. At most two-tone cel shading. Rounded, friendly shapes. Bright and playful, in the spirit of Duolingo or Headspace. Not realistic, no gradients heavier than a soft two-stop, no photographic texture.
- Brand palette: ink #14231C, paper #FFF8EC, Kip orange #FF5A1F, sun #FFC93C, moss #2F9E6B, pine #1C5B43, sea #22B3C5, sky #9FD8FF, berry #FF5C8A, grape #7B61FF.
- No text, letters, numbers, logos, or watermarks in any image.

## Kip, the character (use for every Kip image)

Kip is a Black Oystercatcher drawn as a chubby mascot:
- Round, glossy black body (#1E1A23) with a slightly lighter charcoal belly. About two heads tall: big round head on a small body, no visible neck. Soft white shine on the top-left of the head.
- Oversized friendly eye: yellow iris #FFD23F, thick red-orange eye ring #FF3B2F, black pupil, one white sparkle. Small pink blush under the eye #FF7A9A.
- Signature bill: long, straight, chisel-shaped, vivid orange-red #FF5A1F, about as long as the head is wide, yellow-orange tip #FFB547, with a thin #14231C outline so it reads on orange backgrounds.
- Thin pale pink legs #F7A1B5 with small three-toed feet. Short rounded wings in darker black #100E13 that act like little arms. Short pointed tail.
- Personality: eager, cheerful field guide who loves the outdoors and shouts "KLEEP!" with the bill open.

Base prompt to prefix on every Kip generation:
"Cute mascot character Kip, a Black Oystercatcher shorebird. Chubby round glossy black body, big round head, oversized yellow eye with a thick red-orange eye ring and a white sparkle, pink blush, long straight vivid orange-red bill with a yellow-orange tip and thin dark outline, thin pale pink legs with small feet, short rounded black wings used like arms. Flat vector sticker style, thick consistent dark outline, minimal cel shading, bright and playful. Transparent background, full body centred with margin, facing right."

Consistency process: generate `kip-reference.png` first. Pass it as the input/reference image for every later Kip generation and say "same character as the reference". Regenerate any image where the bill colour, eye design, leg colour, or proportions drift.

## 1. Kip poses -> `public/kip/`

Transparent PNG, 1024x1024, Kip facing right, about 8% margin, nothing cropped (bill tip and toes included). For full-body poses the feet sit on the same baseline at about 90% of canvas height and the body is the same size, so poses can swap without jumping. No ground shadow.

| File | Pose |
| --- | --- |
| `kip-reference.png` | Turnaround sheet: front, three-quarter, side views in a row, neutral standing. 1536x1024. |
| `kip-idle.png` | Standing relaxed and content, wings at sides. |
| `kip-wave.png` | Waving hello with one wing raised high, bill open in a happy "hi!". |
| `kip-point.png` | Pointing forward and slightly up with one wing, eager. |
| `kip-talk.png` | Explaining, bill open mid-sentence, one wing gesturing. |
| `kip-cheer.png` | Jumping with both wings up, bill wide open shouting, eyes squeezed happy, a few small sparkles. Feet off the baseline. |
| `kip-celebrate.png` | Proudly holding a round shiny gold medallion overhead with both wings, big grin. |
| `kip-camera.png` | Holding a small retro camera up to its eye. |
| `kip-map.png` | Holding an unfolded paper trail map, looking at it excitedly. |
| `kip-walk.png` | Walking mid-stride with a tiny green backpack. |
| `kip-think.png` | Head tilted, one wing on chin, curious and puzzled. |
| `kip-sleep.png` | Sitting fluffed up, eyes closed peacefully. |
| `kip-peek.png` | Only head and one wing peeking in from the left edge, cropped at the left edge on purpose. |
| `kip-avatar.png` | Head and shoulders, three-quarter view, friendly smile, centred for a circular crop. |
| `app-icon.png` | Kip's head and bill, bold and simple, on a solid #FF5A1F rounded-square background. Not transparent. 1024x1024. |

## 2. Kip animation rig -> `public/kip/kip-rig.svg`

The code animates Kip's joints, so hand-author (write as SVG code, do not embed a raster) a clean SVG of the idle pose that matches `kip-reference.png`:
- viewBox="0 0 150 150", Kip facing right, feet near y=135.
- Separate top-level groups with these exact ids, each a closed shape with the #14231C outline: `tail`, `legs`, `wing-back`, `body`, `head`, `eye` (inside head), `eye-closed` (a curved closed-eye line, `display="none"` by default), `bill-lower`, `bill-upper`, `wing-front`, `blush`.
- Parts must overlap at the joints so rotating a wing up to 110 degrees or opening the lower bill 18 degrees never shows a gap.
- In `public/kip/kip-rig.json`, record the pivot point in viewBox units for each part: head (neck), wing-front and wing-back (shoulder), bill-lower (hinge at the face), legs (hip), whole body (between the feet).

## 3. Badge scene art -> `public/badges/scenes/`

Each park badge is an embroidered-patch style emblem. The code draws the rim, the stitched border, rarity stars, the name ribbon, holo foil, and shine. You supply only the landscape inside it.

- Square PNG, 1024x1024, fully opaque, edge to edge (it will be clipped to circle, shield, hexagon, arch, and scalloped seal shapes, so keep the key subject inside the central circle of 80% diameter).
- The bottom 30% will be covered by a ribbon, so keep it simple foreground (water, grass, rocks), no key subject there.
- Same flat sticker style as Kip but with thinner outlines (#14231C, about 40% of Kip's weight). Bold simple layers: sky, sun or moon, far range, mid layer, foreground. Soft visible thread texture is welcome (subtle diagonal stitch pattern) so it reads as an embroidered patch.
- Two variants per landscape type, named `<type>-a.png` and `<type>-b.png`. Vary the time of day or the hero element between a and b.

| Type | Hero content |
| --- | --- |
| `coast` | Pacific rocky shore, sea stacks, waves, driftwood; variant with a small red-and-white lighthouse. |
| `forest` | Tall Douglas fir and cedar forest, mossy floor, sunbeams; variant with a small red mushroom or fern. |
| `mountain` | Two snow-capped peaks, alpine meadow, pines at the base. |
| `lake` | Calm lake reflecting hills, an orange canoe; variant at golden hour. |
| `waterfall` | Tall waterfall between purple-grey cliffs, splash pool, spray. |
| `river` | Winding river through green banks, river stones, pines. |
| `cave` | Dark cave mouth under a starry purple night sky, glowing crystals. |
| `marsh` | Wetland with cattails and reeds, a heron silhouette, pink sky. |
| `heritage` | Sandstone rock with a respectful, generic spiral and animal-line petroglyph carving, arbutus trees. Do not copy any specific real petroglyph. |
| `legendary` | Grand vista for national parks: surf beach with rainforest and big sky, sun rays. |

## 4. Product art for the "Make your case real" test -> `public/products/`

PNG, 1200x900, transparent background, soft product-render illustration in the same flat style (slightly more depth allowed), three-quarter view, no text:
- `display-case.png`: a walnut wooden shadow-box display case with a glass front and dark green felt, holding 12 colourful round and shield-shaped enamel park pins in a grid.
- `field-book.png`: a hardcover photo book with a deep pine-green cloth cover, a small embossed badge emblem, and an open copy beside it showing a photo on one page and an enamel-pin-style badge on the facing page.
- `pin-closeup.png`: one enamel pin badge (mountain scene, hexagon shape, gold metal rim) at an angle with a glossy highlight and a butterfly clutch behind it.

## 5. Manifest and checks

Write `public/assets-manifest.json` listing every file you created with its path, pixel size, whether it has transparency, and a one-line description.

Before finishing, verify with a script (Node or Python, run from `parkdex-badge-mockup`, delete any temporary files afterwards):
- Every file in the tables exists with the exact name and pixel size.
- Kip PNGs (except `app-icon.png`) have a transparent background at all four corners. Scene PNGs have no transparency.
- Full-body Kip poses keep feet within 2% of the same baseline, and Kip's bounding box height is within 5% across idle, wave, point, talk, and walk.
- `kip-rig.svg` parses, contains every required id, and `kip-rig.json` has a pivot for each animated part.
- Build a contact sheet at `public/assets-contact-sheet.png` (all images tiled with file names) so the whole set can be reviewed at once.

Report which files were regenerated for consistency and any item you could not produce.

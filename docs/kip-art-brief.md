# Kip art brief

Save every image to `parkdex-badge-mockup/public/kip/` using the exact file names below.
Once they are wired in, any missing file falls back to the built-in SVG Kip.

## Output rules (all images)

- PNG, transparent background, 1024 x 1024.
- Kip centred, about 8% empty margin on every side. Nothing cropped (bill tip and toes included).
- Kip faces right unless noted. The app mirrors images when it needs Kip facing left.
- Feet on the same baseline (about 90% down the canvas) for every full-body pose, so poses swap without jumping.
- No text, no background scenery, no drop shadow on the ground. The app draws its own shadow.

## Kip, the character

Kip is a Black Oystercatcher, the shorebird of BC's rocky coast, drawn as a cute mascot.

- Body: a round, chubby, glossy black body (#1E1A23) with a slightly lighter charcoal belly. About two heads tall, with a big head and a small body.
- Head: large and round, merged into the body with no visible neck. A soft white shine highlight on the top-left of the head.
- Eye: oversized and friendly. Bright yellow iris (#FFD23F), a thick red-orange eye ring (#FF3B2F), a black pupil and one white sparkle. A small pink blush under the eye (#FF7A9A).
- Bill: the signature feature. A long, straight, chisel-shaped bill in vivid orange-red (#FF5A1F), about as long as the head is wide. The tip is slightly yellow-orange (#FFB547). The bill has a thin dark outline so it reads against orange backgrounds.
- Legs: thin, pale pink legs (#F7A1B5) with small three-toed feet.
- Wings: short, rounded, darker black (#100E13). They can act like little arms.
- Tail: a short, pointed black tail.
- Style: flat vector illustration with a thick, consistent dark-green-black outline (#14231C) around the whole character. Two-tone cel shading at most. Rounded, sticker-like shapes. Playful and warm, in the spirit of Duolingo or Headspace mascots, not realistic.
- Personality: an eager, loud, cheerful field guide who loves being outside. Oystercatchers are famous for their loud "kleep!" call, so Kip is often mid-shout with the bill open.

### Reusable style prompt

Paste this at the start of every generation, then add the pose line:

> Cute mascot character "Kip", a Black Oystercatcher shorebird. Chubby round glossy black body, big round head, oversized yellow eye with a thick red-orange eye ring and a white sparkle, pink blush, long straight vivid orange-red bill with a yellow-orange tip, thin pale pink legs with small feet, short rounded black wings used like arms. Flat vector sticker style, thick consistent dark outline, minimal cel shading, bright and playful. Transparent background, 1024x1024, full body centred with margin, facing right.

Generate `kip-reference.png` first. Then upload it with each pose request and say "same character as the reference" to keep Kip consistent.

## Images needed

| File | Pose line to add to the prompt | Where it appears |
| --- | --- | --- |
| `kip-reference.png` | Character turnaround sheet: front, three-quarter and side views in a row, neutral standing pose. (This one can be 1536 x 1024.) | Consistency reference only |
| `kip-idle.png` | Standing relaxed and content, slight smile, wings at sides. | Collection header, share card corner |
| `kip-wave.png` | Waving hello with one wing raised high, bill open in a happy "hi!". | Splash screen, onboarding slide 1 |
| `kip-point.png` | Pointing forward and slightly up with one wing like an arm, eager expression. | Onboarding slide 2 ("Go there. For real.") |
| `kip-talk.png` | Explaining something, bill open mid-sentence, one wing gesturing. | Location permission sheet, camera screen |
| `kip-cheer.png` | Jumping in the air with both wings up, bill wide open shouting "KLEEP!", eyes squeezed happy, a few small sparkles. | Arrival card ("You made it!") |
| `kip-celebrate.png` | Proudly holding up a round shiny badge medallion over its head with both wings, big grin. | Claim ceremony after the badge is claimed |
| `kip-camera.png` | Holding a small retro camera up to its eye, about to snap a photo. | Camera / check-in screen |
| `kip-map.png` | Holding an unfolded paper trail map, looking at it excitedly. | Onboarding slide 1 or nearby-parks rail |
| `kip-walk.png` | Walking mid-stride with a tiny green backpack, determined and happy. | Unused (the in-app trip panel was removed; directions open Google Maps) |
| `kip-think.png` | Head tilted, one wing on chin, curious and puzzled. | "Get inside a park first" hint, empty states |
| `kip-sleep.png` | Sitting fluffed up, eyes closed peacefully, bill tucked slightly down. | Empty collection ("waiting for badge #1") |
| `kip-peek.png` | Only the head and one wing peeking in from the left edge of the frame, curious. Cropped at the left edge on purpose. | Toasts and edge peeks |
| `kip-avatar.png` | Head and shoulders only, three-quarter view, friendly smile, centred for a circular crop. | Map badge counter |
| `app-icon.png` | Kip's head and bill, bold and simple, on a solid orange (#FF5A1F) rounded-square background. Not transparent. | Favicon and home-screen icon |

## After saving

Tell Claude the images are in `public/kip/`. The mockup will switch Kip to the images and keep the
motion (bobbing, squash and stretch, springs and bubbles) on top of them. The blink and bill-flap
micro-animations are only possible with the SVG Kip, so the small avatar may stay as SVG if that
looks better.

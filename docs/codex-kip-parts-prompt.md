Regenerate Kip's animation rig as separate raster parts for `C:\repo\parkdex-workspace\parkdex-badge-mockup`. The existing `public/kip/kip-rig.svg` is rejected; delete it and `public/kip/kip-rig.json`. Do not change any other existing image, and do not edit code. Save everything to `public/kip/parts/`.

Goal: the app will stack these parts and rotate them in code (head tilt, wing flap, bill open and close, blink, body squash). They must look exactly like the approved `public/kip/kip-idle.png` when stacked with no rotation.

## Method

1. Start from `public/kip/kip-idle.png` (1024x1024, transparent). Every part is cut from that exact image so the parts line up pixel for pixel. Do not redraw Kip from scratch.
2. Split it with masks (Python with Pillow and NumPy is fine) into the parts below. Each part is a 1024x1024 transparent PNG, left in its original position on the canvas. Do not crop or move parts.
3. Wherever one part covered another in the original (body under the wings, head under the bill, the eye area when closed), use image editing or inpainting on that single part to fill the hidden area in Kip's style: flat colour, same outline weight (#14231C), same shading. Extend each part about 30 px past its joint so that rotating it never shows a gap or a hard seam.
4. Keep the outline around each part's outer edge, but do not draw an outline along a joint edge that is hidden under another part.

## Parts (bottom to top stacking order)

| File | Contents |
| --- | --- |
| `tail.png` | The tail only, extended under the body. |
| `legs.png` | Both legs and feet, extended up under the body. |
| `wing-back.png` | The far wing (if hidden in idle, create it from the near wing, darker and slightly smaller, peeking behind the body). |
| `body.png` | The torso and belly with no wings and no head, filled where the wings and head covered it. |
| `head.png` | The head with blush and shine, no eye and no bill, filled underneath where they were. |
| `eye-open.png` | The eye only (ring, iris, pupil, sparkle). |
| `eye-closed.png` | A happy closed eye (a curved line with the red ring colour) at the same position and size as the open eye. |
| `bill-lower.png` | The lower half of the bill, a separate piece that can hinge open. |
| `bill-upper.png` | The upper half of the bill with the yellow-orange tip. |
| `wing-front.png` | The near wing only, filled where it met the body. |

## Pivots

Write `public/kip/parts/rig.json` with pixel coordinates on the 1024 canvas:

```json
{
  "canvas": 1024,
  "order": ["tail", "legs", "wing-back", "body", "head", "eye-open", "eye-closed", "bill-lower", "bill-upper", "wing-front"],
  "pivots": {
    "body": [x, y],
    "head": [x, y],
    "wing-front": [x, y],
    "wing-back": [x, y],
    "bill-lower": [x, y],
    "bill-upper": [x, y],
    "tail": [x, y],
    "legs": [x, y]
  },
  "childOf": { "eye-open": "head", "eye-closed": "head", "bill-lower": "head", "bill-upper": "head" }
}
```

Pivot definitions: body = midpoint between the feet; head = base of the neck where the head meets the body; each wing = its shoulder joint; bill-lower and bill-upper = hinge where the bill meets the face; tail = where the tail meets the body; legs = the hip.

## Checks (write a script, run it, then delete temporary files)

- All ten PNGs exist at 1024x1024 with transparency.
- Stacking the parts in order (skip eye-closed) matches `kip-idle.png`: at least 99% of opaque pixels within 12 RGB units.
- Rotating the head by +/-12 degrees, each wing by -110 degrees and the lower bill by 18 degrees around their pivots leaves no transparent gap inside Kip's silhouette.
- Save `public/kip/parts/rig-preview.png` as a 3x2 grid: idle (stacked), head tilted, wing raised, bill open, eyes closed, and an exploded view with every part shown separately and its pivot marked with a dot.

Report any part you had to inpaint and anything you could not produce.

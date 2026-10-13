"""Builds the web app icons in public/icons/ from art-source/kip/app-icon.png.

The source is a rounded orange tile on cream corners. The web needs three shapes:
- "any" icons (192, 512): the rounded tile with transparent corners, shown as is.
- a maskable icon (512): full-bleed orange with Kip inside the centre safe zone, because the
  platform cuts its own shape. Never a pre-rounded tile (docs/learnings/android-orientation-and-icons.md).
- apple-touch-icon (180): full-bleed and opaque, because iOS rounds it and blackens transparency.

Usage: python scripts/build-web-icons.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "art-source" / "kip" / "app-icon.png"
OUT = ROOT / "public" / "icons"

ORANGE = (252, 88, 25, 255)
# The tile's corner radius and the soft edge trimmed inside it, in source pixels (1024 canvas).
TILE_RADIUS = 228
EDGE_TRIM = 4
# Maskable icons keep content inside a centred circle of 40% radius; Kip's beak reaches about
# 0.51 of the canvas from the centre, so 0.74 leaves a margin.
MASKABLE_SCALE = 0.74


def tile_mask(size: int) -> Image.Image:
    """An anti-aliased rounded-rectangle mask just inside the tile's own edge."""
    scale = 4
    big = Image.new("L", (size * scale, size * scale), 0)
    inset = EDGE_TRIM * scale
    ImageDraw.Draw(big).rounded_rectangle(
        (inset, inset, size * scale - 1 - inset, size * scale - 1 - inset),
        radius=(TILE_RADIUS - EDGE_TRIM) * scale,
        fill=255,
    )
    return big.resize((size, size), Image.LANCZOS)


def main() -> None:
    source = Image.open(SOURCE).convert("RGBA")
    size = source.width
    mask = tile_mask(size)

    rounded = Image.new("RGBA", source.size, (0, 0, 0, 0))
    rounded.paste(source, (0, 0), mask)
    full_bleed = Image.new("RGBA", source.size, ORANGE)
    full_bleed.paste(source, (0, 0), mask)

    inner = round(size * MASKABLE_SCALE)
    maskable = Image.new("RGBA", source.size, ORANGE)
    offset = (size - inner) // 2
    maskable.paste(full_bleed.resize((inner, inner), Image.LANCZOS), (offset, offset))

    OUT.mkdir(parents=True, exist_ok=True)
    jobs = [
        (rounded, 192, "parkdex-192.png"),
        (rounded, 512, "parkdex-512.png"),
        (maskable, 512, "parkdex-maskable-512.png"),
        (full_bleed.convert("RGB"), 180, "apple-touch-icon.png"),
    ]
    for image, px, name in jobs:
        image.resize((px, px), Image.LANCZOS).save(OUT / name, "PNG", optimize=True)
        print(f"{name}: {(OUT / name).stat().st_size / 1e3:.0f} kB")


if __name__ == "__main__":
    main()

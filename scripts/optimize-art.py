"""Resizes the generated source art in art-source/ into small WebP files under public/art/.

Only the WebP output ships in the app; art-source/ keeps the full-size originals.
Usage: python scripts/optimize-art.py
"""

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "art-source"
OUT = ROOT / "public" / "art"

JOBS = [
    ("kip", "kip-*.png", 512),
    ("kip/parts", "*.png", 512),
    ("badges/scenes", "*.png", 512),
    ("products", "*.png", 900),
]


def main() -> None:
    for folder, pattern, size in JOBS:
        dest = OUT / folder
        dest.mkdir(parents=True, exist_ok=True)
        for src in sorted((SRC / folder).glob(pattern)):
            if src.stem in ("kip-reference", "rig-preview"):
                continue
            img = Image.open(src)
            img.thumbnail((size, size), Image.LANCZOS)
            img.save(dest / f"{src.stem}.webp", "WEBP", quality=86, method=6)
    total = sum(f.stat().st_size for f in OUT.rglob("*.webp"))
    print(f"{len(list(OUT.rglob('*.webp')))} files, {total / 1e6:.1f} MB")


if __name__ == "__main__":
    main()

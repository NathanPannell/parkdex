"""Builds the iOS app icon and launch splash in ios/App/App/Assets.xcassets/.

- App icon (1024): the same full-bleed, opaque tile as the web apple-touch-icon
  (scripts/build-web-icons.py). iOS cuts its own rounded shape and App Store icons must have no
  alpha, so never a pre-rounded tile (docs/learnings/android-orientation-and-icons.md).
- Splash (2732, used at 1x, 2x and 3x): assets/splash.png, opaque. The launch screen fills the
  screen with it (aspect fill), and Kip sits in the centre so every iPhone crop keeps him.

Usage: python scripts/build-ios-assets.py
"""

import importlib.util
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
CATALOG = ROOT / "ios" / "App" / "App" / "Assets.xcassets"
SPLASH_SOURCE = ROOT / "assets" / "splash.png"
SPLASH_NAMES = ("splash-2732x2732.png", "splash-2732x2732-1.png", "splash-2732x2732-2.png")


def web_icons():
    spec = importlib.util.spec_from_file_location("build_web_icons", ROOT / "scripts" / "build-web-icons.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def full_bleed_icon() -> Image.Image:
    icons = web_icons()
    source = Image.open(icons.SOURCE).convert("RGBA")
    full_bleed = Image.new("RGBA", source.size, icons.ORANGE)
    full_bleed.paste(source, (0, 0), icons.tile_mask(source.width))
    return full_bleed.convert("RGB").resize((1024, 1024), Image.LANCZOS)


def main() -> None:
    icon_path = CATALOG / "AppIcon.appiconset" / "AppIcon-512@2x.png"
    full_bleed_icon().save(icon_path, "PNG", optimize=True)
    print(f"{icon_path.name}: {icon_path.stat().st_size / 1e3:.0f} kB")

    splash = Image.open(SPLASH_SOURCE).convert("RGB")
    for name in SPLASH_NAMES:
        path = CATALOG / "Splash.imageset" / name
        splash.save(path, "PNG", optimize=True)
        print(f"{name}: {path.stat().st_size / 1e3:.0f} kB")


if __name__ == "__main__":
    main()

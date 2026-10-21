"""Downloads the photo lab images from Wikimedia Commons and prepares them for upload.

Usage: python tools/photo-lab/fetch.py [--force] [--only id,id]

Each Commons photo is fetched at 1,280 px through the Commons API and checked against the
manifest's SHA-1 of the original file, so a replaced upload is reported instead of silently
changing the test set. Derived photos are generated from their parent with Pillow. Every photo
is then prepared the way the app prepares an upload (src/lib/photoEncode.ts): orientation
applied, fitted within 1,280 px, and re-encoded as JPEG at quality 82, stepping down when the
file would be over 1.5 MB. The images are not committed; see tools/photo-lab/README.md.
"""

from __future__ import annotations

import argparse
import io
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from PIL import Image, ImageChops, ImageFilter, ImageOps

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
UA = "ParkdexPhotoLab/1.0 (https://github.com/NathanPannell/parkdex-kip; photo moderation test set)"
API = "https://commons.wikimedia.org/w/api.php"
MAX_EDGE = 1280
QUALITIES = (82, 72, 60)
MAX_BYTES = 1_500_000


def data_dir() -> Path:
    """Mirrors labDir() in lab.ts: PHOTO_LAB_DIR, else the workspace .codex/photo-lab above the repo."""
    configured = os.environ.get("PHOTO_LAB_DIR", "").strip()
    if configured:
        return Path(configured)
    for parent in REPO.parents:
        if (parent / ".codex").is_dir():
            return parent / ".codex" / "photo-lab"
    return REPO / ".codex" / "photo-lab"


def get(url: str) -> bytes:
    for attempt in range(6):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=90) as response:
                return response.read()
        except urllib.error.HTTPError as error:
            if error.code not in (429, 500, 502, 503, 504) or attempt == 5:
                raise
        except urllib.error.URLError:
            if attempt == 5:
                raise
        time.sleep(2 * (attempt + 1) ** 2)
    raise RuntimeError("unreachable")


def commons_info(titles: list[str]) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for start in range(0, len(titles), 40):
        chunk = titles[start : start + 40]
        query = urllib.parse.urlencode(
            {
                "action": "query",
                "titles": "|".join(chunk),
                "prop": "imageinfo",
                "iiprop": "url|sha1",
                "iiurlwidth": str(MAX_EDGE),
                "format": "json",
                "formatversion": "2",
            }
        )
        body = json.loads(get(f"{API}?{query}"))
        normalized = {item["to"]: item["from"] for item in body["query"].get("normalized", [])}
        for page in body["query"]["pages"]:
            if "imageinfo" not in page:
                continue
            info = page["imageinfo"][0]
            out[normalized.get(page["title"], page["title"])] = {"url": info.get("thumburl") or info["url"], "sha1": info["sha1"]}
    return out


def commons_source(photo: dict, by_id: dict[str, dict]) -> dict:
    source = photo["source"]
    if source["type"] == "commons":
        return source
    if "fromCommons" in source:
        return source["fromCommons"]
    return commons_source(by_id[source["from"]], by_id)


def flatten(image: Image.Image) -> Image.Image:
    image = ImageOps.exif_transpose(image)
    if image.mode in ("RGBA", "LA") or (image.mode == "P" and "transparency" in image.info):
        rgba = image.convert("RGBA")
        # A canvas JPEG export draws transparent pixels as black.
        background = Image.new("RGBA", rgba.size, (0, 0, 0, 255))
        return Image.alpha_composite(background, rgba).convert("RGB")
    return image.convert("RGB")


def fit_within(image: Image.Image, max_edge: int = MAX_EDGE) -> Image.Image:
    width, height = image.size
    scale = min(1.0, max_edge / max(width, height))
    if scale >= 1:
        return image
    size = (max(1, round(width * scale)), max(1, round(height * scale)))
    return image.resize(size, Image.Resampling.LANCZOS)


def encode(image: Image.Image) -> bytes:
    data = b""
    for quality in QUALITIES:
        buffer = io.BytesIO()
        image.save(buffer, "JPEG", quality=quality)
        data = buffer.getvalue()
        if len(data) <= MAX_BYTES:
            return data
    raise ValueError("photo too large after quality steps")


def motion_blur(image: Image.Image, length: int, angle: float) -> Image.Image:
    import math

    dx, dy = math.cos(math.radians(angle)), -math.sin(math.radians(angle))
    accumulated: Image.Image | None = None
    for index in range(length):
        step = index - (length - 1) / 2
        shifted = ImageChops.offset(image, round(step * dx), round(step * dy))
        accumulated = shifted if accumulated is None else Image.blend(accumulated, shifted, 1 / (index + 1))
    assert accumulated is not None
    # Offsets wrap around; trim the wrapped margin.
    margin_x, margin_y = abs(round(length / 2 * dx)) + 1, abs(round(length / 2 * dy)) + 1
    width, height = accumulated.size
    return accumulated.crop((margin_x, margin_y, width - margin_x, height - margin_y))


def darken(image: Image.Image, gamma: float, scale: float) -> Image.Image:
    return image.point(lambda value: round(255 * scale * (value / 255) ** gamma))


def transform(image: Image.Image, spec: dict) -> Image.Image:
    op = spec["op"]
    if op == "gaussian_blur":
        return image.filter(ImageFilter.GaussianBlur(spec["radius"]))
    if op == "motion_blur":
        return motion_blur(image, int(spec["length"]), float(spec["angle"]))
    if op == "gamma_darken":
        return darken(image, spec["gamma"], spec["scale"])
    if op == "overexpose":
        gain = spec["gain"]
        return image.point(lambda value: min(255, round(value * gain + 30)))
    if op == "partial_blur":
        blurred = image.filter(ImageFilter.GaussianBlur(spec["radius"]))
        width, height = image.size
        ramp = Image.linear_gradient("L").rotate(90, expand=True).resize((width, height))
        mask = ramp if spec.get("side", "left") == "left" else ImageOps.invert(ramp)
        return Image.composite(blurred, image, mask)
    if op == "pocket":
        width, height = image.size
        crop = image.crop((width // 4, height // 4, width * 3 // 4, height * 3 // 4)).resize((width, height))
        return darken(crop.filter(ImageFilter.GaussianBlur(spec["radius"])), spec["gamma"], spec["scale"])
    raise ValueError(f"unknown transform {op}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--force", action="store_true", help="download and prepare again even if the files exist")
    parser.add_argument("--only", default="", help="comma-separated photo ids")
    args = parser.parse_args()

    manifest = json.loads((HERE / "manifest.json").read_text(encoding="utf-8"))
    photos = manifest["photos"]
    by_id = {photo["id"]: photo for photo in photos}
    only = {item.strip() for item in args.only.split(",") if item.strip()}
    selected = [photo for photo in photos if not only or photo["id"] in only]

    root = data_dir()
    originals, prepared = root / "images" / "source", root / "images"
    originals.mkdir(parents=True, exist_ok=True)

    needed = {}
    for photo in selected:
        source = commons_source(photo, by_id)
        needed[source["title"]] = source
    missing = [title for title, source in needed.items() if args.force or not (originals / f"{source['sha1']}.img").exists()]
    info = commons_info(missing) if missing else {}
    changed = []
    for title in missing:
        source = needed[title]
        current = info.get(title)
        if current is None:
            print(f"missing on Commons: {title}", file=sys.stderr)
            continue
        if current["sha1"] != source["sha1"]:
            changed.append(title)
        (originals / f"{source['sha1']}.img").write_bytes(get(current["url"]))
        print(f"downloaded {title}")
        time.sleep(0.4)

    failures = 0
    for photo in selected:
        target = prepared / f"{photo['id']}.jpg"
        if target.exists() and not args.force:
            continue
        source = commons_source(photo, by_id)
        path = originals / f"{source['sha1']}.img"
        if not path.exists():
            failures += 1
            continue
        with Image.open(path) as opened:
            image = flatten(opened)
        image = fit_within(image)
        if photo["source"]["type"] == "derived":
            image = transform(image, photo["source"]["transform"])
        target.write_bytes(encode(image))
    if changed:
        print("These Commons files changed since the manifest was written: " + ", ".join(changed), file=sys.stderr)
    ready = sum(1 for photo in photos if (prepared / f"{photo['id']}.jpg").exists())
    print(f"{ready} of {len(photos)} photos ready in {prepared}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())

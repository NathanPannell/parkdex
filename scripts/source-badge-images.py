"""Fetch individually licensed Commons photos; keep attribution and provenance."""
import html
import json
from pathlib import Path
import re
import requests
import time

ROOT = Path(__file__).resolve().parents[1]
SPECIES = {
    "banana-slug": "Ariolimax columbianus", "black-bear": "Ursus americanus",
    "sea-otter": "Enhydra lutris", "river-otter": "Lontra canadensis",
    "orca": "Orcinus orca", "harbour-seal": "Phoca vitulina",
    "bald-eagle": "Haliaeetus leucocephalus", "great-blue-heron": "Ardea herodias",
    "belted-kingfisher": "Megaceryle alcyon", "rufous-hummingbird": "Selasphorus rufus",
    "stellers-jay": "Cyanocitta stelleri", "black-tailed-deer": "Odocoileus hemionus columbianus",
    "red-squirrel": "Tamiasciurus hudsonicus", "raccoon": "Procyon lotor",
    "pacific-treefrog": "Pseudacris regilla", "red-legged-frog": "Rana aurora",
    "douglas-fir": "Pseudotsuga menziesii", "western-redcedar": "Thuja plicata",
    "arbutus": "Arbutus menziesii", "salal": "Gaultheria shallon",
    "sword-fern": "Polystichum munitum", "camas": "Camassia quamash",
}

def plain(value):
    return html.unescape(re.sub(r"<[^>]*>", "", value)).strip()

def fetch(item):
    slug, species = item
    session = requests.Session()
    session.headers["User-Agent"] = "EveryPark/1.0 (educational field-guide; licensed badge imagery)"
    params = {
        "action": "query", "format": "json", "generator": "search",
        "gsrsearch": f'"{species}" filetype:bitmap', "gsrnamespace": 6, "gsrlimit": 10,
        "prop": "imageinfo", "iiprop": "url|extmetadata", "iiurlwidth": 400,
    }
    for attempt in range(4):
        response = session.get("https://commons.wikimedia.org/w/api.php", params=params, timeout=40)
        if response.status_code != 429:
            break
        time.sleep(min(int(response.headers.get("Retry-After", "30")), 60))
    response.raise_for_status()
    pages = sorted(response.json().get("query", {}).get("pages", {}).values(), key=lambda p: p.get("index", 100))
    for page in pages:
        info = page["imageinfo"][0]
        meta = info.get("extmetadata", {})
        license_name = plain(meta.get("LicenseShortName", {}).get("value", ""))
        if not (license_name.startswith("CC BY") or license_name in ("CC0", "Public domain")):
            continue
        if any(x in license_name for x in ("NC", "ND")):
            continue
        url = info.get("thumburl", info["url"])
        photo = session.get(url, timeout=50)
        if not photo.ok or not photo.headers.get("Content-Type", "").startswith("image/"):
            continue
        extension = ".png" if "png" in photo.headers["Content-Type"] else ".jpg"
        target = ROOT / "frontend/public/badges" / (slug + extension)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(photo.content)
        return slug, {
            "src": "/badges/" + target.name, "alt": slug.replace("-", " "), "species": species,
            "creator": plain(meta.get("Artist", {}).get("value", "See source for creator")),
            "license": license_name, "licenseUrl": meta.get("LicenseUrl", {}).get("value", "https://creativecommons.org/publicdomain/mark/1.0/"),
            "sourceUrl": info["descriptionurl"], "originalUrl": info["url"],
            "sourceTitle": page["title"], "changes": "Displayed cropped to fit badge; source thumbnail resized by Wikimedia.",
        }
    raise RuntimeError(f"No downloadable permitted image for {slug}")

if __name__ == "__main__":
    target = ROOT / "frontend/lib/badge-images.json"
    manifest = json.loads(target.read_text(encoding="utf-8")) if target.exists() else {}
    for item in SPECIES.items():
        if item[0] in manifest:
            continue
        time.sleep(7)
        try:
            slug, entry = fetch(item)
            manifest[slug] = entry
            target.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
            print(slug, entry["license"], flush=True)
        except Exception as error:
            print("FAILED", item[0], str(error), flush=True)
    target.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    if len(manifest) != len(SPECIES):
        raise SystemExit("Some images need manual sourcing")

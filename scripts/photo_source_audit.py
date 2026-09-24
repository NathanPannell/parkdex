"""Find reviewable place-photo leads without downloading or publishing media.

The public staging catalogue is the input. Results are append-only JSONL so a long
run can resume after a rate limit or interruption. A search hit is never treated as
permission or proof that the image depicts a place.
"""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import csv
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import threading
import time
import unicodedata
from urllib.parse import urlparse

import requests

from photo_audit_nature import search_flickr, search_inaturalist
from photo_audit_open import search_commons, search_openverse
from photo_audit_stock import search_pexels, search_unsplash


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CATALOGUE = "https://api-staging-882c.up.railway.app/api/places"
DEFAULT_OUTPUT = ROOT / ".codex" / "photo-source-audit"
AUDIT_POLICY_VERSION = 3
SOURCES = ("commons", "openverse", "inaturalist", "flickr", "pexels", "unsplash")
OPEN_SOURCES = frozenset(("commons", "wikimedia_commons", "openverse", "inaturalist", "flickr"))
USER_AGENT = "ParkdexPhotoAudit/1.0 (https://github.com/NathanPannell/parkdex; candidate research)"
GENERIC_NAME_WORDS = frozenset(("park", "provincial", "regional", "national", "reserve", "protected", "area", "site"))


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def get_json(response: requests.Response) -> dict:
    response.raise_for_status()
    value = response.json()
    if not isinstance(value, dict):
        raise ValueError("Expected a JSON object")
    return value


class PoliteClient:
    """Requests facade with per-host pacing and bounded transient retries."""

    def __init__(self, delay: float = 1.1):
        self.local = threading.local()
        self.delay = delay
        self.last_request: dict[str, float] = {}
        self.lock = threading.Lock()
        self.host_locks: dict[str, threading.Lock] = {}

    def get(self, url: str, **kwargs) -> requests.Response:
        host = urlparse(url).netloc
        kwargs.setdefault("timeout", 30)
        if not hasattr(self.local, "session"):
            self.local.session = requests.Session()
            self.local.session.headers["User-Agent"] = USER_AGENT
        with self.lock:
            host_lock = self.host_locks.setdefault(host, threading.Lock())
        for attempt in range(4):
            with host_lock:
                wait = self.delay - (time.monotonic() - self.last_request.get(host, 0))
                if wait > 0:
                    time.sleep(wait)
                self.last_request[host] = time.monotonic()
            try:
                response = self.local.session.get(url, **kwargs)
            except requests.RequestException:
                if attempt == 3:
                    raise
                time.sleep(min(2 ** attempt, 8))
                continue
            if response.status_code not in (429, 500, 502, 503, 504) or attempt == 3:
                response.raise_for_status()
                return response
            retry_after = response.headers.get("Retry-After", "")
            try:
                pause = max(float(retry_after), 1)
            except ValueError:
                try:
                    pause = max((parsedate_to_datetime(retry_after) - datetime.now(timezone.utc)).total_seconds(), 1)
                except (TypeError, ValueError, OverflowError):
                    pause = min(2 ** attempt, 8)
            if response.status_code == 429 and pause > 90:
                response.raise_for_status()
            time.sleep(pause)
        raise RuntimeError("Unreachable retry state")


def load_catalogue(client: PoliteClient, url: str, path: str | None) -> list[dict]:
    payload = json.loads(Path(path).read_text(encoding="utf-8")) if path else get_json(client.get(url))
    places = payload if isinstance(payload, list) else payload.get("places")
    if not isinstance(places, list):
        raise ValueError("Catalogue must contain a places array")
    ids = set()
    for place in places:
        if not isinstance(place, dict) or not all(key in place for key in ("id", "name", "latitude", "longitude")):
            raise ValueError("Incomplete place in catalogue")
        if place["id"] in ids:
            raise ValueError(f"Duplicate place ID: {place['id']}")
        ids.add(place["id"])
    return places


def existing_photo_ids() -> set[str]:
    catalogue = json.loads((ROOT / "frontend/lib/place-images.catalogue.json").read_text(encoding="utf-8"))
    source = (ROOT / "frontend/lib/place-images.ts").read_text(encoding="utf-8")
    base = set(re.findall(r'^  "([^"\n]+)": \{\s*$', source, re.MULTILINE))
    return set(catalogue) | base


def point_in_ring(point: tuple[float, float], ring: list) -> bool:
    x, y = point
    inside = False
    for a, b in zip(ring, ring[1:]):
        x1, y1 = a[:2]
        x2, y2 = b[:2]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            inside = not inside
    return inside


def point_in_geometry(longitude: float | None, latitude: float | None, geometry: dict | None) -> bool:
    if longitude is None or latitude is None or not geometry:
        return False
    polygons = geometry.get("coordinates", [])
    if geometry.get("type") == "Polygon":
        polygons = [polygons]
    elif geometry.get("type") != "MultiPolygon":
        return False
    point = (float(longitude), float(latitude))
    return any(rings and point_in_ring(point, rings[0]) and not any(point_in_ring(point, hole) for hole in rings[1:]) for rings in polygons)


def load_boundaries() -> dict[str, dict]:
    payload = json.loads((ROOT / "data/boundaries.geojson").read_text(encoding="utf-8"))
    return {feature["properties"]["id"]: feature["geometry"] for feature in payload["features"]}


def words(value: str) -> list[str]:
    plain = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode("ascii").lower()
    return re.findall(r"[a-z0-9]+", plain)


def name_in_metadata(place: dict, candidate: dict) -> bool:
    distinctive = [word for word in words(place["name"]) if word not in GENERIC_NAME_WORDS]
    if len(distinctive) < 2 and (not distinctive or len(distinctive[0]) < 8):
        return False
    haystack = set(words(" ".join(str(candidate.get(key) or "") for key in ("title", "raw_location_text"))))
    if place.get("category") == "island" and not {"british", "columbia"}.issubset(haystack):
        return False
    return all(word in haystack for word in distinctive)


def bc_in_metadata(candidate: dict) -> bool:
    context = " ".join(str(candidate.get(key) or "") for key in ("title", "raw_location_text"))
    tokens = set(words(context))
    return {"british", "columbia"} <= tokens or bool(re.search(r"\bBC\b", context))


def license_status(candidate: dict) -> str:
    if str(candidate.get("source") or "").casefold() not in OPEN_SOURCES:
        return "platform_terms_review"
    license_name = str(candidate.get("license") or "").strip().lower().replace("_", "-")
    if any(term in license_name for term in ("-nc", "noncommercial", "-nd", "no derivatives", "no-derivatives")):
        return "incompatible"
    if re.fullmatch(r"cc by(?:-sa)?(?:[ -]\d(?:\.\d)?)?", license_name) or license_name in ("cc0", "cc0 1.0"):
        return "compatible_claim"
    if license_name.startswith("public domain") or license_name == "pdm":
        return "public_domain_review"
    return "unknown"


def enrich(place: dict, candidate: dict, boundary: dict | None) -> dict:
    row = {key: candidate.get(key) for key in (
        "source", "source_id", "title", "landing_url", "image_url", "thumbnail_url",
        "creator", "license", "license_url", "latitude", "longitude", "query", "raw_location_text",
    )}
    row["place_id"] = place["id"]
    row["place_name"] = place["name"]
    row["inside_boundary"] = point_in_geometry(row["longitude"], row["latitude"], boundary)
    row["name_in_metadata"] = name_in_metadata(place, row)
    row["bc_in_metadata"] = bc_in_metadata(row)
    row["license_status"] = license_status(row)
    row["location_status"] = "boundary" if row["inside_boundary"] else "named_bc" if row["name_in_metadata"] and row["bc_in_metadata"] else "name_only" if row["name_in_metadata"] else "unverified"
    row["review_status"] = "needs_human_review"
    return row


def usable_lead(candidate: dict) -> bool:
    return (
        photo_candidate(candidate)
        and candidate["license_status"] == "compatible_claim"
        and candidate["name_in_metadata"]
        and (candidate["inside_boundary"] or candidate["bc_in_metadata"])
        and bool(candidate.get("landing_url") and candidate.get("image_url") and candidate.get("license_url") and candidate.get("creator"))
        and str(candidate.get("source") or "").casefold() != "inaturalist"
    )


def photo_candidate(candidate: dict) -> bool:
    """Exclude known non-photo media, including files in older checkpoints."""
    excluded = re.compile(r"\.(?:webm|ogv|ogg|mp4|mov|avi|svg|pdf|gif)$", re.IGNORECASE)
    title = str(candidate.get("title") or "")
    image_path = urlparse(str(candidate.get("image_url") or "")).path
    return not (excluded.search(title) or excluded.search(image_path))


def key_for(row: dict) -> tuple[str, str]:
    return row["place_id"], row["source"]


def read_checkpoint(path: Path) -> dict[tuple[str, str], dict]:
    records = {}
    if path.exists():
        raw = path.read_bytes()
        if raw and not raw.endswith(b"\n"):
            path.write_bytes(raw[: raw.rfind(b"\n") + 1])
        for line in path.read_text(encoding="utf-8").splitlines():
            try:
                row = json.loads(line)
                records[key_for(row)] = row
            except (ValueError, KeyError):
                # A truncated last line after a crash can be safely retried.
                continue
    return records


def save_checkpoint(path: Path, row: dict) -> None:
    with path.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")
        stream.flush()
        os.fsync(stream.fileno())


def provider_call(source: str, client: PoliteClient, place: dict, limit: int, keys: dict[str, str]) -> list[dict]:
    if source == "commons":
        return search_commons(client, place, limit)
    if source == "openverse":
        return search_openverse(client, place, limit)
    if source == "inaturalist":
        return search_inaturalist(client, place, limit)
    if source == "flickr":
        return search_flickr(client, place, keys["flickr"], limit)
    if source == "pexels":
        return search_pexels(client, place, keys["pexels"], limit)
    if source == "unsplash":
        return search_unsplash(client, place, keys["unsplash"], limit)
    raise ValueError(f"Unknown source: {source}")


def write_reports(output: Path, records: dict, places: list[dict], existing: set[str], selected: list[str], skipped: dict) -> dict:
    candidates = []
    errors = {}
    completed = {}
    for (place_id, source), record in records.items():
        if source not in selected:
            continue
        if record.get("error"):
            errors[f"{place_id}:{source}"] = record["error"]
            continue
        completed[source] = completed.get(source, 0) + 1
        candidates.extend(candidate for candidate in record.get("candidates", []) if photo_candidate(candidate))
    candidates.sort(key=lambda row: (row["place_id"], row["source"], row.get("source_id") or ""))
    unique = {}
    for candidate in candidates:
        identity = (candidate["place_id"], (candidate.get("landing_url") or "").split("?", 1)[0].rstrip("/"))
        unique.setdefault(identity, candidate)
    deduped = list(unique.values())
    lead_places = {row["place_id"] for row in deduped if usable_lead(row)} - existing
    name_only_places = {row["place_id"] for row in deduped if row["license_status"] == "compatible_claim" and row["name_in_metadata"] and not row["bc_in_metadata"] and not row["inside_boundary"]} - existing
    boundary_only_places = {row["place_id"] for row in deduped if row["license_status"] == "compatible_claim" and row["inside_boundary"] and not row["name_in_metadata"] and str(row.get("source") or "").casefold() != "inaturalist"} - existing
    biodiversity_places = {row["place_id"] for row in deduped if row["license_status"] == "compatible_claim" and row["location_status"] == "boundary" and str(row.get("source") or "").casefold() == "inaturalist"} - existing
    location_only = {row["place_id"] for row in deduped if row["location_status"] != "unverified"} - existing
    any_hit = {row["place_id"] for row in deduped} - existing
    total = len(places)
    target = (total * 7 + 9) // 10
    summary = {
        "generated_at": utc_now(),
        "catalogue_places": total,
        "target_70_percent_places": target,
        "existing_verified_places": len(existing),
        "additional_human_verified_places": 0,
        "additional_compatible_named_place_leads": len(lead_places),
        "additional_unverified_name_only_leads": len(name_only_places),
        "additional_compatible_boundary_only_leads": len(boundary_only_places),
        "additional_on_site_biodiversity_leads": len(biodiversity_places),
        "potential_coverage_after_review": len(existing | lead_places),
        "additional_location_leads_any_license": len(location_only),
        "additional_places_with_any_search_hit": len(any_hit),
        "unresolved_without_compatible_named_place_lead": total - len(existing | lead_places),
        "source_completed_queries": completed,
        "source_skipped": skipped,
        "query_errors": errors,
        "candidate_rows": len(candidates),
        "deduplicated_candidate_rows": len(deduped),
        "method": "Candidates are unreviewed. Only existing manifest photos count as verified. Named-place leads exclude iNaturalist species observations; boundary-only photos are separate because they may depict plants or animals rather than the park landscape.",
    }
    summary_path = output / "summary.json"
    summary_path.write_text(json.dumps(summary, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    csv_path = output / "candidates.csv"
    fields = ["place_id", "place_name", "source", "source_id", "title", "landing_url", "thumbnail_url", "creator", "license", "license_url", "latitude", "longitude", "query", "raw_location_text", "inside_boundary", "name_in_metadata", "bc_in_metadata", "license_status", "location_status", "review_status"]
    with csv_path.open("w", encoding="utf-8-sig", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(deduped)
    return summary


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalogue-url", default=DEFAULT_CATALOGUE)
    parser.add_argument("--catalogue-file", help="Offline JSON list or API response fixture")
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--sources", default="commons,openverse,inaturalist")
    parser.add_argument("--limit-per-source", type=int, default=5)
    parser.add_argument("--max-places", type=int, default=0, help="Run only this many missing places (for smoke tests)")
    parser.add_argument("--place-id", action="append", help="Run a specific catalogue place; may be repeated")
    parser.add_argument("--include-existing", action="store_true")
    parser.add_argument("--flickr-commercial-api-approved", action="store_true", help="Required because Flickr commercial API use needs approval")
    parser.add_argument("--delay-seconds", type=float, default=1.1, help="Minimum interval between requests to one host")
    parser.add_argument("--workers", type=int, default=3, help="Concurrent sources on separate paced API hosts")
    args = parser.parse_args()
    args.sources = list(dict.fromkeys(part.strip() for part in args.sources.split(",") if part.strip()))
    if any(source not in SOURCES for source in args.sources):
        parser.error(f"sources must be from {', '.join(SOURCES)}")
    if args.limit_per_source < 1 or args.max_places < 0 or args.delay_seconds < 0.5 or not 1 <= args.workers <= 6:
        parser.error("limit must be positive, max-places nonnegative, delay at least 0.5 seconds, and workers 1 to 6")
    return args


def main() -> int:
    args = parse_args()
    client = PoliteClient(args.delay_seconds)
    places = load_catalogue(client, args.catalogue_url, args.catalogue_file)
    boundaries = load_boundaries()
    existing = existing_photo_ids()
    place_ids = {place["id"] for place in places}
    if not existing <= place_ids or not place_ids <= set(boundaries):
        raise ValueError("Image manifest or local boundary IDs do not match the staging catalogue")
    output = args.output_dir.resolve()
    output.mkdir(parents=True, exist_ok=True)
    catalogue_fingerprint = hashlib.sha256(json.dumps(places, sort_keys=True).encode("utf-8")).hexdigest()
    boundary_fingerprint = hashlib.sha256((ROOT / "data/boundaries.geojson").read_bytes()).hexdigest()
    run_config = {"catalogue_sha256": catalogue_fingerprint, "boundary_sha256": boundary_fingerprint, "audit_policy_version": AUDIT_POLICY_VERSION, "limit_per_source": args.limit_per_source}
    meta_path = output / "run.json"
    if meta_path.exists():
        previous = json.loads(meta_path.read_text(encoding="utf-8"))
        if any(previous.get(key) != value for key, value in run_config.items()):
            raise ValueError("Catalogue, boundaries, or search settings changed since this audit began; use a new output directory")
    else:
        meta_path.write_text(json.dumps({"catalogue_url": args.catalogue_url, **run_config, "started_at": utc_now(), "place_count": len(places)}, indent=2) + "\n", encoding="utf-8")
        (output / "catalogue.json").write_text(json.dumps(places, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    keys = {"flickr": os.getenv("FLICKR_API_KEY", ""), "pexels": os.getenv("PEXELS_API_KEY", ""), "unsplash": os.getenv("UNSPLASH_ACCESS_KEY", "")}
    skipped = {}
    enabled = []
    for source in args.sources:
        if source == "flickr" and not args.flickr_commercial_api_approved:
            skipped[source] = "Commercial Flickr API use requires a separately approved key; pass --flickr-commercial-api-approved only when approved."
        elif source in keys and not keys[source]:
            skipped[source] = f"Missing {source.upper()} API credential"
        else:
            enabled.append(source)
    skipped["pixabay"] = "Its API documentation disallows systematic mass requests; no bulk adapter is run."
    skipped["bc_government_gallery"] = "Government-hosted photos have no blanket open image license; inspect individual rights or obtain permission."
    if not enabled:
        raise ValueError("No requested sources can run")
    checkpoint = output / "queries.jsonl"
    records = read_checkpoint(checkpoint)
    selected = [place for place in places if args.include_existing or place["id"] not in existing]
    if args.place_id:
        requested = set(args.place_id)
        if not requested <= place_ids:
            raise ValueError(f"Unknown place IDs: {', '.join(sorted(requested - place_ids))}")
        selected = [place for place in selected if place["id"] in requested]
    if args.max_places:
        selected = selected[: args.max_places]
    print(f"Staging places: {len(places)} | existing verified photos: {len(existing)} | places in this pass: {len(selected)}", flush=True)
    print(f"Sources: {', '.join(enabled)} | output: {output}", flush=True)
    disabled_sources = set()
    with ThreadPoolExecutor(max_workers=min(args.workers, len(enabled))) as pool:
        for index, place in enumerate(selected, 1):
            futures = {}
            for source in enabled:
                if source in disabled_sources:
                    continue
                record_key = (place["id"], source)
                if record_key not in records or records[record_key].get("error"):
                    futures[source] = pool.submit(provider_call, source, client, place, args.limit_per_source, keys)
            for source, future in futures.items():
                try:
                    raw = future.result()
                    candidates = [enrich(place, candidate, boundaries[place["id"]]) for candidate in raw]
                    record = {"place_id": place["id"], "source": source, "queried_at": utc_now(), "candidates": candidates}
                except (requests.RequestException, ValueError, KeyError, TypeError) as error:
                    record = {"place_id": place["id"], "source": source, "queried_at": utc_now(), "error": f"{type(error).__name__}: {str(error)[:240]}"}
                    status = getattr(getattr(error, "response", None), "status_code", None)
                    if status in (401, 403, 429):
                        reason = f"HTTP {status}; stopped this source to avoid repeated rejected requests"
                        skipped[source] = reason
                        disabled_sources.add(source)
                        print(f"{source}: {reason}", file=sys.stderr, flush=True)
                records[(place["id"], source)] = record
                save_checkpoint(checkpoint, record)
            if len(disabled_sources) == len(enabled):
                write_reports(output, records, places, existing, enabled, skipped)
                return 2
            if index % 25 == 0 or index == len(selected):
                summary = write_reports(output, records, places, existing, enabled, skipped)
                print(f"{index}/{len(selected)} places | new named-place leads: {summary['additional_compatible_named_place_leads']} | errors: {len(summary['query_errors'])}", flush=True)
    write_reports(output, records, places, existing, enabled, skipped)
    return 2 if disabled_sources else 0


if __name__ == "__main__":
    sys.exit(main())

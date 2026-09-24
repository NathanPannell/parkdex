"""Search open image catalogs for license-eligible place photos.

These adapters return candidates for human review. A returned record is not a
claim that an image depicts the place accurately; callers should retain the
landing page and license information for review and attribution.
"""

from __future__ import annotations

import html
import re
import unicodedata
from typing import Any
from urllib.parse import quote


COMMONS_API = "https://commons.wikimedia.org/w/api.php"
OPENVERSE_API = "https://api.openverse.org/v1/images/"
OPENVERSE_ANONYMOUS_PAGE_SIZE = 20
_TIMEOUT = 20
_MAX_CANDIDATES = 50
_HTML_TAG = re.compile(r"<[^>]*>")


def _value(obj: Any, *names: str) -> Any:
    """Read a field from either a mapping or a simple model object."""
    if isinstance(obj, dict):
        for name in names:
            value = obj.get(name)
            if value is not None and value != "":
                return value
    else:
        for name in names:
            value = getattr(obj, name, None)
            if value is not None and value != "":
                return value
    return None


def _place_name(place: Any) -> str:
    name = _value(place, "name", "display_name", "place_name", "title")
    if name is None:
        raise ValueError("place must include a name, display_name, place_name, or title")
    return str(name).strip()


def _place_coordinates(place: Any) -> tuple[float | None, float | None]:
    latitude = _coordinate(_value(place, "latitude", "lat"), -90, 90)
    longitude = _coordinate(_value(place, "longitude", "lon", "lng", "long"), -180, 180)
    return latitude, longitude


def _number(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if -180 <= result <= 180 else None


def _coordinate(value: Any, minimum: float, maximum: float) -> float | None:
    result = _number(value)
    return result if result is not None and minimum <= result <= maximum else None


def _clean_text(value: Any, max_length: int = 1200) -> str | None:
    if value is None:
        return None
    if isinstance(value, dict):
        value = value.get("value", "")
    text = html.unescape(_HTML_TAG.sub("", str(value))).strip()
    return text[:max_length] or None


def _request_json(client: Any, url: str, params: dict[str, Any]) -> dict[str, Any]:
    response = client.get(url, params=params, timeout=_TIMEOUT)
    raise_for_status = getattr(response, "raise_for_status", None)
    if callable(raise_for_status):
        raise_for_status()
    payload = response.json()
    if not isinstance(payload, dict):
        raise ValueError("image API returned a non-object JSON response")
    return payload


def _license_from_commons(extmetadata: dict[str, Any]) -> tuple[str, str] | None:
    short_name = _clean_text(extmetadata.get("LicenseShortName"))
    license_url = _clean_text(extmetadata.get("LicenseUrl"), max_length=500)
    if not short_name or not license_url:
        return None

    normalized = re.sub(r"\s+", " ", short_name).strip()
    upper = normalized.upper()
    # Reject restrictive Creative Commons variants before matching their base.
    if re.search(r"\b(NC|ND)\b|NON.?COMMERCIAL|NO.?DERIVATIVES", upper):
        return None

    if re.search(r"\b(CC0|CC ZERO)\b", upper):
        license_name = normalized if upper.startswith("CC0") else "CC0 1.0"
    elif re.search(r"\bCC\s*BY\s*[- ]\s*SA\b", upper):
        license_name = re.sub(r"(?i)CC\s*BY\s*[- ]\s*SA", "CC BY-SA", normalized)
    elif re.search(r"\bCC\s*BY\b", upper):
        license_name = normalized
    elif "PUBLIC DOMAIN" in upper or re.match(r"^PD(?:\b|[-_])", upper):
        license_name = normalized
    else:
        return None
    return license_name, license_url


def _commons_location(page: dict[str, Any], extmetadata: dict[str, Any]) -> tuple[float | None, float | None, str | None]:
    coordinates = page.get("coordinates") or []
    if isinstance(coordinates, dict):
        coordinates = [coordinates]
    if coordinates and isinstance(coordinates[0], dict):
        coordinate = coordinates[0]
        latitude = _coordinate(coordinate.get("lat"), -90, 90)
        longitude = _coordinate(coordinate.get("lon"), -180, 180)
        if latitude is not None and longitude is not None:
            location_parts = [
                _clean_text(extmetadata.get("Location")),
                f"Commons coordinates: {latitude:.6f}, {longitude:.6f}",
            ]
            return latitude, longitude, "; ".join(part for part in location_parts if part)

    latitude = _coordinate(_clean_text(extmetadata.get("GPSLatitude")), -90, 90)
    longitude = _coordinate(_clean_text(extmetadata.get("GPSLongitude")), -180, 180)
    location_text = _clean_text(extmetadata.get("Location"))
    return latitude, longitude, location_text


def _commons_query(
    client: Any,
    place_name: str,
    *,
    latitude: float | None = None,
    longitude: float | None = None,
) -> tuple[dict[str, Any], str]:
    common_params: dict[str, Any] = {
        "action": "query",
        "format": "json",
        "formatversion": 2,
        "prop": "imageinfo|coordinates",
        "iiprop": "url|extmetadata",
        "iiurlwidth": 800,
        "colimit": 1,
    }
    if latitude is not None and longitude is not None:
        query = f"{place_name} (geotagged within 10 km)"
        params = {
            **common_params,
            "generator": "geosearch",
            "ggscoord": f"{latitude}|{longitude}",
            "ggsradius": 10000,
            "ggslimit": _MAX_CANDIDATES,
            "ggsnamespace": 6,
        }
    else:
        query = f'"{place_name}"'
        params = {
            **common_params,
            "generator": "search",
            "gsrsearch": query,
            "gsrnamespace": 6,
            "gsrlimit": _MAX_CANDIDATES,
        }
    return _request_json(client, COMMONS_API, params), query


def _commons_results(payload: dict[str, Any], query: str, limit: int) -> list[dict[str, Any]]:
    pages = (payload.get("query") or {}).get("pages") or []
    if isinstance(pages, dict):
        pages = list(pages.values())

    candidates: list[dict[str, Any]] = []
    seen: set[str] = set()
    for page in pages:
        if not isinstance(page, dict):
            continue
        title = _clean_text(_value(page, "title")) or ""
        if re.search(r"\.(?:webm|ogv|ogg|mp4|mov|avi|svg|pdf|gif)$", title, re.IGNORECASE):
            continue
        imageinfo = page.get("imageinfo") or []
        if not imageinfo or not isinstance(imageinfo[0], dict):
            continue
        info = imageinfo[0]
        extmetadata = info.get("extmetadata") or {}
        if not isinstance(extmetadata, dict):
            continue
        license_info = _license_from_commons(extmetadata)
        if license_info is None:
            continue

        source_id = str(page.get("pageid") or page.get("title") or "").strip()
        if not source_id or source_id in seen:
            continue
        seen.add(source_id)
        latitude, longitude, raw_location = _commons_location(page, extmetadata)
        description = _clean_text(extmetadata.get("ImageDescription"))
        if description:
            raw_location = "; ".join(part for part in (raw_location, description) if part)
        # Use the page's own URL as the canonical license-bearing landing page.
        landing_url = info.get("descriptionurl")
        if not landing_url and title:
            landing_url = "https://commons.wikimedia.org/wiki/" + quote(title.replace(" ", "_"), safe="/:()")
        candidates.append(
            {
                "source": "wikimedia_commons",
                "source_id": source_id,
                "title": title.removeprefix("File:"),
                "landing_url": landing_url,
                "image_url": info.get("url"),
                "thumbnail_url": info.get("thumburl") or info.get("url"),
                "creator": _clean_text(extmetadata.get("Artist"))
                or _clean_text(extmetadata.get("Credit")),
                "license": license_info[0],
                "license_url": license_info[1],
                "latitude": latitude,
                "longitude": longitude,
                "query": query,
                "raw_location_text": raw_location,
            }
        )
        if len(candidates) >= limit:
            break
    return candidates


def search_commons(client: Any, place: Any, limit: int = 5) -> list[dict[str, Any]]:
    """Search Wikimedia Commons by exact place name, then nearby coordinates.

    Nearby geosearch is used only when the exact-name search has no acceptable
    licensed results and the place provides latitude and longitude.
    """
    limit = _bounded_limit(limit)
    if not limit:
        return []
    name = _place_name(place)
    payload, query = _commons_query(client, name)
    candidates = _commons_results(payload, query, _MAX_CANDIDATES)
    named = [candidate for candidate in candidates if _looks_named(candidate, name)]
    if named:
        return named[:limit]

    latitude, longitude = _place_coordinates(place)
    if latitude is None or longitude is None:
        return candidates[:limit]
    payload, query = _commons_query(client, name, latitude=latitude, longitude=longitude)
    nearby = _commons_results(payload, query, _MAX_CANDIDATES)
    combined = {}
    for candidate in nearby + candidates:
        combined.setdefault(candidate["source_id"], candidate)
    return list(combined.values())[:limit]


def _looks_named(candidate: dict[str, Any], place_name: str) -> bool:
    def normalized_words(value: str) -> set[str]:
        ascii_text = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode("ascii").lower()
        return set(re.findall(r"[a-z0-9]+", ascii_text))

    distinctive = normalized_words(place_name) - {"park", "provincial", "regional", "national", "reserve", "site"}
    context = normalized_words(str(candidate.get("title") or "") + " " + str(candidate.get("raw_location_text") or ""))
    return bool(distinctive) and distinctive <= context


def _bounded_limit(limit: Any) -> int:
    try:
        return max(0, min(int(limit), _MAX_CANDIDATES))
    except (TypeError, ValueError):
        return 5


def _openverse_license(result: dict[str, Any]) -> tuple[str, str] | None:
    raw_license = str(result.get("license") or "").strip().lower()
    license_url = _clean_text(result.get("license_url"), max_length=500)
    if not license_url:
        return None

    # Openverse uses short codes (by, by-sa, cc0, pdm); tolerate common aliases.
    aliases = {
        "zero": "cc0",
        "cc-zero": "cc0",
        "cc0": "cc0",
        "public-domain": "pdm",
        "public_domain": "pdm",
        "by": "by",
        "cc-by": "by",
        "by-sa": "by-sa",
        "cc-by-sa": "by-sa",
        "pdm": "pdm",
    }
    canonical = aliases.get(raw_license)
    if canonical is None:
        return None

    version = str(result.get("license_version") or "").strip()
    if canonical == "cc0":
        label = f"CC0 {version}".strip()
    elif canonical == "by":
        label = f"CC BY {version}".strip()
    elif canonical == "by-sa":
        label = f"CC BY-SA {version}".strip()
    else:
        label = "Public domain (PDM)"
    return label, license_url


def search_openverse(client: Any, place: Any, limit: int = 5) -> list[dict[str, Any]]:
    """Search Openverse for place-name matches with approved license codes."""
    limit = _bounded_limit(limit)
    if not limit:
        return []
    name = _place_name(place)
    candidates: list[dict[str, Any]] = []
    seen: set[str] = set()

    def search(query: str, page: int = 1) -> None:
        payload = _request_json(client, OPENVERSE_API, {
            "q": query,
            "page_size": OPENVERSE_ANONYMOUS_PAGE_SIZE,
            "page": page,
            "license": "cc0,by,by-sa,pdm",
        })
        for result in payload.get("results") or []:
            if not isinstance(result, dict):
                continue
            license_info = _openverse_license(result)
            if license_info is None:
                continue
            source_id = str(result.get("id") or result.get("foreign_landing_url") or "").strip()
            if not source_id or source_id in seen:
                continue
            seen.add(source_id)
            result_latitude = _coordinate(result.get("latitude"), -90, 90)
            result_longitude = _coordinate(result.get("longitude"), -180, 180)
            location_text = _clean_text(result.get("location") or result.get("raw_location_text") or result.get("description"))
            candidates.append({
                "source": "openverse",
                "source_id": source_id,
                "title": _clean_text(result.get("title")) or "",
                "landing_url": result.get("foreign_landing_url") or result.get("detail_url"),
                "image_url": result.get("url"),
                "thumbnail_url": result.get("thumbnail") or result.get("url"),
                "creator": _clean_text(result.get("creator")),
                "license": license_info[0],
                "license_url": license_info[1],
                "latitude": result_latitude,
                "longitude": result_longitude,
                "query": query,
                "raw_location_text": location_text,
            })

    search(name)
    if not any(_looks_named(candidate, name) for candidate in candidates):
        search(f"{name} British Columbia")
    if not any(_looks_named(candidate, name) for candidate in candidates):
        search(name, page=2)
    candidates.sort(key=lambda candidate: not _looks_named(candidate, name))
    return candidates[:limit]

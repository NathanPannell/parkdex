"""Candidate-only adapters for stock photo APIs.

These sources use their own platform licenses and API terms. Results from this
module must never be counted as Creative Commons-cleared assets. The caller
must review the landing page and retain the returned attribution/license data.

Unsplash API results must be displayed using their returned API image URLs;
this module intentionally does not download or mirror any image bytes.

Pixabay is intentionally omitted from a systematic 1,030-place sweep: its API
documentation says it is intended for human requests, discourages lots of
automated queries, and prohibits systematic mass downloads.
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit


PEXELS_SEARCH_URL = "https://api.pexels.com/v1/search"
PEXELS_LICENSE_URL = "https://www.pexels.com/license/"
UNSPLASH_SEARCH_URL = "https://api.unsplash.com/search/photos"
UNSPLASH_LICENSE_URL = "https://unsplash.com/license"
_TIMEOUT_SECONDS = 20


def _field(value: Any, *names: str) -> Any:
    """Read the first present field from either a mapping or an object."""
    for name in names:
        if isinstance(value, Mapping):
            if name in value:
                return value[name]
        elif hasattr(value, name):
            return getattr(value, name)
    return None


def _text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _number(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return number if math.isfinite(number) else None


def _limit(value: Any, maximum: int) -> int:
    try:
        requested = int(value)
    except (TypeError, ValueError, OverflowError):
        return 5
    return min(max(requested, 0), maximum)


def _place_query(place: Any) -> tuple[str | None, str | None]:
    name = _text(_field(place, "name", "display_name", "place_name", "title"))
    if not name:
        return None, None

    region = _text(_field(place, "region", "province", "state"))
    parts = [name]
    if region and region.casefold() not in name.casefold():
        parts.append(region)
    if "british columbia" not in " ".join(parts).casefold():
        parts.append("British Columbia")
    return " ".join(parts), name


def _record(
    *,
    source: str,
    source_id: Any,
    title: Any,
    landing_url: Any,
    image_url: Any,
    thumbnail_url: Any,
    creator: Any,
    license_name: str,
    license_url: str,
    latitude: Any,
    longitude: Any,
    query: str,
    raw_location_text: Any,
) -> dict[str, Any]:
    """Return a JSON-safe record with a stable, shared shape."""
    return {
        "source": source,
        "source_id": _text(source_id),
        "title": _text(title),
        "landing_url": _text(landing_url),
        "image_url": _text(image_url),
        "thumbnail_url": _text(thumbnail_url),
        "creator": _text(creator),
        "license": license_name,
        "license_url": license_url,
        "latitude": _number(latitude),
        "longitude": _number(longitude),
        "query": query,
        "raw_location_text": _text(raw_location_text),
    }


def _get_json(client: Any, url: str, *, params: dict[str, Any], headers: dict[str, str]) -> dict[str, Any]:
    """Use a requests/httpx-style client and preserve HTTP/API errors for caller reporting."""
    response = client.get(url, params=params, headers=headers, timeout=_TIMEOUT_SECONDS)
    raise_for_status = getattr(response, "raise_for_status", None)
    if callable(raise_for_status):
        raise_for_status()
    payload = response.json()
    return payload if isinstance(payload, dict) else {}


def _unsplash_referral_url(value: Any) -> str | None:
    """Add the referral parameters required for links back to Unsplash."""
    url = _text(value)
    if not url:
        return None
    parts = urlsplit(url)
    query = dict(parse_qsl(parts.query, keep_blank_values=True))
    query["utm_source"] = "parkdex"
    query["utm_medium"] = "referral"
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment))


def search_pexels(
    client: Any,
    place: Any,
    api_key: str | None,
    limit: int = 5,
) -> list[dict[str, Any]]:
    """Search Pexels once for a place and return platform-license candidate leads.

    Pexels requires an API key in the ``Authorization`` header. The API has no
    per-photo location coordinates, so ``latitude``, ``longitude``, and
    ``raw_location_text`` are ``None`` and the user must verify the photograph.
    """
    query, place_name = _place_query(place)
    result_limit = _limit(limit, 80)
    if not query or not _text(api_key) or result_limit == 0:
        return []

    payload = _get_json(
        client,
        PEXELS_SEARCH_URL,
        params={"query": query, "per_page": result_limit},
        headers={"Authorization": str(api_key).strip()},
    )
    photos = payload.get("photos")
    if not isinstance(photos, list):
        return []

    candidates: list[dict[str, Any]] = []
    for photo in photos:
        if not isinstance(photo, Mapping):
            continue
        src = photo.get("src")
        if not isinstance(src, Mapping):
            src = {}
        photographer = _text(photo.get("photographer"))
        photo_id = photo.get("id")
        candidates.append(
            _record(
                source="pexels",
                source_id=photo_id,
                title=photo.get("alt") or (f"Pexels photo {photo_id}" if photo_id is not None else place_name),
                landing_url=photo.get("url"),
                image_url=src.get("large") or src.get("large2x") or src.get("medium") or src.get("original"),
                thumbnail_url=src.get("medium") or src.get("small") or src.get("tiny"),
                creator=photographer,
                license_name="Pexels License",
                license_url=PEXELS_LICENSE_URL,
                latitude=None,
                longitude=None,
                query=query,
                raw_location_text=None,
            )
        )
    return candidates[:result_limit]


def search_unsplash(
    client: Any,
    place: Any,
    api_key: str | None,
    limit: int = 5,
) -> list[dict[str, Any]]:
    """Search Unsplash once for a place and return platform-license candidate leads.

    The API requires a developer access key. Returned image URLs are passed
    through unchanged; the API guidelines require applications to hotlink
    these URLs and to attribute Unsplash and the photographer on display.
    """
    query, place_name = _place_query(place)
    result_limit = _limit(limit, 30)
    if not query or not _text(api_key) or result_limit == 0:
        return []

    payload = _get_json(
        client,
        UNSPLASH_SEARCH_URL,
        params={"query": query, "per_page": result_limit},
        headers={"Authorization": f"Client-ID {str(api_key).strip()}"},
    )
    results = payload.get("results")
    if not isinstance(results, list):
        return []

    candidates: list[dict[str, Any]] = []
    for photo in results:
        if not isinstance(photo, Mapping):
            continue
        urls = photo.get("urls")
        if not isinstance(urls, Mapping):
            urls = {}
        links = photo.get("links")
        if not isinstance(links, Mapping):
            links = {}
        user = photo.get("user")
        if not isinstance(user, Mapping):
            user = {}
        location = photo.get("location")
        if not isinstance(location, Mapping):
            location = {}
        position = location.get("position")
        if not isinstance(position, Mapping):
            position = {}

        location_parts = [
            _text(location.get(field))
            for field in ("name", "city", "country")
        ]
        location_text = ", ".join(part for part in location_parts if part)
        photo_id = photo.get("id")
        candidates.append(
            _record(
                source="unsplash",
                source_id=photo_id,
                title=photo.get("alt_description") or photo.get("description") or (
                    f"Unsplash photo {photo_id}" if photo_id is not None else place_name
                ),
                landing_url=_unsplash_referral_url(links.get("html")),
                image_url=urls.get("regular") or urls.get("full") or urls.get("small"),
                thumbnail_url=urls.get("small") or urls.get("thumb") or urls.get("regular"),
                creator=user.get("name") or user.get("username"),
                license_name="Unsplash License",
                license_url=UNSPLASH_LICENSE_URL,
                latitude=position.get("latitude"),
                longitude=position.get("longitude"),
                query=query,
                raw_location_text=location_text or None,
            )
        )
    return candidates[:result_limit]

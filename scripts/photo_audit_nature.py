"""Search iNaturalist and Flickr for location-specific, reusable photo candidates.

These adapters only discover candidate URLs and metadata. They do not download,
cache, or host Flickr images. Callers should review the linked source page and
license before selecting a candidate for the catalogue.
"""

from __future__ import annotations

import math
import re
from collections.abc import Mapping
from typing import Any
from urllib.parse import quote


INATURALIST_OBSERVATIONS_URL = "https://api.inaturalist.org/v1/observations"
INATURALIST_PLACES_URL = "https://api.inaturalist.org/v1/places/autocomplete"
FLICKR_REST_URL = "https://api.flickr.com/services/rest/"

INATURALIST_LICENSES: dict[str, tuple[str, str | None]] = {
    "cc0": ("CC0 1.0", "https://creativecommons.org/publicdomain/zero/1.0/"),
    "cc-by": ("CC BY", None),
    "cc-by-sa": ("CC BY-SA", None),
}

# Flickr photo license IDs from Flickr's license table. The API search is
# restricted to these IDs so NC and ND material is never returned as reusable.
FLICKR_LICENSES: dict[str, tuple[str, str]] = {
    "4": ("CC BY 2.0", "https://creativecommons.org/licenses/by/2.0/"),
    "5": ("CC BY-SA 2.0", "https://creativecommons.org/licenses/by-sa/2.0/"),
    "9": ("CC0 1.0", "https://creativecommons.org/publicdomain/zero/1.0/"),
    "11": ("CC BY 4.0", "https://creativecommons.org/licenses/by/4.0/"),
    "12": ("CC BY-SA 4.0", "https://creativecommons.org/licenses/by-sa/4.0/"),
}

_EARTH_RADIUS_KM = 6371.0088
_INAT_IMAGE_SIZE_RE = re.compile(r"/(?:square|small|thumb|medium|large|original)(?=\.)")


def _value(place: Any, key: str, default: Any = None) -> Any:
    if isinstance(place, Mapping):
        return place.get(key, default)
    return getattr(place, key, default)


def _place_details(place: Any) -> tuple[str, float | None, float | None]:
    name = str(_value(place, "name", "") or "").strip()
    latitude = _as_float(_value(place, "latitude"))
    longitude = _as_float(_value(place, "longitude"))
    return name, latitude, longitude


def _as_float(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def _positive_limit(limit: int) -> int:
    try:
        return max(0, int(limit))
    except (TypeError, ValueError):
        return 0


def _search_radius(place: Any, default: float, maximum: float) -> float:
    requested = _as_float(
        _value(place, "photo_search_radius_km", _value(place, "search_radius_km"))
    )
    if requested is None or requested <= 0:
        return default
    return min(requested, maximum)


def _distance_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Return distance between two coordinates using the haversine formula."""
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    d_phi = math.radians(lat2 - lat1)
    d_lambda = math.radians(lon2 - lon1)
    a = (
        math.sin(d_phi / 2) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(d_lambda / 2) ** 2
    )
    return 2 * _EARTH_RADIUS_KM * math.asin(min(1.0, math.sqrt(a)))


def _coordinates_within_radius(
    latitude: float | None,
    longitude: float | None,
    place_latitude: float | None,
    place_longitude: float | None,
    radius_km: float,
) -> bool:
    if None in (latitude, longitude, place_latitude, place_longitude):
        return False
    assert latitude is not None and longitude is not None
    assert place_latitude is not None and place_longitude is not None
    return _distance_km(latitude, longitude, place_latitude, place_longitude) <= radius_km


def _inat_license(photo: Mapping[str, Any]) -> tuple[str, str | None] | None:
    code = str(photo.get("license_code") or "").strip().lower()
    return INATURALIST_LICENSES.get(code)


def _normalize_place_name(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", name.casefold()).strip()


def _resolve_inaturalist_place_id(client: Any, place: Any, name: str) -> int | None:
    supplied_id = _value(place, "inat_place_id")
    if supplied_id is not None:
        try:
            return int(supplied_id)
        except (TypeError, ValueError):
            return None

    response = client.get(
        INATURALIST_PLACES_URL,
        params={"q": name, "per_page": 20},
        timeout=30,
    )
    response.raise_for_status()
    payload = response.json()
    normalized_name = _normalize_place_name(name)
    exact_matches = [
        result
        for result in payload.get("results", [])
        if isinstance(result, Mapping)
        and _normalize_place_name(str(result.get("name") or "")) == normalized_name
        and result.get("id") is not None
    ]
    if not exact_matches:
        return None
    exact_matches.sort(key=lambda result: _as_float(result.get("bbox_area")) or math.inf)
    try:
        return int(exact_matches[0]["id"])
    except (TypeError, ValueError):
        return None


def _inat_image_url(url: str, size: str) -> str:
    """Change an iNaturalist size segment when the API supplied one."""
    return _INAT_IMAGE_SIZE_RE.sub(f"/{size}", url, count=1)


def _inat_creator(photo: Mapping[str, Any], observation: Mapping[str, Any]) -> str | None:
    attribution = photo.get("attribution")
    if (
        isinstance(attribution, str)
        and attribution.strip()
        and "no rights reserved" not in attribution.casefold()
    ):
        return attribution.strip()

    photo_user = photo.get("user")
    if isinstance(photo_user, Mapping):
        creator = photo_user.get("name") or photo_user.get("login")
        if creator:
            return str(creator)

    observer = observation.get("user")
    if isinstance(observer, Mapping):
        creator = observer.get("name") or observer.get("login")
        if creator:
            return str(creator)
    return None


def search_inaturalist(client: Any, place: Any, limit: int = 5) -> list[dict[str, Any]]:
    """Find openly licensed iNaturalist photos near a Parkdex place.

    The query uses the place name plus its representative coordinates. Results
    must include observation coordinates within the search radius. Each photo's
    own license is checked independently; observation-level licensing is not
    used as a substitute for the photo license.
    """
    count = _positive_limit(limit)
    name, place_latitude, place_longitude = _place_details(place)
    if count == 0 or not name or place_latitude is None or place_longitude is None:
        return []

    inat_place_id = _resolve_inaturalist_place_id(client, place, name)
    radius_km = _search_radius(place, default=5.0, maximum=500.0)
    if inat_place_id is not None:
        query = f'iNaturalist place_id={inat_place_id} ({name})'
    else:
        query = f'near {name} representative point {place_latitude},{place_longitude} within {radius_km:g} km'
    params: dict[str, Any] = {
        "order_by": "date_added",
        "order": "desc",
        "photos": "true",
        "photo_license": "cc0,cc-by,cc-by-sa",
        "per_page": min(max(count * 8, 40), 200),
    }
    if inat_place_id is not None:
        params["place_id"] = inat_place_id
    else:
        params.update(
            {
                "lat": place_latitude,
                "lng": place_longitude,
                "radius": radius_km,
            }
        )
    response = client.get(
        INATURALIST_OBSERVATIONS_URL,
        params=params,
        timeout=30,
    )
    response.raise_for_status()
    payload = response.json()

    candidates: list[dict[str, Any]] = []
    for observation in payload.get("results", []):
        if not isinstance(observation, Mapping):
            continue
        if observation.get("obscured") is True:
            continue
        location = observation.get("location")
        if not isinstance(location, str) or "," not in location:
            continue
        try:
            obs_latitude_text, obs_longitude_text = location.split(",", 1)
        except ValueError:
            continue
        obs_latitude = _as_float(obs_latitude_text.strip())
        obs_longitude = _as_float(obs_longitude_text.strip())
        if inat_place_id is None and not _coordinates_within_radius(
            obs_latitude, obs_longitude, place_latitude, place_longitude, radius_km
        ):
            continue

        photos = observation.get("photos") or []
        if not isinstance(photos, list):
            continue
        taxon = observation.get("taxon")
        taxon_name = taxon.get("name") if isinstance(taxon, Mapping) else None
        species = observation.get("species_guess") or taxon_name
        observation_id = observation.get("id")
        observation_url = observation.get("uri")
        if not observation_url and observation_id is not None:
            observation_url = f"https://www.inaturalist.org/observations/{observation_id}"
        elif isinstance(observation_url, str) and observation_url.startswith("http://"):
            observation_url = "https://" + observation_url[len("http://") :]
        place_guess = observation.get("place_guess")

        for photo in photos:
            if not isinstance(photo, Mapping):
                continue
            license_info = _inat_license(photo)
            photo_url = photo.get("url")
            photo_id = photo.get("id")
            if license_info is None or not isinstance(photo_url, str) or not photo_url:
                continue
            if photo_id is None:
                continue
            license_name, license_url = license_info
            title = str(species or observation.get("description") or f"iNaturalist observation {observation_id}")
            candidates.append(
                {
                    "source": "inaturalist",
                    "source_id": str(photo_id),
                    "title": title,
                    "landing_url": str(observation_url),
                    "image_url": _inat_image_url(photo_url, "medium"),
                    "thumbnail_url": _inat_image_url(photo_url, "square"),
                    "creator": _inat_creator(photo, observation),
                    "license": license_name,
                    # Observation JSON exposes a license family, not its version.
                    # The per-photo page is the evidence to review for BY/BY-SA.
                    "license_url": license_url or f"https://www.inaturalist.org/photos/{photo_id}",
                    "latitude": obs_latitude,
                    "longitude": obs_longitude,
                    "query": query,
                    "raw_location_text": str(place_guess) if place_guess else None,
                }
            )
            if len(candidates) >= count:
                return candidates

    return candidates


def _flickr_description(photo: Mapping[str, Any]) -> str | None:
    description = photo.get("description")
    if isinstance(description, Mapping):
        description = description.get("_content")
    if isinstance(description, str) and description.strip():
        return description.strip()
    return None


def search_flickr(
    client: Any,
    place: Any,
    api_key: str | None,
    limit: int = 5,
) -> list[dict[str, Any]]:
    """Find CC BY, CC BY-SA, or CC0 Flickr photo candidates near a place.

    Flickr API terms and commercial-key requirements may limit downstream use.
    This function only returns candidate metadata and URLs. It never downloads
    or stores a Flickr image; callers should review Flickr's current API terms.
    """
    count = _positive_limit(limit)
    name, place_latitude, place_longitude = _place_details(place)
    if (
        count == 0
        or not name
        or not api_key
        or place_latitude is None
        or place_longitude is None
    ):
        return []

    radius_km = _search_radius(place, default=25.0, maximum=32.0)
    query = f'q="{name}" near {place_latitude},{place_longitude} within {radius_km:g} km'
    params: dict[str, Any] = {
        "method": "flickr.photos.search",
        "api_key": api_key,
        "text": name,
        "license": ",".join(FLICKR_LICENSES),
        "has_geo": 1,
        "radius": radius_km,
        "radius_units": "km",
        "extras": "owner_name,license,geo,description,url_q,url_m,url_c,url_l",
        "per_page": min(max(count * 4, 20), 100),
        "page": 1,
        "format": "json",
        "nojsoncallback": 1,
    }
    params["lat"] = place_latitude
    params["lon"] = place_longitude

    response = client.get(FLICKR_REST_URL, params=params, timeout=30)
    response.raise_for_status()
    payload = response.json()
    if payload.get("stat") != "ok":
        error = payload.get("message") or payload.get("code") or "unknown Flickr API error"
        raise ValueError(f"Flickr API request failed: {error}")

    photos = payload.get("photos", {}).get("photo", [])
    candidates: list[dict[str, Any]] = []
    for photo in photos:
        if not isinstance(photo, Mapping):
            continue
        license_info = FLICKR_LICENSES.get(str(photo.get("license", "")))
        photo_id = photo.get("id")
        owner_id = photo.get("owner")
        if license_info is None or photo_id is None or not owner_id:
            continue

        latitude = _as_float(photo.get("latitude"))
        longitude = _as_float(photo.get("longitude"))
        if not _coordinates_within_radius(
            latitude,
            longitude,
            place_latitude,
            place_longitude,
            radius_km,
        ):
            continue
        if latitude is None or longitude is None:
            continue

        image_url = next(
            (photo.get(key) for key in ("url_l", "url_c", "url_m") if photo.get(key)),
            None,
        )
        thumbnail_url = next(
            (photo.get(key) for key in ("url_q", "url_m") if photo.get(key)),
            None,
        )
        if not image_url:
            continue

        license_name, license_url = license_info
        owner_name = photo.get("ownername") or owner_id
        landing_url = f"https://www.flickr.com/photos/{quote(str(owner_id), safe='')}/{quote(str(photo_id), safe='')}/"
        candidates.append(
            {
                "source": "flickr",
                "source_id": str(photo_id),
                "title": str(photo.get("title") or ""),
                "landing_url": landing_url,
                "image_url": str(image_url),
                "thumbnail_url": str(thumbnail_url or image_url),
                "creator": str(owner_name) if owner_name else None,
                "license": license_name,
                "license_url": license_url,
                "latitude": latitude,
                "longitude": longitude,
                "query": query,
                "raw_location_text": _flickr_description(photo),
            }
        )
        if len(candidates) >= count:
            break

    return candidates

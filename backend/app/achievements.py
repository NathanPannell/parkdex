"""Server-side achievement rules mirrored from the web application's catalog."""

from __future__ import annotations

from datetime import datetime


_DEFINITIONS = (
    ("banana-slug-medal", "Banana Slug Rainwalk", "banana-slug", "Visit Juan de Fuca, Carmanah Walbran and Macmillan parks.", ("provincial-juan-de-fuca-park", "provincial-carmanah-walbran-park", "provincial-macmillan-park"), 3, "places"),
    ("black-bear-coast", "Black Bear Coast", "black-bear", "Visit Pacific Rim, Cape Scott and Strathcona parks.", ("national-pacific-rim-national-park-reserve", "provincial-cape-scott-park", "provincial-strathcona-park"), 3, "places"),
    ("sea-otter-raft", "Sea Otter Raft", "sea-otter", "Visit Nootka, Flores and Vargas islands along the outer coast.", ("island-nootka-island", "island-flores-island", "island-vargas-island"), 3, "places"),
    ("orca-salish-lookouts", "Orca Lookout Loop", "orca", "Visit Gulf Islands National Park Reserve, East Point and Brooks Point.", ("national-gulf-islands-national-park-reserve", "regional-east-point-regional-park", "regional-brooks-point-regional-park"), 3, "places"),
    ("river-otter-rookie", "River Otter Rookie", "river-otter", "Collect your first place.", (), 1, "places"),
    ("harbour-seal-five", "Harbour Seal High Five", "harbour-seal", "Visit 5 places.", (), 5, "places"),
    ("eagle-ten", "Bald Eagle Ten", "bald-eagle", "Visit 10 places.", (), 10, "places"),
    ("heron-twenty-five", "Heron’s Long Stride", "great-blue-heron", "Visit 25 places.", (), 25, "places"),
    ("kingfisher-fifty", "Kingfisher Fifty", "belted-kingfisher", "Visit 50 places.", (), 50, "places"),
    ("hummingbird-century", "Hummingbird Century", "rufous-hummingbird", "Visit 100 places.", (), 100, "places"),
    ("steller-high-country", "Steller’s Jay High Country", "stellers-jay", "Visit Strathcona, Schoen Lake and Mount Arrowsmith Massif parks.", ("provincial-strathcona-park", "provincial-schoen-lake-park", "regional-mount-arrowsmith-massif-regional-park"), 3, "places"),
    ("deer-south-island", "Black-tailed Deer Ramble", "black-tailed-deer", "Visit East Sooke, Gowlland Tod and Goldstream parks.", ("regional-east-sooke-regional-park", "provincial-gowlland-tod-park", "provincial-goldstream-park"), 3, "places"),
    ("treefrog-pond-hop", "Treefrog Pond Hop", "pacific-treefrog", "Visit Elk/Beaver Lake, Matheson Lake and Thetis Lake regional parks.", ("regional-elk-beaver-lake-regional-park", "regional-matheson-lake-regional-park", "regional-thetis-lake-regional-park"), 3, "places"),
    ("red-legged-wetlands", "Red-legged Wetland Hop", "red-legged-frog", "Visit Kennedy River Bog, Coats Marsh and Hamilton Marsh.", ("provincial-kennedy-river-bog-park", "regional-coats-marsh-regional-park", "regional-hamilton-marsh-regional-park-and-conservation-area"), 3, "places"),
    ("douglas-fir-central", "Douglas-fir Heartwood", "douglas-fir", "Visit 8 places in Central Island.", (), 8, "region:central"),
    ("redcedar-rainline", "Western Redcedar Rainline", "western-redcedar", "Visit Pacific Rim, Carmanah Walbran and Juan de Fuca parks.", ("national-pacific-rim-national-park-reserve", "provincial-carmanah-walbran-park", "provincial-juan-de-fuca-park"), 3, "places"),
    ("arbutus-rainshadow", "Arbutus Rainshadow", "arbutus", "Visit Bodega Ridge, Helliwell and Mount Maxwell parks.", ("provincial-bodega-ridge-park", "provincial-helliwell-park", "provincial-mount-maxwell-park"), 3, "places"),
    ("salal-north", "Salal Northbound", "salal", "Visit 5 places in a northern region.", (), 5, "region:northern"),
    ("sword-fern-falls", "Sword Fern Falls", "sword-fern", "Visit Elk Falls, Englishman River Falls and Little Qualicum Falls.", ("provincial-elk-falls-park", "provincial-englishman-river-falls-park", "provincial-little-qualicum-falls-park"), 3, "places"),
    ("camas-rainshadow", "Camas Rainshadow", "camas", "Visit Gulf Islands National Park Reserve, Ruckle and Mount Maxwell parks.", ("national-gulf-islands-national-park-reserve", "provincial-ruckle-park", "provincial-mount-maxwell-park"), 3, "places"),
    ("heron-tideline", "Heron Tideline", "great-blue-heron", "Visit Island View Beach, Witty’s Lagoon and Little Qualicum River Estuary.", ("regional-island-view-beach-regional-park", "regional-witty-s-lagoon-regional-park", "regional-little-qualicum-river-estuary"), 3, "places"),
    ("harbour-seal-shores", "Harbour Seal Shoreline", "harbour-seal", "Visit Rathtrevor Beach, Miracle Beach and French Beach parks.", ("provincial-rathtrevor-beach-park", "provincial-miracle-beach-park", "provincial-french-beach-park"), 3, "places"),
)


def _count(
    definition: tuple,
    *,
    active_ids: set[str],
    visited_ids: set[str],
    regions: dict[str, str],
) -> int:
    _, _, _, _, required_ids, _, kind = definition
    if kind == "places":
        if required_ids:
            return sum(
                1 for place_id in required_ids
                if place_id in active_ids and place_id in visited_ids
            )
        return len(active_ids & visited_ids)
    region_name = kind.removeprefix("region:")
    return sum(
        1 for place_id in active_ids & visited_ids
        if region_name in regions.get(place_id, "").casefold()
    )


def achievements(
    *,
    places: list[dict],
    visits: list[dict],
) -> list[dict]:
    """Calculate badge progress and earning timestamp from visible catalogue rows."""

    active_ids = {place["id"] for place in places}
    regions = {place["id"]: place["region"] for place in places}
    names = {place["id"]: place["name"] for place in places}
    visit_by_id = {
        visit["place_id"]: visit["visited_at"]
        for visit in visits
        if visit["place_id"] in active_ids
    }
    visited_ids = set(visit_by_id)
    chronology = sorted(
        visit_by_id.items(),
        key=lambda item: (item[1], item[0]),
    )
    results: list[dict] = []
    for definition in _DEFINITIONS:
        badge_id, name, species, description, required_ids, target, _ = definition
        current = min(
            _count(
                definition,
                active_ids=active_ids,
                visited_ids=visited_ids,
                regions=regions,
            ),
            target,
        )
        earned_at: datetime | None = None
        if current >= target:
            seen: set[str] = set()
            for place_id, timestamp in chronology:
                seen.add(place_id)
                if _count(
                    definition,
                    active_ids=active_ids,
                    visited_ids=seen,
                    regions=regions,
                ) >= target:
                    earned_at = timestamp
                    break
        result = {
            "id": badge_id,
            "name": name,
            "species": species,
            "description": description,
            "current": current,
            "target": target,
            "earned": current >= target,
        }
        if required_ids:
            result["required_place_ids"] = list(required_ids)
            result["required_places"] = [
                {"id": place_id, "name": names[place_id]}
                for place_id in required_ids
                if place_id in names
            ]
        if earned_at is not None:
            result["earned_at"] = earned_at
        results.append(result)
    return results

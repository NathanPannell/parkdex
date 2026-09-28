"""Canonical place category values shared across backend contracts."""

from collections.abc import Iterable, Mapping
from typing import Literal, get_args


PlaceCategory = Literal[
    "national",
    "provincial",
    "regional",
    "island",
    "municipal",
    "community",
]
PLACE_CATEGORIES: tuple[str, ...] = get_args(PlaceCategory)
ALLOWED_CATEGORIES = frozenset(PLACE_CATEGORIES)
OPTIONAL_VISITOR_DETAIL_CATEGORIES = frozenset({"municipal", "community"})


def visitor_detail_coverage_issues(
    canonical_categories: Mapping[str, str], reviewed_ids: Iterable[str]
) -> dict[str, list[str]]:
    """Return category and ID coverage issues for the accepted rich-details snapshot.

    Municipal and community catalogue rows may intentionally have no rich visitor
    details. Every other supported category remains required, and reviewed IDs must
    still refer to a canonical place.
    """
    canonical_ids = set(canonical_categories)
    reviewed = set(reviewed_ids)
    return {
        "unsupported_categories": sorted(
            f"{place_id}:{category}"
            for place_id, category in canonical_categories.items()
            if category not in ALLOWED_CATEGORIES
        ),
        "missing_required": sorted(
            place_id
            for place_id, category in canonical_categories.items()
            if category not in OPTIONAL_VISITOR_DETAIL_CATEGORIES
            and place_id not in reviewed
        ),
        "unknown_reviewed": sorted(reviewed - canonical_ids),
    }

"""Canonical place category values shared across backend contracts."""

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

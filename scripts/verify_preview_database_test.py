import json

import pytest

from scripts.verify_preview_database import CATALOGUE, expected_place_ids, validate_target


def test_preview_target_requires_exact_owned_database_and_host() -> None:
    validate_target(
        "postgresql://app_owner:example@ep-preview.neon.tech/app_preview_1234abcd",
        "app_preview_1234abcd",
        "ep-preview.neon.tech",
    )


@pytest.mark.parametrize(
    ("url", "database", "host"),
    [
        ("postgresql://app_owner:example@ep-main.neon.tech/app", "app", "ep-main.neon.tech"),
        ("postgresql://app_owner:example@ep-main.neon.tech/app_preview_1234abcd", "app_preview_1234abcd", "ep-preview.neon.tech"),
        ("postgresql://other:example@ep-preview.neon.tech/app_preview_1234abcd", "app_preview_1234abcd", "ep-preview.neon.tech"),
        ("postgresql://app_owner:example@ep-preview-pooler.neon.tech/app_preview_1234abcd", "app_preview_1234abcd", "ep-preview-pooler.neon.tech"),
    ],
)
def test_preview_target_rejects_parent_or_mismatched_identity(url: str, database: str, host: str) -> None:
    with pytest.raises(RuntimeError):
        validate_target(url, database, host)


def test_historical_place_ids_are_derived_from_exact_seed_migrations() -> None:
    current_ids = {place["id"] for place in json.loads(CATALOGUE.read_text(encoding="utf-8"))}
    migration_ids = set(expected_place_ids())
    assert current_ids < migration_ids

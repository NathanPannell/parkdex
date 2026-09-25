import json
from copy import deepcopy

import pytest

from scripts.verify_preview_database import (
    CATALOGUE,
    expected_place_ids,
    expected_visitor_detail_rows,
    validate_target,
    verify_user_data_empty,
    verify_visitor_details,
)


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


class FakeRows:
    def __init__(self, rows):
        self.rows = rows

    def fetchall(self):
        return self.rows

    def fetchone(self):
        return self.rows[0]


class FakeVisitorDetailsConnection:
    def __init__(self, rows):
        self.rows = rows

    def execute(self, query):
        assert "FROM place_visitor_details" in query
        return FakeRows(self.rows)


def test_checked_in_visitor_metadata_is_accepted_as_the_exact_seed() -> None:
    expected = expected_visitor_detail_rows()
    verified = verify_visitor_details(FakeVisitorDetailsConnection(expected))
    assert len(expected) == 1030
    assert verified == {"place_visitor_details"}


@pytest.mark.parametrize(
    ("mutation", "message"),
    [
        ("missing", "missing=.*"),
        ("extra", "extra=.*unexpected-preview-place"),
        ("modified-json", "visitor_details"),
        ("modified-provenance", "dataset_sha256"),
    ],
)
def test_visitor_metadata_verification_rejects_missing_extra_or_modified_rows(
    mutation: str, message: str
) -> None:
    actual = list(expected_visitor_detail_rows())
    if mutation == "missing":
        actual.pop()
    elif mutation == "extra":
        actual.append(("unexpected-preview-place", *actual[0][1:]))
    elif mutation == "modified-json":
        row = actual[0]
        changed_details = deepcopy(row[5])
        changed_details["overview"] = "Changed outside the reviewed import"
        actual[0] = (*row[:5], changed_details)
    else:
        row = actual[0]
        actual[0] = (*row[:3], "0" * 64, *row[4:])

    with pytest.raises(RuntimeError, match=message):
        verify_visitor_details(FakeVisitorDetailsConnection(actual))


class NonEmptyConnection:
    def __init__(self):
        self.checked = []

    def execute(self, query):
        self.checked.append(query)
        return FakeRows([(1,)])


def test_user_data_check_only_exempts_verified_seed_and_still_rejects_user_rows() -> None:
    details_only = NonEmptyConnection()
    verify_user_data_empty(
        details_only,
        ["places", "schema_migrations", "place_visitor_details"],
        {"place_visitor_details"},
    )
    assert details_only.checked == []

    unverified_details = NonEmptyConnection()
    with pytest.raises(RuntimeError, match="place_visitor_details is not empty"):
        verify_user_data_empty(unverified_details, ["place_visitor_details"], set())

    user_data = NonEmptyConnection()
    with pytest.raises(RuntimeError, match="accounts is not empty"):
        verify_user_data_empty(
            user_data,
            ["places", "schema_migrations", "place_visitor_details", "accounts"],
            {"place_visitor_details"},
        )
    assert len(user_data.checked) == 1

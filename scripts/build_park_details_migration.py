"""Validate and render the reviewed-only park visitor details import."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import date
from pathlib import Path
from typing import Any

from pydantic import ValidationError

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.app.visitor_details import (
    DatasetRecord,
    PlaceVisitorDetails,
    ReviewedDataset,
)


DEFAULT_SOURCE = (
    ROOT.parent
    / "artifacts"
    / "park-details-ingestion-20260924"
    / "park-details.json"
)
CANONICAL_PLACES = ROOT / "data" / "places.json"
REVIEWED_DATA = ROOT / "data" / "park-details.reviewed.json"
REVIEWED_SCHEMA = ROOT / "data" / "park-details.reviewed.schema.json"
MIGRATION = ROOT / "database" / "migrations" / "0027_import_place_visitor_details.sql"
SQL_DOLLAR_TAG = "$parkdex_visitor_details$"


def json_text(value: Any, *, pretty: bool) -> str:
    if pretty:
        return json.dumps(value, ensure_ascii=False, indent=2) + "\n"
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def reviewed_schema_text() -> str:
    return json_text(ReviewedDataset.model_json_schema(by_alias=True), pretty=True)


def canonical_place_ids() -> set[str]:
    places = json.loads(CANONICAL_PLACES.read_text(encoding="utf-8"))
    ids = [place["id"] for place in places]
    if len(ids) != len(set(ids)):
        raise ValueError("data/places.json contains duplicate place IDs")
    return set(ids)


def validate_canonical_ids(dataset: ReviewedDataset) -> None:
    ids = [place.place_id for place in dataset.places]
    if len(ids) != len(set(ids)):
        raise ValueError("Reviewed details contain duplicate place IDs")
    expected = canonical_place_ids()
    actual = set(ids)
    missing = sorted(expected - actual)
    extra = sorted(actual - expected)
    if missing or extra:
        raise ValueError(
            "Reviewed detail IDs must exactly match data/places.json "
            f"(missing={missing[:5]}, extra={extra[:5]})"
        )


def render_reviewed(dataset: ReviewedDataset) -> str:
    normalized = ReviewedDataset.model_validate(
        dataset.model_dump(mode="json", by_alias=True)
    )
    validate_canonical_ids(normalized)
    ids = [place.place_id for place in normalized.places]
    if ids != sorted(ids):
        raise ValueError("Reviewed places must be sorted by placeId")
    return json_text(normalized.model_dump(mode="json", by_alias=True), pretty=True)


def source_snapshot_date(source_path: Path) -> str:
    metadata_path = source_path.parent / "dataset-meta.json"
    if not metadata_path.is_file():
        raise ValueError(
            "A snapshot date is required with --snapshot-date when dataset-meta.json is absent"
        )
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    created_at = metadata.get("createdAt")
    if not isinstance(created_at, str) or len(created_at) < 10:
        raise ValueError("dataset-meta.json must contain an ISO createdAt timestamp")
    snapshot_date = date.fromisoformat(created_at[:10]).isoformat()
    return snapshot_date


def reviewed_from_source(source_path: Path, snapshot_date: str) -> ReviewedDataset:
    date.fromisoformat(snapshot_date)
    source_rows = json.loads(source_path.read_text(encoding="utf-8"))
    if not isinstance(source_rows, list):
        raise ValueError("The accepted park-details source must be a JSON array")

    records: list[dict[str, Any]] = []
    for row in source_rows:
        record = DatasetRecord.model_validate(row)
        public = record.model_dump(mode="json", by_alias=True)
        for internal_key in ("placeId", "identity", "reviewFlagIds"):
            public.pop(internal_key)
        public["source"] = record.source.model_dump(
            mode="json",
            by_alias=True,
            exclude={"archive_ids", "extraction_method"},
        )
        details = PlaceVisitorDetails.model_validate(public).model_dump(
            mode="json", by_alias=True
        )
        records.append({"placeId": record.place_id, "visitorDetails": details})

    dataset = ReviewedDataset.model_validate(
        {
            "schemaVersion": "1.0.0",
            "snapshotDate": snapshot_date,
            "places": sorted(records, key=lambda item: item["placeId"]),
        }
    )
    validate_canonical_ids(dataset)
    return dataset


def load_reviewed(path: Path = REVIEWED_DATA) -> tuple[ReviewedDataset, str]:
    content = path.read_text(encoding="utf-8")
    raw = json.loads(content)
    try:
        dataset = ReviewedDataset.model_validate(raw)
    except ValidationError as exc:
        raise ValueError(f"Reviewed data does not match the strict schema: {exc}") from exc
    validate_canonical_ids(dataset)
    canonical = render_reviewed(dataset)
    if canonical != content:
        raise ValueError(f"{path.relative_to(ROOT)} is not in canonical generated form")
    return dataset, content


def migration_rows(dataset: ReviewedDataset) -> list[dict[str, Any]]:
    return [
        {
            "place_id": place.place_id,
            "source_checked_at": place.visitor_details.source.retrieved_at,
            "visitor_details": place.visitor_details.model_dump(
                mode="json", by_alias=True
            ),
        }
        for place in dataset.places
    ]


def render_migration(dataset: ReviewedDataset, reviewed_json: str) -> str:
    dataset_sha256 = hashlib.sha256(reviewed_json.encode("utf-8")).hexdigest()
    migration_data = json_text(migration_rows(dataset), pretty=False)
    if SQL_DOLLAR_TAG in migration_data:
        raise ValueError("Reviewed text collides with the SQL migration delimiter")
    snapshot_date = dataset.snapshot_date.isoformat()
    return f"""-- Generated by scripts/build_park_details_migration.py from data/park-details.reviewed.json.
-- This accepted-only snapshot never changes canonical place identity or geometry.

CREATE OR REPLACE FUNCTION merge_place_visitor_details_jsonb(existing JSONB, incoming JSONB)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    result JSONB;
    item RECORD;
    existing_value JSONB;
BEGIN
    IF incoming IS NULL OR incoming = 'null'::JSONB THEN
        RETURN existing;
    END IF;
    IF jsonb_typeof(incoming) <> 'object' THEN
        RETURN incoming;
    END IF;
    IF existing IS NULL OR existing = 'null'::JSONB OR jsonb_typeof(existing) <> 'object' THEN
        RETURN incoming;
    END IF;

    result := existing;
    FOR item IN SELECT key, value FROM jsonb_each(incoming)
    LOOP
        IF item.value = 'null'::JSONB THEN
            CONTINUE;
        END IF;
        existing_value := result -> item.key;
        IF jsonb_typeof(item.value) = 'object' THEN
            result := jsonb_set(
                result,
                ARRAY[item.key],
                merge_place_visitor_details_jsonb(existing_value, item.value),
                TRUE
            );
        ELSE
            -- A non-null reviewed array is explicit and replaces the prior array.
            result := jsonb_set(result, ARRAY[item.key], item.value, TRUE);
        END IF;
    END LOOP;
    RETURN result;
END;
$$;

WITH imported AS (
    SELECT place_id, source_checked_at, visitor_details
    FROM jsonb_to_recordset(
        {SQL_DOLLAR_TAG}{migration_data}{SQL_DOLLAR_TAG}::JSONB
    ) AS rows(place_id TEXT, source_checked_at TIMESTAMPTZ, visitor_details JSONB)
)
INSERT INTO place_visitor_details (
    place_id, schema_version, snapshot_date, dataset_sha256,
    source_checked_at, visitor_details
)
SELECT
    imported.place_id,
    imported.visitor_details->>'schemaVersion',
    DATE '{snapshot_date}',
    '{dataset_sha256}',
    imported.source_checked_at,
    imported.visitor_details
FROM imported
ON CONFLICT (place_id) DO UPDATE SET
    schema_version = EXCLUDED.schema_version,
    snapshot_date = EXCLUDED.snapshot_date,
    dataset_sha256 = EXCLUDED.dataset_sha256,
    source_checked_at = COALESCE(
        EXCLUDED.source_checked_at,
        place_visitor_details.source_checked_at
    ),
    visitor_details = merge_place_visitor_details_jsonb(
        place_visitor_details.visitor_details,
        EXCLUDED.visitor_details
    );
"""


def check(source_path: Path | None = None, snapshot_date: str | None = None) -> None:
    dataset, reviewed_json = load_reviewed()
    if REVIEWED_SCHEMA.read_text(encoding="utf-8") != reviewed_schema_text():
        raise SystemExit("data/park-details.reviewed.schema.json is stale")
    expected_migration = render_migration(dataset, reviewed_json)
    if not MIGRATION.is_file() or MIGRATION.read_text(encoding="utf-8") != expected_migration:
        raise SystemExit(
            "database/migrations/0027_import_place_visitor_details.sql is stale"
        )
    if source_path is not None:
        source_snapshot = snapshot_date or source_snapshot_date(source_path)
        source_dataset = reviewed_from_source(source_path, source_snapshot)
        if render_reviewed(source_dataset) != reviewed_json:
            raise SystemExit("Reviewed data is stale against the supplied accepted source")
    print(
        f"Verified {len(dataset.places)} reviewed places, strict schema, and generated migration "
        f"(dataset SHA-256 {hashlib.sha256(reviewed_json.encode('utf-8')).hexdigest()})"
    )


def refresh(source_path: Path, snapshot_date: str | None = None) -> None:
    selected_date = snapshot_date or source_snapshot_date(source_path)
    dataset = reviewed_from_source(source_path, selected_date)
    reviewed_json = render_reviewed(dataset)
    schema_json = reviewed_schema_text()
    migration_sql = render_migration(dataset, reviewed_json)
    REVIEWED_DATA.write_text(reviewed_json, encoding="utf-8", newline="\n")
    REVIEWED_SCHEMA.write_text(schema_json, encoding="utf-8", newline="\n")
    MIGRATION.write_text(migration_sql, encoding="utf-8", newline="\n")
    print(
        f"Wrote {len(dataset.places)} reviewed places to {REVIEWED_DATA.relative_to(ROOT)} "
        f"and {MIGRATION.relative_to(ROOT)}"
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true", help="verify checked-in data and SQL")
    mode.add_argument("--refresh", action="store_true", help="rebuild reviewed JSON and SQL")
    parser.add_argument("--source", type=Path, help="accepted park-details.json source")
    parser.add_argument(
        "--snapshot-date",
        help="snapshot date override in YYYY-MM-DD format",
    )
    args = parser.parse_args()
    if args.snapshot_date:
        date.fromisoformat(args.snapshot_date)
    if args.check:
        check(args.source, args.snapshot_date)
        return
    refresh(args.source or DEFAULT_SOURCE, args.snapshot_date)


if __name__ == "__main__":
    main()

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

import psycopg
import pytest
from psycopg.errors import ForeignKeyViolation
from psycopg.rows import dict_row
from pydantic import ValidationError

from backend.app.schemas import SearchPlace
from backend.app.visitor_details import PlaceVisitorDetails, ReviewedDataset


ROOT = Path(__file__).resolve().parents[2]
REVIEWED_PATH = ROOT / "data" / "park-details.reviewed.json"
MIGRATION_PATH = ROOT / "database" / "migrations" / "0027_import_place_visitor_details.sql"
PLACE_ID = "provincial-goldstream-park"


def test_reviewed_import_matches_canonical_ids_and_omits_ingestion_internals() -> None:
    reviewed_text = REVIEWED_PATH.read_text(encoding="utf-8")
    reviewed = ReviewedDataset.model_validate(json.loads(reviewed_text))
    canonical = json.loads((ROOT / "data" / "places.json").read_text(encoding="utf-8"))
    ids = [place.place_id for place in reviewed.places]
    assert len(ids) == len(set(ids)) == len(canonical) == 1030
    assert set(ids) == {place["id"] for place in canonical}
    assert ids == sorted(ids)
    assert "archiveIds" not in reviewed_text
    assert "extractionMethod" not in reviewed_text
    assert "reviewFlagIds" not in reviewed_text
    assert "\"identity\"" not in reviewed_text
    assert all("placeId" not in place.visitor_details.model_dump(by_alias=True) for place in reviewed.places)

    banks_island = next(place for place in reviewed.places if place.place_id == "island-banks-island")
    assert banks_island.visitor_details.overview
    assert banks_island.visitor_details.activities is None
    assert banks_island.visitor_details.access.directions is None
    assert banks_island.visitor_details.background.wildlife is None
    assert banks_island.visitor_details.scope.matched_name == "Banks Island"
    assert banks_island.visitor_details.source.retrieved_at


def test_place_visitor_details_field_serializes_public_alias_and_is_omitted_when_absent() -> None:
    row = {
        "id": PLACE_ID,
        "name": "Goldstream Park",
        "category": "provincial",
        "latitude": 48.516,
        "longitude": -123.524,
        "region": "Vancouver Island / Gulf Islands",
        "description": "",
        "source_url": "https://bcparks.ca/goldstream-park/",
        "source_name": "BC Parks",
        "source_id": None,
    }
    plain = SearchPlace.model_validate(row).model_dump(by_alias=True, mode="json")
    assert "visitorDetails" not in plain

    reviewed = ReviewedDataset.model_validate(json.loads(REVIEWED_PATH.read_text(encoding="utf-8")))
    details = next(place.visitor_details for place in reviewed.places if place.place_id == PLACE_ID)
    row["visitor_details"] = details.model_dump(by_alias=True, mode="json")
    full = SearchPlace.model_validate(row).model_dump(by_alias=True, mode="json")
    assert full["visitorDetails"]["schemaVersion"] == "1.0.0"
    assert full["visitorDetails"]["areaHectares"] == 477
    assert "archiveIds" not in full["visitorDetails"]["source"]
    assert "extractionMethod" not in full["visitorDetails"]["source"]
    assert "identity" not in full["visitorDetails"]


def test_public_schema_rejects_bad_urls_and_timestamps_without_offsets() -> None:
    reviewed = ReviewedDataset.model_validate(json.loads(REVIEWED_PATH.read_text(encoding="utf-8")))
    valid = next(place.visitor_details.model_dump(by_alias=True, mode="json") for place in reviewed.places)

    for bad_url in (
        "https://",
        "https://user:password@example.com/park",
        "https://example.com/a path",
        "https://example.com/park\nname",
    ):
        invalid = json.loads(json.dumps(valid))
        invalid["source"]["primaryUrl"] = bad_url
        with pytest.raises(ValidationError):
            PlaceVisitorDetails.model_validate(invalid)

    invalid_timestamp = json.loads(json.dumps(valid))
    invalid_timestamp["source"]["retrievedAt"] = "2026-09-24T12:00:00"
    with pytest.raises(ValidationError, match="timezone offset"):
        PlaceVisitorDetails.model_validate(invalid_timestamp)


def test_reviewed_json_schema_and_migration_are_reproducible() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/build_park_details_migration.py", "--check"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    migration_sql = MIGRATION_PATH.read_text(encoding="utf-8").lower()
    assert "update places" not in migration_sql
    assert "insert into places" not in migration_sql

    schema = json.loads((ROOT / "data" / "park-details.reviewed.schema.json").read_text(encoding="utf-8"))
    reviewed_schema = schema["$defs"]["PlaceVisitorDetails"]["properties"]
    assert "placeId" not in reviewed_schema
    assert "identity" not in reviewed_schema
    assert "areaHectares" in reviewed_schema
    assert "mapNotes" in reviewed_schema
    assert "wildlife" in schema["$defs"]["VisitorBackground"]["properties"]
    source_schema = schema["$defs"]["VisitorSource"]["properties"]
    assert source_schema["retrievedAt"]["anyOf"][0]["format"] == "date-time"
    assert source_schema["primaryUrl"]["anyOf"][0]["format"] == "uri"
    assert hashlib.sha256(REVIEWED_PATH.read_bytes()).hexdigest() in MIGRATION_PATH.read_text(encoding="utf-8")


def test_migration_imports_and_sparse_upserts_preserve_unknowns() -> None:
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        pytest.skip("DATABASE_URL must point at an owned local test database")

    reviewed = ReviewedDataset.model_validate(json.loads(REVIEWED_PATH.read_text(encoding="utf-8")))
    place = next(record for record in reviewed.places if record.place_id == PLACE_ID)
    original_details = place.visitor_details.model_dump(by_alias=True, mode="json")
    dataset_sha256 = hashlib.sha256(REVIEWED_PATH.read_bytes()).hexdigest()
    migration_sql = MIGRATION_PATH.read_text(encoding="utf-8")

    with psycopg.connect(database_url, row_factory=dict_row) as conn:
        canonical_before = conn.execute(
            "SELECT id, name, category, latitude, longitude, region, description, "
            "source_url, source_name, source_id FROM places WHERE id = %s",
            (PLACE_ID,),
        ).fetchone()
        # Re-running the generated upsert must keep one row per canonical place.
        conn.execute(migration_sql)
        canonical_after = conn.execute(
            "SELECT id, name, category, latitude, longitude, region, description, "
            "source_url, source_name, source_id FROM places WHERE id = %s",
            (PLACE_ID,),
        ).fetchone()
        assert canonical_after == canonical_before
        assert conn.execute("SELECT COUNT(*) AS count FROM place_visitor_details").fetchone()["count"] == 1030
        stored = conn.execute(
            "SELECT schema_version, snapshot_date, dataset_sha256, source_checked_at, visitor_details "
            "FROM place_visitor_details WHERE place_id = %s",
            (PLACE_ID,),
        ).fetchone()
        assert stored["schema_version"] == "1.0.0"
        assert stored["snapshot_date"].isoformat() == reviewed.snapshot_date.isoformat()
        assert stored["dataset_sha256"].strip() == dataset_sha256
        assert stored["source_checked_at"] is not None
        assert stored["visitor_details"] == original_details

        sparse_update = json.dumps(
            {
                "overview": None,
                "activities": [],
                "background": {"wildlife": "A later accepted wildlife note."},
            }
        )
        conn.execute(
            "UPDATE place_visitor_details SET visitor_details = "
            "merge_place_visitor_details_jsonb(visitor_details, %s::jsonb) "
            "WHERE place_id = %s",
            (sparse_update, PLACE_ID),
        )
        after_sparse = conn.execute(
            "SELECT visitor_details FROM place_visitor_details WHERE place_id = %s",
            (PLACE_ID,),
        ).fetchone()["visitor_details"]
        assert after_sparse["overview"] == original_details["overview"]
        assert after_sparse["activities"] == []
        assert after_sparse["background"]["history"] == original_details["background"]["history"]
        assert after_sparse["background"]["wildlife"] == "A later accepted wildlife note."

        with pytest.raises(ForeignKeyViolation):
            with conn.transaction():
                conn.execute(
                    "INSERT INTO place_visitor_details "
                    "(place_id, schema_version, snapshot_date, dataset_sha256, visitor_details) "
                    "VALUES ('missing-place-for-visitor-details-test', '1.0.0', %s, %s, %s::jsonb)",
                    (reviewed.snapshot_date, dataset_sha256, json.dumps(original_details)),
                )
        conn.rollback()

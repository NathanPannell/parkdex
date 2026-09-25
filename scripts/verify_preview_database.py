"""Verify a fresh or migrated isolated Neon preview database."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
from datetime import date, datetime
from pathlib import Path
from urllib.parse import unquote, urlparse

import psycopg
from psycopg import sql

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "database" / "migrations"
CATALOGUE = ROOT / "data" / "places.json"
REVIEWED_VISITOR_DETAILS = ROOT / "data" / "park-details.reviewed.json"


def validate_target(value: str, database_name: str, expected_host: str) -> None:
    parsed = urlparse(value)
    if parsed.scheme not in {"postgres", "postgresql"}:
        raise RuntimeError("Preview database URI must use PostgreSQL")
    if not re.fullmatch(r"app_preview_[0-9a-f]{8}", database_name):
        raise RuntimeError("Preview database name is invalid")
    if parsed.hostname != expected_host or not expected_host.endswith(".neon.tech"):
        raise RuntimeError("Preview database URI does not match the verified Neon endpoint")
    if unquote(parsed.path) != f"/{database_name}" or unquote(parsed.username or "") != "app_owner":
        raise RuntimeError("Preview database URI does not match the owned database")
    if "-pooler." in expected_host:
        raise RuntimeError("Preview database verification requires the direct Neon endpoint")


def table_names(conn: psycopg.Connection) -> list[str]:
    return [
        row[0]
        for row in conn.execute(
            "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename"
        ).fetchall()
    ]


def verify_empty(conn: psycopg.Connection) -> None:
    tables = table_names(conn)
    if tables:
        raise RuntimeError(f"Fresh preview database unexpectedly contains tables: {', '.join(tables)}")


def expected_migrations() -> dict[str, str]:
    return {
        path.name: hashlib.sha256(path.read_text(encoding="utf-8").encode()).hexdigest()
        for path in sorted(MIGRATIONS.glob("*.sql"))
    }


def expected_place_ids() -> list[str]:
    ids: set[str] = set()
    for path in sorted(MIGRATIONS.glob("*.sql")):
        source = path.read_text(encoding="utf-8")
        for values in re.findall(
            r"INSERT\s+INTO\s+places\b.*?\bVALUES\s*(.*?)\s+ON\s+CONFLICT",
            source,
            flags=re.IGNORECASE | re.DOTALL,
        ):
            ids.update(value.replace("''", "'") for value in re.findall(r"\(\s*'((?:''|[^'])+)'\s*,", values))
    if not ids:
        raise RuntimeError("Source migrations contain no deterministic place catalogue")
    return sorted(ids)


def expected_visitor_detail_rows() -> list[tuple[str, str, date, str, datetime | None, dict]]:
    reviewed_bytes = REVIEWED_VISITOR_DETAILS.read_bytes()
    dataset = json.loads(reviewed_bytes)
    places = dataset["places"]
    details_by_id = {record["placeId"]: record["visitorDetails"] for record in places}
    if len(details_by_id) != len(places):
        raise RuntimeError("Checked-in visitor details contain duplicate place IDs")

    canonical_ids = {
        place["id"] for place in json.loads(CATALOGUE.read_text(encoding="utf-8"))
    }
    if set(details_by_id) != canonical_ids:
        raise RuntimeError(
            "Checked-in visitor detail IDs do not match the canonical place catalogue"
        )

    snapshot_date = date.fromisoformat(dataset["snapshotDate"])
    dataset_sha256 = hashlib.sha256(reviewed_bytes).hexdigest()
    expected_rows = []
    for place_id in sorted(details_by_id):
        details = details_by_id[place_id]
        schema_version = details["schemaVersion"]
        retrieved_at = details["source"]["retrievedAt"]
        source_checked_at = None
        if retrieved_at is not None:
            source_checked_at = datetime.fromisoformat(retrieved_at.replace("Z", "+00:00"))
            if source_checked_at.tzinfo is None or source_checked_at.utcoffset() is None:
                raise RuntimeError(
                    f"Checked-in visitor details have a timezone-naive source timestamp for {place_id}"
                )
        expected_rows.append(
            (place_id, schema_version, snapshot_date, dataset_sha256, source_checked_at, details)
        )
    return expected_rows


def verify_visitor_details(conn: psycopg.Connection) -> set[str]:
    expected_rows = expected_visitor_detail_rows()
    actual_rows = conn.execute(
        """
        SELECT place_id, schema_version, snapshot_date, dataset_sha256,
               source_checked_at, visitor_details
        FROM place_visitor_details
        ORDER BY place_id
        """
    ).fetchall()
    expected_by_id = {row[0]: row for row in expected_rows}
    actual_by_id = {row[0]: row for row in actual_rows}
    if len(actual_by_id) != len(actual_rows):
        raise RuntimeError("Preview visitor details contain duplicate place IDs")
    expected_ids = set(expected_by_id)
    actual_ids = set(actual_by_id)
    missing = sorted(expected_ids - actual_ids)
    extra = sorted(actual_ids - expected_ids)
    if missing or extra:
        raise RuntimeError(
            "Preview visitor detail IDs do not match checked-in accepted JSON "
            f"(missing={missing[:5]}, extra={extra[:5]})"
        )

    fields = ("place_id", "schema_version", "snapshot_date", "dataset_sha256", "source_checked_at", "visitor_details")
    for place_id, expected in expected_by_id.items():
        actual = actual_by_id[place_id]
        differences = []
        for index, field in enumerate(fields):
            expected_value, actual_value = expected[index], actual[index]
            if field == "dataset_sha256":
                actual_value = actual_value.strip() if isinstance(actual_value, str) else actual_value
            elif field == "source_checked_at" and actual_value is not None:
                if not isinstance(actual_value, datetime) or actual_value.tzinfo is None or actual_value.utcoffset() is None:
                    differences.append(field)
                    continue
            if actual_value != expected_value:
                differences.append(field)
        if differences:
            raise RuntimeError(
                f"Preview visitor details for {place_id} differ from accepted JSON: "
                f"{', '.join(differences)}"
            )
    return {"place_visitor_details"}


def verify_user_data_empty(
    conn: psycopg.Connection,
    tables: list[str],
    verified_seed_tables: set[str],
) -> None:
    seeded_tables = {"places", "schema_migrations", *verified_seed_tables}
    for table in tables:
        if table in seeded_tables:
            continue
        count = conn.execute(
            sql.SQL("SELECT COUNT(*) FROM {} ").format(sql.Identifier(table))
        ).fetchone()[0]
        if count:
            raise RuntimeError(f"Preview user-data table {table} is not empty")


def verify_migrated(conn: psycopg.Connection) -> None:
    expected = expected_migrations()
    actual = dict(conn.execute("SELECT version, checksum FROM schema_migrations ORDER BY version").fetchall())
    if actual != expected:
        raise RuntimeError("Preview migration ledger does not match the exact source migrations")

    expected_ids = sorted(place["id"] for place in json.loads(CATALOGUE.read_text(encoding="utf-8")))
    place_rows = conn.execute("SELECT id, active FROM places ORDER BY id").fetchall()
    if [row[0] for row in place_rows if row[1]] != expected_ids or [row[0] for row in place_rows] != expected_place_ids():
        raise RuntimeError("Preview catalogue does not match the exact source catalogue")

    verified_seed_tables = verify_visitor_details(conn)
    verify_user_data_empty(conn, table_names(conn), verified_seed_tables)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--phase", choices=("empty", "migrated"), required=True)
    args = parser.parse_args()
    value = os.environ["PREVIEW_DATABASE_URL_UNPOOLED"]
    database_name = os.environ["PREVIEW_DATABASE_NAME"]
    expected_host = os.environ["PREVIEW_DATABASE_HOST"]
    validate_target(value, database_name, expected_host)
    with psycopg.connect(value) as conn:
        identity = conn.execute("SELECT current_database(), current_user").fetchone()
        if identity != (database_name, "app_owner"):
            raise RuntimeError("Connected preview database identity was not verified")
        if args.phase == "empty":
            verify_empty(conn)
        else:
            verify_migrated(conn)
    print(f"Preview database {args.phase} isolation verified.")


if __name__ == "__main__":
    main()

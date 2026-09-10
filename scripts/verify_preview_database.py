"""Verify a fresh or migrated isolated Neon preview database."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
from pathlib import Path
from urllib.parse import unquote, urlparse

import psycopg
from psycopg import sql

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "database" / "migrations"
CATALOGUE = ROOT / "data" / "places.json"


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


def verify_migrated(conn: psycopg.Connection) -> None:
    expected = expected_migrations()
    actual = dict(conn.execute("SELECT version, checksum FROM schema_migrations ORDER BY version").fetchall())
    if actual != expected:
        raise RuntimeError("Preview migration ledger does not match the exact source migrations")

    expected_ids = sorted(place["id"] for place in json.loads(CATALOGUE.read_text(encoding="utf-8")))
    place_rows = conn.execute("SELECT id, active FROM places ORDER BY id").fetchall()
    if [row[0] for row in place_rows] != expected_ids or not all(row[1] for row in place_rows):
        raise RuntimeError("Preview catalogue does not match the exact source catalogue")

    for table in table_names(conn):
        if table in {"places", "schema_migrations"}:
            continue
        count = conn.execute(
            sql.SQL("SELECT COUNT(*) FROM {}").format(sql.Identifier(table))
        ).fetchone()[0]
        if count:
            raise RuntimeError(f"Preview user-data table {table} is not empty")


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

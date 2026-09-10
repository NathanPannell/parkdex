"""Fail unless a preview connection is an empty, isolated Neon app database."""

from __future__ import annotations

import os
from urllib.parse import urlparse

import psycopg
from psycopg import sql


def main() -> None:
    value = os.environ["PREVIEW_DATABASE_URL_UNPOOLED"]
    parsed = urlparse(value)
    if parsed.scheme not in {"postgres", "postgresql"}:
        raise RuntimeError("Preview database URI must use PostgreSQL")
    if not parsed.hostname or not parsed.hostname.endswith(".neon.tech"):
        raise RuntimeError("Preview database URI must target Neon")
    if parsed.path != "/app" or parsed.username != "app_owner":
        raise RuntimeError("Preview database URI must target app as app_owner")
    with psycopg.connect(value) as conn:
        tables = [
            row[0]
            for row in conn.execute(
                """
                SELECT tablename FROM pg_tables
                WHERE schemaname = 'public' AND tablename <> 'schema_migrations'
                ORDER BY tablename
                """
            ).fetchall()
        ]
        for table in tables:
            count = conn.execute(
                sql.SQL("SELECT COUNT(*) FROM {}").format(sql.Identifier(table))
            ).fetchone()[0]
            if count:
                raise RuntimeError(f"Preview database table {table} is not empty")
    print("Preview database isolation verified.")


if __name__ == "__main__":
    main()

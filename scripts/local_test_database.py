"""Create and remove strictly named, loopback-only PostgreSQL CI databases."""

from __future__ import annotations

import argparse
import os
import re
from urllib.parse import urlparse

import psycopg
from psycopg import sql

NAME = re.compile(r"^parkdex_ci_[a-z0-9_]{8,80}$")


def admin_url() -> str:
    value = os.environ.get(
        "PARKDEX_TEST_DATABASE_ADMIN_URL",
        "postgresql://postgres:postgres@localhost:5432/postgres",
    )
    parsed = urlparse(value)
    if parsed.scheme not in {"postgres", "postgresql"} or parsed.hostname not in {
        "localhost",
        "127.0.0.1",
        "::1",
    }:
        raise RuntimeError("CI database admin URL must use PostgreSQL on loopback")
    if parsed.path != "/postgres":
        raise RuntimeError("CI database admin URL must target the postgres database")
    return value


def validate_name(name: str) -> None:
    if not NAME.fullmatch(name):
        raise RuntimeError("Refusing database name outside the parkdex_ci_ namespace")


def create(name: str) -> None:
    validate_name(name)
    with psycopg.connect(admin_url(), autocommit=True) as conn:
        exists = conn.execute("SELECT 1 FROM pg_database WHERE datname = %s", (name,)).fetchone()
        if exists:
            raise RuntimeError("Refusing to adopt an existing CI database")
        conn.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))


def drop(name: str) -> None:
    validate_name(name)
    with psycopg.connect(admin_url(), autocommit=True) as conn:
        conn.execute(sql.SQL("DROP DATABASE IF EXISTS {} WITH (FORCE)").format(sql.Identifier(name)))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("create", "drop"))
    parser.add_argument("name")
    args = parser.parse_args()
    (create if args.action == "create" else drop)(args.name)

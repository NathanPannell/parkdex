from __future__ import annotations

import os
import uuid
from concurrent.futures import ThreadPoolExecutor

import psycopg

from scripts.local_test_database import admin_url, create, drop


def database_url(name: str) -> str:
    return admin_url().rsplit("/", 1)[0] + f"/{name}"


def test_concurrent_databases_are_isolated_and_removed() -> None:
    names = [f"parkdex_ci_contract_{uuid.uuid4().hex[:12]}" for _ in range(2)]
    try:
        with ThreadPoolExecutor(max_workers=2) as executor:
            list(executor.map(create, names))
        for index, name in enumerate(names):
            with psycopg.connect(database_url(name)) as conn:
                conn.execute("CREATE TABLE isolation_marker (value INTEGER NOT NULL)")
                conn.execute("INSERT INTO isolation_marker VALUES (%s)", (index,))
                conn.commit()
        for index, name in enumerate(names):
            with psycopg.connect(database_url(name)) as conn:
                assert conn.execute("SELECT value FROM isolation_marker").fetchone()[0] == index
    finally:
        with ThreadPoolExecutor(max_workers=2) as executor:
            list(executor.map(drop, names))
    with psycopg.connect(admin_url()) as conn:
        remaining = conn.execute("SELECT datname FROM pg_database WHERE datname = ANY(%s)", (names,)).fetchall()
    assert remaining == []


def test_database_name_and_host_guards(monkeypatch) -> None:
    monkeypatch.setenv("PARKDEX_TEST_DATABASE_ADMIN_URL", "postgresql://postgres:postgres@example.com/postgres")
    try:
        admin_url()
    except RuntimeError as error:
        assert "loopback" in str(error)
    else:
        raise AssertionError("Remote database URL was accepted")

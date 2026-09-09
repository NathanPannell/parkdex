import json
import os
import threading
import uuid
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import psycopg
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from backend.app.migrate import migrate
from backend.worker import main as worker
from backend.worker.main import catalogue_count


def schema_url(database_url: str, schema: str) -> str:
    parsed = urlsplit(database_url)
    query = dict(parse_qsl(parsed.query))
    query["options"] = f"-csearch_path={schema}"
    return urlunsplit((*parsed[:3], urlencode(query), parsed.fragment))


def test_worker_reads_active_catalogue_with_dict_rows() -> None:
    root = Path(__file__).resolve().parents[2]
    expected_count = len(json.loads((root / "data" / "places.json").read_text(encoding="utf-8")))
    with ConnectionPool(
        os.environ["DATABASE_URL"],
        kwargs={"row_factory": dict_row},
        min_size=1,
        max_size=1,
    ) as pool:
        assert catalogue_count(pool) == expected_count


def test_worker_startup_stops_when_migration_fails(monkeypatch) -> None:
    monkeypatch.setattr(worker, "get_settings", lambda: SimpleNamespace(
        effective_migration_database_url="postgresql://direct",
    ))
    monkeypatch.setattr(worker, "migrate", lambda _url: (_ for _ in ()).throw(
        RuntimeError("migration failed")
    ))
    try:
        worker.prepare_database()
    except RuntimeError as error:
        assert str(error) == "migration failed"
    else:
        raise AssertionError("Worker continued after migration failure")


def test_concurrent_worker_startup_migrates_fresh_database(monkeypatch) -> None:
    database_url = os.environ["DATABASE_URL_UNPOOLED"]
    schema = f"worker_startup_{uuid.uuid4().hex}"
    scoped_url = schema_url(database_url, schema)
    errors = []
    with psycopg.connect(database_url, autocommit=True) as conn:
        conn.execute(f'CREATE SCHEMA "{schema}"')
        conn.execute(f'''CREATE TABLE "{schema}".codex_validation_provenance (
            singleton BOOLEAN PRIMARY KEY DEFAULT TRUE,
            branch_id TEXT NOT NULL
        )''')
    try:
        monkeypatch.setattr(worker, "get_settings", lambda: SimpleNamespace(
            effective_migration_database_url=scoped_url,
        ))

        def start(operation):
            try:
                operation()
            except Exception as error:  # surfaced after joining both startup paths
                errors.append(error)

        threads = [
            threading.Thread(target=start, args=(lambda: migrate(scoped_url),)),
            threading.Thread(target=start, args=(worker.prepare_database,)),
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=30)
        assert not any(thread.is_alive() for thread in threads)
        assert errors == []
        expected_count = len(json.loads(
            (Path(__file__).resolve().parents[2] / "data" / "places.json").read_text(encoding="utf-8")
        ))
        with ConnectionPool(scoped_url, kwargs={"row_factory": dict_row}, min_size=1, max_size=1) as pool:
            assert catalogue_count(pool) == expected_count
    finally:
        with psycopg.connect(database_url, autocommit=True) as conn:
            conn.execute(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE')

import os
from types import SimpleNamespace

import psycopg

from backend.app import db


def test_pool_replaces_a_server_closed_idle_connection(monkeypatch) -> None:
    database_url = os.environ["DATABASE_URL"]
    assert db._pool is None
    monkeypatch.setattr(
        db,
        "get_settings",
        lambda: SimpleNamespace(effective_database_url=database_url),
    )

    db.open_pool()
    try:
        assert db._pool is not None
        with db._pool.connection() as conn:
            server_pid = conn.execute("SELECT pg_backend_pid() AS pid").fetchone()["pid"]

        # The server closes the idle session after the app returns it to the
        # pool, so its client-side status still appears healthy until I/O.
        with psycopg.connect(database_url) as admin_conn:
            terminated = admin_conn.execute(
                "SELECT pg_terminate_backend(%s)", (server_pid,)
            ).fetchone()[0]
            assert terminated is True

        with db._pool.connection() as conn:
            assert conn.execute("SELECT 1 AS value").fetchone()["value"] == 1
    finally:
        db.close_pool()

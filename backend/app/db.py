from collections.abc import Iterator

from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from backend.app.settings import get_settings

_pool: ConnectionPool | None = None


def open_pool() -> None:
    global _pool
    if _pool is not None:
        return
    _pool = ConnectionPool(
        conninfo=get_settings().effective_database_url,
        kwargs={"row_factory": dict_row},
        min_size=1,
        max_size=5,
        open=False,
    )
    _pool.open()
    _pool.wait()


def close_pool() -> None:
    global _pool
    if _pool is not None:
        _pool.close()
        _pool = None


def connection() -> Iterator:
    if _pool is None:
        raise RuntimeError("Database pool is not open")
    with _pool.connection() as conn:
        yield conn

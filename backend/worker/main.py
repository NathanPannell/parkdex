"""Low-overhead companion process retained for the standard Railway topology."""

import logging
import signal
import threading

from psycopg_pool import ConnectionPool
from psycopg.rows import dict_row

from backend.app.settings import get_settings

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)
stop_event = threading.Event()


def request_stop(*_: object) -> None:
    stop_event.set()


def catalogue_count(pool: ConnectionPool) -> int:
    with pool.connection() as conn:
        row = conn.execute(
            "SELECT COUNT(*) AS place_count FROM places WHERE active"
        ).fetchone()
    return row["place_count"]


def main() -> None:
    settings = get_settings()
    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)
    with ConnectionPool(
        settings.effective_database_url,
        kwargs={"row_factory": dict_row},
        min_size=1,
        max_size=1,
    ) as pool:
        while not stop_event.is_set():
            place_count = catalogue_count(pool)
            logger.info(
                "Parkdex catalogue ready commit=%s places=%d",
                settings.app_commit_sha,
                place_count,
            )
            stop_event.wait(max(settings.check_interval_seconds, 300))


if __name__ == "__main__":
    main()

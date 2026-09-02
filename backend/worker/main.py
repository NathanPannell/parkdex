import logging
import signal
import threading

from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from backend.app.settings import get_settings
from backend.worker.checker import check_url

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)
stop_event = threading.Event()


def request_stop(*_: object) -> None:
    stop_event.set()


def run_checks(pool: ConnectionPool) -> None:
    settings = get_settings()
    with pool.connection() as conn:
        monitors = conn.execute("SELECT id, url FROM monitors ORDER BY created_at").fetchall()
    logger.info("Checking %d monitor(s)", len(monitors))
    for monitor in monitors:
        if stop_event.is_set():
            return
        result = check_url(monitor["url"], settings.request_timeout_seconds)
        with pool.connection() as conn:
            conn.execute(
                """
                UPDATE monitors
                SET status = %s, http_status = %s, response_time_ms = %s, checked_at = %s
                WHERE id = %s
                """,
                (
                    result.status,
                    result.http_status,
                    result.response_time_ms,
                    result.checked_at,
                    monitor["id"],
                ),
            )
            conn.commit()


def main() -> None:
    settings = get_settings()
    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)
    with ConnectionPool(
        settings.effective_database_url,
        kwargs={"row_factory": dict_row},
        min_size=1,
        max_size=2,
    ) as pool:
        while not stop_event.is_set():
            try:
                run_checks(pool)
            except Exception:
                logger.exception("Monitor pass failed")
            stop_event.wait(settings.check_interval_seconds)


if __name__ == "__main__":
    main()


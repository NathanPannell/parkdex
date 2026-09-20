"""Run one bounded private-photo deletion retry batch and exit."""

from backend.app.db import close_pool, open_pool
from backend.app.main import process_photo_deletion_outbox


def main() -> int:
    try:
        open_pool()
        process_photo_deletion_outbox()
    finally:
        close_pool()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

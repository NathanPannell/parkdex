import json
import os
from pathlib import Path

from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from backend.worker.main import catalogue_count


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

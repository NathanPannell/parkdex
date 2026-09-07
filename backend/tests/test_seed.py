import json
import os
from pathlib import Path

import psycopg

ROOT = Path(__file__).resolve().parents[2]


def test_database_seed_exactly_matches_reviewed_catalogue() -> None:
    catalogue = json.loads((ROOT / "data" / "places.json").read_text(encoding="utf-8"))
    expected_ids = {place["id"] for place in catalogue}
    assert len(expected_ids) == len(catalogue)

    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        rows = conn.execute(
            "SELECT id, source_url, source_name FROM places WHERE active ORDER BY id"
        ).fetchall()
    actual_ids = {row[0] for row in rows}
    assert actual_ids == expected_ids
    assert all(row[1].startswith("https://") and row[2].strip() for row in rows)

import json
import os
import uuid
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


def test_display_name_migration_preserves_visits_and_group_membership() -> None:
    place_id = "provincial-hathayim-marine-park-a-k-a-von-donop-marine-park"
    migration = (ROOT / "database/migrations/0014_clean_place_names.sql").read_text(encoding="utf-8")
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        try:
            account_id = conn.execute(
                "INSERT INTO accounts (email, password_hash) VALUES (%s, 'test-only') RETURNING id",
                (f"name-migration-{uuid.uuid4()}@example.test",),
            ).fetchone()[0]
            group_id = conn.execute(
                "INSERT INTO account_groups (account_id, name) VALUES (%s, 'Name migration test') RETURNING id", (account_id,),
            ).fetchone()[0]
            conn.execute("INSERT INTO account_visits (account_id, place_id) VALUES (%s, %s)", (account_id, place_id))
            conn.execute("INSERT INTO account_group_places (group_id, place_id) VALUES (%s, %s)", (group_id, place_id))
            conn.execute("UPDATE places SET name = 'Hathayim Marine Park [a.k.a. Von Donop Marine Park' WHERE id = %s", (place_id,))
            conn.execute(migration)
            assert conn.execute("SELECT name, source_id FROM places WHERE id = %s", (place_id,)).fetchone() == ("Háthayim Marine Park", "728")
            assert conn.execute("SELECT COUNT(*) FROM account_visits WHERE account_id = %s AND place_id = %s", (account_id, place_id)).fetchone()[0] == 1
            assert conn.execute("SELECT COUNT(*) FROM account_group_places WHERE group_id = %s AND place_id = %s", (group_id, place_id)).fetchone()[0] == 1
        finally:
            conn.rollback()

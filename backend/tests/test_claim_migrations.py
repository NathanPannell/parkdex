from pathlib import Path
import os
from uuid import uuid4

import psycopg


ROOT = Path(__file__).resolve().parents[2]
MIGRATION_DIR = ROOT / "database" / "migrations"
LOCAL_CATEGORIES_MIGRATION = MIGRATION_DIR / "0028_expand_local_park_categories.sql"


def test_claim_migrations_follow_current_schema_and_are_additive():
    names = sorted(path.name for path in MIGRATION_DIR.glob("*.sql"))
    claim_migrations = [
        "0015_create_location_claims.sql",
        "0016_add_visit_postcard_object_storage.sql",
        "0017_schedule_photo_deletion_retries.sql",
        "0018_bind_claim_recommendations_to_session.sql",
        "0019_add_staging_field_place_scope.sql",
        "0020_create_account_deletion_receipts.sql",
        "0021_retire_bell_park_staging_overlay.sql",
    ]
    first_claim_migration = names.index(claim_migrations[0])
    assert names[first_claim_migration:first_claim_migration + len(claim_migrations)] == claim_migrations
    claims, photos, retries, sessions, field_scope, deletion, retirement = (
        (MIGRATION_DIR / name).read_text(encoding="utf-8")
        for name in claim_migrations
    )
    assert "account_id UUID NOT NULL" in claims
    assert "consumed_at TIMESTAMPTZ" in claims
    assert "FOREIGN KEY (account_id, place_id)" in claims
    assert "CREATE INDEX claim_recommendations_expires_at_idx" in claims
    assert "ON claim_recommendations (expires_at, account_id)" in claims
    assert "photo_object_key" in photos
    assert "photo_bytes" not in photos
    assert "SECRET_ACCESS_KEY" not in photos  # provider credentials never belong in Postgres

    # Deletion intent is metadata-only and can outlive both the claim row and
    # the account row while a worker retries the R2 delete.
    assert "CREATE TABLE photo_object_deletions" in photos
    assert "object_key TEXT PRIMARY KEY" in photos
    assert "account_id UUID NULL REFERENCES accounts(id) ON DELETE SET NULL" in photos
    assert "enqueued_at TIMESTAMPTZ NOT NULL DEFAULT NOW()" in photos
    assert "attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0)" in photos
    assert "last_attempted_at TIMESTAMPTZ" in photos
    assert "last_error TEXT" in photos
    assert "object_key LIKE 'postcards/%'" in photos
    assert "CHAR_LENGTH(object_key) <= 512" in photos
    assert "photo_object_deletions_account_idx" in photos
    assert "photo_object_deletions_retry_idx" in photos
    assert "REFERENCES account_visit_claims" not in photos
    assert "ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ" in retries
    assert "ALTER COLUMN next_attempt_at SET DEFAULT NOW()" in retries
    assert "ALTER COLUMN next_attempt_at SET NOT NULL" in retries
    assert "photo_object_deletions_due_idx" in retries
    assert "(next_attempt_at, enqueued_at, object_key)" in retries
    assert "ADD COLUMN IF NOT EXISTS session_hash CHAR(64)" in sessions
    assert "session_hash IS NULL OR session_hash ~ '^[0-9a-f]{64}$'" in sessions
    assert "REFERENCES account_sessions(token_hash)" in sessions
    assert "ON DELETE CASCADE" in sessions
    assert "claim_recommendations_session_hash_idx" in sessions
    assert "ADD COLUMN IF NOT EXISTS field_test_scope TEXT" in field_scope
    assert "field_test_scope = 'staging' AND active = FALSE" in field_scope
    assert "places_field_test_scope_idx" in field_scope
    assert "CREATE TABLE account_deletion_receipts" in deletion
    assert "request_hash CHAR(64) PRIMARY KEY" in deletion
    assert "photo_cleanup_pending BOOLEAN NOT NULL" in deletion
    assert "expires_at TIMESTAMPTZ NOT NULL" in deletion
    assert "expires_at <= created_at + INTERVAL '24 hours'" in deletion
    assert "account_deletion_receipts_expiry_idx" in deletion
    assert "account_deletion_request_hash CHAR(64)" in deletion
    assert "REFERENCES account_deletion_receipts(request_hash) ON DELETE SET NULL" in deletion
    assert "photo_object_deletions_account_deletion_receipt_idx" in deletion
    assert "UPDATE places" in retirement
    assert "active = FALSE" in retirement
    assert "field_test_scope = NULL" in retirement
    assert "id = 'regional-bell-park'" in retirement
    assert "field_test_scope = 'staging'" in retirement


def test_claim_migrations_do_not_rewrite_or_remove_existing_schema_objects():
    """The feature can be rolled forward while an N/N-1 API is still live."""

    for name in (
        "0015_create_location_claims.sql",
        "0016_add_visit_postcard_object_storage.sql",
        "0017_schedule_photo_deletion_retries.sql",
        "0018_bind_claim_recommendations_to_session.sql",
        "0019_add_staging_field_place_scope.sql",
        "0020_create_account_deletion_receipts.sql",
        "0021_retire_bell_park_staging_overlay.sql",
    ):
        sql = (MIGRATION_DIR / name).read_text(encoding="utf-8").upper()
        assert "DROP TABLE" not in sql
        assert "DROP COLUMN" not in sql


def test_offline_claim_migration_is_additive_and_account_scoped():
    sql = (MIGRATION_DIR / "0025_add_offline_claims.sql").read_text(
        encoding="utf-8"
    )
    assert "CREATE TABLE IF NOT EXISTS offline_claim_grants" in sql
    assert "token_hash CHAR(64) PRIMARY KEY" in sql
    assert "REFERENCES accounts(id) ON DELETE CASCADE" in sql
    assert "boundary_version CHAR(64) NOT NULL" in sql
    assert "INTERVAL '30 days'" in sql
    assert "CREATE TABLE IF NOT EXISTS offline_claim_requests" in sql
    assert "PRIMARY KEY (account_id, request_id)" in sql
    assert "request_fingerprint CHAR(64) NOT NULL" in sql
    assert "confirmation JSONB NOT NULL" in sql
    assert "invalidated_at TIMESTAMPTZ" in sql
    assert "CREATE TABLE IF NOT EXISTS offline_claim_undo_tombstones" in sql
    assert "PRIMARY KEY (account_id, place_id)" in sql
    assert "REFERENCES accounts(id) ON DELETE CASCADE" in sql
    assert "place_id TEXT NOT NULL REFERENCES places(id) ON DELETE CASCADE" in sql
    assert "undone_at TIMESTAMPTZ NOT NULL DEFAULT NOW()" in sql
    assert "DROP TABLE" not in sql.upper()
    assert "DROP COLUMN" not in sql.upper()


def test_local_category_migration_preserves_visits_and_accepts_both_categories():
    sql = LOCAL_CATEGORIES_MIGRATION.read_text(encoding="utf-8")
    assert "DROP CONSTRAINT IF EXISTS places_category_check" in sql
    assert "ADD CONSTRAINT places_category_check" in sql
    for category in ("national", "provincial", "regional", "island", "municipal", "community"):
        assert f"'{category}'" in sql
    assert "visits" not in sql.lower()

    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        return

    place_id = f"category-migration-{uuid4().hex}"
    owner_hash = uuid4().hex * 2
    try:
        with psycopg.connect(database_url) as conn:
            conn.execute(
                """INSERT INTO places (
                    id, name, category, latitude, longitude, region, description,
                    source_url, source_name
                ) VALUES (%s, 'Pre-migration fixture', 'regional', 49, -124,
                          'Test Region', '', 'https://example.test/place',
                          'Test fixture')""",
                (place_id,),
            )
            conn.execute(
                "INSERT INTO visits (owner_hash, place_id) VALUES (%s, %s)",
                (owner_hash, place_id),
            )
            conn.execute(sql)

            assert conn.execute(
                "SELECT id, category FROM places WHERE id = %s", (place_id,)
            ).fetchone() == (place_id, "regional")
            assert conn.execute(
                "SELECT owner_hash, place_id FROM visits WHERE owner_hash = %s",
                (owner_hash,),
            ).fetchone() == (owner_hash, place_id)
            conn.cursor().executemany(
                """INSERT INTO places (
                    id, name, category, latitude, longitude, region, description,
                    source_url, source_name
                ) VALUES (%s, %s, %s, 49, -124, 'Test Region', '',
                          'https://example.test/place', 'Test fixture')""",
                [
                    (f"{category}-{place_id}", f"{category.title()} Fixture", category)
                    for category in ("municipal", "community")
                ],
            )
            assert conn.execute(
                "SELECT category FROM places WHERE id = ANY(%s) ORDER BY category",
                ([f"municipal-{place_id}", f"community-{place_id}"],),
            ).fetchall() == [("community",), ("municipal",)]
            conn.rollback()
    finally:
        with psycopg.connect(database_url) as conn:
            conn.execute("DELETE FROM places WHERE id = %s", (place_id,))
            conn.execute(
                "DELETE FROM places WHERE id = ANY(%s)",
                ([f"municipal-{place_id}", f"community-{place_id}"],),
            )
            conn.execute("DELETE FROM visits WHERE owner_hash = %s", (owner_hash,))
            conn.commit()

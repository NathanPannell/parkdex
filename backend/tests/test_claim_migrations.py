from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MIGRATION_DIR = ROOT / "database" / "migrations"


def test_claim_migrations_follow_current_schema_and_are_additive():
    names = sorted(path.name for path in MIGRATION_DIR.glob("*.sql"))
    assert names[-7:] == [
        "0015_create_location_claims.sql",
        "0016_add_visit_postcard_object_storage.sql",
        "0017_schedule_photo_deletion_retries.sql",
        "0018_bind_claim_recommendations_to_session.sql",
        "0019_add_staging_field_place_scope.sql",
        "0020_create_account_deletion_receipts.sql",
        "0021_retire_bell_park_staging_overlay.sql",
    ]
    claims = (MIGRATION_DIR / names[-7]).read_text(encoding="utf-8")
    photos = (MIGRATION_DIR / names[-6]).read_text(encoding="utf-8")
    retries = (MIGRATION_DIR / names[-5]).read_text(encoding="utf-8")
    sessions = (MIGRATION_DIR / names[-4]).read_text(encoding="utf-8")
    field_scope = (MIGRATION_DIR / names[-3]).read_text(encoding="utf-8")
    deletion = (MIGRATION_DIR / names[-2]).read_text(encoding="utf-8")
    retirement = (MIGRATION_DIR / names[-1]).read_text(encoding="utf-8")
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

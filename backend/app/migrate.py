import hashlib
from pathlib import Path

import psycopg

from backend.app.settings import get_settings

MIGRATION_DIR = Path(__file__).resolve().parents[2] / "database" / "migrations"
LOCK_ID = 7_293_816_401


def migrate() -> None:
    database_url = get_settings().effective_migration_database_url
    with psycopg.connect(database_url, autocommit=False) as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT pg_advisory_lock(%s)", (LOCK_ID,))
            try:
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS schema_migrations (
                        version TEXT PRIMARY KEY,
                        checksum TEXT NOT NULL,
                        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    )
                    """
                )
                conn.commit()
                for path in sorted(MIGRATION_DIR.glob("*.sql")):
                    sql = path.read_text(encoding="utf-8")
                    checksum = hashlib.sha256(sql.encode()).hexdigest()
                    cur.execute(
                        "SELECT checksum FROM schema_migrations WHERE version = %s",
                        (path.name,),
                    )
                    row = cur.fetchone()
                    if row:
                        if row[0] != checksum:
                            raise RuntimeError(f"Applied migration changed: {path.name}")
                        continue
                    cur.execute(sql)
                    cur.execute(
                        "INSERT INTO schema_migrations (version, checksum) VALUES (%s, %s)",
                        (path.name, checksum),
                    )
                    conn.commit()
                    print(f"Applied {path.name}")
            finally:
                cur.execute("SELECT pg_advisory_unlock(%s)", (LOCK_ID,))
                conn.commit()


if __name__ == "__main__":
    migrate()



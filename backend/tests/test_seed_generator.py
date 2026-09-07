import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def test_seed_generator_rejects_a_version_before_existing_migrations() -> None:
    target = ROOT / "database" / "migrations" / "0000_bad.sql"
    result = subprocess.run(
        [sys.executable, "scripts/build_seed_migration.py", "--new", target.name],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode != 0
    assert "must sort after" in result.stderr
    assert not target.exists()

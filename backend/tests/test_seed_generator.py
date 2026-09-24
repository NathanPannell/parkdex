import importlib.util
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def load_generator():
    path = ROOT / "scripts/build_seed_migration.py"
    spec = importlib.util.spec_from_file_location("build_seed_migration", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_seed_generator_is_schema_aware_without_rewriting_history() -> None:
    generator = load_generator()
    manifest_target = generator.manifest_target()
    assert manifest_target.name == "0024_expand_bc_places.sql"
    assert generator.render_for_target(manifest_target) == manifest_target.read_text(
        encoding="utf-8"
    )

    legacy = generator.render_for_target(Path("0019_hypothetical_seed.sql"))
    assert "field_test_scope" not in legacy
    current = generator.render_for_target(Path("0020_promote_field_place.sql"))
    assert "UPDATE places SET active = FALSE WHERE field_test_scope IS NULL" in current
    assert "source_id, field_test_scope)" in current
    assert "field_test_scope = NULL" in current
    assert "Remove promoted ids from both staging overlay files" in current


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


def test_catalogue_refresh_preserves_the_reclassified_sooke_place_id() -> None:
    migration = (ROOT / "database" / "migrations" / "0013_expand_regional_catalogue.sql").read_text(encoding="utf-8")

    assert "DELETE FROM places" not in migration
    assert "UPDATE places SET active = FALSE" in migration
    assert "'regional-sooke-river-regional-park', 'Sooke River Park'" in migration

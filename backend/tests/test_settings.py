import pytest

from backend.app.settings import Settings


def test_preview_never_falls_back_to_production_database() -> None:
    settings = Settings(
        DATABASE_URL="postgresql://production",
        RAILWAY_ENVIRONMENT_NAME="pr-42",
    )
    with pytest.raises(RuntimeError, match="PREVIEW_DATABASE_URL"):
        _ = settings.effective_database_url


def test_preview_uses_preview_database() -> None:
    settings = Settings(
        DATABASE_URL="postgresql://production",
        PREVIEW_DATABASE_URL="postgresql://preview",
        RAILWAY_ENVIRONMENT_NAME="pr-42",
    )
    assert settings.effective_database_url == "postgresql://preview"


def test_preview_migrations_require_direct_database_url() -> None:
    settings = Settings(
        PREVIEW_DATABASE_URL="postgresql://preview-pooled",
        RAILWAY_ENVIRONMENT_NAME="pr-42",
    )
    with pytest.raises(RuntimeError, match="PREVIEW_DATABASE_URL_UNPOOLED"):
        _ = settings.effective_migration_database_url


def test_preview_migrations_use_direct_database_url() -> None:
    settings = Settings(
        PREVIEW_DATABASE_URL="postgresql://preview-pooled",
        PREVIEW_DATABASE_URL_UNPOOLED="postgresql://preview-direct",
        RAILWAY_ENVIRONMENT_NAME="pr-42",
    )
    assert settings.effective_migration_database_url == "postgresql://preview-direct"


def test_railway_production_migrations_require_direct_database_url() -> None:
    settings = Settings(
        DATABASE_URL="postgresql://production-pooled",
        DATABASE_URL_UNPOOLED=None,
        RAILWAY_ENVIRONMENT_NAME="production",
    )
    with pytest.raises(RuntimeError, match="DATABASE_URL_UNPOOLED"):
        _ = settings.effective_migration_database_url


def test_local_migrations_may_use_local_database_url() -> None:
    settings = Settings(
        DATABASE_URL="postgresql://localhost/app",
        DATABASE_URL_UNPOOLED=None,
    )
    assert settings.effective_migration_database_url == "postgresql://localhost/app"

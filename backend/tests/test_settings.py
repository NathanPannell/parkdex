import pytest

from backend.app.settings import Settings


def test_staging_field_places_require_the_exact_triple_gate() -> None:
    settings = Settings(
        _env_file=None,
        ENABLE_STAGING_FIELD_PLACES=True,
        APP_ENVIRONMENT="staging",
        RAILWAY_ENVIRONMENT_NAME="staging",
    )
    assert settings.staging_field_places_enabled is True


@pytest.mark.parametrize(
    ("app_environment", "railway_name"),
    [
        ("local", "staging"),
        ("test", "staging"),
        ("preview", "staging"),
        ("production", "staging"),
        ("staging", None),
        ("staging", ""),
        ("staging", "pr-42"),
        ("staging", "production"),
        ("staging", "staging-us"),
        ("staging", "STAGING"),
        ("staging", " staging "),
    ],
)
def test_staging_field_place_flag_rejects_every_mismatched_environment(
    app_environment,
    railway_name,
) -> None:
    with pytest.raises(ValueError, match="requires APP_ENVIRONMENT=staging"):
        Settings(
            _env_file=None,
            ENABLE_STAGING_FIELD_PLACES=True,
            APP_ENVIRONMENT=app_environment,
            RAILWAY_ENVIRONMENT_NAME=railway_name,
        )


def test_disabled_staging_field_places_never_enable_from_environment_names() -> None:
    settings = Settings(
        _env_file=None,
        ENABLE_STAGING_FIELD_PLACES=False,
        APP_ENVIRONMENT="staging",
        RAILWAY_ENVIRONMENT_NAME="staging",
    )
    assert settings.staging_field_places_enabled is False


@pytest.mark.parametrize("app_environment", ["local", "test"])
@pytest.mark.parametrize("railway_name", [None, "", "  "])
def test_claim_test_mode_is_allowed_only_off_platform_locally(
    app_environment,
    railway_name,
) -> None:
    settings = Settings(
        _env_file=None,
        APP_ENVIRONMENT=app_environment,
        CLAIM_TEST_MODE=True,
        RAILWAY_ENVIRONMENT_NAME=railway_name,
    )
    assert settings.claim_test_fixtures_enabled is True


@pytest.mark.parametrize("app_environment", ["preview", "staging", "production"])
def test_claim_test_mode_rejects_deployed_app_environments(app_environment) -> None:
    with pytest.raises(ValueError, match="only allowed.*local/test"):
        Settings(
            _env_file=None,
            APP_ENVIRONMENT=app_environment,
            CLAIM_TEST_MODE=True,
        )


@pytest.mark.parametrize("app_environment", ["local", "test"])
@pytest.mark.parametrize(
    "railway_name",
    [
        "preview",
        "staging",
        "production",
        "pr-42",
        "lp-pr-99999-abcdef01-12345678",
        "preview-blue",
        "staging-us",
        "production-us",
        "local",
        "test",
    ],
)
def test_claim_test_mode_rejects_every_railway_environment(
    app_environment,
    railway_name,
) -> None:
    with pytest.raises(ValueError, match="only allowed.*local/test"):
        Settings(
            _env_file=None,
            APP_ENVIRONMENT=app_environment,
            CLAIM_TEST_MODE=True,
            RAILWAY_ENVIRONMENT_NAME=railway_name,
        )


@pytest.mark.parametrize(
    "app_environment", ["local", "test", "preview", "staging", "production"]
)
def test_disabled_claim_test_mode_is_valid_in_every_environment(
    app_environment,
) -> None:
    settings = Settings(
        _env_file=None,
        APP_ENVIRONMENT=app_environment,
        CLAIM_TEST_MODE=False,
        RAILWAY_ENVIRONMENT_NAME="production",
    )
    assert settings.claim_test_fixtures_enabled is False


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


def test_local_release_namespace_uses_preview_database() -> None:
    settings = Settings(
        DATABASE_URL="postgresql://production",
        PREVIEW_DATABASE_URL="postgresql://preview",
        RAILWAY_ENVIRONMENT_NAME="lp-pr-99999-abcdef01-12345678",
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


def test_visit_claim_enforcement_defaults_to_the_compatibility_bridge(monkeypatch) -> None:
    monkeypatch.delenv("VISIT_CLAIM_ENFORCEMENT", raising=False)
    assert Settings(_env_file=None).visit_claim_enforcement == "compatible"
    assert Settings(
        _env_file=None, VISIT_CLAIM_ENFORCEMENT="required"
    ).visit_claim_enforcement == "required"

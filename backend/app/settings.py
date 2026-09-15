from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import AliasChoices, Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

PROJECT_ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(PROJECT_ROOT / ".env", PROJECT_ROOT / ".env.local"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    database_url: str | None = Field(default=None, alias="DATABASE_URL")
    database_url_unpooled: str | None = Field(
        default=None, alias="DATABASE_URL_UNPOOLED"
    )
    preview_database_url: str | None = Field(
        default=None, alias="PREVIEW_DATABASE_URL"
    )
    preview_database_url_unpooled: str | None = Field(
        default=None, alias="PREVIEW_DATABASE_URL_UNPOOLED"
    )
    railway_environment_name: str | None = Field(
        default=None, alias="RAILWAY_ENVIRONMENT_NAME"
    )
    frontend_origins: str = Field(
        default="http://localhost:3000", alias="FRONTEND_ORIGINS"
    )
    request_timeout_seconds: float = Field(default=10, alias="REQUEST_TIMEOUT_SECONDS")
    app_commit_sha: str = Field(default="local", alias="APP_COMMIT_SHA")
    app_release_id: str = Field(default="local", alias="APP_RELEASE_ID")
    app_public_url: str = Field(default="http://localhost:3000", alias="APP_PUBLIC_URL")
    api_public_url: str = Field(default="http://localhost:8000", alias="API_PUBLIC_URL")
    mcp_public_url: str = Field(default="http://localhost:8000/mcp", alias="MCP_PUBLIC_URL")
    google_client_id: str | None = Field(default=None, alias="GOOGLE_CLIENT_ID")
    google_client_secret: str | None = Field(default=None, alias="GOOGLE_CLIENT_SECRET")
    google_redirect_uri: str | None = Field(default=None, alias="GOOGLE_REDIRECT_URI")
    email_provider: Literal["smtp", "resend"] = Field(default="smtp", alias="EMAIL_PROVIDER")
    smtp_host: str | None = Field(default=None, alias="SMTP_HOST")
    smtp_port: int = Field(default=587, alias="SMTP_PORT")
    smtp_username: str | None = Field(default=None, alias="SMTP_USERNAME")
    smtp_password: str | None = Field(default=None, alias="SMTP_PASSWORD")
    smtp_from: str = Field(default="Parkdex <no-reply@parkdex.app>", alias="SMTP_FROM")
    smtp_use_tls: bool = Field(default=True, alias="SMTP_USE_TLS")
    resend_api_key: str | None = Field(default=None, alias="RESEND_API_KEY")
    resend_api_url: str = Field(default="https://api.resend.com/emails", alias="RESEND_API_URL")
    resend_from: str = Field(default="Parkdex <no-reply@parkdex.app>", alias="RESEND_FROM")
    app_environment: Literal["local", "test", "preview", "staging", "production"] = Field(
        default="production", alias="APP_ENVIRONMENT"
    )
    claim_test_mode: bool = Field(default=False, alias="CLAIM_TEST_MODE")
    visit_claim_enforcement: Literal["compatible", "required"] = Field(
        default="compatible", alias="VISIT_CLAIM_ENFORCEMENT"
    )
    photo_storage_backend: Literal["auto", "r2", "filesystem", "memory"] = Field(
        default="auto", alias="PHOTO_STORAGE_BACKEND"
    )
    photo_storage_path: str = Field(
        default=".photo-objects", alias="PHOTO_STORAGE_PATH"
    )
    r2_endpoint: str | None = Field(
        default=None,
        validation_alias=AliasChoices("R2_ENDPOINT", "R2_S3_ENDPOINT"),
    )
    r2_bucket: str | None = Field(
        default=None,
        validation_alias=AliasChoices("R2_BUCKET", "R2_BUCKET_NAME"),
    )
    r2_access_key_id: str | None = Field(
        default=None, alias="R2_ACCESS_KEY_ID"
    )
    r2_secret_access_key: str | None = Field(
        default=None, alias="R2_SECRET_ACCESS_KEY"
    )
    r2_region: str = Field(default="auto", alias="R2_REGION")

    @model_validator(mode="after")
    def prevent_production_claim_fixtures(self):
        if self.claim_test_mode and not self.claim_test_fixtures_enabled:
            raise ValueError(
                "CLAIM_TEST_MODE is only allowed in non-deployed local/test environments"
            )
        return self

    @property
    def claim_test_fixtures_enabled(self) -> bool:
        railway_name = (self.railway_environment_name or "").strip()
        return (
            self.claim_test_mode
            and self.app_environment in {"local", "test"}
            and not railway_name
        )

    @property
    def is_preview(self) -> bool:
        name = (self.railway_environment_name or "").lower()
        return name.startswith("pr-") or "-pr-" in name

    @property
    def effective_database_url(self) -> str:
        if self.is_preview:
            if not self.preview_database_url:
                raise RuntimeError(
                    "Railway preview environments require PREVIEW_DATABASE_URL; "
                    "DATABASE_URL is intentionally ignored."
                )
            return self.preview_database_url
        if not self.database_url:
            raise RuntimeError("DATABASE_URL is required outside preview environments")
        return self.database_url

    @property
    def effective_migration_database_url(self) -> str:
        """Require a direct Neon connection in every Railway environment."""
        if self.is_preview:
            if not self.preview_database_url_unpooled:
                raise RuntimeError(
                    "Railway preview migrations require PREVIEW_DATABASE_URL_UNPOOLED."
                )
            return self.preview_database_url_unpooled
        if self.railway_environment_name and not self.database_url_unpooled:
            raise RuntimeError(
                "Railway production migrations require DATABASE_URL_UNPOOLED."
            )
        return self.database_url_unpooled or self.effective_database_url

    @property
    def allowed_origins(self) -> list[str]:
        origins: list[str] = []
        seen: set[str] = set()
        for value in (*self.frontend_origins.split(","), "https://localhost"):
            origin = value.strip()
            if origin and origin not in seen:
                origins.append(origin)
                seen.add(origin)
        return origins


@lru_cache
def get_settings() -> Settings:
    return Settings()

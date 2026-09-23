from pathlib import Path

import pytest

from backend.app.object_storage import (
    FilesystemObjectStorage,
    MemoryObjectStorage,
    ObjectStorageConfigurationError,
    ObjectStorageNotFound,
    R2ObjectStorage,
    object_storage_from_settings,
)
from backend.app.settings import Settings


def test_memory_store_is_private_and_missing_objects_are_explicit():
    store = MemoryObjectStorage()
    store.put("postcards/account/place/photo.jpg", b"bytes", "image/jpeg")
    assert store.get("postcards/account/place/photo.jpg") == b"bytes"
    store.delete("postcards/account/place/photo.jpg")
    with pytest.raises(ObjectStorageNotFound):
        store.get("postcards/account/place/photo.jpg")
    with pytest.raises(Exception):
        store.put("../escape", b"bad", "image/jpeg")


def test_filesystem_store_writes_atomically_under_configured_root(tmp_path: Path):
    store = FilesystemObjectStorage(tmp_path)
    store.put("postcards/a/b.jpg", b"bytes", "image/jpeg")
    assert (tmp_path / "postcards" / "a" / "b.jpg").read_bytes() == b"bytes"
    assert store.get("postcards/a/b.jpg") == b"bytes"
    store.delete("postcards/a/b.jpg")
    with pytest.raises(ObjectStorageNotFound):
        store.get("postcards/a/b.jpg")


def test_auto_storage_fails_closed_outside_local_test():
    settings = Settings(APP_ENVIRONMENT="production", PHOTO_STORAGE_BACKEND="auto")
    with pytest.raises(ObjectStorageConfigurationError, match="R2_ENDPOINT"):
        object_storage_from_settings(settings)
    assert object_storage_from_settings(
        Settings(APP_ENVIRONMENT="test", PHOTO_STORAGE_BACKEND="auto")
    ).__class__ is MemoryObjectStorage


@pytest.mark.parametrize("app_environment", ["preview", "staging", "production"])
@pytest.mark.parametrize("backend", ["memory", "filesystem"])
def test_ephemeral_storage_is_rejected_in_deployed_environments(
    app_environment: str, backend: str, tmp_path: Path
):
    settings = Settings(
        APP_ENVIRONMENT=app_environment,
        PHOTO_STORAGE_BACKEND=backend,
        PHOTO_STORAGE_PATH=str(tmp_path),
    )
    with pytest.raises(ObjectStorageConfigurationError, match="local/test"):
        object_storage_from_settings(settings)


@pytest.mark.parametrize("app_environment", ["local", "test"])
@pytest.mark.parametrize(
    ("backend", "expected_type"),
    [("memory", MemoryObjectStorage), ("filesystem", FilesystemObjectStorage)],
)
def test_ephemeral_storage_remains_available_locally_and_in_tests(
    app_environment: str,
    backend: str,
    expected_type: type,
    tmp_path: Path,
):
    settings = Settings(
        APP_ENVIRONMENT=app_environment,
        PHOTO_STORAGE_BACKEND=backend,
        PHOTO_STORAGE_PATH=str(tmp_path),
    )
    assert isinstance(object_storage_from_settings(settings), expected_type)


@pytest.mark.parametrize("backend", ["memory", "filesystem", "auto"])
def test_ephemeral_storage_rejects_railway_even_if_app_environment_is_local(
    backend: str,
    tmp_path: Path,
):
    settings = Settings(
        APP_ENVIRONMENT="local",
        RAILWAY_ENVIRONMENT_NAME="pr-42",
        PHOTO_STORAGE_BACKEND=backend,
        PHOTO_STORAGE_PATH=str(tmp_path),
    )
    with pytest.raises(ObjectStorageConfigurationError):
        object_storage_from_settings(settings)


def test_allowed_origins_include_capacitor_origin_once():
    settings = Settings(
        FRONTEND_ORIGINS="https://staging.web.parkdex.app, https://localhost, https://staging.web.parkdex.app"
    )
    assert settings.allowed_origins == [
        "https://staging.web.parkdex.app",
        "https://localhost",
    ]


def test_r2_client_uses_bounded_network_timeouts_and_retries(monkeypatch):
    captured = {}

    class FakeClient:
        def put_object(self, **options):
            captured["put"] = options

        def get_object(self, **options):
            captured["get"] = options
            return {"Body": type("Body", (), {"read": lambda self: b"stored"})()}

        def delete_object(self, **options):
            captured["delete"] = options

    def fake_client(name, **options):
        captured["name"] = name
        captured.update(options)
        return FakeClient()

    monkeypatch.setattr("boto3.client", fake_client)
    store = R2ObjectStorage(
        endpoint="https://r2.example.test",
        bucket="private-postcards",
        access_key_id="key",
        secret_access_key="secret",
    )

    assert store.bucket == "private-postcards"
    assert captured["name"] == "s3"
    config = captured["config"]
    assert config.connect_timeout == 5
    assert config.read_timeout == 15
    assert config.retries == {"mode": "standard", "total_max_attempts": 3}
    store.put("postcards/opaque.jpg", b"stored", "image/jpeg")
    assert store.get("postcards/opaque.jpg") == b"stored"
    store.delete("postcards/opaque.jpg")
    assert captured["put"] == {
        "Bucket": "private-postcards",
        "Key": "postcards/opaque.jpg",
        "Body": b"stored",
        "ContentType": "image/jpeg",
        "CacheControl": "private, no-store",
    }
    assert captured["get"] == {
        "Bucket": "private-postcards",
        "Key": "postcards/opaque.jpg",
    }
    assert captured["delete"] == {
        "Bucket": "private-postcards",
        "Key": "postcards/opaque.jpg",
    }

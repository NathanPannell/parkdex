"""Private object storage adapters for visit postcard photos.

The API deliberately owns all reads and writes.  R2 objects are never exposed as
public URLs; the S3-compatible adapter is used only from the authenticated API.
The memory and filesystem adapters make the same contract available to tests and
local development without cloud credentials.
"""

from __future__ import annotations

from pathlib import Path
import os
import tempfile
from threading import RLock
from typing import Protocol


class ObjectStorageError(RuntimeError):
    """An object-store operation failed."""


class ObjectStorageConfigurationError(ObjectStorageError):
    """The configured object store cannot be constructed safely."""


class ObjectStorageNotFound(ObjectStorageError):
    """An object did not exist in the store."""


class ObjectStorage(Protocol):
    def put(self, key: str, content: bytes, content_type: str) -> None:
        ...

    def get(self, key: str) -> bytes:
        ...

    def delete(self, key: str) -> None:
        ...


def validate_object_key(key: str) -> str:
    """Reject keys that could escape a filesystem adapter or surprise S3."""

    if not isinstance(key, str) or not key or len(key) > 512:
        raise ObjectStorageError("Invalid object key")
    if key.startswith("/") or "\\" in key:
        raise ObjectStorageError("Invalid object key")
    parts = key.split("/")
    if any(not part or part in {".", ".."} for part in parts):
        raise ObjectStorageError("Invalid object key")
    return key


class MemoryObjectStorage:
    """Thread-safe in-memory store used by unit and API tests."""

    def __init__(self):
        self.objects: dict[str, tuple[bytes, str]] = {}
        self._lock = RLock()

    def put(self, key: str, content: bytes, content_type: str) -> None:
        key = validate_object_key(key)
        with self._lock:
            self.objects[key] = (bytes(content), content_type)

    def get(self, key: str) -> bytes:
        key = validate_object_key(key)
        with self._lock:
            value = self.objects.get(key)
        if value is None:
            raise ObjectStorageNotFound(key)
        return value[0]

    def delete(self, key: str) -> None:
        key = validate_object_key(key)
        with self._lock:
            self.objects.pop(key, None)


class FilesystemObjectStorage:
    """Small private local store with atomic replacement semantics."""

    def __init__(self, root: str | Path):
        self.root = Path(root).expanduser().resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def _path(self, key: str) -> Path:
        key = validate_object_key(key)
        path = (self.root / key).resolve()
        try:
            path.relative_to(self.root)
        except ValueError as exc:
            raise ObjectStorageError("Invalid object key") from exc
        return path

    def put(self, key: str, content: bytes, content_type: str) -> None:
        del content_type  # MIME is authoritative in the database metadata.
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary: str | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="wb", dir=path.parent, prefix=f".{path.name}.", delete=False
            ) as handle:
                temporary = handle.name
                handle.write(content)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, path)
            temporary = None
        finally:
            if temporary:
                try:
                    os.unlink(temporary)
                except FileNotFoundError:
                    pass

    def get(self, key: str) -> bytes:
        path = self._path(key)
        try:
            return path.read_bytes()
        except FileNotFoundError as exc:
            raise ObjectStorageNotFound(key) from exc

    def delete(self, key: str) -> None:
        path = self._path(key)
        try:
            path.unlink()
        except FileNotFoundError:
            pass


class R2ObjectStorage:
    """Cloudflare R2 through its S3-compatible API.

    boto3 is imported lazily so geometry/photo normalization tests do not need
    cloud SDKs or credentials.  Production images install boto3 from the API
    requirements and configure all four R2 secrets/endpoint values.
    """

    def __init__(
        self,
        *,
        endpoint: str,
        bucket: str,
        access_key_id: str,
        secret_access_key: str,
        region: str = "auto",
    ):
        values = (endpoint, bucket, access_key_id, secret_access_key)
        if not all(isinstance(value, str) and value.strip() for value in values):
            raise ObjectStorageConfigurationError(
                "R2 object storage requires R2_ENDPOINT, R2_BUCKET, "
                "R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY"
            )
        try:
            import boto3
            from botocore.config import Config
        except ImportError as exc:
            raise ObjectStorageConfigurationError(
                "R2 object storage requires the boto3 package"
            ) from exc
        try:
            self._client = boto3.client(
                "s3",
                endpoint_url=endpoint.rstrip("/"),
                aws_access_key_id=access_key_id,
                aws_secret_access_key=secret_access_key,
                region_name=region or "auto",
                config=Config(
                    connect_timeout=5,
                    read_timeout=15,
                    retries={"mode": "standard", "total_max_attempts": 3},
                ),
            )
        except Exception as exc:
            raise ObjectStorageConfigurationError(
                "R2 object storage client could not be configured"
            ) from exc
        self.bucket = bucket

    def put(self, key: str, content: bytes, content_type: str) -> None:
        try:
            self._client.put_object(
                Bucket=self.bucket,
                Key=validate_object_key(key),
                Body=content,
                ContentType=content_type,
                CacheControl="private, no-store",
            )
        except Exception as exc:
            raise ObjectStorageError("R2 photo upload failed") from exc

    def get(self, key: str) -> bytes:
        try:
            result = self._client.get_object(
                Bucket=self.bucket, Key=validate_object_key(key)
            )
            return result["Body"].read()
        except Exception as exc:
            # Avoid importing botocore merely to identify a not-found response;
            # API callers intentionally receive a private 404 either way.
            error = getattr(exc, "response", {})
            code = str((error.get("Error") or {}).get("Code", ""))
            if code in {"404", "NoSuchKey", "NotFound"}:
                raise ObjectStorageNotFound(key) from exc
            raise ObjectStorageError("R2 photo read failed") from exc

    def delete(self, key: str) -> None:
        try:
            self._client.delete_object(
                Bucket=self.bucket, Key=validate_object_key(key)
            )
        except Exception as exc:
            raise ObjectStorageError("R2 photo delete failed") from exc


def object_storage_from_settings(settings) -> ObjectStorage:
    """Construct the configured adapter, failing closed outside local/test."""

    backend = settings.photo_storage_backend
    app_environment = str(
        getattr(settings, "app_environment", "production") or "production"
    ).strip().lower()
    railway_environment = str(
        getattr(settings, "railway_environment_name", "") or ""
    ).strip()
    ephemeral_storage_allowed = (
        app_environment in {"local", "test"} and not railway_environment
    )
    if backend in {"memory", "filesystem"}:
        if not ephemeral_storage_allowed:
            raise ObjectStorageConfigurationError(
                f"PHOTO_STORAGE_BACKEND={backend} is only allowed in local/test environments"
            )
    if backend == "memory":
        return MemoryObjectStorage()
    if backend == "filesystem":
        return FilesystemObjectStorage(settings.photo_storage_path)
    if backend == "r2":
        return R2ObjectStorage(
            endpoint=settings.r2_endpoint or "",
            bucket=settings.r2_bucket or "",
            access_key_id=settings.r2_access_key_id or "",
            secret_access_key=settings.r2_secret_access_key or "",
            region=settings.r2_region,
        )
    if backend != "auto":
        raise ObjectStorageConfigurationError("Unknown photo storage backend")

    r2_values = (
        settings.r2_endpoint,
        settings.r2_bucket,
        settings.r2_access_key_id,
        settings.r2_secret_access_key,
    )
    if all(isinstance(value, str) and value.strip() for value in r2_values):
        return R2ObjectStorage(
            endpoint=settings.r2_endpoint,
            bucket=settings.r2_bucket,
            access_key_id=settings.r2_access_key_id,
            secret_access_key=settings.r2_secret_access_key,
            region=settings.r2_region,
        )
    if ephemeral_storage_allowed:
        return MemoryObjectStorage()
    raise ObjectStorageConfigurationError(
        "Private photo object storage is not configured; set R2_ENDPOINT, "
        "R2_BUCKET, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY"
    )

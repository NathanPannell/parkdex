"""Owned Cloudflare lifecycle for Kip's private-photo Worker and R2 buckets.

This module is called by scripts/kip-delivery.py. It keeps Cloudflare management
credentials local to explicit provider operations and never writes them to a
journal or runtime bundle. Only the persistent staging and production resources are managed.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
import time
import tomllib
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


CF_API = "https://api.cloudflare.com/client/v4"
WRANGLER_CONFIG = Path(os.environ.get("APPDATA", r"C:\Users\n8tew\AppData\Roaming")) / "xdg.config" / ".wrangler" / "config" / "default.toml"
OWNER_OBJECT = "_parkdex-control/private-photos-owner.json"
OWNER_SCHEMA = "parkdex-kip.private-photos-owner/v1"
JOURNAL_SCHEMA = "parkdex-kip.private-photos-journal/v1"
REPOSITORY = "NathanPannell/parkdex-kip"
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
ACCOUNT_RE = re.compile(r"^[0-9a-f]{32}$", re.I)
NAME_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])$")
PAGE_SIZE = 1000
MAX_PAGES = 10000


def _error(delivery, message: str):
    raise delivery.DeliveryError(message)


def _account_id(delivery, config: dict) -> str:
    value = config.get("privatePhotos", {}).get("accountId", "")
    if not ACCOUNT_RE.fullmatch(value):
        _error(delivery, "Private-photo Cloudflare account ID is invalid.")
    return value


def _settings(delivery, config: dict) -> dict:
    settings = config.get("privatePhotos", {})
    required = (
        "sourcePath",
        "stagingWorkerName",
        "stagingBucketName",
        "productionWorkerName",
        "productionBucketName",
        "wranglerVersion",
        "compatibilityDate",
        "retentionCron",
    )
    if any(not isinstance(settings.get(key), str) or not settings[key] for key in required):
        _error(delivery, "Private-photo deployment settings are incomplete.")
    for key in ("stagingWorkerName", "stagingBucketName", "productionWorkerName", "productionBucketName"):
        if not NAME_RE.fullmatch(settings[key]):
            _error(delivery, f"Private-photo {key} is invalid.")
    if not re.fullmatch(r"\d+\.\d+\.\d+", settings["wranglerVersion"]):
        _error(delivery, "Private-photo Wrangler version is invalid.")
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", settings["compatibilityDate"]):
        _error(delivery, "Private-photo compatibility date is invalid.")
    if config.get("repository") != REPOSITORY:
        _error(delivery, "Private-photo repository identity is invalid.")
    return settings


def _api_token(delivery) -> tuple[str, bool]:
    """Return (token, supplied-as-API-token); OAuth is read only from Wrangler config."""
    token = os.environ.get("CLOUDFLARE_API_TOKEN", "").strip()
    direct = bool(token)
    if not token:
        try:
            document = tomllib.loads(WRANGLER_CONFIG.read_text(encoding="utf-8"))
            token = document.get("oauth_token", "")
        except (OSError, tomllib.TOMLDecodeError):
            token = ""
    if not isinstance(token, str) or not token:
        _error(delivery, "Cloudflare API credentials are unavailable. Set CLOUDFLARE_API_TOKEN or sign in with Wrangler locally.")
    delivery.register_secret(token)
    return token, direct


def _api(delivery, config: dict, path: str, *, method="GET", body=None, query=None, not_found_ok=False):
    token, _ = _api_token(delivery)
    try:
        response = delivery.api_json(
            CF_API,
            path,
            token=token,
            method=method,
            body=body,
            query=query,
            not_found_ok=not_found_ok,
        )
    except delivery.DeliveryError:
        raise
    if response is None and not_found_ok:
        return None
    if not isinstance(response, dict) or response.get("success") is not True:
        _error(delivery, f"Cloudflare API {method} operation did not confirm success.")
    return response


def _r2_object(delivery, config: dict, bucket: str, key: str, *, method: str, body: bytes | None = None, sleep=time.sleep):
    account = _account_id(delivery, config)
    token, _ = _api_token(delivery)
    path = f"/accounts/{account}/r2/buckets/{urllib.parse.quote(bucket, safe='')}/objects/{urllib.parse.quote(key, safe='/')}"
    url = CF_API + path
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    if body is not None:
        headers["Content-Type"] = "application/json; charset=utf-8"
    request = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        # Shared with api_json so marker reads retry transient failures and writes never do.
        status, payload = delivery.urlopen_read(
            request,
            timeout=60,
            limit=16_385 if method == "GET" else 2_000_000,
            sleep=sleep,
        )
    except urllib.error.HTTPError as exc:
        if exc.code == 404 and method == "GET":
            return 404, b""
        _error(delivery, f"Cloudflare R2 object {method} request failed with HTTP {exc.code}.")
    except (urllib.error.URLError, TimeoutError, ConnectionError):
        _error(delivery, f"Cloudflare R2 object {method} request could not complete.")
    if method == "GET" and len(payload) > 16_384:
        _error(delivery, "Private-photo ownership marker exceeded its size limit.")
    return status, payload


def _owner_marker(delivery, config: dict, bucket: str) -> dict | None:
    status, payload = _r2_object(delivery, config, bucket, OWNER_OBJECT, method="GET")
    if status == 404:
        return None
    try:
        marker = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        _error(delivery, "Private-photo bucket ownership marker is invalid.")
    if not isinstance(marker, dict):
        _error(delivery, "Private-photo bucket ownership marker is invalid.")
    return marker


def _put_owner_marker(delivery, config: dict, bucket: str, marker: dict) -> None:
    payload = json.dumps(marker, sort_keys=True, separators=(",", ":")).encode("utf-8")
    status, _ = _r2_object(delivery, config, bucket, OWNER_OBJECT, method="PUT", body=payload)
    if status not in (200, 201):
        _error(delivery, "Cloudflare did not confirm the private-photo bucket ownership marker.")


def _r2_path(delivery, config: dict, bucket: str, suffix: str) -> str:
    account = _account_id(delivery, config)
    return f"/accounts/{account}/r2/buckets/{urllib.parse.quote(bucket, safe='')}{suffix}"


def _require_private_bucket(delivery, config: dict, bucket: str) -> None:
    managed = _api(delivery, config, _r2_path(delivery, config, bucket, "/domains/managed"))
    managed_result = managed.get("result")
    if not isinstance(managed_result, dict) or managed_result.get("enabled") is not False:
        _error(delivery, "Private-photo R2 bucket has public r2.dev access enabled or unverified.")
    custom = _api(delivery, config, _r2_path(delivery, config, bucket, "/domains/custom"))
    custom_result = custom.get("result")
    if not isinstance(custom_result, dict) or not isinstance(custom_result.get("domains"), list):
        _error(delivery, "Private-photo R2 custom-domain inventory is incomplete.")
    if custom_result["domains"]:
        _error(delivery, "Private-photo R2 bucket has a custom-domain association and cannot be verified private.")


def _list_buckets(delivery, config: dict) -> list[dict]:
    account = _account_id(delivery, config)
    rows = []
    cursor = None
    seen = set()
    for _ in range(MAX_PAGES):
        query = {"per_page": PAGE_SIZE}
        if cursor:
            query["cursor"] = cursor
        response = _api(delivery, config, f"/accounts/{account}/r2/buckets", query=query)
        result = response.get("result")
        if not isinstance(result, dict) or not isinstance(result.get("buckets"), list):
            _error(delivery, "Cloudflare R2 bucket inventory response is incomplete.")
        rows.extend(item for item in result["buckets"] if isinstance(item, dict))
        next_cursor = (response.get("result_info") or {}).get("cursor")
        if not next_cursor:
            return rows
        if not isinstance(next_cursor, str) or next_cursor in seen:
            _error(delivery, "Cloudflare R2 bucket inventory pagination did not advance.")
        seen.add(next_cursor)
        cursor = next_cursor
    _error(delivery, "Cloudflare R2 bucket inventory exceeded its pagination safety limit.")


def _list_workers(delivery, config: dict) -> list[dict]:
    account = _account_id(delivery, config)
    response = _api(delivery, config, f"/accounts/{account}/workers/scripts")
    result = response.get("result")
    if not isinstance(result, list) or any(not isinstance(item, dict) for item in result):
        _error(delivery, "Cloudflare Worker inventory response is incomplete.")
    return result


def _list_namespaces(delivery, config: dict) -> list[dict]:
    account = _account_id(delivery, config)
    rows = []
    page = 1
    for _ in range(MAX_PAGES):
        response = _api(
            delivery,
            config,
            f"/accounts/{account}/workers/durable_objects/namespaces",
            query={"page": page, "per_page": PAGE_SIZE},
        )
        result = response.get("result")
        info = response.get("result_info")
        if not isinstance(result, list) or not isinstance(info, dict):
            _error(delivery, "Cloudflare Durable Object namespace inventory response is incomplete.")
        rows.extend(item for item in result if isinstance(item, dict))
        total_pages = info.get("total_pages")
        if isinstance(total_pages, int) and page >= total_pages:
            return rows
        if not total_pages and len(result) < PAGE_SIZE:
            return rows
        page += 1
    _error(delivery, "Cloudflare Durable Object namespace inventory exceeded its pagination safety limit.")


def _subdomain(delivery, config: dict) -> str:
    account = _account_id(delivery, config)
    response = _api(delivery, config, f"/accounts/{account}/workers/subdomain")
    value = (response.get("result") or {}).get("subdomain")
    if not isinstance(value, str) or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", value):
        _error(delivery, "Cloudflare Workers subdomain is missing or invalid.")
    return value


def _service_url(worker_name: str, subdomain: str) -> str:
    return f"https://{worker_name}.{subdomain}.workers.dev"


def _health(url: str) -> dict:
    request = urllib.request.Request(url + "/health", headers={"Accept": "application/json", "User-Agent": "Parkdex-Kip-Delivery/1.0"})
    opener = urllib.request.build_opener(_NoRedirect())
    try:
        with opener.open(request, timeout=20) as response:
            if response.status != 200:
                raise RuntimeError("Worker health returned a non-success response.")
            payload = response.read(16_384)
    except (urllib.error.URLError, TimeoutError, RuntimeError):
        raise RuntimeError("Private-photo Worker health check could not complete.") from None
    try:
        result = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise RuntimeError("Private-photo Worker health response was invalid.") from None
    if not isinstance(result, dict):
        raise RuntimeError("Private-photo Worker health response was invalid.")
    return result


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        return None


def _worker_path(delivery, config: dict, worker_name: str, suffix: str = "") -> str:
    account = _account_id(delivery, config)
    return f"/accounts/{account}/workers/scripts/{urllib.parse.quote(worker_name, safe='')}{suffix}"


def _worker_settings(delivery, config: dict, worker_name: str) -> dict | None:
    response = _api(delivery, config, _worker_path(delivery, config, worker_name, "/settings"), not_found_ok=True)
    if response is None:
        return None
    result = response.get("result")
    if not isinstance(result, dict):
        _error(delivery, "Cloudflare Worker settings response is incomplete.")
    return result


def _binding_map(delivery, settings: dict) -> dict[str, dict]:
    bindings = settings.get("bindings")
    if not isinstance(bindings, list):
        _error(delivery, "Private-photo Worker binding inventory is incomplete.")
    result = {}
    for binding in bindings:
        if isinstance(binding, dict) and isinstance(binding.get("name"), str):
            result[binding["name"]] = binding
    return result


def _binding_value(binding: dict) -> str | None:
    for key in ("text", "value"):
        value = binding.get(key)
        if isinstance(value, str):
            return value
    return None


def _check_worker_settings(
    delivery,
    settings: dict,
    identity: dict,
    release_sha: str | None,
    *,
    require_secrets: bool = True,
    require_storage: bool = True,
) -> dict:
    bindings = _binding_map(delivery, settings)
    expected = {
        "KIP_ENVIRONMENT": identity["environment"],
        "KIP_REPOSITORY": REPOSITORY,
        "KIP_RESOURCE_ID": identity["resourceId"],
        "KIP_PHOTO_BUCKET": identity["bucketName"],
    }
    if release_sha is not None:
        expected["KIP_RELEASE_SHA"] = release_sha
        expected["RELEASE_SHA"] = release_sha
        expected["KIP_CANDIDATE_SHA"] = release_sha
    expected["RETENTION_URL"] = identity["retentionUrl"]
    for name, value in expected.items():
        binding = bindings.get(name)
        if not binding or _binding_value(binding) != value:
            _error(delivery, f"Private-photo Worker ownership metadata mismatch for {name}.")
    if release_sha is None:
        provenance_names = ("KIP_RELEASE_SHA", "RELEASE_SHA", "KIP_CANDIDATE_SHA")
        release_values = [_binding_value(bindings.get(name, {})) for name in provenance_names]
        if any(not isinstance(value, str) or not SHA_RE.fullmatch(value) for value in release_values) or len(set(release_values)) != 1:
            _error(delivery, "Private-photo Worker release provenance is missing or inconsistent.")
    for name in ("PHOTO_SERVICE_TOKEN", "KIP_RETENTION_SECRET"):
        secret = bindings.get(name)
        if require_secrets and (not secret or secret.get("type") not in ("secret_text", "secret_text_binding")):
            _error(delivery, f"Private-photo Worker {name} binding is missing or not secret.")
        if secret and secret.get("type") not in ("secret_text", "secret_text_binding"):
            _error(delivery, f"Private-photo Worker {name} binding is not secret.")
    namespace_id = None
    if require_storage:
        bucket = bindings.get("PHOTOS")
        if not bucket or bucket.get("type") not in ("r2_bucket", "r2") or bucket.get("bucket_name", bucket.get("bucketName")) != identity["bucketName"]:
            _error(delivery, "Private-photo Worker is not bound to its exact private R2 bucket.")
        do = bindings.get("ACCOUNT_PHOTOS")
        if not do or do.get("type") not in ("durable_object_namespace", "durable_object") or do.get("class_name", do.get("className")) != "AccountPhotos":
            _error(delivery, "Private-photo Worker Durable Object binding is missing or incorrect.")
        namespace_id = do.get("namespace_id", do.get("namespaceId"))
    return {"namespaceId": namespace_id} if namespace_id else {}


def _check_retired_worker_settings(delivery, settings: dict, identity: dict) -> None:
    _check_worker_settings(delivery, settings, identity, None, require_secrets=False, require_storage=False)
    bindings = _binding_map(delivery, settings)
    if any(binding.get("type") in ("r2_bucket", "r2", "durable_object_namespace", "durable_object") for binding in bindings.values()):
        _error(delivery, "Retired private-photo Worker still has a storage binding.")


def _worker_owned_namespaces(delivery, config: dict, worker_name: str) -> list[dict]:
    return [item for item in _list_namespaces(delivery, config) if item.get("script") == worker_name and item.get("class") == "AccountPhotos"]


def _verify_namespace(delivery, config: dict, worker_name: str, binding_info: dict | None = None) -> dict:
    namespaces = _worker_owned_namespaces(delivery, config, worker_name)
    if len(namespaces) != 1 or not namespaces[0].get("id") or namespaces[0].get("use_sqlite") is not True:
        _error(delivery, "Private-photo Worker must own exactly one SQLite AccountPhotos namespace.")
    if binding_info and binding_info.get("namespaceId") and binding_info["namespaceId"] != namespaces[0]["id"]:
        _error(delivery, "Private-photo Worker binding points at an unexpected Durable Object namespace.")
    return namespaces[0]


def _worker_url(delivery, config: dict, worker_name: str) -> str:
    return _service_url(worker_name, _subdomain(delivery, config))


def _marker(identity: dict) -> dict:
    marker = {
        "schema": OWNER_SCHEMA,
        "repository": REPOSITORY,
        "environment": identity["environment"],
        "resourceId": identity["resourceId"],
        "bucketName": identity["bucketName"],
        "workerName": identity["workerName"],
    }
    return marker


def _save(delivery, journal: Path, state: dict) -> None:
    delivery.save_json(Path(journal), state)


def _set_step(delivery, journal: Path | None, state: dict, step: str, value: dict) -> None:
    state.setdefault("intent", {}).setdefault("cloudflarePhotos", {})[step] = value
    if journal:
        _save(delivery, journal, state)


def _bucket_names(delivery, config: dict) -> set[str]:
    return {item.get("name") for item in _list_buckets(delivery, config) if isinstance(item.get("name"), str)}


def _ensure_bucket(delivery, config: dict, identity: dict, journal: Path | None, state: dict) -> None:
    bucket = identity["bucketName"]
    expected_marker = _marker(identity)
    names = _bucket_names(delivery, config)
    if bucket in names:
        existing_marker = _owner_marker(delivery, config, bucket)
        if existing_marker != expected_marker:
            create_step = state.get("intent", {}).get("cloudflarePhotos", {}).get("bucketCreate", {})
            if (
                existing_marker is None
                and create_step.get("name") == bucket
                and create_step.get("owner") == expected_marker
                and create_step.get("status") == "created"
            ):
                _set_step(delivery, journal, state, "bucketMarker", {"status": "intent", "name": bucket, "owner": expected_marker})
                _put_owner_marker(delivery, config, bucket, expected_marker)
                _set_step(delivery, journal, state, "bucketMarker", {"status": "stored", "name": bucket, "owner": expected_marker})
            else:
                _error(delivery, "A same-named R2 bucket exists without this release's exact ownership marker; preserving it for manual inspection.")
    else:
        _set_step(
            delivery,
            journal,
            state,
            "bucketCreate",
            {
                "status": "intent",
                "name": bucket,
                "owner": expected_marker,
            },
        )
        response = _api(
            delivery,
            config,
            f"/accounts/{_account_id(delivery, config)}/r2/buckets",
            method="POST",
            body={"name": bucket},
        )
        result = response.get("result")
        if not isinstance(result, dict) or result.get("name") != bucket:
            _error(delivery, "Cloudflare did not confirm the exact private-photo R2 bucket creation.")
        _set_step(delivery, journal, state, "bucketCreate", {"status": "created", "name": bucket, "owner": expected_marker})
        _set_step(delivery, journal, state, "bucketMarker", {"status": "intent", "name": bucket, "owner": expected_marker})
        _put_owner_marker(delivery, config, bucket, expected_marker)
        _set_step(delivery, journal, state, "bucketMarker", {"status": "stored", "name": bucket, "owner": expected_marker})
    _require_private_bucket(delivery, config, bucket)
    state.setdefault("resources", {})["photoBucketName"] = bucket
    if journal:
        _save(delivery, journal, state)


def _check_bucket_owned(delivery, config: dict, identity: dict) -> bool:
    if identity["bucketName"] not in _bucket_names(delivery, config):
        return False
    marker = _owner_marker(delivery, config, identity["bucketName"])
    if marker != _marker(identity):
        _error(delivery, "Private-photo bucket ownership marker does not match the expected release.")
    _require_private_bucket(delivery, config, identity["bucketName"])
    return True


def _source_file(delivery, config: dict, source_root: Path) -> Path:
    settings = _settings(delivery, config)
    root = Path(source_root).resolve()
    path = (root / settings["sourcePath"]).resolve()
    if not path.is_relative_to(root) or not path.is_file() or path.suffix != ".mjs":
        _error(delivery, "Private-photo Worker source is missing or escapes the candidate checkout.")
    return path


def validate_candidate(delivery, config: dict, candidate_root: Path, *, environment: str = "staging") -> None:
    """Compile the Worker with the pinned Wrangler while isolating all credentials."""
    path = _source_file(delivery, config, candidate_root)
    try:
        source = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        _error(delivery, "Private-photo Worker source could not be read as UTF-8.")
    required = (
        "export class AccountPhotos",
        "export function createPhotoWorker",
        "PHOTO_SERVICE_TOKEN",
        "ACCOUNT_PHOTOS",
        "PHOTOS",
        "PHOTO_MAX_BYTES",
        "KIP_RETENTION_SECRET",
        "RETENTION_URL",
    )
    if any(fragment not in source for fragment in required):
        _error(delivery, "Private-photo Worker source is missing a required storage or retention contract.")
    if "aws4fetch" in source or "@aws-sdk" in source or "S3_ACCESS_KEY" in source:
        _error(delivery, "Private-photo Worker must use its scoped Cloudflare R2 binding, not management or S3 credentials.")
    identity = _persistent_identity(config, environment)
    with tempfile.TemporaryDirectory(prefix="parkdex-kip-photos-dry-run-") as temp:
        directory = Path(temp)
        config_path = _write_worker_project(delivery, config, path, identity["workerName"], identity["bucketName"], "0" * 40, identity, directory)
        auth_root = directory / "isolated-auth"
        auth_root.mkdir()
        _wrangler(
            delivery,
            config,
            ["deploy", "--dry-run", "--config", str(config_path), "--outdir", str(directory / "bundle")],
            cwd=directory,
            credential_free=True,
            auth_root=auth_root,
        )


def _worker_vars(identity: dict, release_sha: str) -> dict[str, str]:
    variables = {
        "RELEASE_SHA": release_sha,
        "KIP_ENVIRONMENT": identity["environment"],
        "KIP_REPOSITORY": REPOSITORY,
        "KIP_RESOURCE_ID": identity["resourceId"],
        "KIP_PHOTO_BUCKET": identity["bucketName"],
        "KIP_RELEASE_SHA": release_sha,
        "KIP_CANDIDATE_SHA": release_sha,
        "RETENTION_URL": identity["retentionUrl"],
    }
    return variables


def _worker_config(config: dict, identity: dict, release_sha: str, *, enable_retention: bool = True) -> dict:
    settings = config["privatePhotos"]
    result = {
        "name": identity["workerName"],
        "main": "private-photos.mjs",
        "compatibility_date": settings["compatibilityDate"],
        "account_id": settings["accountId"],
        "workers_dev": True,
        "vars": _worker_vars(identity, release_sha),
        "r2_buckets": [{"binding": "PHOTOS", "bucket_name": identity["bucketName"]}],
        "durable_objects": {"bindings": [{"name": "ACCOUNT_PHOTOS", "class_name": "AccountPhotos"}]},
        "migrations": [{"tag": "v1", "new_sqlite_classes": ["AccountPhotos"]}],
    }
    if enable_retention:
        result["triggers"] = {"crons": [settings["retentionCron"]]}
    return result


def _write_worker_project(
    delivery,
    config: dict,
    source_path: Path,
    worker_name: str,
    bucket_name: str,
    release_sha: str,
    identity: dict,
    directory: Path,
    *,
    enable_retention: bool = True,
) -> Path:
    _settings(delivery, config)
    shutil.copyfile(source_path, directory / "private-photos.mjs")
    worker_config = _worker_config(config, identity, release_sha, enable_retention=enable_retention)
    config_path = directory / "wrangler.jsonc"
    config_path.write_text(json.dumps(worker_config, indent=2) + "\n", encoding="utf-8")
    return config_path


def _wrangler(
    delivery,
    config: dict,
    args: list[str],
    *,
    cwd: Path,
    secret: str | None = None,
    credential_free: bool = False,
    auth_root: Path | None = None,
) -> None:
    version = _settings(delivery, config)["wranglerVersion"]
    command = [*delivery.npm_args(), "exec", "--yes", f"--package=wrangler@{version}", "--", "wrangler", *args]
    extra = {}
    if credential_free:
        if auth_root is None:
            _error(delivery, "Credential-free Wrangler compilation requires an isolated auth directory.")
        auth_root = Path(auth_root).resolve()
        auth_root.mkdir(parents=True, exist_ok=True)
        for key in ("APPDATA", "LOCALAPPDATA", "USERPROFILE", "HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "NPM_CONFIG_CACHE"):
            extra[key] = str(auth_root)
    else:
        direct_token = os.environ.get("CLOUDFLARE_API_TOKEN", "").strip()
        if direct_token:
            delivery.register_secret(direct_token)
            extra["CLOUDFLARE_API_TOKEN"] = direct_token
    env = delivery.safe_env(extra=extra)
    delivery.run(command, cwd=cwd, env=env, input_text=secret, label="Cloudflare Wrangler")


def _deploy_worker(
    delivery,
    config: dict,
    source_path: Path,
    identity: dict,
    release_sha: str,
    secrets: dict[str, str],
    journal: Path | None,
    state: dict,
    *,
    enable_retention: bool = True,
) -> dict:
    for key, value in secrets.items():
        if not isinstance(value, str) or len(value) < 32:
            _error(delivery, f"{key} must be configured with at least 32 random characters.")
        delivery.register_secret(value)
    existing_settings = _worker_settings(delivery, config, identity["workerName"])
    if existing_settings is None:
        existing_scripts = _list_workers(delivery, config)
        if any(item.get("id") == identity["workerName"] or item.get("script_name") == identity["workerName"] for item in existing_scripts):
            _error(delivery, "A same-named private-photo Worker exists but its settings are unavailable; preserving it.")
    else:
        binding_info = _check_worker_settings(delivery, existing_settings, identity, None, require_secrets=False)
        namespace = _verify_namespace(delivery, config, identity["workerName"], binding_info)
        previous_id = state.get("resources", {}).get("photoDoNamespaceId") or state.get("resources", {}).get("doNamespaceId")
        if previous_id and previous_id != namespace["id"]:
            _error(delivery, "Existing private-photo Worker namespace does not match the ownership journal; preserving it.")
    temp = tempfile.TemporaryDirectory(prefix="parkdex-kip-photos-worker-")
    directory = Path(temp.name)
    try:
        config_path = _write_worker_project(
            delivery,
            config,
            source_path,
            identity["workerName"],
            identity["bucketName"],
            release_sha,
            identity,
            directory,
            enable_retention=enable_retention,
        )
        message = f"Parkdex Kip {identity['environment']} {identity['resourceId']} {release_sha}"
        _set_step(
            delivery,
            journal,
            state,
            "workerDeploy",
            {
                "status": "intent",
                "name": identity["workerName"],
                "bucketName": identity["bucketName"],
                "environment": identity["environment"],
                "resourceId": identity["resourceId"],
                "releaseSha": release_sha,
            },
        )
        _wrangler(
            delivery,
            config,
            [
                "deploy",
                "--config",
                str(config_path),
                "--tag",
                release_sha,
                "--message",
                message,
            ],
            cwd=directory,
        )
        _set_step(
            delivery,
            journal,
            state,
            "workerDeploy",
            {
                "status": "deployed",
                "name": identity["workerName"],
                "bucketName": identity["bucketName"],
                "environment": identity["environment"],
                "resourceId": identity["resourceId"],
                "releaseSha": release_sha,
            },
        )
        namespace = _verify_namespace(delivery, config, identity["workerName"])
        state.setdefault("resources", {}).update(
            {
                "photoWorkerName": identity["workerName"],
                "photoBucketName": identity["bucketName"],
                "photoDoNamespaceId": namespace["id"],
            }
        )
        _set_step(
            delivery,
            journal,
            state,
            "workerDeploy",
            {
                "status": "deployed",
                "name": identity["workerName"],
                "bucketName": identity["bucketName"],
                "environment": identity["environment"],
                "resourceId": identity["resourceId"],
                "releaseSha": release_sha,
                "doNamespaceId": namespace["id"],
            },
        )
        for name, secret_value in secrets.items():
            _set_step(delivery, journal, state, f"secret-{name}", {"status": "intent", "name": identity["workerName"]})
            _wrangler(
                delivery,
                config,
                [
                    "secret",
                    "put",
                    name,
                    "--name",
                    identity["workerName"],
                    "--config",
                    str(config_path),
                ],
                cwd=directory,
                secret=secret_value + "\n",
            )
            _set_step(delivery, journal, state, f"secret-{name}", {"status": "stored", "name": identity["workerName"]})
        settings = _worker_settings(delivery, config, identity["workerName"])
        if settings is None:
            _error(delivery, "Cloudflare did not expose the deployed private-photo Worker settings.")
        binding_info = _check_worker_settings(delivery, settings, identity, release_sha)
        verified_namespace = _verify_namespace(delivery, config, identity["workerName"], binding_info)
        if verified_namespace["id"] != namespace["id"]:
            _error(delivery, "Private-photo Worker Durable Object namespace changed during deployment.")
        url = _worker_url(delivery, config, identity["workerName"])
        state.setdefault("resources", {}).update(
            {
                "photoWorkerName": identity["workerName"],
                "photoBucketName": identity["bucketName"],
                "photoServiceUrl": url,
                "photoReleaseSha": release_sha,
                "photoDoNamespaceId": namespace["id"],
            }
        )
        if journal:
            _save(delivery, journal, state)
        return {
            "workerName": identity["workerName"],
            "bucketName": identity["bucketName"],
            "photoServiceUrl": url,
            "releaseSha": release_sha,
            "doNamespaceId": namespace["id"],
        }
    finally:
        temp.cleanup()


def _persistent_identity(config: dict, environment: str, release_sha: str | None = None) -> dict:
    if environment not in ("staging", "production"):
        raise ValueError("persistent private-photo environment must be staging or production")
    settings = config["privatePhotos"]
    prefix = "production" if environment == "production" else "staging"
    app_url = config["productionUrl"] if environment == "production" else config["stagingUrl"]
    result = {
        "environment": environment,
        "resourceId": environment,
        "bucketName": settings[f"{prefix}BucketName"],
        "workerName": settings[f"{prefix}WorkerName"],
        "retentionUrl": app_url.rstrip("/") + "/api/retention/interactions/purge",
    }
    if release_sha:
        result["releaseSha"] = release_sha
    return result


def _staging_identity(config: dict, release_sha: str | None = None) -> dict:
    return _persistent_identity(config, "staging", release_sha)


def _production_identity(config: dict, release_sha: str | None = None) -> dict:
    return _persistent_identity(config, "production", release_sha)


def _staging_marker(config: dict) -> dict:
    return _marker(_staging_identity(config))


def _verify_persistent_resources(delivery, config: dict, environment: str, expected_sha: str | None = None) -> dict:
    identity = _persistent_identity(config, environment)
    if not _check_bucket_owned(delivery, config, identity):
        _error(delivery, f"The owned private-photo {environment} bucket is missing; run explicit {environment} photo provisioning.")
    settings = _worker_settings(delivery, config, identity["workerName"])
    if settings is None:
        _error(delivery, f"The owned private-photo {environment} Worker is missing; run explicit {environment} photo provisioning.")
    binding_info = _check_worker_settings(delivery, settings, identity, expected_sha)
    namespace = _verify_namespace(delivery, config, identity["workerName"], binding_info)
    url = _worker_url(delivery, config, identity["workerName"])
    if expected_sha:
        health = _health(url)
        if health.get("status") != "ok" or health.get("releaseSha") != expected_sha:
            _error(delivery, f"Private-photo {environment} health did not report the exact release SHA.")
    return {"identity": identity, "settings": settings, "namespace": namespace, "url": url}


def _verify_staging_resources(delivery, config: dict, expected_sha: str | None = None) -> dict:
    return _verify_persistent_resources(delivery, config, "staging", expected_sha)


def _verify_production_resources(delivery, config: dict, expected_sha: str | None = None) -> dict:
    return _verify_persistent_resources(delivery, config, "production", expected_sha)


def _runtime_photo_secrets(delivery, bundle: dict, *, environment: str) -> dict[str, str]:
    secrets = {}
    for name in ("KIP_PHOTO_SERVICE_TOKEN", "KIP_RETENTION_SECRET"):
        value = bundle.get(name)
        if not isinstance(value, str) or len(value) < 32:
            _error(delivery, f"{name} must be configured with at least 32 random characters.")
        delivery.register_secret(value)
        secret_name = "PHOTO_SERVICE_TOKEN" if name == "KIP_PHOTO_SERVICE_TOKEN" else name
        secrets[secret_name] = value
    if len(set(secrets.values())) != len(secrets):
        _error(delivery, "Photo and retention Worker secrets must be distinct.")
    return secrets


def _journal_load(delivery, journal: Path, config: dict, environment: str = "staging") -> dict:
    identity = _persistent_identity(config, environment)
    expected = {
        "schema": JOURNAL_SCHEMA,
        "repository": REPOSITORY,
        "environment": environment,
        "accountId": _account_id(delivery, config),
        "workerName": identity["workerName"],
        "bucketName": identity["bucketName"],
    }
    if Path(journal).exists():
        try:
            state = json.loads(Path(journal).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            _error(delivery, "Private-photo staging ownership journal is invalid.")
        if not isinstance(state, dict) or any(state.get(key) != value for key, value in expected.items()):
            _error(delivery, "Private-photo staging ownership journal does not match this deployment configuration.")
        return state
    return {**expected, "resources": {}, "intent": {}, "status": "new"}


def provision_environment(
    delivery,
    config: dict,
    journal: Path,
    environment: str,
    *,
    apply: bool = False,
    candidate_root: Path | None = None,
    release_sha: str | None = None,
) -> dict:
    """Explicit one-time persistent setup. The default call only records and prints a plan."""
    if environment not in ("staging", "production"):
        _error(delivery, "Persistent private-photo provisioning requires staging or production.")
    settings = _settings(delivery, config)
    journal = Path(journal)
    state = _journal_load(delivery, journal, config, environment)
    identity = _persistent_identity(config, environment)
    if release_sha is not None and candidate_root is None:
        _error(delivery, "A source release SHA requires its trusted candidate source root.")
    if apply and candidate_root is not None and release_sha is None:
        _error(delivery, "Candidate staging provisioning requires the exact source release SHA.")
    source_root = Path(candidate_root) if candidate_root is not None else Path(delivery.ROOT)
    source = _source_file(delivery, config, source_root)
    validate_candidate(delivery, config, source_root, environment=environment)
    if not apply:
        state["status"] = "planned"
        state["plannedResources"] = {"workerName": identity["workerName"], "bucketName": identity["bucketName"], "environment": environment}
        _save(delivery, journal, state)
        print(f"plan=provision private {environment} R2 bucket {identity['bucketName']} and Worker {identity['workerName']}")
        print(f"plan=configure private R2 access, PHOTO_SERVICE_TOKEN, KIP_RETENTION_SECRET, and cron {settings['retentionCron']}")
        return {"status": "planned", "workerName": identity["workerName"], "bucketName": identity["bucketName"]}

    bundle = delivery.read_runtime_bundle(config, environment=environment)
    secrets = _runtime_photo_secrets(delivery, bundle, environment=environment)
    if release_sha is None:
        release_sha = delivery.git("rev-parse", "HEAD", cwd=source_root)
    if not SHA_RE.fullmatch(release_sha):
        _error(delivery, f"{environment.capitalize()} provisioning requires a full source release SHA.")
    state["status"] = "provisioning"
    state["releaseSha"] = release_sha
    _save(delivery, journal, state)
    _ensure_bucket(delivery, config, identity, journal, state)
    deployment = _deploy_worker(
        delivery,
        config,
        source,
        identity,
        release_sha,
        secrets,
        journal,
        state,
        enable_retention=False,
    )
    health = _health(deployment["photoServiceUrl"])
    if health.get("status") != "ok" or health.get("releaseSha") != release_sha:
        _error(delivery, f"Private-photo {environment} provisioning health did not report its exact source SHA.")
    state.setdefault("resources", {}).update(
        {
            "workerName": identity["workerName"],
            "bucketName": identity["bucketName"],
            "photoServiceUrl": deployment["photoServiceUrl"],
            "doNamespaceId": deployment["doNamespaceId"],
            "releaseSha": release_sha,
        }
    )
    state["status"] = "provisioned"
    _save(delivery, journal, state)
    print(f"photo-service-url={deployment['photoServiceUrl']}")
    print(f"photo-worker={identity['workerName']}")
    print(f"photo-bucket={identity['bucketName']}")
    print(f"photo-release-sha={release_sha}")
    return {"status": "provisioned", **deployment}


def provision_staging(delivery, config: dict, journal: Path, **kwargs) -> dict:
    return provision_environment(delivery, config, journal, "staging", **kwargs)


def provision_production(delivery, config: dict, journal: Path, **kwargs) -> dict:
    return provision_environment(delivery, config, journal, "production", **kwargs)


def dispatch_environment(delivery, config: dict, root: Path, sha: str, bundle: dict, environment: str) -> dict:
    if not SHA_RE.fullmatch(sha or ""):
        _error(delivery, f"{environment.capitalize()} private-photo dispatch requires a full merged SHA.")
    if environment not in ("staging", "production"):
        _error(delivery, "Private-photo dispatch requires staging or production.")
    _settings(delivery, config)
    source = _source_file(delivery, config, root)
    identity = _persistent_identity(config, environment)
    journal = Path(delivery.state_root()) / "persistent" / f"private-photos-{environment}.json"
    state = _journal_load(delivery, journal, config, environment)
    existing = _verify_persistent_resources(delivery, config, environment)
    if bundle.get("KIP_PHOTO_SERVICE_URL") != existing["url"]:
        _error(delivery, f"{environment.capitalize()} runtime photo-service URL does not match the owned Cloudflare Worker.")
    # A persistent dispatch is never a bootstrap path. It must use a previously owned bucket.
    secrets = _runtime_photo_secrets(delivery, bundle, environment=environment)
    deployment = _deploy_worker(delivery, config, source, identity, sha, secrets, journal, state)
    state.setdefault("resources", {}).update(
        {
            "workerName": identity["workerName"],
            "bucketName": identity["bucketName"],
            "photoServiceUrl": deployment["photoServiceUrl"],
            "doNamespaceId": deployment["doNamespaceId"],
            "releaseSha": sha,
        }
    )
    state["status"] = "dispatched"
    _save(delivery, journal, state)
    return {"worker": identity["workerName"], "bucket": identity["bucketName"], "sha": sha, "url": deployment["photoServiceUrl"]}


def dispatch_staging(delivery, config: dict, root: Path, sha: str, bundle: dict) -> dict:
    return dispatch_environment(delivery, config, root, sha, bundle, "staging")


def dispatch_production(delivery, config: dict, root: Path, sha: str, bundle: dict) -> dict:
    return dispatch_environment(delivery, config, root, sha, bundle, "production")


def verify_environment(delivery, config: dict, sha: str, environment: str) -> None:
    if not SHA_RE.fullmatch(sha or ""):
        _error(delivery, f"{environment.capitalize()} private-photo verification requires a full merged SHA.")
    _verify_persistent_resources(delivery, config, environment, sha)


def verify_staging(delivery, config: dict, sha: str) -> None:
    verify_environment(delivery, config, sha, "staging")


def verify_production(delivery, config: dict, sha: str) -> None:
    verify_environment(delivery, config, sha, "production")

#!/usr/bin/env python3
"""Explicit, journaled CI, staging and production delivery for Parkdex Kip."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import threading
import urllib.error
import urllib.parse
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = ROOT / "deployment.json"
REPOSITORY = "NathanPannell/parkdex-kip"
NEON_API = "https://console.neon.tech/api/v2"
VERCEL_API = "https://api.vercel.com"
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
ID_RE = re.compile(r"^[0-9]+$")
GOOGLE_CLIENT_ID_PATTERN = re.compile(r"[0-9]+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com")
SECRET_VALUES: list[str] = []
JOURNAL_LOCK = threading.RLock()


class DeliveryError(RuntimeError):
    pass


def load_config() -> dict:
    try:
        config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except Exception as exc:
        raise DeliveryError("Could not read deployment.json.") from exc
    if config.get("schema") != "parkdex-kip.deployment/v1" or config.get("repository") != REPOSITORY:
        raise DeliveryError("deployment.json identity is invalid.")
    return config


def register_secret(value: str | None) -> None:
    if value and value not in SECRET_VALUES:
        SECRET_VALUES.append(value)


def redact(value: str) -> str:
    cleaned = value
    for secret in sorted(SECRET_VALUES, key=len, reverse=True):
        cleaned = cleaned.replace(secret, "[redacted]")
    cleaned = re.sub(r"postgres(?:ql)?://[^\s\"']+", "postgres://[redacted]", cleaned, flags=re.I)
    cleaned = re.sub(r"(?i)bearer\s+[A-Za-z0-9._~+/-]+=*", "Bearer [redacted]", cleaned)
    return cleaned


def safe_env(*, gh: bool = False, extra: dict[str, str] | None = None) -> dict[str, str]:
    allowed = {
        "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR",
        "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "CI", "LANG", "LC_ALL", "LC_CTYPE",
    }
    env = {key: value for key, value in os.environ.items() if key.upper() in allowed}
    env["CI"] = "1"
    env["NO_COLOR"] = "1"
    env["GIT_TERMINAL_PROMPT"] = "0"
    if gh:
        for key in ("GH_TOKEN", "GITHUB_TOKEN"):
            if os.environ.get(key):
                env[key] = os.environ[key]
    if extra:
        env.update(extra)
    return env


FAILURE_MARKER = re.compile(r"(?:\bError\b|Error:|AssertionError|\berror:|Traceback|\bFAIL(?:ED)?\b|✖)")
FAILURE_EXCERPT_CHARS = 1200
FAILURE_TAIL_CHARS = 800
FAILURE_PROGRESS_LINES = 3


def failure_detail(stdout: str, stderr: str) -> str:
    """A bounded, redacted account of a failed command: the lines around the first error, the end
    of the output, and the last progress lines on stdout. A tail alone can be all object dump."""
    output = redact((stderr or stdout or "").strip())
    if not output:
        return ""
    if len(output) <= FAILURE_EXCERPT_CHARS + FAILURE_TAIL_CHARS:
        parts = [output]
    else:
        lines = output.splitlines()
        first = next((index for index, line in enumerate(lines) if FAILURE_MARKER.search(line)), None)
        parts = []
        if first is not None:
            excerpt = "\n".join(lines[max(0, first - 2):first + 12])[:FAILURE_EXCERPT_CHARS]
            parts.append(f"first error:\n{excerpt}")
        else:
            parts.append(f"start of output:\n{output[:FAILURE_EXCERPT_CHARS]}")
        parts.append(f"end of output:\n{output[-FAILURE_TAIL_CHARS:]}")
    if stderr.strip() and stdout.strip():
        progress = redact(stdout.strip()).splitlines()[-FAILURE_PROGRESS_LINES:]
        parts.append("last progress on stdout:\n" + "\n".join(line[:200] for line in progress))
    return "\n...\n".join(parts)


def run(
    args: list[str],
    *,
    cwd: Path | None = None,
    env: dict[str, str] | None = None,
    input_text: str | None = None,
    label: str | None = None,
    timeout: int = 1200,
) -> str:
    try:
        result = subprocess.run(
            args,
            cwd=str(cwd) if cwd else None,
            env=env or safe_env(),
            input=input_text,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise DeliveryError(f"{label or Path(args[0]).name} could not complete.") from exc
    if result.returncode != 0:
        detail = failure_detail(result.stdout or "", result.stderr or "")
        suffix = f": {detail}" if detail else ""
        raise DeliveryError(f"{label or Path(args[0]).name} failed with exit code {result.returncode}{suffix}")
    return result.stdout.strip()


def git(*args: str, cwd: Path = ROOT, env: dict[str, str] | None = None) -> str:
    return run(["git", "-C", str(cwd), *args], cwd=cwd, env=env or safe_env(), label="git")


def npm_args() -> list[str]:
    if os.name != "nt":
        executable = shutil.which("npm")
        if executable:
            return [executable]
        raise DeliveryError("npm was not found on PATH.")
    node = shutil.which("node.exe") or shutil.which("node")
    if not node:
        raise DeliveryError("Node.js was not found on PATH.")
    npm_cmd = shutil.which("npm.cmd") or shutil.which("npm")
    candidates = []
    if npm_cmd:
        candidates.append(Path(npm_cmd).parent / "node_modules" / "npm" / "bin" / "npm-cli.js")
    for prefix in (os.environ.get("APPDATA"), os.environ.get("ProgramFiles"), os.environ.get("NPM_CONFIG_PREFIX")):
        if prefix:
            candidates.append(Path(prefix) / "npm" / "node_modules" / "npm" / "bin" / "npm-cli.js")
    for candidate in candidates:
        if candidate.is_file():
            return [node, str(candidate)]
    raise DeliveryError("Could not locate npm-cli.js for isolated candidate validation.")


def vercel_args() -> list[str]:
    node = shutil.which("node.exe") or shutil.which("node")
    if os.name == "nt":
        candidates: list[Path] = []
        for executable in (shutil.which("vercel.cmd"), shutil.which("vercel.ps1"), shutil.which("vercel")):
            if executable:
                candidates.append(Path(executable).parent / "node_modules" / "vercel" / "dist" / "vc.js")
        for prefix in (os.environ.get("APPDATA"), os.environ.get("NPM_CONFIG_PREFIX")):
            if prefix:
                candidates.append(Path(prefix) / "npm" / "node_modules" / "vercel" / "dist" / "vc.js")
        if node:
            for candidate in candidates:
                if candidate.is_file():
                    return [node, str(candidate)]
        raise DeliveryError("Install the configured Vercel CLI before running provider operations.")
    executable = shutil.which("vercel")
    if executable:
        return [executable]
    raise DeliveryError("Install the configured Vercel CLI before running provider operations.")


def state_root() -> Path:
    """Local home of the persistent staging and production photo journals.

    The directory name is historical (it once held PR preview journals); existing journals live there."""
    base = os.environ.get("LOCALAPPDATA") if os.name == "nt" else os.environ.get("XDG_STATE_HOME")
    if base:
        return Path(base).resolve() / "Parkdex" / "kip-preview-pr"
    return Path.home() / ".local" / "state" / "Parkdex" / "kip-preview-pr"


def save_json(path: Path, data: dict) -> None:
    with JOURNAL_LOCK:
        _save_json(path, data)


def _save_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(path.parent, 0o700)
    except OSError:
        pass
    temp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
        stream.write(json.dumps(data, indent=2) + "\n")
    os.replace(temp, path)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def assert_origin() -> None:
    origin = git("remote", "get-url", "origin").strip()
    valid = re.fullmatch(
        r"(?:https://github\.com/|git@github\.com:)NathanPannell/parkdex-kip(?:\.git)?",
        origin,
        flags=re.I,
    )
    if not valid:
        raise DeliveryError("Git origin is not NathanPannell/parkdex-kip.")


def assert_clean_branch_harness(config: dict, branch: str) -> tuple[str, str]:
    assert_origin()
    if git("status", "--porcelain"):
        raise DeliveryError(f"Run release setup from a clean {branch} checkout.")
    git("fetch", "--no-tags", "origin", f"+refs/heads/{branch}:refs/remotes/origin/{branch}")
    base_sha = git("rev-parse", f"refs/remotes/origin/{branch}")
    head_sha = git("rev-parse", "HEAD")
    if head_sha != base_sha:
        raise DeliveryError(f"The trusted harness must be at the current origin/{branch} SHA.")
    return head_sha, git("rev-parse", "--show-toplevel")


def assert_clean_staging_harness(config: dict) -> tuple[str, str]:
    return assert_clean_branch_harness(config, config["stagingBranch"])


def set_release_file(root: Path, sha: str, environment: str) -> None:
    if environment not in ("staging", "production") or not SHA_RE.fullmatch(sha):
        raise DeliveryError("Release metadata requires an exact SHA and a supported environment.")
    target = root / "public" / "release.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps({"sha": sha, "environment": environment}, separators=(",", ":")) + "\n", encoding="utf-8")


def ci_checks() -> None:
    """Run the same release checks as the PR check and push workflows, so local, PR and release results agree."""
    accounts = accounts_present(load_config(), ROOT)

    def starting(name: str) -> None:
        print(f"RUN  {name}", flush=True)

    def passed(name: str) -> None:
        print(f"PASS {name}", flush=True)

    release_checks(ROOT, accounts=accounts, starting=starting, passed=passed)
    print("All release checks passed.", flush=True)


def release_checks(candidate_root: Path, *, accounts: bool, starting, passed) -> None:
    commands = [
        ("install", ["ci"]),
        ("typecheck", ["run", "typecheck"]),
        ("tests", ["test", "--if-present"]),
        ("build", ["run", "build"]),
    ]
    env = safe_env()
    npm = npm_args()
    for name, args in commands:
        starting(name)
        run([*npm, *args], cwd=candidate_root, env=env, label=f"candidate npm {name}")
        passed(name)
    run([sys.executable, "-m", "unittest", "discover", "-s", "scripts", "-p", "test_kip*.py"], cwd=candidate_root, env=env, label="candidate delivery tests")
    passed("delivery-tests")
    if content_sync_present(load_config(), candidate_root):
        feature = load_config()["contentSync"]
        requirements = candidate_root / feature["pythonRequirementsPath"]
        run(
            [sys.executable, "-m", "pip", "install", "--disable-pip-version-check", "-r", str(requirements)],
            cwd=candidate_root,
            env=env,
            label="candidate content Python dependencies",
        )
        run_content_sync_sql_qa(load_config(), candidate_root)
        passed("postgresql-content-sync-integration")
        for name in feature["pythonTestPaths"]:
            run(
                [sys.executable, str(candidate_root / name)],
                cwd=candidate_root,
                env=env,
                label=f"candidate content Python test {Path(name).name}",
            )
        passed("content-python-tests")
        run(
            [sys.executable, str(candidate_root / feature["legacyImporterTestPath"]), "ImportPlanTests"],
            cwd=candidate_root,
            env=env,
            label="candidate legacy import unit tests",
        )
        passed("legacy-import-unit-tests")
        run_legacy_import_postgres_qa(load_config(), candidate_root)
        passed("postgresql-legacy-import-integration")

    account_sql = candidate_root / "scripts" / "qa-account-sql.mjs"
    if account_sql.is_file():
        run([*npm, "run", "test:sql"], cwd=candidate_root, env=candidate_sql_env(), label="candidate PostgreSQL integration tests")
        passed("postgresql-account-integration")

    if accounts:
        photo_provider().validate_candidate(sys.modules[__name__], load_config(), candidate_root)
        passed("private-photo-worker-bundle")


def candidate_sql_env() -> dict[str, str]:
    values = {key: os.environ.get(key, "") for key in ("PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD")}
    if (
        values["PGHOST"] not in ("127.0.0.1", "localhost", "::1")
        or not re.fullmatch(r"kip_qa_[a-z0-9_]+|kip_accounts_qa", values["PGDATABASE"])
        or not values["PGUSER"]
        or not values["PGPASSWORD"]
        or (values["PGPORT"] and (not values["PGPORT"].isdigit() or not 1 <= int(values["PGPORT"]) <= 65535))
    ):
        raise DeliveryError("Candidate SQL tests require PG* credentials for a disposable loopback kip_qa_ database.")
    register_secret(values["PGPASSWORD"])
    return safe_env(extra={key: value for key, value in values.items() if value})


def candidate_database_url(env: dict[str, str]) -> str:
    host = env["PGHOST"]
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    port = env.get("PGPORT", "5432")
    user = urllib.parse.quote(env["PGUSER"], safe="")
    password = urllib.parse.quote(env["PGPASSWORD"], safe="")
    database = urllib.parse.quote(env["PGDATABASE"], safe="")
    value = f"postgresql://{user}:{password}@{host}:{port}/{database}"
    register_secret(value)
    return value


# Provider reads are idempotent, so one dropped connection or overloaded edge should not abort a
# release that cannot be re-run. Writes are never retried: the provider may already have applied them.
GET_RETRY_DELAYS = (2, 5)
TRANSIENT_HTTP_STATUSES = frozenset({429, 500, 502, 503, 504})
TRANSIENT_ERRORS = (urllib.error.URLError, TimeoutError, ConnectionError)


def is_transient(exc: Exception) -> bool:
    if isinstance(exc, urllib.error.HTTPError):
        return exc.code in TRANSIENT_HTTP_STATUSES
    return isinstance(exc, TRANSIENT_ERRORS)


def urlopen_read(request: urllib.request.Request, *, timeout: float, limit: int | None = None,
                 sleep=time.sleep) -> tuple[int, bytes]:
    delays = GET_RETRY_DELAYS if request.get_method() == "GET" else ()
    for attempt, delay in enumerate((*delays, None), start=1):
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return response.status, response.read(limit)
        except TRANSIENT_ERRORS as exc:
            if delay is None or not is_transient(exc):
                raise
            print(f"provider-get-retry={request.host} attempt={attempt}", file=sys.stderr, flush=True)
            sleep(delay)


def api_json(base: str, path: str, *, token: str, method: str = "GET", body: dict | None = None,
             query: dict | None = None, not_found_ok: bool = False, timeout: float = 30, sleep=time.sleep):
    url = base + path
    if query:
        url += "?" + urllib.parse.urlencode(query)
    data = json.dumps(body).encode("utf-8") if body is not None else None
    request = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "parkdex-kip-delivery/1",
        },
    )
    try:
        _, payload = urlopen_read(request, timeout=timeout, sleep=sleep)
    except urllib.error.HTTPError as exc:
        if not_found_ok and exc.code == 404:
            return None
        raise DeliveryError(f"{urllib.parse.urlsplit(url).netloc} API {method} request failed with HTTP {exc.code}.") from exc
    except TRANSIENT_ERRORS as exc:
        raise DeliveryError(f"{urllib.parse.urlsplit(url).netloc} API {method} request could not complete.") from exc
    if not payload:
        return {}
    try:
        return json.loads(payload.decode("utf-8"))
    except ValueError as exc:
        raise DeliveryError(f"{urllib.parse.urlsplit(url).netloc} API returned invalid JSON.") from exc


def neon_request(config: dict, path: str, *, method: str = "GET", body: dict | None = None,
                 query: dict | None = None, timeout: float = 30):
    key = os.environ.get("NEON_API_KEY", "")
    if not key:
        raise DeliveryError("NEON_API_KEY is required for this Neon operation.")
    register_secret(key)
    return api_json(NEON_API, path, token=key, method=method, body=body, query=query, timeout=timeout)


def vercel_token(config: dict) -> str:
    name = config["vercelTokenEnvironment"]
    token = os.environ.get(name, "")
    if not token:
        raise DeliveryError(f"{name} is required for this Vercel operation.")
    register_secret(token)
    return token


def vercel_request(config: dict, path: str, *, method: str = "GET", body: dict | None = None,
                   query: dict | None = None, not_found_ok: bool = False):
    params = dict(query or {})
    params["teamId"] = os.environ.get(config["vercelTeamIdEnvironment"], "")
    if not params["teamId"]:
        raise DeliveryError(f"{config['vercelTeamIdEnvironment']} is required for this Vercel operation.")
    return api_json(
        VERCEL_API, path, token=vercel_token(config), method=method, body=body,
        query=params, not_found_ok=not_found_ok,
    )


def list_vercel_deployments(config: dict, project_id: str, since_ms: int, *, target: str | None = None) -> list[dict]:
    token = vercel_token(config)
    team = os.environ.get(config["vercelTeamIdEnvironment"], "")
    collected: list[dict] = []
    cursor = None
    seen_cursors = set()
    for _ in range(1000):
        query = {
            "teamId": team,
            "projectId": project_id,
            "limit": 100,
            "since": since_ms,
        }
        if target:
            query["target"] = target
        if cursor:
            query["until"] = cursor
        payload = api_json(VERCEL_API, "/v7/deployments", token=token, query=query)
        page = payload.get("deployments") if isinstance(payload, dict) else None
        if not isinstance(page, list):
            raise DeliveryError("Vercel returned an incomplete deployment inventory.")
        collected.extend(page)
        pagination = payload.get("pagination") or {}
        next_cursor = pagination.get("next")
        if not next_cursor:
            if len(page) >= 100:
                raise DeliveryError("Vercel deployment inventory may be truncated.")
            return collected
        cursor = str(next_cursor)
        if cursor in seen_cursors:
            raise DeliveryError("Vercel deployment inventory repeated a pagination cursor.")
        seen_cursors.add(cursor)
    raise DeliveryError("Vercel deployment inventory exceeded its pagination limit.")


def deployment_meta(deployment: dict) -> dict:
    value = deployment.get("meta")
    return value if isinstance(value, dict) else {}


def deployment_url(deployment: dict) -> str:
    host = deployment.get("url")
    if not isinstance(host, str):
        raise DeliveryError("Vercel deployment did not return a URL.")
    if host.startswith("https://"):
        parsed = urllib.parse.urlsplit(host)
        if parsed.scheme != "https" or parsed.hostname is None or not parsed.hostname.endswith(".vercel.app"):
            raise DeliveryError("Vercel returned an unexpected deployment hostname.")
        return f"https://{parsed.hostname}"
    if not re.fullmatch(r"[A-Za-z0-9.-]+\.vercel\.app", host):
        raise DeliveryError("Vercel returned an unexpected deployment hostname.")
    return "https://" + host


def http_bytes(url: str) -> tuple[int, bytes | None]:
    request = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "parkdex-kip-delivery/1"})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as exc:
        return exc.code, None
    except (urllib.error.URLError, TimeoutError) as exc:
        raise DeliveryError(f"HTTP check could not reach {urllib.parse.urlsplit(url).hostname}.") from exc


def http_json(url: str) -> tuple[int, dict | None]:
    status, payload = http_bytes(url)
    if payload is None:
        return status, None
    try:
        value = json.loads(payload.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return status, None
    return status, value


RELEASE_VERIFY_TIMEOUT_SECONDS = 90
RELEASE_VERIFY_INTERVAL_SECONDS = 5


def release_url_problem(config: dict, url: str, sha: str, environment: str, *, api_present: bool) -> str | None:
    try:
        status, release = http_json(url.rstrip("/") + config["releasePath"])
        if status != 200 or release != {"sha": sha, "environment": environment}:
            return "The deployed /release.json does not match the expected SHA and environment."
        if api_present:
            status, health = http_json(url.rstrip("/") + config["healthPath"])
            if status != 200 or not isinstance(health, dict) or health.get("ok") is not True or health.get("releaseSha") != sha:
                return "The API health check did not confirm the expected release SHA."
    except DeliveryError as exc:
        return str(exc)
    return None


def verify_release_url(
    config: dict,
    url: str,
    sha: str,
    environment: str,
    *,
    api_present: bool,
    timeout: float = RELEASE_VERIFY_TIMEOUT_SECONDS,
    sleep=time.sleep,
    clock=time.monotonic,
) -> None:
    # A freshly assigned alias can serve the previous release for up to a minute,
    # so keep checking for a bounded time before reporting the mismatch.
    deadline = clock() + timeout
    while True:
        problem = release_url_problem(config, url, sha, environment, api_present=api_present)
        if problem is None:
            return
        remaining = deadline - clock()
        if remaining <= 0:
            raise DeliveryError(problem)
        sleep(min(RELEASE_VERIFY_INTERVAL_SECONDS, remaining))


def parse_database_url(value: str, expected_database: str | None = None) -> tuple[urllib.parse.SplitResult, str, str]:
    register_secret(value)
    uri = urllib.parse.urlsplit(value)
    if uri.scheme not in ("postgres", "postgresql") or not uri.hostname or not uri.username or uri.password is None:
        raise DeliveryError("Database connection URL is not a complete PostgreSQL URI.")
    if not uri.hostname.endswith(".neon.tech"):
        raise DeliveryError("Database connection must use a Neon endpoint.")
    database = urllib.parse.unquote(uri.path.lstrip("/"))
    if expected_database and database != expected_database:
        raise DeliveryError("Database connection points to an unexpected database.")
    return uri, urllib.parse.unquote(uri.username), urllib.parse.unquote(uri.password)


def normalize_neon_endpoint_host(host: str) -> str:
    parsed = urllib.parse.urlsplit("//" + host)
    if not parsed.hostname or parsed.port or parsed.path or parsed.query or parsed.fragment or parsed.username or parsed.password:
        raise DeliveryError("Neon returned an invalid database endpoint host.")
    labels = parsed.hostname.lower().split(".")
    if labels[0].endswith("-pooler"):
        labels[0] = labels[0][:-7]
    return ".".join(labels)


def verify_neon_branch_database_urls(config: dict, expected_branch: str, environment: str, *database_urls: str) -> None:
    project_id = os.environ.get("NEON_PROJECT_ID", config["neonProjectId"])
    if project_id != config["neonProjectId"]:
        raise DeliveryError("NEON_PROJECT_ID does not match deployment.json.")
    if not isinstance(expected_branch, str) or not re.fullmatch(r"br-[a-z0-9-]+", expected_branch):
        raise DeliveryError("The configured Neon branch ID is invalid.")
    payload = neon_request(config, f"/projects/{project_id}/branches/{expected_branch}/endpoints")
    endpoints = payload.get("endpoints") if isinstance(payload, dict) else None
    if not isinstance(endpoints, list):
        raise DeliveryError("Neon did not return the configured branch endpoint inventory.")
    hosts = {
        normalize_neon_endpoint_host(endpoint["host"])
        for endpoint in endpoints
        if isinstance(endpoint, dict)
        and endpoint.get("branch_id") == expected_branch
        and endpoint.get("type") == "read_write"
        and isinstance(endpoint.get("host"), str)
    }
    if not hosts:
        raise DeliveryError("The configured Neon branch has no verified read-write endpoint.")
    for database_url in database_urls:
        uri, _, _ = parse_database_url(database_url, config["neonDatabaseName"])
        if normalize_neon_endpoint_host(uri.hostname or "") not in hosts:
            branch_name = "main" if environment == "production" else "staging"
            raise DeliveryError(f"Database connection does not target the configured Neon {branch_name} branch.")


def verify_production_database_urls(config: dict, *database_urls: str) -> None:
    expected_branch = config.get("neonProductionBranchId")
    if not isinstance(expected_branch, str):
        raise DeliveryError("The configured Neon production branch ID is invalid.")
    verify_neon_branch_database_urls(config, expected_branch, "production", *database_urls)


def verify_staging_database_urls(config: dict, *database_urls: str) -> None:
    expected_branch = config.get("neonStagingBranchId")
    if not isinstance(expected_branch, str):
        raise DeliveryError("The configured Neon staging branch ID is invalid.")
    verify_neon_branch_database_urls(config, expected_branch, "staging", *database_urls)


def verify_production_runtime_branch(config: dict, bundle: dict) -> None:
    urls = [bundle["DATABASE_URL"]]
    if bundle.get("MIGRATION_DATABASE_URL"):
        urls.append(bundle["MIGRATION_DATABASE_URL"])
    verify_production_database_urls(config, *urls)


def verify_staging_runtime_branch(config: dict, bundle: dict) -> None:
    urls = [bundle["DATABASE_URL"]]
    if bundle.get("MIGRATION_DATABASE_URL"):
        urls.append(bundle["MIGRATION_DATABASE_URL"])
    verify_staging_database_urls(config, *urls)


def psql_executable() -> str:
    executable = shutil.which("psql")
    if not executable and os.name == "nt":
        for candidate in sorted(Path("C:/Program Files/PostgreSQL").glob("*/bin/psql.exe"), reverse=True):
            if candidate.is_file():
                executable = str(candidate)
                break
    if not executable:
        raise DeliveryError("PostgreSQL client psql was not found.")
    return executable


def psql_args(uri: urllib.parse.SplitResult, username: str, database: str) -> list[str]:
    return [
        psql_executable(), "-X", "-v", "ON_ERROR_STOP=1", "-h", uri.hostname,
        "-p", str(uri.port or 5432), "-U", username, "-d", database,
    ]


MIGRATION_ATTEMPTS = 4
MIGRATION_LOCK_CONFLICT = re.compile(r"deadlock detected|canceling statement due to lock timeout", re.IGNORECASE)


def run_migration(database_url: str, migration: Path, *, sleep=time.sleep) -> None:
    uri, username, password = parse_database_url(database_url)
    # Migrations replay on every deploy and recreate triggers on live tables. A short lock
    # timeout fails fast instead of queueing behind traffic, and because each migration is
    # idempotent and runs in one transaction, a lock conflict can simply be retried.
    env = safe_env(extra={"PGPASSWORD": password, "PGSSLMODE": "require", "PGOPTIONS": "-c lock_timeout=5s"})
    args = [*psql_args(uri, username, urllib.parse.unquote(uri.path.lstrip("/"))), "-1", "-f", str(migration)]
    for attempt in range(1, MIGRATION_ATTEMPTS + 1):
        try:
            run(args, cwd=ROOT, env=env, label=f"database migration {migration.name}")
            return
        except DeliveryError as exc:
            if attempt == MIGRATION_ATTEMPTS or not MIGRATION_LOCK_CONFLICT.search(str(exc)):
                raise
            print(f"migration-retry={migration.name} attempt={attempt} reason=lock-conflict", flush=True)
            sleep(2 * attempt)


def candidate_psql_args(env: dict[str, str], *, database_override: str | None = None) -> list[str]:
    args = [psql_executable(), "-X", "-v", "ON_ERROR_STOP=1"]
    for key, flag in (("PGHOST", "-h"), ("PGPORT", "-p"), ("PGUSER", "-U"), ("PGDATABASE", "-d")):
        if key == "PGDATABASE" and database_override is not None:
            continue
        if env.get(key):
            args.extend((flag, env[key]))
    if database_override is not None:
        args.extend(("-d", database_override))
    return args


def run_candidate_sql_file(script: Path, env: dict[str, str], *, cwd: Path = ROOT, transactional: bool = True) -> None:
    args = candidate_psql_args(env)
    if transactional:
        args.extend(("-1", "-f", str(script)))
    else:
        args.extend(("-f", str(script)))
    run(args, cwd=cwd, env=env, label=f"candidate SQL {script.name}")


def read_runtime_bundle(config: dict, *, environment: str = "staging", optional: bool = False) -> dict | None:
    env_key = "productionRuntimeSecretBundleEnvironment" if environment == "production" else "runtimeSecretBundleEnvironment"
    env_name = config[env_key]
    raw = os.environ.get(env_name, "")
    if not raw and optional:
        return None
    if not raw:
        raise DeliveryError(f"{env_name} is required for a {environment} API deployment.")
    register_secret(raw)
    try:
        bundle = json.loads(raw)
    except ValueError as exc:
        raise DeliveryError(f"{env_name} must contain a JSON object.") from exc
    if not isinstance(bundle, dict):
        raise DeliveryError(f"{env_name} must contain a JSON object.")
    expected = set(config["runtimeSecretBundleKeys"])
    allowed = expected | set(config.get("runtimeOptionalKeys", [])) | {"MIGRATION_DATABASE_URL"}
    if set(bundle) - allowed or expected - set(bundle):
        raise DeliveryError(f"{env_name} must contain the documented runtime keys.")
    for key, value in bundle.items():
        if not isinstance(value, str) or not value:
            raise DeliveryError(f"{env_name} contains a missing or invalid value.")
        register_secret(value)
    return bundle | read_extra_runtime_bundle(config, bundle, environment=environment)


def read_extra_runtime_bundle(config: dict, bundle: dict, *, environment: str) -> dict:
    """Optional keys live in their own secret so adding one never means rewriting the main bundle."""
    env_key = "productionRuntimeExtraBundleEnvironment" if environment == "production" else "runtimeExtraBundleEnvironment"
    env_name = config.get(env_key)
    raw = os.environ.get(env_name, "") if env_name else ""
    if not raw:
        return {}
    register_secret(raw)
    try:
        extra = json.loads(raw)
    except ValueError as exc:
        raise DeliveryError(f"{env_name} must contain a JSON object.") from exc
    if not isinstance(extra, dict):
        raise DeliveryError(f"{env_name} must contain a JSON object.")
    optional = set(config.get("runtimeOptionalKeys", []))
    if set(extra) - optional or set(extra) & set(bundle):
        raise DeliveryError(f"{env_name} may only add documented optional keys that the main bundle does not set.")
    for value in extra.values():
        if not isinstance(value, str) or not value:
            raise DeliveryError(f"{env_name} contains a missing or invalid value.")
        register_secret(value)
    return extra


def verify_runtime_bundle(bundle: dict, config: dict, *, environment: str = "staging") -> None:
    parse_database_url(bundle["DATABASE_URL"], config["neonDatabaseName"])
    if not re.fullmatch(r"(?:[0-9a-fA-F]{2}){16,64}:[0-9a-fA-F]{64}", bundle["OPERATOR_PASSWORD_HASH"]):
        raise DeliveryError("OPERATOR_PASSWORD_HASH must use the documented hexadecimal salt:digest format.")
    if len(bundle["SESSION_SECRET"]) < 32:
        raise DeliveryError("SESSION_SECRET must contain at least 32 characters.")


def migration_presence(candidate_root: Path) -> tuple[bool, bool]:
    config = load_config()
    has_api = (candidate_root / config["apiEntrypoint"]).is_file()
    has_migration = (candidate_root / config["migrationPath"]).is_file()
    if has_api != has_migration:
        raise DeliveryError("The candidate has only one of the API and feedback migration; the pair must ship together.")
    return has_api, has_migration


def content_sync_present(config: dict, candidate_root: Path) -> bool:
    feature = config.get("contentSync")
    if not isinstance(feature, dict):
        raise DeliveryError("The content sync delivery allowlist is invalid.")
    migration_names = feature.get("migrationPaths")
    api_names = feature.get("apiPaths")
    bootstrap_name = feature.get("bootstrapPath")
    qa_sql_name = feature.get("qaSqlPath")
    python_test_names = feature.get("pythonTestPaths")
    python_requirements_name = feature.get("pythonRequirementsPath")
    importer_name = feature.get("legacyImporterPath")
    importer_test_name = feature.get("legacyImporterTestPath")
    if (
        not isinstance(migration_names, list) or not migration_names
        or not isinstance(api_names, list) or not api_names
        or not isinstance(bootstrap_name, str) or not bootstrap_name
        or not isinstance(qa_sql_name, str) or not qa_sql_name
        or not isinstance(python_test_names, list) or not python_test_names
        or not isinstance(python_requirements_name, str) or not python_requirements_name
        or not isinstance(importer_name, str) or not importer_name
        or not isinstance(importer_test_name, str)
        or any(not isinstance(name, str) or not name for name in [*migration_names, *api_names])
        or any(not isinstance(name, str) or not name for name in python_test_names)
    ):
        raise DeliveryError("The content sync delivery allowlist is invalid.")
    marker_names = [*migration_names, *api_names, bootstrap_name, qa_sql_name]
    present = [ (candidate_root / name).is_file() for name in marker_names ]
    if any(present) and not all(present):
        raise DeliveryError("The content sync migration, API routes, bootstrap helper, SQL QA, and Python test assets must ship together.")
    if not any(present):
        if (candidate_root / importer_name).exists() or (candidate_root / importer_test_name).exists():
            raise DeliveryError("The legacy importer requires the complete content sync feature.")
        return False
    support_names = [*python_test_names, python_requirements_name, importer_name, importer_test_name]
    if any(not (candidate_root / name).is_file() for name in support_names):
        raise DeliveryError("The complete content sync feature requires its allowlisted Python tests and pinned dependencies.")
    supporting = feature.get("supportingMigrationPaths")
    if not isinstance(supporting, list) or not supporting or any(not isinstance(name, str) or not name for name in supporting):
        raise DeliveryError("The content sync supporting migration allowlist is invalid.")
    if any(not (candidate_root / name).is_file() for name in supporting):
        raise DeliveryError("Content sync requires its allowlisted public content schema migration.")
    return True


def bootstrap_content(config: dict, candidate_root: Path, database_url: str, environment: str) -> None:
    # "preview" is the CI/QA seeding mode: run_content_sync_sql_qa seeds a throwaway database with it.
    if environment not in ("preview", "staging"):
        raise DeliveryError("Public content bootstrap requires a preview or staging environment.")
    if not content_sync_present(config, candidate_root):
        raise DeliveryError("Public content bootstrap requires the complete content sync feature.")
    helper = candidate_root / config["contentSync"]["bootstrapPath"]
    register_secret(database_url)
    env = safe_env(extra={"MIGRATION_DATABASE_URL": database_url})
    run(
        [sys.executable, str(helper), "--apply", "--environment", environment],
        cwd=candidate_root,
        env=env,
        label=f"public content bootstrap ({environment})",
    )


def run_content_sync_sql_qa(config: dict, candidate_root: Path) -> None:
    feature = config.get("contentSync", {})
    qa_name = feature.get("qaSqlPath") if isinstance(feature, dict) else None
    if not isinstance(qa_name, str) or not qa_name:
        raise DeliveryError("The content sync SQL QA allowlist is invalid.")
    qa_script = candidate_root / qa_name
    if not qa_script.is_file():
        raise DeliveryError("The allowlisted content sync SQL QA script is missing.")
    if not content_sync_present(config, candidate_root):
        raise DeliveryError("Content sync SQL QA requires the complete content sync feature.")

    admin_env = candidate_sql_env()
    database_name = f"kip_qa_content_sync_{uuid.uuid4().hex}"
    if not re.fullmatch(r"kip_qa_content_sync_[0-9a-f]{32}", database_name):
        raise DeliveryError("Could not create a safe owned content QA database name.")
    admin_psql = candidate_psql_args(admin_env, database_override="postgres")
    existing = run(
        [*admin_psql, "-qAt", "-c", f"SELECT 1 FROM pg_catalog.pg_database WHERE datname = '{database_name}'"],
        cwd=candidate_root,
        env=admin_env,
        label="candidate content QA database ownership check",
    ).strip()
    if existing:
        raise DeliveryError("The unique content QA database name already exists; refusing to use or remove it.")
    run(
        [*admin_psql, "-c", f'CREATE DATABASE "{database_name}"'],
        cwd=candidate_root,
        env=admin_env,
        label="create owned content QA database",
    )
    qa_env = dict(admin_env)
    qa_env["PGDATABASE"] = database_name
    try:
        table_count = run(
            [*candidate_psql_args(qa_env), "-qAt", "-c",
             "SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') AND table_type = 'BASE TABLE'"],
            cwd=candidate_root,
            env=qa_env,
            label="candidate PostgreSQL initialization check",
        ).strip()
        if table_count != "0":
            raise DeliveryError("The newly created content QA database is not empty.")

        for migration in migration_paths(config, candidate_root):
            run_candidate_sql_file(migration, qa_env, cwd=candidate_root)
        database_url = candidate_database_url(qa_env)
        bootstrap_content(config, candidate_root, database_url, "preview")
        run_candidate_sql_file(qa_script, qa_env, cwd=candidate_root, transactional=False)
        queue_test = "scripts/test_authoring_queue.py"
        if queue_test in feature.get("pythonTestPaths", []):
            run(
                [
                    sys.executable,
                    str(candidate_root / queue_test),
                    "AuthoringQueuePostgresTests.test_expired_lease_renewal_cannot_overlap_a_new_claim",
                ],
                cwd=candidate_root,
                env={**qa_env, "AUTHORING_QUEUE_TEST_DATABASE_URL": database_url},
                label="candidate authoring queue concurrency test",
            )
    finally:
        run(
            [*admin_psql, "-c", f'DROP DATABASE "{database_name}"'],
            cwd=candidate_root,
            env=admin_env,
            label="drop owned content QA database",
        )


def run_legacy_import_postgres_qa(config: dict, candidate_root: Path) -> None:
    feature = config.get("contentSync", {})
    test_name = feature.get("legacyImporterTestPath") if isinstance(feature, dict) else None
    if not isinstance(test_name, str) or not test_name or not content_sync_present(config, candidate_root):
        raise DeliveryError("Legacy import PostgreSQL QA requires the complete content sync feature and allowlisted test.")
    test_script = candidate_root / test_name
    admin_env = candidate_sql_env()
    database_name = f"kip_qa_legacy_import_{uuid.uuid4().hex}"
    if not re.fullmatch(r"kip_qa_legacy_import_[0-9a-f]{32}", database_name):
        raise DeliveryError("Could not create a safe owned legacy import QA database name.")
    admin_psql = candidate_psql_args(admin_env, database_override="postgres")
    existing = run(
        [*admin_psql, "-qAt", "-c", f"SELECT 1 FROM pg_catalog.pg_database WHERE datname = '{database_name}'"],
        cwd=candidate_root, env=admin_env, label="candidate legacy import QA database ownership check",
    ).strip()
    if existing:
        raise DeliveryError("The unique legacy import QA database name already exists; refusing to use or remove it.")
    run(
        [*admin_psql, "-c", f'CREATE DATABASE "{database_name}"'],
        cwd=candidate_root, env=admin_env, label="create owned legacy import QA database",
    )
    qa_env = dict(admin_env)
    qa_env["PGDATABASE"] = database_name
    try:
        table_count = run(
            [*candidate_psql_args(qa_env), "-qAt", "-c",
             "SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') AND table_type = 'BASE TABLE'"],
            cwd=candidate_root, env=qa_env, label="candidate legacy import QA initialization check",
        ).strip()
        if table_count != "0":
            raise DeliveryError("The newly created legacy import QA database is not empty.")
        database_url = candidate_database_url(qa_env)
        run(
            [sys.executable, str(test_script), "PostgreSQLImportTests"],
            cwd=candidate_root,
            env={**qa_env, "LEGACY_IMPORT_TEST_DATABASE_URL": database_url},
            label="candidate legacy import PostgreSQL integration tests",
        )
    finally:
        run(
            [*admin_psql, "-c", f'DROP DATABASE "{database_name}"'],
            cwd=candidate_root, env=admin_env, label="drop owned legacy import QA database",
        )


def qa_content_sync() -> None:
    config = load_config()
    run_content_sync_sql_qa(config, ROOT)


def qa_legacy_import() -> None:
    config = load_config()
    run_legacy_import_postgres_qa(config, ROOT)


def migration_paths(config: dict, candidate_root: Path) -> list[Path]:
    """Trusted ordered inventory. Never execute arbitrary candidate SQL filenames."""
    has_content_sync = content_sync_present(config, candidate_root)
    has_api, _ = migration_presence(candidate_root)
    if not has_api:
        if has_content_sync:
            raise DeliveryError("Content sync requires the existing application API and feedback migration.")
        return []
    paths = [candidate_root / config["migrationPath"]]
    if has_content_sync:
        feature = config["contentSync"]
        paths.extend(candidate_root / name for name in feature["supportingMigrationPaths"])
    optional = [candidate_root / name for name in config.get("optionalMigrationPaths", [])]
    present = [path for path in optional if path.is_file()]
    feature_markers = (candidate_root / "worker/accounts", candidate_root / config["privatePhotos"]["sourcePath"])
    if any(path.exists() for path in feature_markers) and not present:
        raise DeliveryError("Account feature code requires its ordered migrations.")
    if present and len(present) != len(optional):
        raise DeliveryError("Account, progress, and interaction migrations must ship together.")
    if present and not (candidate_root / config["privatePhotos"]["sourcePath"]).is_file():
        raise DeliveryError("Account migrations require the private photo Worker service.")
    paths.extend(present)
    if has_content_sync:
        paths.extend(candidate_root / name for name in config["contentSync"]["migrationPaths"])
    # Standalone additive schemas (build configuration, park proposals) ship whenever their file is present.
    paths.extend(path for path in (candidate_root / name for name in config.get("independentMigrationPaths", [])) if path.is_file())
    return paths


def accounts_present(config: dict, candidate_root: Path) -> bool:
    paths = migration_paths(config, candidate_root)
    account_names = config.get("optionalMigrationPaths", [])
    return bool(account_names) and all(candidate_root / name in paths for name in account_names)


def require_account_runtime(config: dict, bundle: dict, candidate_root: Path, *, environment: str = "staging") -> None:
    if not accounts_present(config, candidate_root):
        return
    for key in ("AUTH_SESSION_SECRET", "KIP_PHOTO_SERVICE_TOKEN", "KIP_RETENTION_SECRET"):
        if len(bundle.get(key, "")) < 32:
            raise DeliveryError(f"{key} must be configured with at least 32 random characters.")
    if len({bundle["SESSION_SECRET"], bundle["AUTH_SESSION_SECRET"], bundle["KIP_PHOTO_SERVICE_TOKEN"], bundle["KIP_RETENTION_SECRET"]}) != 4:
        raise DeliveryError("Operator, account, photo, and retention secrets must be distinct.")
    url = urllib.parse.urlsplit(bundle.get("KIP_PHOTO_SERVICE_URL", ""))
    expected_host = config["privatePhotos"][f"{environment}WorkerName"] + "."
    if url.scheme != "https" or not url.hostname or not url.hostname.startswith(expected_host) or not url.hostname.endswith(".workers.dev") or url.path not in ("", "/") or url.query or url.fragment or url.username or url.port:
        raise DeliveryError(f"KIP_PHOTO_SERVICE_URL must be the dedicated HTTPS {environment} Worker origin.")
    if not GOOGLE_CLIENT_ID_PATTERN.fullmatch(bundle.get("GOOGLE_WEB_CLIENT_ID", "")):
        raise DeliveryError(f"{environment.capitalize()} accounts require a configured Google Web OAuth client.")
    if "GOOGLE_NATIVE_CLIENT_ID" in bundle and not GOOGLE_CLIENT_ID_PATTERN.fullmatch(bundle["GOOGLE_NATIVE_CLIENT_ID"]):
        raise DeliveryError("GOOGLE_NATIVE_CLIENT_ID must be a Google OAuth client ID.")
    if not bundle.get("AUTH_EMAIL_FROM") and not bundle.get("EMAIL_FROM"):
        raise DeliveryError(f"{environment.capitalize()} accounts require an authentication email sender.")


def photo_provider():
    import kip_private_photos
    return kip_private_photos


def run_vercel(config: dict, args: list[str], auth_dir: Path, *, cwd: Path = ROOT, env_extra: dict[str, str] | None = None) -> str:
    cli = vercel_args()
    project_id = os.environ.get(config["vercelProjectIdEnvironment"], "")
    if os.environ.get("VERCEL_PROJECT_ID") and os.environ["VERCEL_PROJECT_ID"] != project_id:
        raise DeliveryError("Ambient VERCEL_PROJECT_ID does not match the configured Kip project.")
    env = safe_env(extra={
        config["vercelTeamIdEnvironment"]: os.environ.get(config["vercelTeamIdEnvironment"], ""),
        "VERCEL_PROJECT_ID": project_id,
        **(env_extra or {}),
    })
    command = [*cli, *args, "--scope", os.environ.get(config["vercelTeamIdEnvironment"], ""),
               "--global-config", str(auth_dir)]
    return run(command, cwd=cwd, env=env, label="Vercel CLI", timeout=1800)


def assert_vercel_cli_version(config: dict) -> None:
    auth_dir = _vercel_auth_dir(config)
    try:
        version = run_vercel(config, ["--version"], auth_dir, cwd=ROOT).strip()
        if version != config["vercelCliVersion"]:
            raise DeliveryError(f"Use Vercel CLI {config['vercelCliVersion']}; found {version}.")
    finally:
        shutil.rmtree(auth_dir, ignore_errors=True)


def _vercel_auth_dir(config: dict) -> Path:
    token = vercel_token(config)
    root = Path(tempfile.mkdtemp(prefix="parkdex-kip-vercel-auth-")).resolve()
    try:
        os.chmod(root, 0o700)
    except OSError:
        pass
    save_json(root / "auth.json", {"token": token})
    return root


def verify_git_sha(
    expected: str,
    *,
    staging_only: bool = False,
    production_only: bool = False,
    clean: bool = True,
) -> None:
    if not SHA_RE.fullmatch(expected or ""):
        raise DeliveryError("Expected SHA must be a full 40-character lowercase Git SHA.")
    actual = git("rev-parse", "HEAD")
    if actual != expected:
        raise DeliveryError(f"Checkout HEAD {actual} does not match requested SHA {expected}.")
    if clean and git("status", "--porcelain"):
        raise DeliveryError("Run release operations from a clean checkout.")
    if staging_only and production_only:
        raise DeliveryError("A release operation cannot target both staging and production.")
    expected_branch = "staging" if staging_only else "main" if production_only else None
    github_ref = os.environ.get("GITHUB_REF")
    if expected_branch and github_ref and github_ref != f"refs/heads/{expected_branch}":
        raise DeliveryError(f"This release operation is restricted to the {expected_branch} branch.")


def prepare_release(args) -> None:
    verify_git_sha(args.sha, staging_only=args.environment == "staging", production_only=args.environment == "production")
    set_release_file(ROOT, args.sha, args.environment)
    print(f"release-file=public/release.json environment={args.environment} sha={args.sha}")


def staging_api_state(config: dict) -> tuple[bool, bool]:
    return migration_presence(ROOT)


def verify_main_content_channel(config: dict | None = None) -> None:
    config = config or load_config()
    origin = "https://kip-assets.parkdex.app"
    pinned_path = ROOT / "database" / "content-manifest.json"
    try:
        pinned_bytes = pinned_path.read_bytes()
        pinned_manifest = json.loads(pinned_bytes.decode("utf-8"))
    except (OSError, ValueError, UnicodeDecodeError) as exc:
        raise DeliveryError("The checked-in public content baseline cannot be read.") from exc
    if not isinstance(pinned_manifest, dict) or not isinstance(pinned_manifest.get("version"), str):
        raise DeliveryError("The checked-in public content baseline is invalid.")
    pinned_version = pinned_manifest["version"]
    pinned_manifest_sha = hashlib.sha256(pinned_bytes).hexdigest()
    status, pointer = http_json(origin + "/channels/main/current.json")
    expected_keys = {
        "schema", "environment", "generation", "releaseId", "manifestUrl",
        "manifestSha256", "minimumReaderVersion",
    }
    if (
        status != 200
        or not isinstance(pointer, dict)
        or set(pointer) != expected_keys
        or pointer.get("schema") != "parkdex.content-channel/v1"
        or pointer.get("environment") != "main"
        or not isinstance(pointer.get("generation"), int)
        or pointer["generation"] < 1
        or not isinstance(pointer.get("releaseId"), str)
        or not re.fullmatch(r"[a-f0-9]{64}", pointer["releaseId"])
        or not isinstance(pointer.get("manifestSha256"), str)
        or not re.fullmatch(r"[a-f0-9]{64}", pointer["manifestSha256"])
        or not isinstance(pointer.get("minimumReaderVersion"), int)
        or pointer["minimumReaderVersion"] < 1
        or pointer.get("manifestUrl") != f"{origin}/releases/{pointer.get('releaseId')}/manifest.json"
    ):
        raise DeliveryError("The public main content channel is missing or invalid; publish it before production release.")
    if pointer["releaseId"] != pinned_version or pointer["manifestSha256"] != pinned_manifest_sha:
        raise DeliveryError("The public main content channel does not match the checked-in content baseline.")
    status, manifest_bytes = http_bytes(pointer["manifestUrl"])
    if status != 200 or manifest_bytes is None or hashlib.sha256(manifest_bytes).hexdigest() != pointer["manifestSha256"]:
        raise DeliveryError("The public main content manifest is unavailable or does not match its channel pointer hash.")
    try:
        manifest = json.loads(manifest_bytes.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        manifest = None
    if (
        status != 200
        or not isinstance(manifest, dict)
        or manifest.get("version") != pointer["releaseId"]
        or manifest.get("cdnOrigin") != origin
        or not isinstance(manifest.get("files"), list)
    ):
        raise DeliveryError("The public main content manifest is unavailable or does not match its channel pointer.")
    print(f"main-content-channel=verified generation={pointer['generation']} release={pointer['releaseId']}")


def migration_release(args, environment: str) -> None:
    config = load_config()
    verify_git_sha(args.sha, staging_only=environment == "staging", production_only=environment == "production", clean=False)
    if environment == "production":
        verify_main_content_channel(config)
    has_api, has_migration = staging_api_state(config)
    migrations = migration_paths(config, ROOT)
    has_content_sync = content_sync_present(config, ROOT)
    if not has_migration:
        print("migration=skipped static bootstrap has no API or feedback schema")
        return
    if not args.apply:
        for migration in migrations:
            target = "Neon main" if environment == "production" else "the dedicated Parkdex Kip staging database"
            print(f"plan=apply {migration.relative_to(ROOT).as_posix()} to {target}")
        if has_content_sync and environment == "staging":
            print("plan=run the all-or-nothing verified public content bootstrap after the additive migrations")
        elif has_content_sync and environment == "production":
            print("plan=preserve the curated Neon main catalogue without replaying the historical public content bootstrap")
        return
    bundle = read_runtime_bundle(config, environment=environment)
    verify_runtime_bundle(bundle, config, environment=environment)
    if environment == "production":
        verify_production_runtime_branch(config, bundle)
    else:
        verify_staging_runtime_branch(config, bundle)
    database_url = bundle.get("MIGRATION_DATABASE_URL") or bundle["DATABASE_URL"]
    parse_database_url(database_url, config["neonDatabaseName"])
    require_account_runtime(config, bundle, ROOT, environment=environment)
    for migration in migrations:
        run_migration(database_url, migration)
        print(f"migration-applied={migration.relative_to(ROOT).as_posix()}")
    if has_content_sync and environment == "staging":
        bootstrap_content(config, ROOT, database_url, "staging")
        print("content-bootstrap=verified public content inserted missing-only in one staging transaction")
    elif has_content_sync and environment == "production":
        print("main-content-bootstrap=skipped; production preserves the curated Neon main catalogue")


def migration_staging(args) -> None:
    migration_release(args, "staging")


def migration_main(args) -> None:
    migration_release(args, "production")


def release_project_id(config: dict, environment: str) -> str:
    env_key = config["productionVercelProjectIdEnvironment"] if environment == "production" else config["vercelProjectIdEnvironment"]
    project_id = os.environ.get(env_key, "")
    if not project_id or not re.fullmatch(r"prj_[A-Za-z0-9]+", project_id):
        raise DeliveryError(f"{env_key} is required.")
    return project_id


def ensure_previous_release_resolved(config: dict, project_id: str, environment: str) -> None:
    # Vercel reports Kip CLI Preview releases with `target: null` in its list and
    # detail APIs, even though the deploy command explicitly requested Preview.
    # Inventory the full project and use signed Kip metadata to find our releases.
    deployments = list_vercel_deployments(config, project_id, int((time.time() - 90 * 86400) * 1000))
    expected_target = "production" if environment == "production" else None
    previous = [
        item for item in deployments
        if deployment_meta(item).get("kipEnvironment") == environment
        and (
            item.get("target") == expected_target
            if environment == "production"
            else item.get("target") in (None, "preview")
        )
    ]
    if not previous:
        return
    latest = max(previous, key=lambda item: int(item.get("createdAt") or item.get("created") or 0))
    status = latest.get("readyState") or latest.get("state")
    previous_sha = deployment_meta(latest).get("githubCommitSha")
    if status != "READY" or not SHA_RE.fullmatch(previous_sha or ""):
        raise DeliveryError(f"A previous {environment} deployment is unresolved. Verify or recover it before starting another release.")
    base_url = config["productionUrl"] if environment == "production" else config["stagingUrl"]
    status, release = http_json(base_url.rstrip("/") + config["releasePath"])
    expected_release = {"sha": previous_sha, "environment": environment}
    if status == 200 and release == expected_release:
        return
    if (
        environment == "staging"
        and previous_sha == config.get("legacyStagingCutoverSha")
        and config.get("legacyStagingAlias")
    ):
        legacy_url = "https://" + config["legacyStagingAlias"]
        legacy_status, legacy_release = http_json(legacy_url + config["releasePath"])
        if legacy_status == 200 and legacy_release == expected_release:
            print("prior-staging-release=verified on legacy alias for the configured first stable-host cutover SHA")
            return
    raise DeliveryError(f"The prior {environment} SHA has not passed stable URL verification.")


def release_runtime_env(config: dict, bundle: dict | None, sha: str, *, api_present: bool, environment: str) -> dict:
    if not api_present:
        return {}
    if bundle is None:
        raise DeliveryError(f"The {environment} runtime secret bundle is required for the API deployment.")
    verify_runtime_bundle(bundle, config, environment=environment)
    require_account_runtime(config, bundle, ROOT, environment=environment)
    is_production = environment == "production"
    app_url = config["productionUrl"] if is_production else config["stagingUrl"]
    allowed_origins = ["http://localhost", "https://localhost", "capacitor://localhost", app_url]
    if not is_production and config.get("legacyStagingAlias"):
        allowed_origins.append("https://" + config["legacyStagingAlias"])
    return {
        **{key: bundle[key] for key in config["runtimeSecretBundleKeys"]},
        **{key: bundle[key] for key in config.get("runtimeOptionalKeys", []) if key in bundle},
        "AUTH_EMAIL_FROM": bundle.get("AUTH_EMAIL_FROM", bundle["EMAIL_FROM"]),
        "EMAIL_MODE": config["productionEmailMode"] if is_production else config["stagingEmailMode"],
        "PUBLIC_APP_URL": app_url,
        "CONTENT_CHANNEL": "main" if is_production else "staging",
        "VITE_CONTENT_ENV": "main" if is_production else "staging",
        "VITE_APP_URL": app_url,
        "ALLOWED_ORIGINS": ",".join(allowed_origins),
        "RELEASE_SHA": sha,
    }


def staging_runtime_env(config: dict, bundle: dict | None, sha: str, *, api_present: bool) -> dict:
    return release_runtime_env(config, bundle, sha, api_present=api_present, environment="staging")


def production_runtime_env(config: dict, bundle: dict | None, sha: str, *, api_present: bool) -> dict:
    return release_runtime_env(config, bundle, sha, api_present=api_present, environment="production")


def vercel_release_target_args(environment: str) -> list[str]:
    if environment == "production":
        return ["--prod", "--skip-domain"]
    if environment == "staging":
        return ["--target", "preview"]
    raise DeliveryError("Vercel release target must be staging or production.")


def dispatch_release(args, environment: str) -> None:
    config = load_config()
    if environment == "production":
        config["vercelProjectIdEnvironment"] = config["productionVercelProjectIdEnvironment"]
    verify_git_sha(args.sha, staging_only=environment == "staging", production_only=environment == "production", clean=False)
    if os.environ.get("GITHUB_RUN_ATTEMPT", "1") != "1":
        raise DeliveryError(f"{environment.capitalize()} release dispatch is first-attempt only.")
    has_api, has_migration = staging_api_state(config)
    if has_api != has_migration:
        raise DeliveryError(f"{environment.capitalize()} API and migration must be released together.")
    if not args.apply:
        target = "Production" if environment == "production" else "Preview"
        print(f"plan=queue the exact {args.sha} Vercel {target} deployment for {environment}")
        print("plan=use the environment runtime bundle only when the API is present")
        print("plan=verify provider readiness and assign the stable alias outside GitHub Actions")
        return
    project_id = release_project_id(config, environment)
    token = vercel_token(config)
    if has_api:
        bundle = read_runtime_bundle(config, environment=environment)
    else:
        bundle = None
    if environment == "production" and bundle is not None:
        verify_production_runtime_branch(config, bundle)
    elif environment == "staging" and bundle is not None:
        verify_staging_runtime_branch(config, bundle)
    ensure_previous_release_resolved(config, project_id, environment)
    auth_dir = Path(tempfile.mkdtemp(prefix=f"parkdex-kip-{environment}-auth-")).resolve()
    runtime_dir = None
    try:
        os.chmod(auth_dir, 0o700)
    except OSError:
        pass
    save_json(auth_dir / "auth.json", {"token": token})
    try:
        runtime_env = release_runtime_env(config, bundle, args.sha, api_present=has_api, environment=environment)
        local_config = {}
        config_file = ROOT / "vercel.json"
        if config_file.is_file():
            try:
                local_config = json.loads(config_file.read_text(encoding="utf-8"))
            except ValueError as exc:
                raise DeliveryError("vercel.json is invalid.") from exc
        local_config["env"] = {**(local_config.get("env") or {}), **runtime_env}
        runtime_dir = Path(tempfile.mkdtemp(prefix=f"parkdex-kip-{environment}-config-")).resolve()
        try:
            os.chmod(runtime_dir, 0o700)
        except OSError:
            pass
        local_config_path = runtime_dir / "vercel.json"
        save_json(local_config_path, local_config)
        release_id = f"{environment}-{args.sha}"
        output = run_vercel(config, [
            "deploy", "--cwd", str(ROOT), "--yes", *vercel_release_target_args(environment), "--no-wait",
            "--local-config", str(local_config_path),
            "--meta", f"githubCommitSha={args.sha}",
            "--meta", f"kipReleaseId={release_id}",
            "--meta", f"kipEnvironment={environment}",
        ], auth_dir, cwd=ROOT)
        urls = re.findall(r"https://[A-Za-z0-9.-]+\.vercel\.app", output)
        if urls:
            print(f"deployment-url={urls[-1]}")
        print(f"release-sha={args.sha}")
        print(f"release-id={release_id}")
        print(f"dispatch=accepted; Vercel readiness and {environment} alias are verified outside this workflow")
    finally:
        shutil.rmtree(auth_dir, ignore_errors=True)
        if runtime_dir:
            shutil.rmtree(runtime_dir, ignore_errors=True)


def dispatch_staging(args) -> None:
    dispatch_release(args, "staging")


def dispatch_main(args) -> None:
    dispatch_release(args, "production")


def dispatch_release_services(args, environment: str) -> None:
    """Queue independent services together; convergence is checked outside Actions."""
    config = load_config()
    verify_git_sha(args.sha, staging_only=environment == "staging", production_only=environment == "production", clean=False)
    if not accounts_present(config, ROOT):
        dispatch_release(args, environment)
        return
    if os.environ.get("GITHUB_RUN_ATTEMPT", "1") != "1":
        raise DeliveryError(f"{environment.capitalize()} release dispatch is first-attempt only.")
    if not args.apply:
        print(f"plan=queue the {environment} private photo Worker and Vercel concurrently after ordered migrations")
        return
    bundle = read_runtime_bundle(config, environment=environment)
    verify_runtime_bundle(bundle, config, environment=environment)
    require_account_runtime(config, bundle, ROOT, environment=environment)
    if environment == "production":
        verify_production_runtime_branch(config, bundle)
    elif environment == "staging":
        verify_staging_runtime_branch(config, bundle)
    failures = []
    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [
            ("Vercel", executor.submit(dispatch_release, args, environment)),
            ("Cloudflare", executor.submit(photo_provider().dispatch_environment, sys.modules[__name__], config, ROOT, args.sha, bundle, environment)),
        ]
        for name, future in futures:
            try:
                result = future.result()
                if result:
                    print(f"{name.lower()}-dispatch={json.dumps(result)}")
            except Exception as exc:
                failures.append(f"{name}: {redact(str(exc))}")
    if failures:
        raise DeliveryError(f"{environment.capitalize()} dispatch needs manual recovery: " + "; ".join(failures))


def dispatch_staging_services(args) -> None:
    dispatch_release_services(args, "staging")


def dispatch_main_services(args) -> None:
    dispatch_release_services(args, "production")


def provision_staging_photos(args) -> None:
    config = load_config()
    assert_clean_staging_harness(config)
    path = state_root() / "persistent" / "private-photos-staging.json"
    photo_provider().provision_staging(sys.modules[__name__], config, path, apply=args.apply)


def provision_main_photos(args) -> None:
    config = load_config()
    staging_sha, _ = assert_clean_staging_harness(config)
    path = state_root() / "persistent" / "private-photos-production.json"
    photo_provider().provision_production(
        sys.modules[__name__], config, path, apply=args.apply,
        candidate_root=ROOT, release_sha=staging_sha,
    )


def assign_release(args, environment: str) -> None:
    config = load_config()
    if environment == "production":
        config["vercelProjectIdEnvironment"] = config["productionVercelProjectIdEnvironment"]
    if not re.fullmatch(r"dpl_[A-Za-z0-9]+", args.deployment_id):
        raise DeliveryError("Deployment ID must be a full Vercel dpl_ identifier.")
    if not SHA_RE.fullmatch(args.sha or ""):
        raise DeliveryError(f"{environment.capitalize()} alias assignment requires the full merge SHA.")
    project_env_key = config["productionVercelProjectIdEnvironment"] if environment == "production" else config["vercelProjectIdEnvironment"]
    aliases = [config["productionAlias"]] if environment == "production" else [config["stagingAlias"]]
    if environment == "staging" and config.get("legacyStagingAlias"):
        aliases.append(config["legacyStagingAlias"])
    if not args.apply:
        print(f"plan=assign {args.deployment_id} to " + ", ".join("https://" + alias for alias in aliases) + " after READY and SHA verification")
        print(f"plan=expected githubCommitSha={args.sha}")
        return
    deployment = vercel_request(config, f"/v13/deployments/{args.deployment_id}")
    meta = deployment_meta(deployment)
    expected_target = "production" if environment == "production" else "preview"
    if (
        deployment.get("id") != args.deployment_id
        or deployment.get("projectId") != os.environ.get(project_env_key)
        or (deployment.get("target") != expected_target if environment == "production" else deployment.get("target") not in (None, expected_target))
        or (deployment.get("readyState") or deployment.get("state")) != "READY"
        or meta.get("githubCommitSha") != args.sha
        or meta.get("kipEnvironment") != environment
    ):
        raise DeliveryError(f"The deployment is not the READY {environment} candidate for the requested merge SHA.")
    auth_dir = _vercel_auth_dir(config)
    try:
        assert_vercel_cli_version(config)
        for alias in aliases:
            run_vercel(config, ["alias", "set", deployment_url(deployment), alias], auth_dir, cwd=ROOT)
    finally:
        shutil.rmtree(auth_dir, ignore_errors=True)
    print(f"{environment}-aliases=" + ",".join("https://" + alias for alias in aliases))
    print(f"deployment-id={args.deployment_id}")
    print(f"release-sha={args.sha}")


def assign_staging(args) -> None:
    assign_release(args, "staging")


def assign_main(args) -> None:
    assign_release(args, "production")


def verify_staging(args) -> None:
    config = load_config()
    has_api, _ = staging_api_state(config)
    verify_release_url(config, config["stagingUrl"], args.sha, "staging", api_present=has_api)
    if accounts_present(config, ROOT):
        photo_provider().verify_staging(sys.modules[__name__], config, args.sha)
    print(f"staging-url={config['stagingUrl']}")
    if config.get("legacyStagingAlias"):
        verify_release_url(config, "https://" + config["legacyStagingAlias"], args.sha, "staging", api_present=has_api)
        print(f"legacy-staging-url=https://{config['legacyStagingAlias']}")
    print(f"release-sha={args.sha}")
    print("staging-verification=passed")


def verify_main(args) -> None:
    config = load_config()
    has_api, _ = staging_api_state(config)
    verify_release_url(config, config["productionUrl"], args.sha, "production", api_present=has_api)
    verify_main_content_channel(config)
    if accounts_present(config, ROOT):
        photo_provider().verify_environment(sys.modules[__name__], config, args.sha, "production")
    print(f"production-url={config['productionUrl']}")
    print(f"release-sha={args.sha}")
    print("production-verification=passed")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Parkdex Kip delivery lifecycle")
    sub = parser.add_subparsers(dest="command", required=True)
    item = sub.add_parser("write-release")
    item.add_argument("--environment", choices=("staging", "production"), required=True)
    item.add_argument("--sha", required=True)
    item = sub.add_parser("migrate-staging")
    item.add_argument("--sha", required=True)
    item.add_argument("--apply", action="store_true")
    item = sub.add_parser("migrate-main")
    item.add_argument("--sha", required=True)
    item.add_argument("--apply", action="store_true")
    sub.add_parser("verify-main-content")
    sub.add_parser("ci-checks")
    sub.add_parser("qa-content-sync")
    sub.add_parser("qa-legacy-import")
    item = sub.add_parser("deploy-staging")
    item.add_argument("--sha", required=True)
    item.add_argument("--apply", action="store_true")
    item = sub.add_parser("deploy-staging-services")
    item.add_argument("--sha", required=True)
    item.add_argument("--apply", action="store_true")
    item = sub.add_parser("deploy-main-services")
    item.add_argument("--sha", required=True)
    item.add_argument("--apply", action="store_true")
    item = sub.add_parser("assign-staging")
    item.add_argument("--deployment-id", required=True)
    item.add_argument("--sha", required=True)
    item.add_argument("--apply", action="store_true")
    item = sub.add_parser("verify-staging")
    item.add_argument("--sha", required=True)
    item = sub.add_parser("assign-main")
    item.add_argument("--deployment-id", required=True)
    item.add_argument("--sha", required=True)
    item.add_argument("--apply", action="store_true")
    item = sub.add_parser("verify-main")
    item.add_argument("--sha", required=True)
    item = sub.add_parser("provision-staging-photos")
    item.add_argument("--apply", action="store_true")
    item = sub.add_parser("provision-production-photos")
    item.add_argument("--apply", action="store_true")
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        if args.command == "write-release":
            prepare_release(args)
        elif args.command == "migrate-staging":
            migration_staging(args)
        elif args.command == "migrate-main":
            migration_main(args)
        elif args.command == "verify-main-content":
            verify_main_content_channel()
        elif args.command == "ci-checks":
            ci_checks()
        elif args.command == "qa-content-sync":
            qa_content_sync()
        elif args.command == "qa-legacy-import":
            qa_legacy_import()
        elif args.command == "deploy-staging":
            dispatch_staging(args)
        elif args.command == "deploy-staging-services":
            dispatch_staging_services(args)
        elif args.command == "deploy-main-services":
            dispatch_main_services(args)
        elif args.command == "assign-staging":
            assign_staging(args)
        elif args.command == "verify-staging":
            verify_staging(args)
        elif args.command == "assign-main":
            assign_main(args)
        elif args.command == "verify-main":
            verify_main(args)
        elif args.command == "provision-staging-photos":
            provision_staging_photos(args)
        elif args.command == "provision-production-photos":
            provision_main_photos(args)
    except (DeliveryError, OSError, ValueError) as exc:
        print(redact(str(exc)), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Explicit, journaled preview and staging delivery for Parkdex Kip."""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import os
import re
import secrets
import shutil
import socket
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
from datetime import datetime, timedelta, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = ROOT / "deployment.json"
REPOSITORY = "NathanPannell/parkdex-kip"
NEON_API = "https://console.neon.tech/api/v2"
VERCEL_API = "https://api.vercel.com"
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
ID_RE = re.compile(r"^[0-9]+$")
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
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
        detail = redact((result.stderr or result.stdout or "").strip())[-1400:]
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
    base = os.environ.get("LOCALAPPDATA") if os.name == "nt" else os.environ.get("XDG_STATE_HOME")
    if base:
        return Path(base).resolve() / "Parkdex" / "kip-preview-pr"
    return Path.home() / ".local" / "state" / "Parkdex" / "kip-preview-pr"


def journal_path(pr: int) -> Path:
    return state_root() / "journals" / f"pr-{pr}.json"


def credential_path(pr: int, release_id: str) -> Path:
    return state_root() / "credentials" / f"pr-{pr}-{release_id}.json"


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


@contextlib.contextmanager
def lifecycle_lock(pr: int):
    root = state_root()
    root.mkdir(parents=True, exist_ok=True)
    lock_path = root / "locks" / f"pr-{pr}.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    owner = {
        "pid": os.getpid(),
        "host": socket.gethostname(),
        "user": os.environ.get("USERNAME") or os.environ.get("USER") or "unknown",
        "startedAt": datetime.now(timezone.utc).isoformat(),
    }
    try:
        fd = os.open(lock_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError as exc:
        raise DeliveryError(f"PR #{pr} already has a lifecycle operation. Inspect lock {lock_path} before recovery.") from exc
    with os.fdopen(fd, "w", encoding="utf-8") as stream:
        json.dump(owner, stream)
    try:
        yield lock_path
    finally:
        try:
            existing = json.loads(lock_path.read_text(encoding="utf-8"))
            if existing == owner:
                lock_path.unlink()
        except (OSError, ValueError):
            pass


def external_command(executable: str, args: list[str], *, gh: bool = False, cwd: Path = ROOT) -> str:
    path = shutil.which(executable)
    if not path:
        raise DeliveryError(f"{executable} was not found on PATH.")
    return run([path, *args], cwd=cwd, env=safe_env(gh=gh), label=executable)


def gh_pr(pr: int) -> dict:
    result = external_command(
        "gh",
        ["pr", "view", str(pr), "--repo", REPOSITORY, "--json",
         "number,state,isDraft,isCrossRepository,baseRefName,headRefName,headRefOid,headRepository,mergedAt,mergeCommit"],
        gh=True,
    )
    try:
        return json.loads(result)
    except ValueError as exc:
        raise DeliveryError("GitHub CLI returned invalid pull request metadata.") from exc


def assert_origin() -> None:
    origin = git("remote", "get-url", "origin").strip()
    valid = re.fullmatch(
        r"(?:https://github\.com/|git@github\.com:)NathanPannell/parkdex-kip(?:\.git)?",
        origin,
        flags=re.I,
    )
    if not valid:
        raise DeliveryError("Git origin is not NathanPannell/parkdex-kip.")


def validate_pr(pr: dict, pr_number: int) -> tuple[str, str]:
    if (
        pr.get("number") != pr_number
        or pr.get("state") != "OPEN"
        or pr.get("isDraft") is not True
        or pr.get("isCrossRepository") is not False
        or pr.get("baseRefName") != "staging"
    ):
        raise DeliveryError("Preview requires an open same-repository draft PR targeting staging.")
    head_sha = pr.get("headRefOid", "")
    head_ref = pr.get("headRefName", "")
    if not SHA_RE.fullmatch(head_sha):
        raise DeliveryError("GitHub did not return a full 40-character PR head SHA.")
    if (
        not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]{0,199}", head_ref)
        or ".." in head_ref
        or "//" in head_ref
        or "@{" in head_ref
        or head_ref.endswith(("/", "."))
    ):
        raise DeliveryError("The PR head branch name is not safe to fetch.")
    repo = pr.get("headRepository") or {}
    name = repo.get("nameWithOwner")
    if name and name.lower() != REPOSITORY.lower():
        raise DeliveryError("Preview requires a PR head from the canonical repository.")
    return head_sha, head_ref


def assert_clean_staging_harness(config: dict) -> tuple[str, str]:
    assert_origin()
    if git("status", "--porcelain"):
        raise DeliveryError("Run preview creation from a clean staging checkout.")
    git("fetch", "--no-tags", "origin", f"+refs/heads/{config['stagingBranch']}:refs/remotes/origin/{config['stagingBranch']}")
    base_sha = git("rev-parse", f"refs/remotes/origin/{config['stagingBranch']}")
    head_sha = git("rev-parse", "HEAD")
    if head_sha != base_sha:
        raise DeliveryError("The trusted harness must be at the current origin/staging SHA.")
    return head_sha, git("rev-parse", "--show-toplevel")


def fetch_pr_head(head_ref: str, pr_number: int) -> str:
    remote_ref = f"refs/remotes/origin/kip-preview-pr/{pr_number}"
    git("fetch", "--no-tags", "origin", f"+refs/heads/{head_ref}:{remote_ref}")
    return git("rev-parse", remote_ref)


def make_candidate(head_sha: str, base_sha: str) -> tuple[str, Path]:
    output = git("merge-tree", "--write-tree", base_sha, head_sha)
    tree_sha = output.splitlines()[0].strip() if output else ""
    if not SHA_RE.fullmatch(tree_sha):
        raise DeliveryError("The PR and staging branch do not have a clean synthetic merge.")
    env = safe_env(extra={
        "GIT_AUTHOR_NAME": "Parkdex Kip Preview",
        "GIT_AUTHOR_EMAIL": "preview@parkdex.app",
        "GIT_COMMITTER_NAME": "Parkdex Kip Preview",
        "GIT_COMMITTER_EMAIL": "preview@parkdex.app",
    })
    candidate = run(
        ["git", "-C", str(ROOT), "-c", "commit.gpgsign=false", "commit-tree", tree_sha,
         "-p", base_sha, "-p", head_sha, "-m", "Parkdex Kip preview merge candidate"],
        cwd=ROOT,
        env=env,
        label="synthetic merge commit",
    ).strip()
    if not SHA_RE.fullmatch(candidate):
        raise DeliveryError("Git could not create a full synthetic merge candidate.")
    temp_dir = Path(tempfile.mkdtemp(prefix="parkdex-kip-preview-")).resolve()
    try:
        git("worktree", "add", "--detach", str(temp_dir), candidate)
    except Exception:
        shutil.rmtree(temp_dir, ignore_errors=True)
        raise
    return candidate, temp_dir


def remove_candidate(path: Path) -> None:
    temp_root = Path(tempfile.gettempdir()).resolve()
    resolved = path.resolve()
    if resolved.parent != temp_root or not resolved.name.startswith("parkdex-kip-preview-"):
        raise DeliveryError("Refusing to remove a candidate worktree outside its generated temp directory.")
    try:
        git("worktree", "remove", "--force", str(resolved))
    finally:
        if resolved.exists():
            shutil.rmtree(resolved, ignore_errors=True)
        try:
            git("worktree", "prune")
        except DeliveryError:
            pass


def set_release_file(root: Path, sha: str, environment: str) -> None:
    if environment not in ("preview", "staging") or not SHA_RE.fullmatch(sha):
        raise DeliveryError("Release metadata requires an exact SHA and a supported environment.")
    target = root / "public" / "release.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps({"sha": sha, "environment": environment}, separators=(",", ":")) + "\n", encoding="utf-8")


def candidate_checks(candidate_root: Path, state: dict, path: Path) -> None:
    commands = [
        ("install", ["ci"]),
        ("typecheck", ["run", "typecheck"]),
        ("tests", ["test", "--if-present"]),
        ("build", ["run", "build"]),
    ]
    env = safe_env()
    npm = npm_args()
    state["validation"] = []
    for name, args in commands:
        state["status"] = f"validating-{name}"
        save_json(path, state)
        run([*npm, *args], cwd=candidate_root, env=env, label=f"candidate npm {name}")
        state["validation"].append({"check": name, "status": "passed", "at": datetime.now(timezone.utc).isoformat()})
        save_json(path, state)
    run([sys.executable, "-m", "unittest", "discover", "-s", "scripts", "-p", "test_kip*.py"], cwd=candidate_root, env=env, label="candidate delivery tests")
    state["validation"].append({"check": "delivery-tests", "status": "passed", "at": datetime.now(timezone.utc).isoformat()})
    save_json(path, state)
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
        state["validation"].append({"check": "postgresql-content-sync-integration", "status": "passed", "at": datetime.now(timezone.utc).isoformat()})
        save_json(path, state)
        for name in feature["pythonTestPaths"]:
            run(
                [sys.executable, str(candidate_root / name)],
                cwd=candidate_root,
                env=env,
                label=f"candidate content Python test {Path(name).name}",
            )
        state["validation"].append({"check": "content-python-tests", "status": "passed", "at": datetime.now(timezone.utc).isoformat()})
        save_json(path, state)
        run(
            [sys.executable, str(candidate_root / feature["legacyImporterTestPath"]), "ImportPlanTests"],
            cwd=candidate_root,
            env=env,
            label="candidate legacy import unit tests",
        )
        state["validation"].append({"check": "legacy-import-unit-tests", "status": "passed", "at": datetime.now(timezone.utc).isoformat()})
        save_json(path, state)
        run_legacy_import_postgres_qa(load_config(), candidate_root)
        state["validation"].append({"check": "postgresql-legacy-import-integration", "status": "passed", "at": datetime.now(timezone.utc).isoformat()})
        save_json(path, state)

    account_sql = candidate_root / "scripts" / "qa-account-sql.mjs"
    if account_sql.is_file():
        run([*npm, "run", "test:sql"], cwd=candidate_root, env=candidate_sql_env(), label="candidate PostgreSQL integration tests")
        state["validation"].append({"check": "postgresql-account-integration", "status": "passed", "at": datetime.now(timezone.utc).isoformat()})
        save_json(path, state)

    if state.get("accountsPresent"):
        photo_provider().validate_candidate(sys.modules[__name__], load_config(), candidate_root)
        state["validation"].append({"check": "private-photo-worker-bundle", "status": "passed", "at": datetime.now(timezone.utc).isoformat()})
        save_json(path, state)


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


def api_json(base: str, path: str, *, token: str, method: str = "GET", body: dict | None = None,
             query: dict | None = None, not_found_ok: bool = False, timeout: float = 30):
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
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = response.read()
    except urllib.error.HTTPError as exc:
        if not_found_ok and exc.code == 404:
            return None
        raise DeliveryError(f"{urllib.parse.urlsplit(url).netloc} API {method} request failed with HTTP {exc.code}.") from exc
    except (urllib.error.URLError, TimeoutError) as exc:
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
        raise DeliveryError("NEON_API_KEY is required for preview apply or teardown.")
    register_secret(key)
    return api_json(NEON_API, path, token=key, method=method, body=body, query=query, timeout=timeout)


def wait_neon_operations(config: dict, state: dict, journal: Path, response: dict,
                         branch_id: str, phase: str) -> None:
    operations = response.get("operations") if isinstance(response, dict) else None
    if not isinstance(operations, list):
        raise DeliveryError(f"Neon did not return operation identities after {phase} creation.")
    pending: dict[str, dict] = {}
    # Schema-only creation can start the configured parent compute to read its schema.
    allowed_branches = {None, branch_id}
    if phase == "branch":
        allowed_branches.add(config["neonParentBranchId"])
    for item in operations:
        if not isinstance(item, dict):
            raise DeliveryError(f"Neon returned an invalid operation after {phase} creation.")
        operation_id = item.get("id")
        if not isinstance(operation_id, str) or not UUID_RE.fullmatch(operation_id):
            raise DeliveryError(f"Neon returned an invalid operation ID after {phase} creation.")
        if item.get("project_id") not in (None, config["neonProjectId"]):
            raise DeliveryError(f"Neon returned an operation for a different project after {phase} creation.")
        if item.get("branch_id") not in allowed_branches:
            raise DeliveryError(f"Neon returned an operation for a different branch after {phase} creation.")
        if operation_id in pending:
            raise DeliveryError(f"Neon repeated an operation ID after {phase} creation.")
        pending[operation_id] = item

    history = state.setdefault("neonOperations", [])
    for operation_id, item in pending.items():
        history.append({
            "id": operation_id,
            "phase": phase,
            "action": item.get("action"),
            "status": item.get("status", "submitted"),
            "branchId": item.get("branch_id"),
        })
    save_json(journal, state)

    deadline = time.monotonic() + 120
    while pending:
        for operation_id in list(pending):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise DeliveryError(f"Neon {phase} operations did not finish within 120 seconds; keep the preview journal for recovery.")
            try:
                payload = neon_request(
                    config,
                    f"/projects/{config['neonProjectId']}/operations/{operation_id}",
                    timeout=min(10, remaining),
                )
            except DeliveryError as exc:
                message = str(exc)
                if any(f"HTTP {status}" in message for status in (404, 423, 503)):
                    continue
                raise
            operation = payload.get("operation") if isinstance(payload, dict) else None
            if (
                not isinstance(operation, dict)
                or operation.get("id") != operation_id
                or operation.get("project_id") not in (None, config["neonProjectId"])
                or operation.get("branch_id") not in allowed_branches
            ):
                raise DeliveryError(f"Neon operation identity changed while waiting after {phase} creation.")
            status = operation.get("status")
            record = next(entry for entry in history if entry["id"] == operation_id and entry["phase"] == phase)
            record["status"] = status
            record["updatedAt"] = datetime.now(timezone.utc).isoformat()
            if status == "finished":
                pending.pop(operation_id)
            elif status in ("failed", "error", "cancelled", "cancelling", "skipped"):
                save_json(journal, state)
                raise DeliveryError(f"Neon operation failed after {phase} creation with status {status}.")
            elif status not in ("scheduling", "running"):
                save_json(journal, state)
                raise DeliveryError(f"Neon returned an unsupported operation status after {phase} creation.")
        save_json(journal, state)
        if pending:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise DeliveryError(f"Neon {phase} operations did not finish within 120 seconds; keep the preview journal for recovery.")
            time.sleep(min(2, remaining))


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


def neon_branches(config: dict) -> list[dict]:
    project_id = os.environ.get("NEON_PROJECT_ID", config["neonProjectId"])
    if project_id != config["neonProjectId"]:
        raise DeliveryError("NEON_PROJECT_ID does not match deployment.json.")
    results: list[dict] = []
    cursor = None
    seen = set()
    while True:
        query = {"limit": 1000}
        if cursor:
            query["cursor"] = cursor
        payload = neon_request(config, f"/projects/{project_id}/branches", query=query)
        branches = payload.get("branches") if isinstance(payload, dict) else None
        if not isinstance(branches, list):
            raise DeliveryError("Neon returned an incomplete branch inventory.")
        results.extend(branches)
        pagination = payload.get("pagination") or {}
        next_cursor = pagination.get("next")
        if not next_cursor:
            break
        next_cursor = str(next_cursor)
        if next_cursor in seen:
            raise DeliveryError("Neon branch inventory repeated a pagination cursor.")
        seen.add(next_cursor)
        cursor = next_cursor
    return results


def neon_annotations(payload: dict) -> dict:
    return (
        (payload.get("annotation") or {}).get("value")
        or (payload.get("branch") or {}).get("annotation_value")
        or (payload.get("branch") or {}).get("annotations")
        or payload.get("annotation_value")
        or payload.get("annotations")
        or {}
    )


def neon_branch_by_id(config: dict, branch_id: str) -> dict | None:
    project = config["neonProjectId"]
    return neon_request(config, f"/projects/{project}/branches/{branch_id}", method="GET")


def verify_neon_ownership(config: dict, state: dict, branch: dict) -> None:
    details = neon_branch_by_id(config, branch["id"])
    annotations = neon_annotations(details)
    expected = {
        "kip-release-id": state["releaseId"],
        "kip-head-sha": state["headSha"],
        "kip-pr": str(state["pullRequest"]),
    }
    if details.get("branch", {}).get("name", branch.get("name")) != state["branchName"]:
        raise DeliveryError("Neon preview branch name does not match the journal.")
    if any(annotations.get(key) != value for key, value in expected.items()):
        raise DeliveryError("Neon preview branch provenance does not match the journal.")


def create_preview_database(config: dict, state: dict, branch_id: str, journal: Path) -> str:
    project_id = config["neonProjectId"]
    suffix = state["releaseId"].replace("-", "")[:10]
    role_name = f"kip_pr_{state['pullRequest']}_{suffix}"
    database_name = f"kip_preview_{state['pullRequest']}_{suffix}"
    state["intent"]["neonRole"] = {"branchId": branch_id, "name": role_name}
    state["intent"]["neonDatabase"] = {
        "branchId": branch_id,
        "name": database_name,
        "ownerName": role_name,
    }
    state["status"] = "creating-neon-preview-role"
    save_json(journal, state)

    roles_path = f"/projects/{project_id}/branches/{branch_id}/roles"
    role_result = neon_request(config, roles_path, method="POST", body={"role": {"name": role_name}})
    role = role_result.get("role") if isinstance(role_result, dict) else None
    if not isinstance(role, dict) or role.get("name") != role_name or role.get("branch_id") not in (None, branch_id):
        raise DeliveryError("Neon did not return the exact fresh preview role identity.")
    state["resources"]["neonRoleName"] = role_name
    if role.get("id"):
        state["resources"]["neonRoleId"] = role["id"]
    state["status"] = "neon-preview-role-created"
    save_json(journal, state)
    wait_neon_operations(config, state, journal, role_result, branch_id, "role")

    databases_path = f"/projects/{project_id}/branches/{branch_id}/databases"
    listing = neon_request(config, databases_path)
    databases = listing.get("databases") if isinstance(listing, dict) else None
    if not isinstance(databases, list):
        raise DeliveryError("Neon preview database inventory was incomplete.")
    if any(database.get("name") == database_name for database in databases):
        raise DeliveryError("The unique Neon preview database name already exists.")
    state["status"] = "creating-neon-preview-database"
    save_json(journal, state)
    created = neon_request(config, databases_path, method="POST", body={
        "database": {"name": database_name, "owner_name": role_name},
    })
    database = created.get("database") if isinstance(created, dict) else None
    if (
        not isinstance(database, dict)
        or not database.get("id")
        or database.get("name") != database_name
        or database.get("owner_name") not in (None, role_name)
        or database.get("branch_id") not in (None, branch_id)
    ):
        raise DeliveryError("Neon did not return the exact fresh preview database identity.")
    state["resources"]["neonDatabaseId"] = database["id"]
    state["status"] = "neon-preview-database-created"
    save_json(journal, state)
    wait_neon_operations(config, state, journal, created, branch_id, "database")

    connection = neon_request(config, f"/projects/{project_id}/connection_uri", query={
        "branch_id": branch_id,
        "database_name": database_name,
        "role_name": role_name,
        "pooled": "false",
    })
    database_url = connection.get("uri") if isinstance(connection, dict) else None
    if not isinstance(database_url, str):
        raise DeliveryError("Neon did not return a connection for the fresh preview database.")
    _, username, _ = parse_database_url(database_url, database_name)
    if username != role_name or username == config["neonRoleName"]:
        raise DeliveryError("The preview connection did not use a new branch-scoped application role.")
    return database_url


def vercel_project(config: dict) -> dict:
    project_id = os.environ.get(config["vercelPreviewProjectIdEnvironment"], "")
    expected_id = os.environ.get(config["vercelProjectIdEnvironment"], project_id)
    if not project_id or project_id != expected_id or not re.fullmatch(r"prj_[A-Za-z0-9]+", project_id):
        raise DeliveryError("Preview and staging Vercel project IDs must match and use the configured project.")
    team_id = os.environ.get(config["vercelTeamIdEnvironment"], "")
    if not re.fullmatch(r"team_[A-Za-z0-9]+", team_id):
        raise DeliveryError("The Vercel team ID is invalid.")
    result = vercel_request(config, f"/v9/projects/{project_id}")
    if result.get("id") != project_id or result.get("name") != config["vercelProjectName"]:
        raise DeliveryError("Vercel project ID and name did not verify together.")
    return result


def vercel_preview_vars(config: dict, project_id: str) -> None:
    payload = vercel_request(config, f"/v10/projects/{project_id}/env", query={"limit": 100})
    envs = payload.get("envs") if isinstance(payload, dict) else None
    if not isinstance(envs, list):
        raise DeliveryError("Vercel environment-variable inventory was incomplete.")
    pagination = payload.get("pagination") or {}
    if pagination.get("next") or len(envs) >= 100:
        raise DeliveryError("Vercel environment inventory is paginated; refusing to assume Preview variables are absent.")
    scoped = []
    for item in envs:
        if item.get("system") is True:
            continue
        target = item.get("target")
        if target is None:
            scoped.append(item.get("key", "unknown"))
        elif isinstance(target, list) and any(str(value).lower() == "preview" for value in target):
            scoped.append(item.get("key", "unknown"))
        elif isinstance(target, dict) and target.get("preview"):
            scoped.append(item.get("key", "unknown"))
    if scoped:
        raise DeliveryError("The Vercel Preview environment has persistent variables; clear them before creating an isolated preview.")


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


def deployment_for_state(config: dict, state: dict) -> dict | None:
    project_id = os.environ.get(config["vercelPreviewProjectIdEnvironment"], "")
    since_ms = int(datetime.fromisoformat(state["createdAt"]).timestamp() * 1000) - 1000
    candidates = [
        item for item in list_vercel_deployments(config, project_id, since_ms, target="preview")
        if deployment_meta(item).get("kipReleaseId") == state["releaseId"]
    ]
    if len(candidates) > 1:
        raise DeliveryError("Multiple Vercel deployments match the preview release ID.")
    return candidates[0] if candidates else None


def verify_deployment(config: dict, state: dict, deployment: dict) -> None:
    meta = deployment_meta(deployment)
    dep_id = deployment.get("id") or deployment.get("uid")
    project_id = os.environ.get(config["vercelPreviewProjectIdEnvironment"], "")
    if (
        dep_id != state.get("resources", {}).get("vercelDeploymentId")
        or deployment.get("projectId") != project_id
        or deployment.get("target") not in (None, "preview")
        or meta.get("kipReleaseId") != state["releaseId"]
        or meta.get("kipPullRequest") != str(state["pullRequest"])
        or meta.get("githubCommitSha") != state["headSha"]
    ):
        raise DeliveryError("Vercel deployment identity does not match the preview journal.")


def deployment_url(deployment: dict) -> str:
    host = deployment.get("url")
    if not isinstance(host, str):
        raise DeliveryError("Vercel deployment did not return a URL.")
    if host.startswith("https://"):
        parsed = urllib.parse.urlsplit(host)
        if parsed.scheme != "https" or parsed.hostname is None or not parsed.hostname.endswith(".vercel.app"):
            raise DeliveryError("Vercel returned an unexpected preview hostname.")
        return f"https://{parsed.hostname}"
    if not re.fullmatch(r"[A-Za-z0-9.-]+\.vercel\.app", host):
        raise DeliveryError("Vercel returned an unexpected preview hostname.")
    return "https://" + host


def http_json(url: str) -> tuple[int, dict | None]:
    request = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "parkdex-kip-delivery/1"})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            payload = response.read()
            try:
                return response.status, json.loads(payload.decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                return response.status, None
    except urllib.error.HTTPError as exc:
        return exc.code, None
    except (urllib.error.URLError, TimeoutError) as exc:
        raise DeliveryError(f"HTTP check could not reach {urllib.parse.urlsplit(url).hostname}.") from exc


def verify_release_url(config: dict, url: str, sha: str, environment: str, *, api_present: bool) -> None:
    status, release = http_json(url.rstrip("/") + config["releasePath"])
    if status != 200 or release != {"sha": sha, "environment": environment}:
        raise DeliveryError("The deployed /release.json does not match the expected SHA and environment.")
    if api_present:
        status, health = http_json(url.rstrip("/") + config["healthPath"])
        if status != 200 or not isinstance(health, dict) or health.get("ok") is not True or health.get("releaseSha") != sha:
            raise DeliveryError("The API health check did not confirm the expected release SHA.")


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


def run_migration(database_url: str, migration: Path) -> None:
    uri, username, password = parse_database_url(database_url)
    env = safe_env(extra={"PGPASSWORD": password, "PGSSLMODE": "require"})
    run([*psql_args(uri, username, urllib.parse.unquote(uri.path.lstrip("/"))), "-1", "-f", str(migration)],
        cwd=ROOT, env=env, label=f"database migration {migration.name}")


def preview_psql_query(database_url: str, sql: str) -> str:
    uri, username, password = parse_database_url(database_url)
    env = safe_env(extra={"PGPASSWORD": password, "PGSSLMODE": "require"})
    output = run(
        [*psql_args(uri, username, urllib.parse.unquote(uri.path.lstrip("/"))), "-qAt", "-c", sql],
        cwd=ROOT,
        env=env,
        label="preview database verification",
    )
    return output.strip()


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


def verify_preview_database_empty(database_url: str, *, migration_applied: bool, allow_content_clock: bool = False) -> None:
    if not migration_applied:
        tables = preview_psql_query(
            database_url,
            "SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') AND table_type = 'BASE TABLE'",
        )
        if tables != "0":
            raise DeliveryError("The fresh preview database already contains application tables; refusing to use it.")
        return
    clock_guard = ""
    clock_skip = "false"
    if allow_content_clock:
        clock_table = load_config().get("contentSync", {}).get("previewClockTable")
        if not isinstance(clock_table, str) or not re.fullmatch(r"[a-z_][a-z0-9_]*", clock_table):
            raise DeliveryError("The content sync clock allowlist is invalid.")
        clock_guard = f"""
          SELECT count(*) INTO clock_rows FROM public.{clock_table};
          IF clock_rows <> 1 OR NOT EXISTS (
            SELECT 1 FROM public.{clock_table}
             WHERE singleton IS TRUE
               AND revision = 0
               AND retention_floor = 0
               AND last_transaction_id IS NULL
          ) THEN
            RAISE EXCEPTION 'Fresh preview content clock is not exactly initialized';
          END IF;
        """
        clock_skip = f"(item.table_schema = 'public' AND item.table_name = '{clock_table}')"
    preview_psql_query(database_url, f"""
        DO $$ DECLARE item record; populated boolean; clock_rows bigint;
        BEGIN
          {clock_guard}
          FOR item IN SELECT table_schema, table_name FROM information_schema.tables
            WHERE table_schema NOT IN ('pg_catalog','information_schema') AND table_type = 'BASE TABLE'
          LOOP
            IF {clock_skip} THEN CONTINUE; END IF;
            EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.%I LIMIT 1)', item.table_schema, item.table_name) INTO populated;
            IF populated THEN RAISE EXCEPTION 'Fresh preview database contains data'; END IF;
          END LOOP;
        END $$;
    """)


def read_runtime_bundle(config: dict, *, optional: bool = False) -> dict | None:
    env_name = config["runtimeSecretBundleEnvironment"]
    raw = os.environ.get(env_name, "")
    if not raw and optional:
        return None
    if not raw:
        raise DeliveryError(f"{env_name} is required for a staging API deployment.")
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
    return bundle


def verify_runtime_bundle(bundle: dict, config: dict) -> None:
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
    return paths


def accounts_present(config: dict, candidate_root: Path) -> bool:
    paths = migration_paths(config, candidate_root)
    account_names = config.get("optionalMigrationPaths", [])
    return bool(account_names) and all(candidate_root / name in paths for name in account_names)


def require_account_runtime(config: dict, bundle: dict, candidate_root: Path) -> None:
    if not accounts_present(config, candidate_root):
        return
    for key in ("AUTH_SESSION_SECRET", "KIP_PHOTO_SERVICE_TOKEN", "KIP_RETENTION_SECRET"):
        if len(bundle.get(key, "")) < 32:
            raise DeliveryError(f"{key} must be configured with at least 32 random characters.")
    if len({bundle["SESSION_SECRET"], bundle["AUTH_SESSION_SECRET"], bundle["KIP_PHOTO_SERVICE_TOKEN"], bundle["KIP_RETENTION_SECRET"]}) != 4:
        raise DeliveryError("Operator, account, photo, and retention secrets must be distinct.")
    url = urllib.parse.urlsplit(bundle.get("KIP_PHOTO_SERVICE_URL", ""))
    expected_host = config["privatePhotos"]["stagingWorkerName"] + "."
    if url.scheme != "https" or not url.hostname or not url.hostname.startswith(expected_host) or not url.hostname.endswith(".workers.dev") or url.path not in ("", "/") or url.query or url.fragment or url.username or url.port:
        raise DeliveryError("KIP_PHOTO_SERVICE_URL must be the dedicated HTTPS Worker origin.")
    if not re.fullmatch(r"[0-9]+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com", bundle.get("GOOGLE_WEB_CLIENT_ID", "")):
        raise DeliveryError("Staging accounts require a configured Google Web OAuth client.")
    if not bundle.get("AUTH_EMAIL_FROM") and not bundle.get("EMAIL_FROM"):
        raise DeliveryError("Staging accounts require an authentication email sender.")


def runtime_env_for_preview(config: dict, state: dict, database_url: str | None,
                            credential_path_value: Path | None) -> dict:
    if database_url is None or credential_path_value is None:
        return {}
    password_doc = json.loads(credential_path_value.read_text(encoding="utf-8"))
    result = {
        "DATABASE_URL": database_url,
        "SESSION_SECRET": password_doc["sessionSecret"],
        "OPERATOR_PASSWORD_HASH": password_doc["operatorPasswordHash"],
        "EMAIL_MODE": config["previewEmailMode"],
        "RELEASE_SHA": state["headSha"],
    }
    if state.get("accountsPresent"):
        result.update({
            "AUTH_SESSION_SECRET": password_doc["authSessionSecret"],
            "KIP_RETENTION_SECRET": password_doc["retentionSecret"],
            "KIP_PHOTO_SERVICE_TOKEN": password_doc["photoServiceToken"],
            "KIP_PHOTO_SERVICE_URL": state["resources"]["photoServiceUrl"],
        })
    return result


def make_operator_credentials(pr: int, release_id: str) -> Path:
    password = secrets.token_urlsafe(24)
    salt = secrets.token_bytes(32)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 210_000, dklen=32)
    session_secret = secrets.token_urlsafe(48)
    target = credential_path(pr, release_id)
    document = {
        "operatorPassword": password,
        "operatorPasswordHash": f"{salt.hex()}:{digest.hex()}",
        "sessionSecret": session_secret,
        "authSessionSecret": secrets.token_urlsafe(48),
        "photoServiceToken": secrets.token_urlsafe(48),
        "retentionSecret": secrets.token_urlsafe(48),
    }
    for value in document.values():
        register_secret(value)
    save_json(target, document)
    return target


def photo_provider():
    import kip_private_photos
    return kip_private_photos


def merge_photo_journal(state: dict, path: Path) -> None:
    sidecar = state.get("photoJournal")
    if not sidecar:
        return
    expected = path.with_name(f"{path.stem}-{state['releaseId']}-photos.json")
    if Path(sidecar).resolve() != expected.resolve():
        raise DeliveryError("Photo sidecar path does not match the preview journal identity.")
    if not expected.exists():
        return
    photo_state = json.loads(expected.read_text(encoding="utf-8"))
    for key in ("repository", "pullRequest", "releaseId", "headSha", "candidateSha"):
        if photo_state.get(key) != state.get(key):
            raise DeliveryError("Photo sidecar provenance does not match its preview journal.")
    state["resources"].update(photo_state.get("resources", {}))
    state["intent"].update(photo_state.get("intent", {}))
    state["photoStatus"] = photo_state.get("status")
    save_json(path, state)


def write_vercel_files(candidate_root: Path, config: dict, token: str, runtime_env: dict):
    project_id = os.environ.get(config["vercelPreviewProjectIdEnvironment"], "")
    team_id = os.environ.get(config["vercelTeamIdEnvironment"], "")
    if not project_id or not team_id:
        raise DeliveryError("Vercel preview project and team IDs are required.")
    vercel_dir = candidate_root / ".vercel"
    vercel_dir.mkdir(exist_ok=True)
    save_json(vercel_dir / "project.json", {
        "orgId": team_id,
        "projectId": project_id,
        "projectName": config["vercelProjectName"],
    })
    temp_dir = Path(tempfile.mkdtemp(prefix="parkdex-kip-vercel-")).resolve()
    try:
        os.chmod(temp_dir, 0o700)
    except OSError:
        pass
    save_json(temp_dir / "auth.json", {"token": token})
    local_config = {}
    repo_config = candidate_root / "vercel.json"
    if repo_config.is_file():
        try:
            local_config = json.loads(repo_config.read_text(encoding="utf-8"))
        except ValueError as exc:
            raise DeliveryError("Candidate vercel.json is invalid.") from exc
    local_config["env"] = {**(local_config.get("env") or {}), **runtime_env}
    config_path = temp_dir / "vercel.json"
    save_json(config_path, local_config)
    return temp_dir, config_path


def run_vercel(config: dict, args: list[str], auth_dir: Path, *, cwd: Path = ROOT, env_extra: dict[str, str] | None = None) -> str:
    cli = vercel_args()
    project_id = os.environ.get(config["vercelProjectIdEnvironment"]) or os.environ.get(config["vercelPreviewProjectIdEnvironment"], "")
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


def preview_plan(pr: int) -> None:
    config = load_config()
    print(f"plan=preview PR #{pr} in {REPOSITORY} targeting {config['stagingBranch']}")
    print("plan=validate the clean exact origin/staging harness and the open same-repository draft PR")
    print("plan=build a synthetic merge in a temporary worktree with provider credentials removed")
    print("plan=create a 72-hour schema-only Neon branch, fresh app role and empty database, then verify zero rows")
    print("plan=apply only trusted allowlisted migrations required by complete API, account, and content feature markers")
    print("plan=after the fresh-database proof, seed only manifest-verified public content when content sync is present")
    print("plan=deploy one Vercel Preview deployment with isolated runtime credentials and email disabled")
    print(f"plan=journal outside the repository at {journal_path(pr)}")
    print(f"apply-command=pwsh -File scripts/preview-pr.ps1 -PullRequest {pr} -Apply")


def preview_apply(pr: int) -> None:
    config = load_config()
    assert_origin()
    base_sha, _ = assert_clean_staging_harness(config)
    pr_info = gh_pr(pr)
    head_sha, head_ref = validate_pr(pr_info, pr)
    if fetch_pr_head(head_ref, pr) != head_sha:
        raise DeliveryError("The PR head changed while fetching its branch.")
    if git("rev-parse", f"refs/remotes/origin/{config['stagingBranch']}") != base_sha:
        raise DeliveryError("The staging branch changed while preparing the candidate.")
    vercel_project(config)
    project_id = os.environ[config["vercelPreviewProjectIdEnvironment"]]
    vercel_preview_vars(config, project_id)
    assert_vercel_cli_version(config)
    path = journal_path(pr)
    if path.exists():
        previous = json.loads(path.read_text(encoding="utf-8"))
        if previous.get("status") != "cleaned" and (previous.get("intent") or previous.get("resources")):
            raise DeliveryError(f"PR #{pr} has an active preview journal. Tear it down before creating another.")
        if previous.get("status") != "cleaned":
            history = state_root() / "history" / f"pr-{pr}-{previous.get('releaseId','unknown')}.json"
            history.parent.mkdir(parents=True, exist_ok=True)
            os.replace(path, history)
        elif previous.get("absenceVerifiedAt"):
            history = state_root() / "history" / f"pr-{pr}-{previous.get('releaseId','unknown')}.json"
            history.parent.mkdir(parents=True, exist_ok=True)
            os.replace(path, history)
        else:
            raise DeliveryError(f"PR #{pr} has an unverified prior journal.")
    release_id = str(uuid.uuid4())
    state = {
        "schema": "parkdex-kip.preview/v1",
        "repository": REPOSITORY,
        "pullRequest": pr,
        "releaseId": release_id,
        "headSha": head_sha,
        "baseSha": base_sha,
        "branchName": f"kip-pr-{pr}-{head_sha[:8]}-{release_id[:8]}",
        "ownerHost": socket.gethostname(),
        "ownerUser": os.environ.get("USERNAME") or os.environ.get("USER") or "unknown",
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "status": "validating",
        "resources": {},
        "intent": {},
        "validation": [],
    }
    save_json(path, state)
    candidate_root = None
    auth_dir = None
    local_config_path = None
    credential_file = None
    photo_executor = None
    photo_future = None
    try:
        candidate_sha, candidate_root = make_candidate(head_sha, base_sha)
        state["candidateSha"] = candidate_sha
        has_api, has_migration = migration_presence(candidate_root)
        state["apiPresent"] = has_api
        migrations = migration_paths(config, candidate_root)
        state["accountsPresent"] = accounts_present(config, candidate_root)
        state["contentSyncPresent"] = content_sync_present(config, candidate_root)
        set_release_file(candidate_root, head_sha, "preview")
        candidate_checks(candidate_root, state, path)
        pr_latest = gh_pr(pr)
        latest_head, _ = validate_pr(pr_latest, pr)
        latest_base, _ = assert_clean_staging_harness(config)
        if latest_head != head_sha or latest_base != base_sha:
            raise DeliveryError("The PR head or staging base changed after candidate validation.")

        database_url = None
        if has_migration:
            credential_file = make_operator_credentials(pr, release_id)
            state["credentialFile"] = str(credential_file)
            save_json(path, state)
            if state["accountsPresent"]:
                photo_path = path.with_name(f"{path.stem}-{state['releaseId']}-photos.json")
                photo_state = json.loads(json.dumps(state))
                photo_state["resources"] = {}
                photo_state["intent"] = {}
                state["photoJournal"] = str(photo_path)
                save_json(path, state)
                save_json(photo_path, photo_state)
                photo_executor = ThreadPoolExecutor(max_workers=1)
                photo_future = photo_executor.submit(photo_provider().create_preview, sys.modules[__name__], config, photo_state, photo_path, candidate_root, credential_file)
            branches = neon_branches(config)
            parent_id = config["neonParentBranchId"]
            parent = [branch for branch in branches if branch.get("id") == parent_id]
            if len(parent) != 1:
                raise DeliveryError("The configured persistent Neon staging parent was not found exactly once.")
            if any(branch.get("name") == state["branchName"] for branch in branches):
                raise DeliveryError("The unique Neon preview branch name already exists.")
            expires_at = (datetime.now(timezone.utc) + timedelta(hours=config["previewExpiryHours"])).isoformat()
            state["intent"]["neon"] = {
                "projectId": config["neonProjectId"],
                "branchName": state["branchName"],
                "parentBranchId": parent_id,
                "initSource": config["previewDatabaseInitSource"],
            }
            state["status"] = "creating-neon-branch"
            save_json(path, state)
            created = neon_request(config, f"/projects/{config['neonProjectId']}/branches", method="POST", body={
                "branch": {
                    "name": state["branchName"],
                    "parent_id": parent_id,
                    "init_source": config["previewDatabaseInitSource"],
                    "expires_at": expires_at,
                },
                "endpoints": [{"type": "read_write"}],
                "annotation_value": {
                    "kip-release-id": release_id,
                    "kip-head-sha": head_sha,
                    "kip-pr": str(pr),
                    "repository": REPOSITORY,
                },
            })
            branch = created.get("branch") if isinstance(created, dict) else None
            if not isinstance(branch, dict) or not branch.get("id") or branch.get("name") != state["branchName"]:
                raise DeliveryError("Neon did not return the exact owned branch identity.")
            state["resources"]["neonBranchId"] = branch["id"]
            state["status"] = "waiting-neon-branch-operations"
            save_json(path, state)
            wait_neon_operations(config, state, path, created, branch["id"], "branch")
            verify_neon_ownership(config, state, branch)
            state["status"] = "neon-created"
            save_json(path, state)
            database_url = create_preview_database(config, state, branch["id"], path)
            verify_preview_database_empty(database_url, migration_applied=False)
            for migration in migrations:
                run_migration(database_url, migration)
            verify_preview_database_empty(
                database_url,
                migration_applied=True,
                allow_content_clock=state["contentSyncPresent"],
            )
            if state["contentSyncPresent"]:
                bootstrap_content(config, candidate_root, database_url, "preview")
                state["contentSeededAt"] = datetime.now(timezone.utc).isoformat()
            state["status"] = "neon-migrated"
            save_json(path, state)

        if photo_future:
            photo_future.result()
            merge_photo_journal(state, path)
            photo_provider().verify_preview(sys.modules[__name__], config, state)

        token = vercel_token(config)
        runtime_env = runtime_env_for_preview(config, state, database_url, credential_file)
        auth_dir, local_config_path = write_vercel_files(candidate_root, config, token, runtime_env)
        state["intent"]["vercel"] = {
            "projectId": project_id,
            "target": "preview",
            "headSha": head_sha,
            "releaseId": release_id,
        }
        state["status"] = "creating-vercel-deployment"
        save_json(path, state)
        output = run_vercel(config, [
            "deploy", "--cwd", str(candidate_root), "--yes", "--target", "preview", "--no-wait",
            "--local-config", str(local_config_path),
            "--meta", f"githubCommitSha={head_sha}",
            "--meta", f"kipReleaseId={release_id}",
            "--meta", f"kipPullRequest={pr}",
            "--meta", f"kipCandidateSha={candidate_sha}",
        ], auth_dir, cwd=candidate_root)
        url_match = re.findall(r"https://[A-Za-z0-9.-]+\.vercel\.app", output)
        if not url_match:
            raise DeliveryError("Vercel accepted no recognizable preview URL; preserve the journal for recovery.")
        response = vercel_request(config, f"/v13/deployments/{urllib.parse.urlsplit(url_match[-1]).hostname}")
        dep_id = response.get("id") or response.get("uid")
        if not dep_id:
            raise DeliveryError("Vercel did not return a deployment ID; preserve the journal for recovery.")
        state["resources"]["vercelDeploymentId"] = dep_id
        verify_deployment(config, state, response)
        state["url"] = deployment_url(response)
        state["status"] = "waiting-vercel-ready"
        save_json(path, state)
        ready = wait_for_preview(config, state, path)
        verify_release_url(config, state["url"], head_sha, "preview", api_present=has_api)
        if state["accountsPresent"]:
            photo_provider().verify_preview(sys.modules[__name__], config, state)
        state["status"] = "ready-for-browser-verification"
        state["readyAt"] = datetime.now(timezone.utc).isoformat()
        save_json(path, state)
        print(f"preview-url={state['url']}")
        print(f"pull-request={pr}")
        print(f"head-sha={head_sha}")
        print(f"release-id={release_id}")
        print(f"deployment-id={ready.get('id') or ready.get('uid')}")
        print(f"journal={path}")
        if credential_file:
            print(f"operator-credential-file={credential_file}")
        print("preview-email-mode=disabled")
        print(f"teardown-command=pwsh -File scripts/teardown-preview-pr.ps1 -PullRequest {pr} -Apply")
    except Exception as exc:
        if photo_future:
            try:
                photo_future.result()
            except Exception as photo_error:
                state["photoFailure"] = redact(str(photo_error))
            merge_photo_journal(state, path)
        if state.get("intent") or state.get("resources"):
            state["status"] = "failed-needs-teardown"
            state["failure"] = redact(str(exc))
            save_json(path, state)
            print(f"partial-preview-may-exist; preserve journal {path}", file=sys.stderr)
            print(f"recovery-command=pwsh -File scripts/teardown-preview-pr.ps1 -PullRequest {pr} -Apply", file=sys.stderr)
        else:
            state["status"] = "validation-failed"
            state["failure"] = redact(str(exc))
            save_json(path, state)
        raise
    finally:
        if photo_executor:
            photo_executor.shutdown(wait=True)
        if auth_dir and auth_dir.exists():
            shutil.rmtree(auth_dir, ignore_errors=True)
        if candidate_root:
            remove_candidate(candidate_root)


def _vercel_auth_dir(config: dict) -> Path:
    token = vercel_token(config)
    root = Path(tempfile.mkdtemp(prefix="parkdex-kip-vercel-auth-")).resolve()
    try:
        os.chmod(root, 0o700)
    except OSError:
        pass
    save_json(root / "auth.json", {"token": token})
    return root


def wait_for_preview(config: dict, state: dict, path: Path) -> dict:
    dep_id = state["resources"]["vercelDeploymentId"]
    end = time.time() + 900
    while time.time() < end:
        deployment = vercel_request(config, f"/v13/deployments/{dep_id}")
        verify_deployment(config, state, deployment)
        status = deployment.get("readyState") or deployment.get("state")
        if status == "READY":
            return deployment
        if status in ("ERROR", "CANCELED", "BLOCKED"):
            raise DeliveryError(f"Vercel preview reached terminal state {status}.")
        state["providerStatus"] = status
        state["lastProviderCheckAt"] = datetime.now(timezone.utc).isoformat()
        save_json(path, state)
        time.sleep(10)
    raise DeliveryError("Vercel preview did not reach READY within 15 minutes.")


def teardown_plan(pr: int) -> None:
    config = load_config()
    print(f"plan=read the exact external journal for {REPOSITORY} PR #{pr}")
    print("plan=verify staging or the explicit abandoned, aborted, or superseded condition")
    print("plan=delete only the journaled Vercel deployment and Neon branch after provenance checks")
    print("plan=require three consecutive all-absent provider inventories after a consistency grace period")
    print(f"plan=journal={journal_path(pr)}")
    print(f"apply-command=pwsh -File scripts/teardown-preview-pr.ps1 -PullRequest {pr} -Apply")


def staging_sha_for_pr(pr_info: dict) -> str:
    merge = pr_info.get("mergeCommit") or {}
    sha = merge.get("oid") or merge.get("sha")
    if pr_info.get("state") != "MERGED" or not SHA_RE.fullmatch(sha or ""):
        raise DeliveryError("The preview can be cleaned after the PR is merged and its exact merge SHA is known.")
    return sha


def delete_neon_branch(config: dict, state: dict) -> None:
    branch_id = state.get("resources", {}).get("neonBranchId")
    if not branch_id:
        return
    branches = neon_branches(config)
    found = [branch for branch in branches if branch.get("id") == branch_id]
    if len(found) > 1:
        raise DeliveryError("Neon returned a duplicate exact branch ID.")
    if not found:
        return
    verify_neon_ownership(config, state, found[0])
    state["status"] = "deleting-neon-branch"
    save_json(journal_path(state["pullRequest"]), state)
    neon_request(config, f"/projects/{config['neonProjectId']}/branches/{branch_id}", method="DELETE")


def delete_vercel_deployment(config: dict, state: dict) -> None:
    dep_id = state.get("resources", {}).get("vercelDeploymentId")
    if not dep_id:
        return
    exact = vercel_request(config, f"/v13/deployments/{dep_id}", not_found_ok=True)
    if exact is None:
        return
    verify_deployment(config, state, exact)
    state["status"] = "deleting-vercel-deployment"
    save_json(journal_path(state["pullRequest"]), state)
    vercel_request(config, f"/v13/deployments/{dep_id}", method="DELETE")


def recover_intended_resources(config: dict, state: dict, path: Path) -> None:
    if state.get("intent", {}).get("neon") and not state.get("resources", {}).get("neonBranchId"):
        branches = neon_branches(config)
        matches = [item for item in branches if item.get("name") == state["branchName"]]
        if len(matches) > 1:
            raise DeliveryError("Multiple Neon branches match the journaled preview name.")
        if matches:
            verify_neon_ownership(config, state, matches[0])
            state["resources"]["neonBranchId"] = matches[0]["id"]
            save_json(path, state)
    if state.get("intent", {}).get("vercel") and not state.get("resources", {}).get("vercelDeploymentId"):
        candidate = deployment_for_state(config, state)
        if candidate:
            state["resources"]["vercelDeploymentId"] = candidate.get("id") or candidate.get("uid")
            verify_deployment(config, state, candidate)
            save_json(path, state)


def verify_teardown_condition(config: dict, state: dict, pr_info: dict) -> None:
    if pr_info.get("state") == "MERGED" and pr_info.get("mergedAt"):
        if os.environ.get("STAGING_VERIFIED") != "1":
            raise DeliveryError("Set STAGING_VERIFIED=1 after the merged SHA and affected staging journey pass.")
        merged_sha = staging_sha_for_pr(pr_info)
        verify_release_url(config, config["stagingUrl"], merged_sha, "staging", api_present=bool(state.get("apiPresent")))
        if state.get("accountsPresent"):
            photo_provider().verify_staging(sys.modules[__name__], config, merged_sha)
        state["stagingVerifiedSha"] = merged_sha
        return
    if pr_info.get("state") == "CLOSED" and os.environ.get("PREVIEW_ABANDONED") == "1":
        return
    if pr_info.get("state") == "OPEN" and state.get("status") == "failed-needs-teardown" and os.environ.get("PREVIEW_ABORTED") == "1":
        return
    if pr_info.get("state") == "OPEN" and pr_info.get("headRefOid") != state["headSha"] and os.environ.get("PREVIEW_SUPERSEDED") == "1":
        return
    raise DeliveryError(
        "Teardown requires verified staging, PREVIEW_ABANDONED=1 for a closed PR, "
        "PREVIEW_ABORTED=1 for a failed draft preview, or PREVIEW_SUPERSEDED=1 after a head change."
    )


def resource_absent_observation(config: dict, state: dict) -> dict:
    neon_absent = True
    vercel_absent = True
    neon_id = state.get("resources", {}).get("neonBranchId")
    neon_name = state.get("branchName")
    if state.get("intent", {}).get("neon"):
        branches = neon_branches(config)
        matching = [item for item in branches if item.get("name") == neon_name or item.get("id") == neon_id]
        if matching:
            neon_absent = False
    vercel_id = state.get("resources", {}).get("vercelDeploymentId")
    if state.get("intent", {}).get("vercel"):
        matches = deployment_for_state(config, state)
        if matches:
            vercel_absent = False
        if vercel_id:
            exact = vercel_request(config, f"/v13/deployments/{vercel_id}", not_found_ok=True)
            if exact is not None:
                verify_deployment(config, state, exact)
                vercel_absent = False
    return {
        "neonAbsent": neon_absent,
        "vercelAbsent": vercel_absent,
        "photosAbsent": photo_provider().absence(sys.modules[__name__], config, state) if state.get("accountsPresent") else True,
        "at": datetime.now(timezone.utc).isoformat(),
    }


def teardown_apply(pr: int) -> None:
    config = load_config()
    path = journal_path(pr)
    if not path.is_file():
        raise DeliveryError(f"No external preview journal exists for PR #{pr}.")
    state = json.loads(path.read_text(encoding="utf-8"))
    if (
        state.get("schema") != "parkdex-kip.preview/v1"
        or state.get("repository") != REPOSITORY
        or state.get("pullRequest") != pr
        or not SHA_RE.fullmatch(state.get("headSha", ""))
    ):
        raise DeliveryError("Preview journal identity is invalid.")
    if state.get("status") == "cleaned" and state.get("absenceVerifiedAt"):
        print(f"preview-already-cleaned={path}")
        return
    pr_info = gh_pr(pr)
    verify_teardown_condition(config, state, pr_info)
    merge_photo_journal(state, path)
    recover_intended_resources(config, state, path)
    errors = []
    try:
        delete_vercel_deployment(config, state)
    except Exception as exc:
        errors.append(f"Vercel: {redact(str(exc))}")
    try:
        delete_neon_branch(config, state)
    except Exception as exc:
        errors.append(f"Neon: {redact(str(exc))}")
    if state.get("accountsPresent"):
        try:
            photo_provider().delete_preview(sys.modules[__name__], config, state, path)
        except Exception as exc:
            errors.append(f"Cloudflare private photos: {redact(str(exc))}")
    if errors:
        state["status"] = "cleanup-failed"
        state["cleanupErrors"] = errors
        save_json(path, state)
        raise DeliveryError("One or more preview deletions failed: " + "; ".join(errors))
    state["status"] = "verifying-absence"
    state["cleanupErrors"] = []
    save_json(path, state)
    observations = []
    time.sleep(15)
    for index in range(3):
        observation = resource_absent_observation(config, state)
        observations.append(observation)
        state["absenceObservations"] = observations
        save_json(path, state)
        if any(observation.get(key) is not True for key in ("neonAbsent", "vercelAbsent", "photosAbsent")):
            state["status"] = "cleanup-pending"
            save_json(path, state)
            raise DeliveryError("A journaled preview resource is still visible; keep the journal and retry teardown.")
        if index < 2:
            time.sleep(10)
    state["status"] = "cleaned"
    state["absenceVerifiedAt"] = datetime.now(timezone.utc).isoformat()
    state["stagingVerifiedSha"] = state.get("stagingVerifiedSha")
    save_json(path, state)
    credential = state.get("credentialFile")
    if credential:
        try:
            Path(credential).unlink(missing_ok=True)
        except OSError:
            pass
    print(f"preview-cleaned=pr-{pr}")
    print(f"absence-observations={len(observations)}")
    print(f"journal={path}")


def verify_git_sha(expected: str, *, staging_only: bool = False, clean: bool = True) -> None:
    if not SHA_RE.fullmatch(expected or ""):
        raise DeliveryError("Expected SHA must be a full 40-character lowercase Git SHA.")
    actual = git("rev-parse", "HEAD")
    if actual != expected:
        raise DeliveryError(f"Checkout HEAD {actual} does not match requested SHA {expected}.")
    if clean and git("status", "--porcelain"):
        raise DeliveryError("Run release operations from a clean checkout.")
    if staging_only and os.environ.get("GITHUB_REF") and os.environ["GITHUB_REF"] != "refs/heads/staging":
        raise DeliveryError("This release operation is restricted to the staging branch.")


def prepare_release(args) -> None:
    verify_git_sha(args.sha, staging_only=args.environment == "staging")
    set_release_file(ROOT, args.sha, args.environment)
    print(f"release-file=public/release.json environment={args.environment} sha={args.sha}")


def staging_api_state(config: dict) -> tuple[bool, bool]:
    return migration_presence(ROOT)


def migration_staging(args) -> None:
    config = load_config()
    verify_git_sha(args.sha, staging_only=True, clean=False)
    has_api, has_migration = staging_api_state(config)
    migrations = migration_paths(config, ROOT)
    has_content_sync = content_sync_present(config, ROOT)
    if not has_migration:
        print("migration=skipped static bootstrap has no API or feedback schema")
        return
    if not args.apply:
        for migration in migrations:
            print(f"plan=apply {migration.relative_to(ROOT).as_posix()} to the dedicated Parkdex Kip staging database")
        if has_content_sync:
            print("plan=run the all-or-nothing verified public content bootstrap after the additive migrations")
        return
    bundle = read_runtime_bundle(config)
    verify_runtime_bundle(bundle, config)
    database_url = bundle.get("MIGRATION_DATABASE_URL") or bundle["DATABASE_URL"]
    parse_database_url(database_url, config["neonDatabaseName"])
    require_account_runtime(config, bundle, ROOT)
    for migration in migrations:
        run_migration(database_url, migration)
        print(f"migration-applied={migration.relative_to(ROOT).as_posix()}")
    if has_content_sync:
        bootstrap_content(config, ROOT, database_url, "staging")
        print("content-bootstrap=verified public content inserted missing-only in one staging transaction")


def ensure_previous_staging_resolved(config: dict, project_id: str) -> None:
    deployments = list_vercel_deployments(config, project_id, int((time.time() - 90 * 86400) * 1000), target="preview")
    staging = [item for item in deployments if deployment_meta(item).get("kipEnvironment") == "staging"]
    if not staging:
        return
    latest = max(staging, key=lambda item: int(item.get("createdAt") or item.get("created") or 0))
    status = latest.get("readyState") or latest.get("state")
    previous_sha = deployment_meta(latest).get("githubCommitSha")
    if status != "READY" or not SHA_RE.fullmatch(previous_sha or ""):
        raise DeliveryError("A previous staging deployment is unresolved. Verify or recover it before starting another release.")
    status, release = http_json(config["stagingUrl"].rstrip("/") + config["releasePath"])
    if status != 200 or not isinstance(release, dict) or release.get("sha") != previous_sha:
        raise DeliveryError("The prior staging SHA has not passed its stable URL verification and alias step.")


def staging_runtime_env(config: dict, bundle: dict | None, sha: str, *, api_present: bool) -> dict:
    if not api_present:
        return {}
    if bundle is None:
        raise DeliveryError("The staging runtime secret bundle is required for the API deployment.")
    verify_runtime_bundle(bundle, config)
    require_account_runtime(config, bundle, ROOT)
    return {
        **{key: bundle[key] for key in config["runtimeSecretBundleKeys"]},
        **{key: bundle[key] for key in config.get("runtimeOptionalKeys", []) if key in bundle},
        "AUTH_EMAIL_FROM": bundle.get("AUTH_EMAIL_FROM", bundle["EMAIL_FROM"]),
        "EMAIL_MODE": config["stagingEmailMode"],
        "PUBLIC_APP_URL": config["stagingUrl"],
        "ALLOWED_ORIGINS": ",".join([
            "http://localhost",
            "https://localhost",
            "capacitor://localhost",
            config["stagingUrl"],
        ]),
        "RELEASE_SHA": sha,
    }


def dispatch_staging(args) -> None:
    config = load_config()
    verify_git_sha(args.sha, staging_only=True, clean=False)
    if os.environ.get("GITHUB_RUN_ATTEMPT", "1") != "1":
        raise DeliveryError("Staging release dispatch is first-attempt only.")
    has_api, has_migration = staging_api_state(config)
    if has_api != has_migration:
        raise DeliveryError("Staging API and migration must be released together.")
    if not args.apply:
        print(f"plan=queue the exact {args.sha} Vercel Preview deployment for staging")
        print("plan=use the runtime secret bundle only when the feedback API is present")
        print("plan=wait for provider readiness and assign the stable alias outside GitHub Actions")
        return
    project_id = os.environ.get(config["vercelProjectIdEnvironment"], "")
    if not project_id or not re.fullmatch(r"prj_[A-Za-z0-9]+", project_id):
        raise DeliveryError(f"{config['vercelProjectIdEnvironment']} is required.")
    token = vercel_token(config)
    if has_api:
        bundle = read_runtime_bundle(config)
    else:
        bundle = None
    ensure_previous_staging_resolved(config, project_id)
    auth_dir = Path(tempfile.mkdtemp(prefix="parkdex-kip-staging-auth-")).resolve()
    runtime_dir = None
    try:
        os.chmod(auth_dir, 0o700)
    except OSError:
        pass
    save_json(auth_dir / "auth.json", {"token": token})
    try:
        runtime_env = staging_runtime_env(config, bundle, args.sha, api_present=has_api)
        local_config = {}
        config_file = ROOT / "vercel.json"
        if config_file.is_file():
            try:
                local_config = json.loads(config_file.read_text(encoding="utf-8"))
            except ValueError as exc:
                raise DeliveryError("vercel.json is invalid.") from exc
        local_config["env"] = {**(local_config.get("env") or {}), **runtime_env}
        runtime_dir = Path(tempfile.mkdtemp(prefix="parkdex-kip-staging-config-")).resolve()
        try:
            os.chmod(runtime_dir, 0o700)
        except OSError:
            pass
        local_config_path = runtime_dir / "vercel.json"
        save_json(local_config_path, local_config)
        release_id = f"staging-{args.sha}"
        output = run_vercel(config, [
            "deploy", "--cwd", str(ROOT), "--yes", "--target", "preview", "--no-wait",
            "--local-config", str(local_config_path),
            "--meta", f"githubCommitSha={args.sha}",
            "--meta", f"kipReleaseId={release_id}",
            "--meta", "kipEnvironment=staging",
        ], auth_dir, cwd=ROOT)
        urls = re.findall(r"https://[A-Za-z0-9.-]+\.vercel\.app", output)
        if urls:
            print(f"deployment-url={urls[-1]}")
        print(f"release-sha={args.sha}")
        print(f"release-id={release_id}")
        print("dispatch=accepted; Vercel readiness and staging alias are verified outside this workflow")
    finally:
        shutil.rmtree(auth_dir, ignore_errors=True)
        if runtime_dir:
            shutil.rmtree(runtime_dir, ignore_errors=True)


def dispatch_staging_services(args) -> None:
    """Queue independent services together; convergence is checked outside Actions."""
    config = load_config()
    verify_git_sha(args.sha, staging_only=True, clean=False)
    if not accounts_present(config, ROOT):
        dispatch_staging(args)
        return
    if os.environ.get("GITHUB_RUN_ATTEMPT", "1") != "1":
        raise DeliveryError("Staging release dispatch is first-attempt only.")
    if not args.apply:
        print("plan=queue the private photo Worker and Vercel concurrently after ordered migrations")
        return
    bundle = read_runtime_bundle(config)
    verify_runtime_bundle(bundle, config)
    require_account_runtime(config, bundle, ROOT)
    failures = []
    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [
            ("Vercel", executor.submit(dispatch_staging, args)),
            ("Cloudflare", executor.submit(photo_provider().dispatch_staging, sys.modules[__name__], config, ROOT, args.sha, bundle)),
        ]
        for name, future in futures:
            try:
                result = future.result()
                if result:
                    print(f"{name.lower()}-dispatch={json.dumps(result)}")
            except Exception as exc:
                failures.append(f"{name}: {redact(str(exc))}")
    if failures:
        raise DeliveryError("Staging dispatch needs manual recovery: " + "; ".join(failures))


def provision_staging_photos(args) -> None:
    config = load_config()
    base_sha, _ = assert_clean_staging_harness(config)
    path = state_root() / "persistent" / "private-photos-staging.json"
    preview_pr = getattr(args, "from_preview_pr", None)
    if preview_pr is None:
        photo_provider().provision_staging(sys.modules[__name__], config, path, apply=args.apply)
        return
    if not 1 <= preview_pr <= 999999:
        raise DeliveryError("Preview PR number is invalid.")
    with lifecycle_lock(preview_pr):
        state = verified_photo_source(config, preview_pr, base_sha)
        # Only the standalone Worker from the verified merge tree is copied. No
        # candidate scripts, runtime credentials, or local working files run here.
        source_path = config["privatePhotos"]["sourcePath"]
        if not re.fullmatch(r"cloudflare/[A-Za-z0-9_-]+\.mjs", source_path):
            raise DeliveryError("The trusted private-photo source path is invalid.")
        object_name = f"{state['candidateSha']}:{source_path}"
        try:
            blob = subprocess.run(["git", "-C", str(ROOT), "show", object_name], env=safe_env(), capture_output=True, check=True, timeout=30).stdout
        except (OSError, subprocess.SubprocessError) as exc:
            raise DeliveryError("Could not read the exact verified Worker blob.") from exc
        object_hash = hashlib.sha1(b"blob " + str(len(blob)).encode("ascii") + b"\0" + blob).hexdigest()
        if object_hash != git("rev-parse", object_name):
            raise DeliveryError("The extracted Worker bytes do not match the verified Git blob.")
        with tempfile.TemporaryDirectory(prefix="parkdex-kip-photo-provision-") as directory:
            root = Path(directory)
            worker = root / source_path
            worker.parent.mkdir(parents=True)
            worker.write_bytes(blob)
            photo_provider().provision_staging(
                sys.modules[__name__], config, path, apply=args.apply,
                candidate_root=root, release_sha=state["headSha"],
            )
        persistent = json.loads(path.read_text(encoding="utf-8"))
        persistent["sourcePreview"] = {
            key: state[key] for key in ("pullRequest", "releaseId", "headSha", "baseSha", "candidateSha")
        }
        save_json(path, persistent)


def attest_preview_browser(args) -> None:
    if not 1 <= args.pr <= 999999 or not re.fullmatch(r"dpl_[A-Za-z0-9]+", args.deployment_id):
        raise DeliveryError("Browser attestation requires a valid PR and full Vercel deployment ID.")
    config = load_config()
    base_sha, _ = assert_clean_staging_harness(config)
    with lifecycle_lock(args.pr):
        state = verified_photo_source(config, args.pr, base_sha, require_attestation=False)
        deployment_id = state["resources"]["vercelDeploymentId"]
        if deployment_id != args.deployment_id:
            raise DeliveryError("Browser attestation deployment ID does not match the owned preview.")
        state.update({
            "browserVerifiedHeadSha": state["headSha"],
            "browserVerifiedCandidateSha": state["candidateSha"],
            "browserVerifiedDeploymentId": deployment_id,
            "browserVerifiedAt": datetime.now(timezone.utc).isoformat(),
        })
        save_json(journal_path(args.pr), state)
    print(f"browser-attested-preview=PR #{args.pr} deployment {deployment_id}")


def verified_photo_source(config: dict, pr: int, base_sha: str, *, require_attestation: bool = True) -> dict:
    try:
        state = json.loads(journal_path(pr).read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise DeliveryError("The source preview journal is unavailable.") from exc
    head_sha, head_ref = validate_pr(gh_pr(pr), pr)
    if (
        state.get("schema") != "parkdex-kip.preview/v1"
        or state.get("repository") != REPOSITORY
        or state.get("pullRequest") != pr
        or not UUID_RE.fullmatch(state.get("releaseId", ""))
        or state.get("status") != "ready-for-browser-verification"
        or state.get("accountsPresent") is not True
        or state.get("headSha") != head_sha
        or state.get("baseSha") != base_sha
        or not SHA_RE.fullmatch(state.get("candidateSha", ""))
    ):
        raise DeliveryError("Staging photo provisioning requires the current owned account preview.")
    if require_attestation and (
        state.get("browserVerifiedHeadSha") != head_sha
        or state.get("browserVerifiedCandidateSha") != state["candidateSha"]
        or state.get("browserVerifiedDeploymentId") != state.get("resources", {}).get("vercelDeploymentId")
        or not state.get("browserVerifiedAt")
    ):
        raise DeliveryError("Staging photo provisioning requires browser attestation for the current preview deployment.")
    if fetch_pr_head(head_ref, pr) != head_sha:
        raise DeliveryError("The source preview PR changed while fetching.")
    parents = git("rev-list", "--parents", "-n", "1", state["candidateSha"]).split()
    if parents != [state["candidateSha"], base_sha, head_sha]:
        raise DeliveryError("The source preview merge candidate has unexpected parents.")
    tree = git("merge-tree", "--write-tree", base_sha, head_sha).splitlines()[0]
    if tree != git("rev-parse", f"{state['candidateSha']}^{{tree}}"):
        raise DeliveryError("The source preview is not the exact current merge candidate.")
    photo_provider().verify_preview(sys.modules[__name__], config, state)
    deployment_id = state.get("resources", {}).get("vercelDeploymentId", "")
    if not re.fullmatch(r"dpl_[A-Za-z0-9]+", deployment_id):
        raise DeliveryError("The source preview deployment ID is invalid.")
    deployment = vercel_request(config, f"/v13/deployments/{deployment_id}")
    verify_deployment(config, state, deployment)
    if (deployment.get("readyState") or deployment.get("state")) != "READY":
        raise DeliveryError("The source preview deployment is not ready.")
    url = state.get("url")
    if url != deployment_url(deployment):
        raise DeliveryError("The source preview deployment URL is missing.")
    verify_release_url(config, url, head_sha, "preview", api_present=True)
    return state


def assign_staging(args) -> None:
    config = load_config()
    if not re.fullmatch(r"dpl_[A-Za-z0-9]+", args.deployment_id):
        raise DeliveryError("Deployment ID must be a full Vercel dpl_ identifier.")
    if not SHA_RE.fullmatch(args.sha or ""):
        raise DeliveryError("Staging alias assignment requires the full merge SHA.")
    if not args.apply:
        print(f"plan=assign {args.deployment_id} to https://{config['stagingAlias']} after READY and SHA verification")
        print(f"plan=expected githubCommitSha={args.sha}")
        return
    deployment = vercel_request(config, f"/v13/deployments/{args.deployment_id}")
    meta = deployment_meta(deployment)
    if (
        deployment.get("id") != args.deployment_id
        or deployment.get("projectId") != os.environ.get(config["vercelProjectIdEnvironment"])
        or deployment.get("target") not in (None, "preview")
        or (deployment.get("readyState") or deployment.get("state")) != "READY"
        or meta.get("githubCommitSha") != args.sha
        or meta.get("kipEnvironment") != "staging"
    ):
        raise DeliveryError("The deployment is not the READY staging candidate for the requested merge SHA.")
    auth_dir = _vercel_auth_dir(config)
    try:
        assert_vercel_cli_version(config)
        run_vercel(config, [
            "alias", "set", deployment_url(deployment), config["stagingAlias"],
        ], auth_dir, cwd=ROOT)
    finally:
        shutil.rmtree(auth_dir, ignore_errors=True)
    print(f"staging-alias=https://{config['stagingAlias']}")
    print(f"deployment-id={args.deployment_id}")
    print(f"release-sha={args.sha}")


def verify_staging(args) -> None:
    config = load_config()
    has_api, _ = staging_api_state(config)
    verify_release_url(config, config["stagingUrl"], args.sha, "staging", api_present=has_api)
    if accounts_present(config, ROOT):
        photo_provider().verify_staging(sys.modules[__name__], config, args.sha)
    print(f"staging-url={config['stagingUrl']}")
    print(f"release-sha={args.sha}")
    print("staging-verification=passed")


def teardown(pr: int, apply: bool) -> None:
    if not apply:
        teardown_plan(pr)
        return
    with lifecycle_lock(pr):
        teardown_apply(pr)


def preview(pr: int, apply: bool) -> None:
    if not apply:
        preview_plan(pr)
        return
    with lifecycle_lock(pr):
        preview_apply(pr)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Parkdex Kip delivery lifecycle")
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("preview", "teardown"):
        item = sub.add_parser(name)
        item.add_argument("--pr", required=True, type=int)
        item.add_argument("--apply", action="store_true")
    item = sub.add_parser("write-release")
    item.add_argument("--environment", choices=("preview", "staging"), required=True)
    item.add_argument("--sha", required=True)
    item = sub.add_parser("migrate-staging")
    item.add_argument("--sha", required=True)
    item.add_argument("--apply", action="store_true")
    sub.add_parser("qa-content-sync")
    sub.add_parser("qa-legacy-import")
    item = sub.add_parser("deploy-staging")
    item.add_argument("--sha", required=True)
    item.add_argument("--apply", action="store_true")
    item = sub.add_parser("deploy-staging-services")
    item.add_argument("--sha", required=True)
    item.add_argument("--apply", action="store_true")
    item = sub.add_parser("assign-staging")
    item.add_argument("--deployment-id", required=True)
    item.add_argument("--sha", required=True)
    item.add_argument("--apply", action="store_true")
    item = sub.add_parser("verify-staging")
    item.add_argument("--sha", required=True)
    item = sub.add_parser("provision-staging-photos")
    item.add_argument("--from-preview-pr", type=int)
    item.add_argument("--apply", action="store_true")
    item = sub.add_parser("attest-preview-browser")
    item.add_argument("--pr", required=True, type=int)
    item.add_argument("--deployment-id", required=True)
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        if args.command == "preview":
            if not (1 <= args.pr <= 999999):
                raise DeliveryError("PR number must be between 1 and 999999.")
            preview(args.pr, args.apply)
        elif args.command == "teardown":
            if not (1 <= args.pr <= 999999):
                raise DeliveryError("PR number must be between 1 and 999999.")
            teardown(args.pr, args.apply)
        elif args.command == "write-release":
            prepare_release(args)
        elif args.command == "migrate-staging":
            migration_staging(args)
        elif args.command == "qa-content-sync":
            qa_content_sync()
        elif args.command == "qa-legacy-import":
            qa_legacy_import()
        elif args.command == "deploy-staging":
            dispatch_staging(args)
        elif args.command == "deploy-staging-services":
            dispatch_staging_services(args)
        elif args.command == "assign-staging":
            assign_staging(args)
        elif args.command == "verify-staging":
            verify_staging(args)
        elif args.command == "provision-staging-photos":
            provision_staging_photos(args)
        elif args.command == "attest-preview-browser":
            attest_preview_browser(args)
    except (DeliveryError, OSError, ValueError) as exc:
        print(redact(str(exc)), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

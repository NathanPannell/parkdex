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
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = ROOT / "deployment.json"
REPOSITORY = "NathanPannell/parkdex-kip"
NEON_API = "https://console.neon.tech/api/v2"
VERCEL_API = "https://api.vercel.com"
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
ID_RE = re.compile(r"^[0-9]+$")
SECRET_VALUES: list[str] = []


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
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(path.parent, 0o700)
    except OSError:
        pass
    temp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
        json.dump(data, stream, indent=2)
        stream.write("\n")
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


def api_json(base: str, path: str, *, token: str, method: str = "GET", body: dict | None = None,
             query: dict | None = None, not_found_ok: bool = False):
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
        with urllib.request.urlopen(request, timeout=30) as response:
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


def neon_request(config: dict, path: str, *, method: str = "GET", body: dict | None = None, query: dict | None = None):
    key = os.environ.get("NEON_API_KEY", "")
    if not key:
        raise DeliveryError("NEON_API_KEY is required for preview apply or teardown.")
    register_secret(key)
    return api_json(NEON_API, path, token=key, method=method, body=body, query=query)


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


def psql_args(uri: urllib.parse.SplitResult, username: str, database: str) -> list[str]:
    executable = shutil.which("psql")
    if not executable and os.name == "nt":
        for candidate in sorted(Path("C:/Program Files/PostgreSQL").glob("*/bin/psql.exe"), reverse=True):
            if candidate.is_file():
                executable = str(candidate)
                break
    if not executable:
        raise DeliveryError("PostgreSQL client psql was not found.")
    return [
        executable, "-X", "-v", "ON_ERROR_STOP=1", "-h", uri.hostname,
        "-p", str(uri.port or 5432), "-U", username, "-d", database,
    ]


def run_migration(database_url: str, migration: Path) -> None:
    uri, username, password = parse_database_url(database_url)
    env = safe_env(extra={"PGPASSWORD": password, "PGSSLMODE": "require"})
    run([*psql_args(uri, username, urllib.parse.unquote(uri.path.lstrip("/"))), "-f", str(migration)],
        cwd=ROOT, env=env, label="feedback migration")


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


def verify_preview_database_empty(database_url: str, *, migration_applied: bool) -> None:
    if not migration_applied:
        tables = preview_psql_query(
            database_url,
            "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'kip_feedback'",
        )
        if tables != "0":
            raise DeliveryError("The fresh preview database already contains feedback tables; refusing to use it.")
        return
    counts = preview_psql_query(database_url, """
        SELECT
          (SELECT count(*) FROM kip_feedback.reports)::text || ':' ||
          (SELECT count(*) FROM kip_feedback.attachments)::text || ':' ||
          (SELECT count(*) FROM kip_feedback.email_deliveries)::text || ':' ||
          (SELECT count(*) FROM kip_feedback.rate_limits)::text
    """)
    if counts != "0:0:0:0":
        raise DeliveryError("The preview feedback database is not empty after migration; refusing to deploy it.")


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
    allowed = expected | {"MIGRATION_DATABASE_URL"}
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


def runtime_env_for_preview(config: dict, state: dict, database_url: str | None,
                            credential_path_value: Path | None) -> dict:
    if database_url is None or credential_path_value is None:
        return {}
    password_doc = json.loads(credential_path_value.read_text(encoding="utf-8"))
    return {
        "DATABASE_URL": database_url,
        "SESSION_SECRET": password_doc["sessionSecret"],
        "OPERATOR_PASSWORD_HASH": password_doc["operatorPasswordHash"],
        "EMAIL_MODE": config["previewEmailMode"],
        "RELEASE_SHA": state["headSha"],
    }


def make_operator_credentials(pr: int, release_id: str) -> Path:
    password = secrets.token_urlsafe(24)
    salt = secrets.token_bytes(32)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 210_000, dklen=32)
    session_secret = secrets.token_urlsafe(48)
    target = credential_path(pr, release_id)
    save_json(target, {
        "operatorPassword": password,
        "operatorPasswordHash": f"{salt.hex()}:{digest.hex()}",
        "sessionSecret": session_secret,
    })
    register_secret(password)
    register_secret(session_secret)
    register_secret(f"{salt.hex()}:{digest.hex()}")
    return target


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
    print("plan=apply only the feedback migration when the API is present")
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
    try:
        candidate_sha, candidate_root = make_candidate(head_sha, base_sha)
        state["candidateSha"] = candidate_sha
        has_api, has_migration = migration_presence(candidate_root)
        state["apiPresent"] = has_api
        set_release_file(candidate_root, head_sha, "preview")
        candidate_checks(candidate_root, state, path)
        pr_latest = gh_pr(pr)
        latest_head, _ = validate_pr(pr_latest, pr)
        latest_base, _ = assert_clean_staging_harness(config)
        if latest_head != head_sha or latest_base != base_sha:
            raise DeliveryError("The PR head or staging base changed after candidate validation.")

        database_url = None
        if has_migration:
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
            verify_neon_ownership(config, state, branch)
            state["status"] = "neon-created"
            save_json(path, state)
            database_url = create_preview_database(config, state, branch["id"], path)
            verify_preview_database_empty(database_url, migration_applied=False)
            run_migration(database_url, candidate_root / config["migrationPath"])
            verify_preview_database_empty(database_url, migration_applied=True)
            credential_file = make_operator_credentials(pr, release_id)
            state["credentialFile"] = str(credential_file)
            state["status"] = "neon-migrated"
            save_json(path, state)

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
    neon_id = state.get("resources", {}).get("neonBranchId")
    neon_name = state.get("branchName")
    if state.get("intent", {}).get("neon"):
        branches = neon_branches(config)
        matching = [item for item in branches if item.get("name") == neon_name or item.get("id") == neon_id]
        if matching:
            return {"neonAbsent": False, "vercelAbsent": None, "at": datetime.now(timezone.utc).isoformat()}
    else:
        branches = []
    vercel_id = state.get("resources", {}).get("vercelDeploymentId")
    if state.get("intent", {}).get("vercel"):
        matches = deployment_for_state(config, state)
        if matches:
            return {"neonAbsent": True if not state.get("intent", {}).get("neon") else True,
                    "vercelAbsent": False, "at": datetime.now(timezone.utc).isoformat()}
        if vercel_id:
            exact = vercel_request(config, f"/v13/deployments/{vercel_id}", not_found_ok=True)
            if exact is not None:
                verify_deployment(config, state, exact)
                return {"neonAbsent": True if not state.get("intent", {}).get("neon") else True,
                        "vercelAbsent": False, "at": datetime.now(timezone.utc).isoformat()}
    return {
        "neonAbsent": True,
        "vercelAbsent": True,
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
        if observation.get("neonAbsent") is not True or observation.get("vercelAbsent") is not True:
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
    if not has_migration:
        print("migration=skipped static bootstrap has no API or feedback schema")
        return
    if not args.apply:
        print(f"plan=apply {config['migrationPath']} to the dedicated Parkdex Kip staging database")
        return
    bundle = read_runtime_bundle(config)
    verify_runtime_bundle(bundle, config)
    database_url = bundle.get("MIGRATION_DATABASE_URL") or bundle["DATABASE_URL"]
    parse_database_url(database_url, config["neonDatabaseName"])
    migration = ROOT / config["migrationPath"]
    if not migration.is_file():
        raise DeliveryError("The configured additive feedback migration is missing.")
    run_migration(database_url, migration)
    print(f"migration-applied={config['migrationPath']}")


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
    return {
        **{key: bundle[key] for key in config["runtimeSecretBundleKeys"]},
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
            "--yes",
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
    item = sub.add_parser("deploy-staging")
    item.add_argument("--sha", required=True)
    item.add_argument("--apply", action="store_true")
    item = sub.add_parser("assign-staging")
    item.add_argument("--deployment-id", required=True)
    item.add_argument("--sha", required=True)
    item.add_argument("--apply", action="store_true")
    item = sub.add_parser("verify-staging")
    item.add_argument("--sha", required=True)
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
        elif args.command == "deploy-staging":
            dispatch_staging(args)
        elif args.command == "assign-staging":
            assign_staging(args)
        elif args.command == "verify-staging":
            verify_staging(args)
    except (DeliveryError, OSError, ValueError) as exc:
        print(redact(str(exc)), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

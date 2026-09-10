"""Create or adopt one isolated, schema-only Neon branch for a local preview."""

from __future__ import annotations

import json
import os
import re
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


API_BASE = "https://console.neon.tech/api/v2"


def request(method: str, path: str, api_key: str, body: dict | None = None) -> dict:
    payload = None if body is None else json.dumps(body).encode()
    req = Request(
        f"{API_BASE}{path}",
        data=payload,
        method=method,
        headers={
            "Accept": "application/json",
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "User-Agent": "parkdex-local-preview/1",
        },
    )
    try:
        with urlopen(req, timeout=20) as response:
            return json.load(response)
    except HTTPError as error:
        detail = {}
        try:
            detail = json.loads(error.read(16_384))
        except (json.JSONDecodeError, UnicodeDecodeError):
            pass
        code = str(detail.get("code", "unknown"))[:80]
        message = str(detail.get("message", "request rejected"))[:300]
        raise RuntimeError(f"Neon API {error.code} {code}: {message}") from None
    except (TimeoutError, URLError):
        raise RuntimeError("Neon API network failure; response status is unknown") from None


def exact_branch(branches: list[dict], name: str) -> dict | None:
    matches = [branch for branch in branches if branch.get("name") == name]
    if len(matches) > 1:
        raise RuntimeError(f"Neon returned duplicate branch name {name}")
    return matches[0] if matches else None


def connection_uri(project: str, branch: str, api_key: str, pooled: bool) -> str:
    query = urlencode({
        "branch_id": branch,
        "database_name": os.environ.get("NEON_DATABASE", "app"),
        "role_name": os.environ.get("NEON_ROLE", "app_owner"),
        "pooled": str(pooled).lower(),
    })
    for attempt in range(6):
        try:
            return request("GET", f"/projects/{project}/connection_uri?{query}", api_key)["uri"]
        except RuntimeError as error:
            if not any(f" {status} " in str(error) for status in (404, 423, 503)) or attempt == 5:
                raise
            time.sleep(2**attempt)
    raise RuntimeError("Neon connection URI was not available")


def main() -> None:
    project = os.environ["NEON_PROJECT_ID"]
    api_key = os.environ["NEON_API_KEY"]
    branch_name = os.environ["NEON_BRANCH"]
    parent_name = os.environ["NEON_PARENT_BRANCH"]
    expires_at = os.environ["NEON_EXPIRES_AT"]
    marker = os.environ["NEON_RUN_MARKER"]
    output_path = os.environ["NEON_OUTPUT_PATH"]
    if not re.fullmatch(r"[a-z0-9-]{1,60}", project):
        raise RuntimeError("NEON_PROJECT_ID has an invalid shape")
    if not re.fullmatch(r"[a-z0-9][a-z0-9/-]{0,60}", branch_name):
        raise RuntimeError("NEON_BRANCH has an invalid shape")
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9 _/-]{0,60}", parent_name):
        raise RuntimeError("NEON_PARENT_BRANCH has an invalid shape")
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", expires_at):
        raise RuntimeError("NEON_EXPIRES_AT must be UTC RFC3339")

    listing = request("GET", f"/projects/{project}/branches?{urlencode({'limit': 1000})}", api_key)
    branches = listing.get("branches", [])
    parent = exact_branch(branches, parent_name)
    if not parent or not re.fullmatch(r"br-[a-z0-9-]+", str(parent.get("id", ""))):
        raise RuntimeError(f"Neon parent branch {parent_name!r} was not found exactly")

    branch = exact_branch(branches, branch_name)
    created = branch is None
    if created:
        payload = {
            "branch": {
                "name": branch_name,
                "parent_id": parent["id"],
                "init_source": "parent-schema",
                "expires_at": expires_at,
            },
            "endpoints": [{"type": "read_write"}],
            "annotation_value": {
                "parkdex-local-run": marker,
                "parkdex-local-parent": parent["id"],
            },
        }
        try:
            branch = request("POST", f"/projects/{project}/branches", api_key, payload).get("branch")
        except RuntimeError as error:
            recovered = request("GET", f"/projects/{project}/branches?{urlencode({'limit': 1000})}", api_key)
            branch = exact_branch(recovered.get("branches", []), branch_name)
            if not branch:
                raise error
    if not branch or not re.fullmatch(r"br-[a-z0-9-]+", str(branch.get("id", ""))):
        raise RuntimeError("Neon branch identity was not verified")
    if branch.get("name") != branch_name or branch.get("init_source") != "parent-schema":
        raise RuntimeError("Existing Neon branch is not a schema-only branch")
    if not created and branch.get("parent_id") not in (None, parent["id"]):
        raise RuntimeError("Existing Neon branch parent does not match the requested parent")

    pooled = connection_uri(project, branch["id"], api_key, True)
    unpooled = connection_uri(project, branch["id"], api_key, False)
    output = {
        "branch_id": branch["id"],
        "branch_name": branch_name,
        "parent_name": parent_name,
        "created": created,
        "expires_at": expires_at,
        "db_url_pooled": pooled,
        "db_url": unpooled,
    }
    with open(output_path, "w", encoding="utf-8") as handle:
        json.dump(output, handle)
    print(f"Neon local preview branch verified: {branch_name} ({branch['id']})")


if __name__ == "__main__":
    try:
        main()
    except (KeyError, RuntimeError) as error:
        raise SystemExit(str(error)) from None

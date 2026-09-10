# Parkdex MCP server

Parkdex ships a local, authenticated MCP server over the standard stdio transport. It uses the [official MCP Python SDK v2](https://py.sdk.modelcontextprotocol.io/) (`mcp==2.2.0`) and calls the same authenticated REST API as the app; there is no hosted MCP endpoint in this change.

## Setup

Install the backend dependencies, then run the interactive setup with the API origin:

```sh
python -m pip install -r backend/requirements-dev.txt
python -m backend.app.mcp_server setup --origin https://parkdex.app
```

The setup prompt calls `POST /api/auth/login` with the existing account email and password. Email is the actual Parkdex login identifier (not a new MCP identity). The password is entered with `getpass` and discarded; only the resulting bearer session token is saved in the operating system keyring, scoped by normalized API origin and email. For headless environments, set `PARKDEX_API_ORIGIN`, `PARKDEX_ACCOUNT_EMAIL`, and `PARKDEX_SESSION_TOKEN` instead; never put a token in a prompt, command log, or source file.

Revoke the saved session and remove only that origin/email keyring entry with `python -m backend.app.mcp_server logout --origin https://parkdex.app --email you@example.com`.

Origins must use HTTPS, except `http://localhost`, `http://127.0.0.1`, or `http://[::1]` for local development. The client does not follow redirects and rejects responses from a different origin. Sessions retain the app's existing expiration and revocation behavior.

## Run and workflow

Configure an MCP host to launch:

```json
{
  "mcpServers": {
    "parkdex": {
      "command": "python",
      "args": ["-m", "backend.app.mcp_server"]
    }
  }
}
```

The intended workflow is `search_places` (optionally `visited=false`, `type`/`category`, text, origin latitude/longitude, `radius_km`, `limit`, and `offset`) → `get_place_details` → `create_group` with `place_ids` → `add_places_to_group` / `remove_places_from_group`. Origin results are in kilometres, nearest-first, with deterministic name/ID tie ordering and bounded pagination. `list_groups`, `get_group`, `rename_group`, and `delete_group` manage private account-owned groups; each account also has one protected `Wishlist`, available through `get_wishlist`, `add_places_to_wishlist`, and `remove_places_from_wishlist`. Wishlist cannot be renamed/deleted. Duplicate place IDs are ignored. The `/api/trips` REST/MCP names remain compatibility aliases over the same group records. MCP exposes no visit mutation or collection-key access.

Example tool sequence:

```text
search_places(visited=false, type="national", latitude=49.28, longitude=-123.12, radius_km=100, limit=10)
get_place_details(place_id="...")
create_group(name="Weekend parks", place_ids=["..."])
add_places_to_wishlist(place_ids=["..."])
```

Groups and Wishlist entries created through MCP are immediately visible in the app, and app-created groups are returned by MCP because both use the same persisted REST/database records.

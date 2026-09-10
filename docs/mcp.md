# Parkdex MCP server

Parkdex exposes a public, authenticated MCP server from its Railway API at `https://<railway-api-domain>/mcp`. It uses the official MCP Python SDK v2 Streamable HTTP transport and OAuth 2.1 authorization-code flow with PKCE. Any Parkdex account with a password can authorize an MCP client without sharing credentials with that client.

## Connect

Add this remote MCP server URL to an MCP client:

```text
https://<railway-api-domain>/mcp
```

The client discovers Parkdex's OAuth metadata, dynamically registers, and opens the Parkdex authorization page. Sign in there and approve access. Access is account-scoped, revocable, and never grants the MCP client access to Parkdex's REST session endpoints.

Google-only accounts must set a Parkdex password before using the hosted authorization page. Local development uses the same endpoint at `http://localhost:8000/mcp` with `API_PUBLIC_URL=http://localhost:8000` and `MCP_PUBLIC_URL=http://localhost:8000/mcp`.

## Groups and tools

A Group is a private, account-owned collection of places. Wishlist is the protected Group named `Wishlist`: it uses the same records and membership operations as every other Group, but cannot be renamed or deleted.

The server exposes ten tools:

- `search_places` and `get_place_details`
- `list_groups`, `get_group`, `create_group`, `rename_group`, and `delete_group`
- `add_places_to_group` and `remove_places_from_group`
- `get_wishlist`, a convenience lookup for the protected Wishlist Group

The intended workflow is `search_places` → `get_place_details` → `create_group` → `add_places_to_group` or `remove_places_from_group`. Search supports visit state, place category, text, origin coordinates, radius, and bounded pagination. Results with an origin are nearest-first with deterministic name/ID tie ordering. Duplicate place IDs are ignored, and changes made through MCP appear immediately in the Parkdex app because both use the same persisted Group records.

The MCP server does not expose visit mutation, route optimization, social sharing, or collection-key access.

## Optional local stdio client

The repository retains a local stdio client for development. Install backend dependencies, save a revocable Parkdex session in the operating-system keyring, then launch the server:

```sh
python -m pip install -r backend/requirements-dev.txt
python -m backend.app.mcp_server setup --origin https://parkdex.app
python -m backend.app.mcp_server
```

For headless development, use `PARKDEX_API_ORIGIN`, `PARKDEX_ACCOUNT_EMAIL`, and `PARKDEX_SESSION_TOKEN`. Never put a token in a prompt, command log, or source file. Revoke and remove the saved session with `python -m backend.app.mcp_server logout --origin https://parkdex.app --email you@example.com`.

"""Local Parkdex MCP server using the official MCP Python SDK v2 stdio transport."""

from __future__ import annotations

import argparse
import getpass
import os
from dataclasses import dataclass
from urllib.parse import urlsplit, urlunsplit

import httpx
import keyring
from keyring.errors import PasswordDeleteError
from mcp.server import MCPServer


KEYRING_SERVICE = "parkdex-mcp-session"
SESSION_ENV = "PARKDEX_SESSION_TOKEN"
EMAIL_ENV = "PARKDEX_ACCOUNT_EMAIL"
ORIGIN_ENV = "PARKDEX_API_ORIGIN"
MAX_TIMEOUT_SECONDS = 20.0


def normalize_origin(value: str) -> str:
    raw = value.strip()
    parsed = urlsplit(raw)
    if parsed.username or parsed.password or parsed.fragment or parsed.query:
        raise ValueError("API origin must not include credentials, query, or fragment")
    hostname = (parsed.hostname or "").lower().rstrip(".")
    allowed_local = hostname in {"localhost", "127.0.0.1", "::1"}
    if parsed.scheme != "https" and not (parsed.scheme == "http" and allowed_local):
        raise ValueError("API origin must use HTTPS (HTTP is allowed only for local development)")
    if not hostname or parsed.path not in {"", "/"}:
        raise ValueError("API origin must be a host origin without a path")
    netloc = hostname
    if parsed.port is not None:
        default = (parsed.scheme == "https" and parsed.port == 443) or (
            parsed.scheme == "http" and parsed.port == 80
        )
        if not default:
            netloc = f"{netloc}:{parsed.port}"
    return urlunsplit((parsed.scheme, netloc, "", "", ""))


def keyring_user(origin: str, email: str) -> str:
    return f"{normalize_origin(origin)}|{email.strip().lower()}"


def _same_origin(url: httpx.URL, origin: str) -> bool:
    expected = httpx.URL(origin)
    return (url.scheme, url.host, url.port) == (expected.scheme, expected.host, expected.port)


def session_token(origin: str, email: str | None = None) -> str:
    token = os.environ.get(SESSION_ENV, "").strip()
    if token:
        return token
    account_email = (email or os.environ.get(EMAIL_ENV, "")).strip().lower()
    if not account_email:
        raise RuntimeError(f"Set {SESSION_ENV}, or set {EMAIL_ENV} for the keyring session")
    token = keyring.get_password(KEYRING_SERVICE, keyring_user(origin, account_email))
    if not token:
        raise RuntimeError("No Parkdex session found; run `python -m backend.app.mcp_server setup`")
    return token


def setup_session(origin: str) -> None:
    origin = normalize_origin(origin)
    email = input("Parkdex email (your existing account login identifier): ").strip().lower()
    password = getpass.getpass("Parkdex password: ")
    with httpx.Client(base_url=origin, follow_redirects=False, timeout=MAX_TIMEOUT_SECONDS) as client:
        response = client.post("/api/auth/login", json={"email": email, "password": password})
        if not _same_origin(response.url, origin):
            raise RuntimeError("Login response came from an unexpected origin")
    if 300 <= response.status_code < 400 or response.status_code != 200:
        raise RuntimeError("Parkdex login failed; check the email and password")
    try:
        payload = response.json()
        token = payload["token"]
    except (ValueError, KeyError, TypeError) as exc:
        raise RuntimeError("Parkdex login returned an invalid response") from exc
    if not isinstance(token, str) or not token:
        raise RuntimeError("Parkdex login returned no session")
    keyring.set_password(KEYRING_SERVICE, keyring_user(origin, email), token)
    print(f"Session saved for {email} at {origin}; the password was not stored.")


@dataclass
class ParkdexClient:
    origin: str
    token: str

    def __post_init__(self) -> None:
        self.origin = normalize_origin(self.origin)
        self._client = httpx.Client(
            base_url=self.origin,
            headers={"Authorization": f"Bearer {self.token}"},
            follow_redirects=False,
            timeout=MAX_TIMEOUT_SECONDS,
        )

    def close(self) -> None:
        self._client.close()

    def request(self, method: str, path: str, **kwargs) -> dict | list | None:
        response = self._client.request(method, path, **kwargs)
        if not _same_origin(response.url, self.origin):
            raise RuntimeError("Parkdex rejected an unexpected redirect")
        if 300 <= response.status_code < 400:
            raise RuntimeError("Parkdex returned an unexpected redirect")
        if response.status_code >= 400:
            try:
                detail = response.json().get("detail", "request failed")
            except (ValueError, AttributeError):
                detail = "request failed"
            raise RuntimeError(f"Parkdex request failed ({response.status_code}): {detail}")
        if response.status_code == 204:
            return None
        return response.json()


def _client() -> ParkdexClient:
    origin = normalize_origin(os.environ.get(ORIGIN_ENV, "https://parkdex.app"))
    return ParkdexClient(origin, session_token(origin))


def logout_session(origin: str, email: str | None = None) -> None:
    origin = normalize_origin(origin)
    account_email = (email or os.environ.get(EMAIL_ENV, "")).strip().lower()
    if not account_email:
        account_email = input("Parkdex email for the saved session: ").strip().lower()
    token = session_token(origin, account_email)
    client = ParkdexClient(origin, token)
    try:
        client.request("POST", "/api/auth/logout")
    finally:
        client.close()
    try:
        keyring.delete_password(KEYRING_SERVICE, keyring_user(origin, account_email))
    except PasswordDeleteError:
        pass
    print(f"Session revoked for {account_email} at {origin}.")


mcp = MCPServer(
    "Parkdex Trips",
    description="Search Parkdex places and manage private account-owned trips.",
    instructions="Use search_places first, then get_place_details, then create_group or add_places_to_wishlist. Groups and Wishlist are private to the authenticated Parkdex account.",
)


@mcp.tool()
def search_places(
    visited: bool | None = None,
    type: str | None = None,
    category: str | None = None,
    query: str | None = None,
    latitude: float | None = None,
    longitude: float | None = None,
    radius_km: float | None = None,
    limit: int = 25,
    offset: int = 0,
) -> dict:
    """Search active places. `type` and `category` use national/provincial/regional/island; origin searches are nearest-first."""
    if type and category and type != category:
        raise ValueError("type and category must match when both are provided")
    client = _client()
    try:
        params = {"visited": visited, "type": type or category, "query": query, "latitude": latitude, "longitude": longitude, "radius_km": radius_km, "limit": limit, "offset": offset}
        return client.request("GET", "/api/places/search", params={k: v for k, v in params.items() if v is not None})
    finally:
        client.close()


@mcp.tool()
def get_place_details(place_id: str) -> dict:
    """Retrieve one active place's details and whether it is visited by this account."""
    client = _client()
    try:
        return client.request("GET", f"/api/places/{place_id}")
    finally:
        client.close()


@mcp.tool()
def list_trips() -> list:
    """List this account's private trips."""
    client = _client()
    try:
        return client.request("GET", "/api/trips")
    finally:
        client.close()


@mcp.tool()
def get_trip(trip_id: str) -> dict:
    """Get one private trip with its active places."""
    client = _client()
    try:
        return client.request("GET", f"/api/trips/{trip_id}")
    finally:
        client.close()


@mcp.tool()
def create_trip(name: str, place_ids: list[str] | None = None) -> dict:
    """Create a private trip and optionally add existing active places; duplicate IDs are ignored."""
    client = _client()
    try:
        return client.request("POST", "/api/trips", json={"name": name, "placeIds": place_ids or []})
    finally:
        client.close()


@mcp.tool()
def rename_trip(trip_id: str, name: str) -> dict:
    """Rename a private trip."""
    client = _client()
    try:
        return client.request("PATCH", f"/api/trips/{trip_id}", json={"name": name})
    finally:
        client.close()


@mcp.tool()
def delete_trip(trip_id: str) -> dict:
    """Delete a private trip."""
    client = _client()
    try:
        client.request("DELETE", f"/api/trips/{trip_id}")
        return {"deleted": True, "trip_id": trip_id}
    finally:
        client.close()


@mcp.tool()
def add_places_to_trip(trip_id: str, place_ids: list[str]) -> dict:
    """Add active places to a private trip; duplicate memberships are ignored."""
    client = _client()
    try:
        return client.request("POST", f"/api/trips/{trip_id}/places", json={"placeIds": place_ids})
    finally:
        client.close()


@mcp.tool()
def remove_places_from_trip(trip_id: str, place_ids: list[str]) -> dict:
    """Remove places from a private trip; no visit state is changed."""
    client = _client()
    try:
        return client.request("DELETE", f"/api/trips/{trip_id}/places", json={"placeIds": place_ids})
    finally:
        client.close()


@mcp.tool()
def list_groups() -> list:
    """List this account's private groups, including its protected Wishlist group."""
    client = _client()
    try:
        return client.request("GET", "/api/groups")
    finally:
        client.close()


@mcp.tool()
def get_group(group_id: str) -> dict:
    """Get one private group with its active places."""
    client = _client()
    try:
        return client.request("GET", f"/api/groups/{group_id}")
    finally:
        client.close()


@mcp.tool()
def create_group(name: str, place_ids: list[str] | None = None) -> dict:
    """Create an ordinary private group; duplicate place IDs are ignored."""
    client = _client()
    try:
        return client.request("POST", "/api/groups", json={"name": name, "placeIds": place_ids or []})
    finally:
        client.close()


@mcp.tool()
def rename_group(group_id: str, name: str) -> dict:
    """Rename an ordinary group; the protected Wishlist cannot be renamed."""
    client = _client()
    try:
        return client.request("PATCH", f"/api/groups/{group_id}", json={"name": name})
    finally:
        client.close()


@mcp.tool()
def delete_group(group_id: str) -> dict:
    """Delete an ordinary private group; the protected Wishlist cannot be deleted."""
    client = _client()
    try:
        client.request("DELETE", f"/api/groups/{group_id}")
        return {"deleted": True, "group_id": group_id}
    finally:
        client.close()


@mcp.tool()
def add_places_to_group(group_id: str, place_ids: list[str]) -> dict:
    """Add active places to an ordinary group or Wishlist; duplicate memberships are ignored."""
    client = _client()
    try:
        return client.request("POST", f"/api/groups/{group_id}/places", json={"placeIds": place_ids})
    finally:
        client.close()


@mcp.tool()
def remove_places_from_group(group_id: str, place_ids: list[str]) -> dict:
    """Remove places from a group without changing visit state."""
    client = _client()
    try:
        return client.request("DELETE", f"/api/groups/{group_id}/places", json={"placeIds": place_ids})
    finally:
        client.close()


@mcp.tool()
def get_wishlist() -> dict:
    """Get this account's protected singleton Wishlist, creating it if needed."""
    client = _client()
    try:
        return client.request("GET", "/api/wishlist")
    finally:
        client.close()


@mcp.tool()
def add_places_to_wishlist(place_ids: list[str]) -> dict:
    """Add active places to the protected Wishlist; duplicate memberships are ignored."""
    client = _client()
    try:
        return client.request("POST", "/api/wishlist/places", json={"placeIds": place_ids})
    finally:
        client.close()


@mcp.tool()
def remove_places_from_wishlist(place_ids: list[str]) -> dict:
    """Remove places from the protected Wishlist without changing visit state."""
    client = _client()
    try:
        return client.request("DELETE", "/api/wishlist/places", json={"placeIds": place_ids})
    finally:
        client.close()


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Parkdex MCP server and safe session setup")
    parser.add_argument("command", choices=("serve", "setup", "logout"), nargs="?", default="serve")
    parser.add_argument("--origin", default=os.environ.get(ORIGIN_ENV, "https://parkdex.app"))
    parser.add_argument("--email", default=os.environ.get(EMAIL_ENV))
    args = parser.parse_args(argv)
    if args.command == "setup":
        setup_session(args.origin)
        return
    if args.command == "logout":
        logout_session(args.origin, args.email)
        return
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()

import asyncio
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
from uuid import uuid4

import httpx
from mcp import Client, StdioServerParameters
import psycopg


ROOT = Path(__file__).resolve().parents[2]


def _payload(result) -> dict:
    if result.structured_content is not None:
        return result.structured_content
    text = next(item.text for item in result.content if item.type == "text")
    return json.loads(text)


def _free_port() -> int:
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def _wait_for_api(origin: str) -> None:
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        try:
            if httpx.get(f"{origin}/health", timeout=0.5).status_code == 200:
                return
        except httpx.HTTPError:
            pass
        time.sleep(0.1)
    raise RuntimeError("Local Parkdex API did not become ready")


async def _exercise_mcp(origin: str, token: str, place: dict) -> tuple[str, str]:
    environment = {
        **os.environ,
        "PARKDEX_API_ORIGIN": origin,
        "PARKDEX_SESSION_TOKEN": token,
    }
    parameters = StdioServerParameters(
        command=sys.executable,
        args=["-m", "backend.app.mcp_server"],
        cwd=str(ROOT),
        env=environment,
    )
    async with Client(parameters, raise_exceptions=True) as client:
        tools = await client.list_tools()
        names = {tool.name for tool in tools.tools}
        assert {
            "search_places",
            "get_place_details",
            "create_group",
            "add_places_to_wishlist",
            "list_groups",
        } <= names

        found = await client.call_tool(
            "search_places",
            {
                "visited": False,
                "type": place["category"],
                "latitude": place["latitude"],
                "longitude": place["longitude"],
                "radius_km": 1,
                "limit": 1,
                "offset": 0,
            },
        )
        assert not found.is_error
        found_payload = _payload(found)
        assert found_payload["places"][0]["id"] == place["id"]
        assert found_payload["places"][0]["distanceKm"] == 0

        details = await client.call_tool("get_place_details", {"place_id": place["id"]})
        assert not details.is_error
        assert _payload(details)["id"] == place["id"]

        wishlist = await client.call_tool(
            "add_places_to_wishlist", {"place_ids": [place["id"], place["id"]]}
        )
        assert not wishlist.is_error
        wishlist_payload = _payload(wishlist)
        assert wishlist_payload["placeIds"] == [place["id"]]

        created = await client.call_tool(
            "create_group",
            {"name": "MCP island day", "place_ids": [place["id"], place["id"]]},
        )
        assert not created.is_error
        created_payload = _payload(created)
        group_id = created_payload["id"]
        assert created_payload["placeIds"] == [place["id"]]

        renamed = await client.call_tool(
            "rename_group", {"group_id": group_id, "name": "MCP island weekend"}
        )
        assert not renamed.is_error
        assert _payload(renamed)["name"] == "MCP island weekend"

        invalid = await client.call_tool("get_group", {"group_id": "not-a-uuid"})
        assert invalid.is_error
        return group_id, wishlist_payload["id"]


def test_stdio_mcp_round_trip_matches_rest_and_enforces_account_ownership() -> None:
    database_url = os.environ["DATABASE_URL"]
    port = _free_port()
    origin = f"http://127.0.0.1:{port}"
    suffix = uuid4().hex
    first_email = f"mcp-first-{suffix}@example.com"
    second_email = f"mcp-second-{suffix}@example.com"
    server_environment = {**os.environ, "DATABASE_URL": database_url}
    creation_flags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
    server = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "backend.app.main:app", "--host", "127.0.0.1", "--port", str(port)],
        cwd=ROOT,
        env=server_environment,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=creation_flags,
    )
    try:
        _wait_for_api(origin)
        with httpx.Client(base_url=origin, timeout=10) as api:
            first = api.post(
                "/api/auth/register",
                json={"email": first_email, "password": "first mcp test password"},
            )
            second = api.post(
                "/api/auth/register",
                json={"email": second_email, "password": "second mcp test password"},
            )
            assert first.status_code == 201
            assert second.status_code == 201
            first_headers = {"Authorization": f"Bearer {first.json()['token']}"}
            second_headers = {"Authorization": f"Bearer {second.json()['token']}"}
            catalogue = api.get("/api/places", headers=first_headers)
            assert catalogue.status_code == 200
            place = catalogue.json()["places"][0]

            group_id, wishlist_id = asyncio.run(
                _exercise_mcp(origin, first.json()["token"], place)
            )

            groups = api.get("/api/groups", headers=first_headers)
            assert groups.status_code == 200
            by_id = {group["id"]: group for group in groups.json()}
            assert by_id[group_id]["name"] == "MCP island weekend"
            assert by_id[group_id]["placeIds"] == [place["id"]]
            assert by_id[wishlist_id]["isWishlist"] is True
            assert by_id[wishlist_id]["placeIds"] == [place["id"]]

            assert api.get(f"/api/groups/{group_id}", headers=second_headers).status_code == 404
            assert api.post(
                f"/api/groups/{group_id}/places",
                headers=second_headers,
                json={"placeIds": [place["id"]]},
            ).status_code == 404
    finally:
        server.terminate()
        try:
            server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            server.kill()
            server.wait(timeout=5)
        with psycopg.connect(database_url) as conn:
            conn.execute(
                "DELETE FROM accounts WHERE email = ANY(%s)",
                ([first_email, second_email],),
            )
            conn.commit()

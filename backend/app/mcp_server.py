"""Parkdex MCP: hosted OAuth Streamable HTTP plus optional local stdio."""
from __future__ import annotations

import argparse, getpass, os
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import timedelta
from typing import Annotated, Literal
from urllib.parse import urlsplit, urlunsplit

import httpx, keyring
from keyring.errors import PasswordDeleteError
from mcp.server import MCPServer
from mcp.server.auth.middleware.auth_context import get_access_token
from mcp.server.auth.settings import AuthSettings, ClientRegistrationOptions, RevocationOptions
from mcp.types import ToolAnnotations
from pydantic import AnyHttpUrl, Field
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from backend.app.auth import reserve_rate_limit
from backend.app.db import connection
from backend.app.mcp_oauth import MCP_SCOPE, ParkdexOAuthProvider, consent_get, consent_post
from backend.app.groups import add_group_places, create_group_row, delete_group_row, ensure_wishlist, group_row, list_group_rows, place_detail_row, remove_group_places, rename_group_row, search_place_rows

KEYRING_SERVICE, SESSION_ENV, EMAIL_ENV, ORIGIN_ENV = "parkdex-mcp-session", "PARKDEX_SESSION_TOKEN", "PARKDEX_ACCOUNT_EMAIL", "PARKDEX_API_ORIGIN"
MAX_TIMEOUT_SECONDS = 20.0
PlaceType = Literal["national", "provincial", "regional", "island"]
GroupName = Annotated[str, Field(min_length=1, max_length=200)]
GroupId = Annotated[str, Field(pattern=r"^[0-9a-fA-F-]{36}$")]
PlaceIds = Annotated[list[str], Field(min_length=1, max_length=100)]
OptionalPlaceIds = Annotated[list[str] | None, Field(max_length=100)]
READ_ONLY = ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=False)
WRITE = ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=False, openWorldHint=False)
DELETE = ToolAnnotations(readOnlyHint=False, destructiveHint=True, idempotentHint=True, openWorldHint=False)

def normalize_origin(value: str) -> str:
    parsed = urlsplit(value.strip()); hostname = (parsed.hostname or "").lower().rstrip(".")
    if parsed.username or parsed.password or parsed.fragment or parsed.query or not hostname or parsed.path not in {"", "/"}: raise ValueError("API origin must be a host origin without credentials, path, query, or fragment")
    if parsed.scheme != "https" and not (parsed.scheme == "http" and hostname in {"localhost", "127.0.0.1", "::1"}): raise ValueError("API origin must use HTTPS (HTTP is allowed only for local development)")
    netloc = f"[{hostname}]" if ":" in hostname else hostname
    if parsed.port is not None and not ((parsed.scheme == "https" and parsed.port == 443) or (parsed.scheme == "http" and parsed.port == 80)): netloc += f":{parsed.port}"
    return urlunsplit((parsed.scheme, netloc, "", "", ""))

def keyring_user(origin: str, email: str) -> str: return f"{normalize_origin(origin)}|{email.strip().lower()}"
def _same_origin(url: httpx.URL, origin: str) -> bool:
    expected=httpx.URL(origin); return (url.scheme,url.host,url.port)==(expected.scheme,expected.host,expected.port)
def session_token(origin: str, email: str | None = None) -> str:
    if token := os.environ.get(SESSION_ENV, "").strip(): return token
    account_email=(email or os.environ.get(EMAIL_ENV, "")).strip().lower()
    if not account_email: raise RuntimeError(f"Set {SESSION_ENV}, or set {EMAIL_ENV} for the keyring session")
    token=keyring.get_password(KEYRING_SERVICE,keyring_user(origin,account_email))
    if not token: raise RuntimeError("No Parkdex session found; run `python -m backend.app.mcp_server setup`")
    return token
def setup_session(origin: str) -> None:
    origin=normalize_origin(origin); email=input("Parkdex email: ").strip().lower(); password=getpass.getpass("Parkdex password: ")
    with httpx.Client(base_url=origin,follow_redirects=False,timeout=MAX_TIMEOUT_SECONDS) as client: response=client.post("/api/auth/login",json={"email":email,"password":password})
    if not _same_origin(response.url,origin) or response.status_code != 200: raise RuntimeError("Parkdex login failed")
    token=response.json().get("token")
    if not isinstance(token,str) or not token: raise RuntimeError("Parkdex login returned no session")
    keyring.set_password(KEYRING_SERVICE,keyring_user(origin,email),token)

@dataclass
class ParkdexClient:
    origin: str; token: str
    def __post_init__(self):
        self.origin=normalize_origin(self.origin); self._client=httpx.Client(base_url=self.origin,headers={"Authorization":f"Bearer {self.token}"},follow_redirects=False,timeout=MAX_TIMEOUT_SECONDS)
    def close(self): self._client.close()
    def request(self,method,path,**kwargs):
        response=self._client.request(method,path,**kwargs)
        if not _same_origin(response.url,self.origin) or 300 <= response.status_code < 400: raise RuntimeError("Parkdex returned an unexpected redirect")
        if response.status_code >= 400:
            try: detail=response.json().get("detail","request failed")
            except (ValueError,AttributeError): detail="request failed"
            raise RuntimeError(f"Parkdex request failed ({response.status_code}): {detail}")
        return None if response.status_code == 204 else response.json()
def _client():
    origin=normalize_origin(os.environ.get(ORIGIN_ENV,"https://parkdex.app")); return ParkdexClient(origin,session_token(origin))
def logout_session(origin: str,email: str|None=None):
    origin=normalize_origin(origin); account_email=(email or os.environ.get(EMAIL_ENV,"")).strip().lower() or input("Parkdex email: ").strip().lower(); client=ParkdexClient(origin,session_token(origin,account_email)); error=None
    try: client.request("POST","/api/auth/logout")
    except Exception as exc: error=exc
    finally: client.close()
    try: keyring.delete_password(KEYRING_SERVICE,keyring_user(origin,account_email))
    except PasswordDeleteError: pass
    if error: raise RuntimeError("Saved session removed locally, but server revocation failed") from error
@contextmanager
def _local_client():
    client=_client()
    try: yield client
    finally: client.close()
def _account_id():
    token=get_access_token(); return token.subject if token else None
def _mutation_limit(conn,account_id): reserve_rate_limit(conn,"group_mutation",account_id,120,timedelta(minutes=15))
def _name(value):
    name=value.strip()
    if not name or name.casefold()=="wishlist": raise ValueError("Group name must not be blank and Wishlist is reserved")
    return name

mcp=MCPServer("Parkdex Groups",description="Search Parkdex places and manage private account-owned groups, including Wishlist.",instructions="Authentication is required. Wishlist is the protected account group named Wishlist.")

@mcp.tool(annotations=READ_ONLY)
def search_places(visited:bool|None=None,type:PlaceType|None=None,category:PlaceType|None=None,query:Annotated[str|None,Field(max_length=200)]=None,latitude:Annotated[float|None,Field(ge=-90,le=90)]=None,longitude:Annotated[float|None,Field(ge=-180,le=180)]=None,radius_km:Annotated[float|None,Field(gt=0,le=20000)]=None,limit:Annotated[int,Field(ge=1,le=100)]=25,offset:Annotated[int,Field(ge=0,le=10000)]=0)->dict:
    """Read/search active places and this account's visit state."""
    selected=type or category
    if type and category and type!=category: raise ValueError("type and category must match")
    if (latitude is None)!=(longitude is None) or (radius_km is not None and latitude is None): raise ValueError("latitude and longitude are required together; radius requires both")
    if account_id:=_account_id():
        with contextmanager(connection)() as conn: rows,total=search_place_rows(conn,account_id,visited=visited,category=selected,query=query,latitude=latitude,longitude=longitude,radius_km=radius_km,limit=limit,offset=offset)
        return {"places":rows,"total":total,"limit":limit,"offset":offset}
    with _local_client() as client:
        params={"visited":visited,"type":selected,"query":query,"latitude":latitude,"longitude":longitude,"radius_km":radius_km,"limit":limit,"offset":offset}; return client.request("GET","/api/places/search",params={k:v for k,v in params.items() if v is not None})
@mcp.tool(annotations=READ_ONLY)
def get_place_details(place_id:Annotated[str,Field(min_length=1,max_length=200)])->dict:
    """Read one active place and this account's visit state."""
    if account_id:=_account_id():
        with contextmanager(connection)() as conn: result=place_detail_row(conn,account_id,place_id)
        if result is None: raise ValueError("Place not found")
        return result
    with _local_client() as client: return client.request("GET",f"/api/places/{place_id}")
@mcp.tool(annotations=READ_ONLY)
def list_groups()->list:
    """Read all private groups, including Wishlist."""
    if account_id:=_account_id():
        with contextmanager(connection)() as conn: ensure_wishlist(conn,account_id); conn.commit(); return list_group_rows(conn,account_id)
    with _local_client() as client: return client.request("GET","/api/groups")
@mcp.tool(annotations=READ_ONLY)
def get_group(group_id:GroupId)->dict:
    """Read one private group and its places."""
    if account_id:=_account_id():
        with contextmanager(connection)() as conn: result=group_row(conn,account_id,group_id)
        if result is None: raise ValueError("Group not found")
        return result
    with _local_client() as client: return client.request("GET",f"/api/groups/{group_id}")
@mcp.tool(annotations=WRITE)
def create_group(name:GroupName,place_ids:OptionalPlaceIds=None)->dict:
    """Create a private group. This writes group data."""
    if account_id:=_account_id():
        with contextmanager(connection)() as conn: _mutation_limit(conn,account_id); result=create_group_row(conn,account_id,_name(name),place_ids or []); conn.commit(); return result
    with _local_client() as client: return client.request("POST","/api/groups",json={"name":name,"placeIds":place_ids or []})
@mcp.tool(annotations=WRITE)
def rename_group(group_id:GroupId,name:GroupName)->dict:
    """Rename an ordinary group. Wishlist is protected."""
    if account_id:=_account_id():
        with contextmanager(connection)() as conn:
            current=group_row(conn,account_id,group_id)
            if current is None or current["is_wishlist"]: raise ValueError("Group not found or protected")
            _mutation_limit(conn,account_id); rename_group_row(conn,account_id,group_id,_name(name)); conn.commit(); return group_row(conn,account_id,group_id)
    with _local_client() as client: return client.request("PATCH",f"/api/groups/{group_id}",json={"name":name})
@mcp.tool(annotations=DELETE)
def delete_group(group_id:GroupId)->dict:
    """Permanently delete an ordinary group. Wishlist is protected."""
    if account_id:=_account_id():
        with contextmanager(connection)() as conn:
            current=group_row(conn,account_id,group_id)
            if current is None or current["is_wishlist"]: raise ValueError("Group not found or protected")
            _mutation_limit(conn,account_id); delete_group_row(conn,account_id,group_id); conn.commit(); return {"deleted":True,"group_id":group_id}
    with _local_client() as client: client.request("DELETE",f"/api/groups/{group_id}"); return {"deleted":True,"group_id":group_id}
def _change_places(group_id,place_ids,remove):
    if account_id:=_account_id():
        with contextmanager(connection)() as conn:
            _mutation_limit(conn,account_id); fn=remove_group_places if remove else add_group_places
            if not fn(conn,account_id,group_id,place_ids): raise ValueError("Group not found")
            conn.commit(); return group_row(conn,account_id,group_id)
    with _local_client() as client: return client.request("DELETE" if remove else "POST",f"/api/groups/{group_id}/places",json={"placeIds":place_ids})
@mcp.tool(annotations=WRITE)
def add_places_to_group(group_id:GroupId,place_ids:PlaceIds)->dict:
    """Add active places to a private group, including Wishlist."""
    return _change_places(group_id,place_ids,False)
@mcp.tool(annotations=WRITE)
def remove_places_from_group(group_id:GroupId,place_ids:PlaceIds)->dict:
    """Remove places from a private group without changing visits."""
    return _change_places(group_id,place_ids,True)
@mcp.tool(annotations=READ_ONLY)
def get_wishlist()->dict:
    """Read the protected group named Wishlist."""
    if account_id:=_account_id():
        with contextmanager(connection)() as conn: result=ensure_wishlist(conn,account_id); conn.commit(); return result
    with _local_client() as client: return client.request("GET","/api/wishlist")

def build_hosted_mcp_app(*,issuer_url:str,resource_url:str,account_url:str):
    issuer=normalize_origin(issuer_url)
    if resource_url!=f"{issuer}/mcp": raise ValueError("MCP resource URL must be canonical issuer plus /mcp")
    provider=ParkdexOAuthProvider(issuer_url=issuer,resource_url=resource_url,account_url=account_url)
    hosted=MCPServer("Parkdex Groups",description=mcp.description,instructions=mcp.instructions,auth_server_provider=provider,auth=AuthSettings(issuer_url=AnyHttpUrl(issuer),resource_server_url=AnyHttpUrl(resource_url),validate_token_resource=True,required_scopes=[MCP_SCOPE],client_registration_options=ClientRegistrationOptions(enabled=True,valid_scopes=[MCP_SCOPE],default_scopes=[MCP_SCOPE]),revocation_options=RevocationOptions(enabled=True)),tools=mcp._tool_manager.list_tools())
    @hosted.custom_route("/oauth/consent",methods=["GET"])
    async def oauth_consent_get(request:Request): return await consent_get(request,provider)
    @hosted.custom_route("/oauth/consent",methods=["POST"])
    async def oauth_consent_post(request:Request): return await consent_post(request,provider)
    app = hosted.streamable_http_app(streamable_http_path="/mcp",stateless_http=True,json_response=True,host="0.0.0.0")
    # SDK 2.2's generic metadata omits `none`, although its token endpoint and
    # DCR handler support public PKCE clients. Publish the capabilities this
    # provider actually accepts so remote MCP clients choose the correct flow.
    async def public_metadata(_: Request):
        return JSONResponse({
            "issuer": f"{issuer}/", "authorization_endpoint": f"{issuer}/authorize",
            "token_endpoint": f"{issuer}/token", "registration_endpoint": f"{issuer}/register",
            "revocation_endpoint": f"{issuer}/revoke", "scopes_supported": [MCP_SCOPE],
            "response_types_supported": ["code"], "grant_types_supported": ["authorization_code", "refresh_token"],
            "token_endpoint_auth_methods_supported": ["none"], "revocation_endpoint_auth_methods_supported": ["none"],
            "code_challenge_methods_supported": ["S256"],
        }, headers={"Cache-Control":"no-store","Access-Control-Allow-Origin":"*"})
    app.routes.insert(0, Route("/.well-known/oauth-authorization-server", public_metadata, methods=["GET"]))
    return app

def main(argv:list[str]|None=None):
    parser=argparse.ArgumentParser(); parser.add_argument("command",choices=("serve","setup","logout"),nargs="?",default="serve"); parser.add_argument("--origin",default=os.environ.get(ORIGIN_ENV,"https://parkdex.app")); parser.add_argument("--email",default=os.environ.get(EMAIL_ENV)); args=parser.parse_args(argv)
    if args.command=="setup": setup_session(args.origin)
    elif args.command=="logout": logout_session(args.origin,args.email)
    else: mcp.run(transport="stdio")
if __name__=="__main__": main()

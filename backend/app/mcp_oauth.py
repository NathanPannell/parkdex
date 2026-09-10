from __future__ import annotations

import html
import asyncio
import secrets
from contextlib import contextmanager
from functools import wraps
from datetime import datetime, timedelta, timezone
from urllib.parse import urlsplit
from uuid import UUID, uuid4

from mcp.server.auth.provider import (
    AccessToken,
    AuthorizationCode,
    AuthorizationParams,
    OAuthAuthorizationServerProvider,
    RefreshToken,
    TokenError,
    construct_redirect_uri,
)
from mcp.shared.auth import OAuthClientInformationFull, OAuthToken
from fastapi import HTTPException
from psycopg.errors import UniqueViolation
from starlette.requests import Request
from starlette.responses import HTMLResponse, RedirectResponse

from backend.app.auth import (
    DUMMY_PASSWORD_HASH,
    clear_login_failures,
    reserve_login_attempt,
    reserve_rate_limit,
    sha256_hex,
    verify_password,
)
from backend.app.db import connection


MCP_SCOPE = "mcp"
AUTH_REQUEST_LIFETIME = timedelta(minutes=10)
AUTH_CODE_LIFETIME = timedelta(minutes=5)
ACCESS_TOKEN_LIFETIME = timedelta(hours=1)
REFRESH_TOKEN_LIFETIME = timedelta(days=30)
MAX_DCR_METADATA_BYTES = 16 * 1024
MAX_DCR_REDIRECT_URIS = 10
MAX_DCR_REDIRECT_URI_LENGTH = 2048
MAX_DCR_CLIENT_NAME_LENGTH = 128
MAX_CONSENT_BODY_BYTES = 16 * 1024
MAX_DCR_CLIENTS = 10_000
MAX_DCR_REGISTRATIONS_PER_HOUR = 5_000


def database_thread(method):
    """Run synchronous psycopg/Argon provider work away from the ASGI loop."""
    @wraps(method)
    async def wrapped(*args, **kwargs):
        import anyio
        return await anyio.to_thread.run_sync(lambda: asyncio.run(method(*args, **kwargs)))
    return wrapped


def _token() -> str:
    return secrets.token_urlsafe(32)


def _timestamp(value: datetime) -> int:
    return int(value.timestamp())


def _valid_redirect_uri(value: str) -> bool:
    parsed = urlsplit(value)
    if parsed.username or parsed.password or parsed.fragment or not parsed.hostname:
        return False
    hostname = parsed.hostname.lower().rstrip(".")
    loopback = hostname in {"localhost", "127.0.0.1", "::1"}
    return parsed.scheme == "https" or (parsed.scheme == "http" and loopback)


def _cleanup_expired(conn) -> None:
    conn.execute("DELETE FROM mcp_oauth_authorization_requests WHERE expires_at < NOW()")
    conn.execute("DELETE FROM mcp_oauth_authorization_codes WHERE expires_at < NOW()")
    conn.execute("DELETE FROM mcp_oauth_tokens WHERE expires_at < NOW()")
    conn.execute("DELETE FROM mcp_oauth_clients WHERE last_used_at < NOW() - INTERVAL '90 days' AND NOT EXISTS (SELECT 1 FROM mcp_oauth_authorization_requests r WHERE r.client_id = mcp_oauth_clients.client_id AND r.expires_at > NOW()) AND NOT EXISTS (SELECT 1 FROM mcp_oauth_authorization_codes c WHERE c.client_id = mcp_oauth_clients.client_id AND c.expires_at > NOW()) AND NOT EXISTS (SELECT 1 FROM mcp_oauth_tokens t WHERE t.client_id = mcp_oauth_clients.client_id AND t.revoked_at IS NULL AND t.expires_at > NOW())")
    conn.execute("DELETE FROM auth_security_events WHERE occurred_at < NOW() - INTERVAL '90 days'")


class ParkdexAccessToken(AccessToken):
    grant_id: str


class ParkdexRefreshToken(RefreshToken):
    grant_id: str
    family_id: str
    revoked: bool = False


class ParkdexOAuthProvider(
    OAuthAuthorizationServerProvider[AuthorizationCode, ParkdexRefreshToken, ParkdexAccessToken]
):
    def __init__(self, *, issuer_url: str, resource_url: str, account_url: str):
        self.issuer_url = issuer_url.rstrip("/") + "/"
        self.resource_url = resource_url.rstrip("/")
        self.account_url = account_url.rstrip("/")

    @database_thread
    async def get_client(self, client_id: str) -> OAuthClientInformationFull | None:
        try:
            UUID(client_id)
        except ValueError:
            return None
        with contextmanager(connection)() as conn:
            _cleanup_expired(conn)
            row = conn.execute(
                "UPDATE mcp_oauth_clients SET last_used_at = NOW() WHERE client_id = %s RETURNING metadata", (client_id,)
            ).fetchone()
            conn.commit()
        return OAuthClientInformationFull.model_validate(row["metadata"]) if row else None

    @database_thread
    async def register_client(self, client_info: OAuthClientInformationFull) -> None:
        if client_info.client_secret is not None or client_info.token_endpoint_auth_method != "none":
            from mcp.server.auth.provider import RegistrationError

            raise RegistrationError(
                error="invalid_client_metadata",
                error_description="Parkdex DCR accepts public PKCE clients only (token_endpoint_auth_method=none)",
            )
        if set(client_info.grant_types) - {"authorization_code", "refresh_token"}:
            from mcp.server.auth.provider import RegistrationError

            raise RegistrationError(
                error="invalid_client_metadata", error_description="Unsupported grant type"
            )
        if not client_info.redirect_uris or any(
            not _valid_redirect_uri(str(uri)) for uri in client_info.redirect_uris
        ):
            from mcp.server.auth.provider import RegistrationError

            raise RegistrationError(
                error="invalid_redirect_uri",
                error_description="Redirect URIs must use HTTPS or loopback HTTP and cannot contain credentials or fragments",
            )
        if len(client_info.redirect_uris) > MAX_DCR_REDIRECT_URIS or any(len(str(uri)) > MAX_DCR_REDIRECT_URI_LENGTH for uri in client_info.redirect_uris):
            from mcp.server.auth.provider import RegistrationError
            raise RegistrationError(error="invalid_redirect_uri", error_description="Too many or too-long redirect URIs")
        if client_info.client_name and len(client_info.client_name) > MAX_DCR_CLIENT_NAME_LENGTH:
            from mcp.server.auth.provider import RegistrationError
            raise RegistrationError(error="invalid_client_metadata", error_description="Client name is too long")
        metadata = client_info.model_dump(mode="json")
        import json
        if len(json.dumps(metadata, separators=(",", ":")).encode("utf-8")) > MAX_DCR_METADATA_BYTES:
            from mcp.server.auth.provider import RegistrationError
            raise RegistrationError(error="invalid_client_metadata", error_description="Client metadata is too large")
        registration_error: str | None = None
        duplicate_client = False
        with contextmanager(connection)() as conn:
            _cleanup_expired(conn)
            try:
                reserve_rate_limit(
                    conn,
                    "mcp_dcr",
                    "global",
                    MAX_DCR_REGISTRATIONS_PER_HOUR,
                    timedelta(hours=1),
                    record_throttled=False,
                )
            except HTTPException:
                registration_error = "Registration rate limit exceeded"
            if registration_error is None:
                client_count = conn.execute("SELECT COUNT(*) AS count FROM mcp_oauth_clients").fetchone()["count"]
                if client_count >= MAX_DCR_CLIENTS:
                    evicted = conn.execute(
                        """DELETE FROM mcp_oauth_clients WHERE client_id = (
                               SELECT candidate.client_id FROM mcp_oauth_clients candidate
                               WHERE NOT EXISTS (SELECT 1 FROM mcp_oauth_authorization_requests r WHERE r.client_id = candidate.client_id AND r.expires_at > NOW())
                                 AND NOT EXISTS (SELECT 1 FROM mcp_oauth_authorization_codes c WHERE c.client_id = candidate.client_id AND c.expires_at > NOW() AND c.used_at IS NULL)
                                 AND NOT EXISTS (SELECT 1 FROM mcp_oauth_tokens t WHERE t.client_id = candidate.client_id AND t.revoked_at IS NULL AND t.expires_at > NOW())
                               ORDER BY candidate.last_used_at, candidate.created_at
                               LIMIT 1
                           ) RETURNING client_id"""
                    ).fetchone()
                    if evicted is None:
                        registration_error = "Registration capacity is temporarily full"
            if registration_error is not None:
                conn.commit()
            else:
                try:
                    conn.execute(
                        "INSERT INTO mcp_oauth_clients (client_id, metadata) VALUES (%s, %s::jsonb)",
                        (client_info.client_id, __import__("json").dumps(metadata)),
                    )
                    conn.commit()
                except UniqueViolation:
                    conn.rollback()
                    duplicate_client = True
        if registration_error or duplicate_client:
            from mcp.server.auth.provider import RegistrationError

            raise RegistrationError(
                error="invalid_client_metadata",
                error_description=registration_error or "Client already registered",
            )

    @database_thread
    async def authorize(self, client: OAuthClientInformationFull, params: AuthorizationParams) -> str:
        from mcp.server.auth.provider import AuthorizeError

        if params.resource != self.resource_url:
            raise AuthorizeError(error="invalid_target", error_description="resource must identify the Parkdex MCP endpoint")
        if params.scopes != [MCP_SCOPE]:
            raise AuthorizeError(error="invalid_scope", error_description=f"scope must be {MCP_SCOPE}")
        request_token = _token()
        expires_at = datetime.now(timezone.utc) + AUTH_REQUEST_LIFETIME
        with contextmanager(connection)() as conn:
            _cleanup_expired(conn)
            conn.execute(
                """
                INSERT INTO mcp_oauth_authorization_requests
                    (request_hash, client_id, redirect_uri, state, scopes, code_challenge, resource, expires_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    sha256_hex(request_token), client.client_id, str(params.redirect_uri), params.state,
                    params.scopes, params.code_challenge, params.resource, expires_at,
                ),
            )
            conn.commit()
        return f"{self.issuer_url}oauth/consent?request={request_token}"

    @database_thread
    async def load_authorization_code(
        self, client: OAuthClientInformationFull, authorization_code: str
    ) -> AuthorizationCode | None:
        with contextmanager(connection)() as conn:
            row = conn.execute(
                """
                SELECT client_id, account_id, redirect_uri, scopes, code_challenge, resource, expires_at
                FROM mcp_oauth_authorization_codes
                WHERE code_hash = %s AND client_id = %s AND used_at IS NULL AND expires_at > NOW()
                """,
                (sha256_hex(authorization_code), client.client_id),
            ).fetchone()
        if row is None:
            return None
        return AuthorizationCode(
            code=authorization_code,
            client_id=str(row["client_id"]),
            subject=str(row["account_id"]),
            redirect_uri=row["redirect_uri"],
            redirect_uri_provided_explicitly=True,
            scopes=row["scopes"],
            code_challenge=row["code_challenge"],
            resource=row["resource"],
            expires_at=row["expires_at"].timestamp(),
        )

    @database_thread
    async def exchange_authorization_code(
        self, client: OAuthClientInformationFull, authorization_code: AuthorizationCode
    ) -> OAuthToken:
        access, refresh, grant_id = _token(), _token(), str(uuid4())
        now = datetime.now(timezone.utc)
        token_error: str | None = None
        with contextmanager(connection)() as conn:
            candidate = conn.execute(
                """SELECT account_id FROM mcp_oauth_authorization_codes
                   WHERE code_hash = %s AND client_id = %s""",
                (sha256_hex(authorization_code.code), client.client_id),
            ).fetchone()
            if candidate is not None:
                conn.execute("SELECT id FROM accounts WHERE id = %s FOR UPDATE", (candidate["account_id"],))
            row = conn.execute(
                """
                UPDATE mcp_oauth_authorization_codes SET used_at = NOW()
                WHERE code_hash = %s AND client_id = %s AND used_at IS NULL AND expires_at > NOW()
                RETURNING account_id, scopes, resource
                """,
                (sha256_hex(authorization_code.code), client.client_id),
            ).fetchone()
            if row is None:
                conn.rollback()
                token_error = "Authorization code is invalid or already used"
            else:
                self._insert_pair(conn, access, refresh, grant_id, str(client.client_id), str(row["account_id"]), row["scopes"], row["resource"], now)
                conn.commit()
        if token_error:
            raise TokenError(error="invalid_grant", error_description=token_error)
        return OAuthToken(access_token=access, refresh_token=refresh, expires_in=int(ACCESS_TOKEN_LIFETIME.total_seconds()), scope=" ".join(row["scopes"]))

    @database_thread
    async def load_refresh_token(
        self, client: OAuthClientInformationFull, refresh_token: str
    ) -> ParkdexRefreshToken | None:
        with contextmanager(connection)() as conn:
            row = conn.execute(
                """SELECT grant_id, family_id, account_id, scopes, resource, expires_at, revoked_at FROM mcp_oauth_tokens
                   WHERE token_hash = %s AND token_kind = 'refresh' AND client_id = %s
                     AND expires_at > NOW()""",
                (sha256_hex(refresh_token), client.client_id),
            ).fetchone()
            if row is not None:
                conn.execute("UPDATE mcp_oauth_clients SET last_used_at = NOW() WHERE client_id = %s", (client.client_id,))
                conn.commit()
        if row is None:
            return None
        return ParkdexRefreshToken(token=refresh_token, grant_id=str(row["grant_id"]), family_id=str(row["family_id"]), revoked=row["revoked_at"] is not None, client_id=str(client.client_id), subject=str(row["account_id"]), scopes=row["scopes"], resource=row["resource"], expires_at=_timestamp(row["expires_at"]))

    @database_thread
    async def exchange_refresh_token(
        self, client: OAuthClientInformationFull, refresh_token: ParkdexRefreshToken, scopes: list[str]
    ) -> OAuthToken:
        access, refresh, grant_id = _token(), _token(), str(uuid4())
        now = datetime.now(timezone.utc)
        token_error = None
        with contextmanager(connection)() as conn:
            candidate = conn.execute(
                """SELECT account_id FROM mcp_oauth_tokens
                   WHERE token_hash = %s AND token_kind = 'refresh' AND client_id = %s""",
                (sha256_hex(refresh_token.token), client.client_id),
            ).fetchone()
            if candidate is not None:
                conn.execute("SELECT id FROM accounts WHERE id = %s FOR UPDATE", (candidate["account_id"],))
            row = conn.execute(
                """SELECT grant_id, account_id, resource, family_id, revoked_at FROM mcp_oauth_tokens
                   WHERE token_hash = %s AND token_kind = 'refresh' AND client_id = %s
                     AND expires_at > NOW() FOR UPDATE""",
                (sha256_hex(refresh_token.token), client.client_id),
            ).fetchone()
            if row is None:
                conn.rollback()
                token_error = "Refresh token is invalid or expired"
            elif row["revoked_at"] is not None:
                conn.execute("UPDATE mcp_oauth_tokens SET revoked_at = NOW() WHERE family_id = %s AND revoked_at IS NULL", (row["family_id"],))
                conn.commit()
                token_error = "Refresh token reuse detected"
            else:
                conn.execute("UPDATE mcp_oauth_tokens SET revoked_at = NOW() WHERE grant_id = %s AND client_id = %s AND revoked_at IS NULL", (row["grant_id"], client.client_id))
                self._insert_pair(conn, access, refresh, grant_id, str(client.client_id), str(row["account_id"]), scopes, row["resource"] or self.resource_url, now, family_id=str(row["family_id"]), parent_grant_id=str(row["grant_id"]))
                conn.commit()
        if token_error:
            raise TokenError(error="invalid_grant", error_description=token_error)
        return OAuthToken(access_token=access, refresh_token=refresh, expires_in=int(ACCESS_TOKEN_LIFETIME.total_seconds()), scope=" ".join(scopes))

    @database_thread
    async def load_access_token(self, token: str) -> ParkdexAccessToken | None:
        with contextmanager(connection)() as conn:
            row = conn.execute(
                """SELECT grant_id, client_id, account_id, scopes, resource, expires_at
                   FROM mcp_oauth_tokens WHERE token_hash = %s AND token_kind = 'access'
                     AND revoked_at IS NULL AND expires_at > NOW()""",
                (sha256_hex(token),),
            ).fetchone()
            if row is not None:
                conn.execute("UPDATE mcp_oauth_clients SET last_used_at = NOW() WHERE client_id = %s", (row["client_id"],))
                conn.commit()
        if row is None:
            return None
        return ParkdexAccessToken(token=token, grant_id=str(row["grant_id"]), client_id=str(row["client_id"]), subject=str(row["account_id"]), scopes=row["scopes"], resource=row["resource"], expires_at=_timestamp(row["expires_at"]))

    @database_thread
    async def revoke_token(self, token: ParkdexAccessToken | ParkdexRefreshToken) -> None:
        with contextmanager(connection)() as conn:
            conn.execute("UPDATE mcp_oauth_tokens SET revoked_at = NOW() WHERE grant_id = %s AND revoked_at IS NULL", (token.grant_id,))
            conn.commit()

    def _insert_pair(self, conn, access: str, refresh: str, grant_id: str, client_id: str, account_id: str, scopes: list[str], resource: str, now: datetime, *, family_id: str | None = None, parent_grant_id: str | None = None) -> None:
        with conn.cursor() as cursor:
            cursor.executemany(
            """INSERT INTO mcp_oauth_tokens
               (token_hash, token_kind, grant_id, family_id, parent_grant_id, client_id, account_id, scopes, resource, expires_at)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
            [
                (sha256_hex(access), "access", grant_id, family_id or grant_id, parent_grant_id, client_id, account_id, scopes, resource, now + ACCESS_TOKEN_LIFETIME),
                (sha256_hex(refresh), "refresh", grant_id, family_id or grant_id, parent_grant_id, client_id, account_id, scopes, resource, now + REFRESH_TOKEN_LIFETIME),
                ],
            )

    def consent_page(self, request_token: str, *, error: str | None = None) -> HTMLResponse:
        with contextmanager(connection)() as conn:
            row = conn.execute(
                """SELECT c.metadata FROM mcp_oauth_authorization_requests r
                   JOIN mcp_oauth_clients c ON c.client_id = r.client_id
                   WHERE r.request_hash = %s AND r.used_at IS NULL AND r.expires_at > NOW()""",
                (sha256_hex(request_token),),
            ).fetchone()
        if row is None:
            return HTMLResponse("Authorization request expired or invalid.", status_code=400, headers=_html_headers())
        name = html.escape(row["metadata"].get("client_name") or "An MCP client")
        message = f'<p role="alert">{html.escape(error)}</p>' if error else ""
        csrf = _token()
        page = f"""<!doctype html><html><head><meta charset=utf-8><meta name=viewport content='width=device-width'><title>Connect Parkdex</title>
        <style>body{{font:16px system-ui;max-width:32rem;margin:4rem auto;padding:1rem;color:#17231b}}label{{display:block;margin:1rem 0}}input{{box-sizing:border-box;width:100%;padding:.75rem}}button{{padding:.75rem 1rem;margin-right:.5rem}}small{{color:#526057}}</style></head>
        <body><h1>Connect {name} to Parkdex</h1><p>This allows the client to search places and read or change your private groups, including Wishlist.</p>{message}
        <form method=post action=/oauth/consent><input type=hidden name=request value='{html.escape(request_token)}'><input type=hidden name=csrf value='{csrf}'>
        <label>Email<input required type=email name=email autocomplete=username></label><label>Password<input required type=password name=password autocomplete=current-password></label>
        <button name=decision value=allow>Log in and allow</button><button name=decision value=deny>Cancel</button></form>
        <p><small>No account? <a href='{html.escape(self.account_url)}'>Create one in Parkdex</a>, then return here.</small></p></body></html>"""
        response = HTMLResponse(page, headers=_html_headers())
        response.set_cookie("mcp_oauth_csrf", csrf, max_age=int(AUTH_REQUEST_LIFETIME.total_seconds()), secure=self.issuer_url.startswith("https://"), httponly=True, samesite="lax", path="/oauth/consent")
        return response

    def complete_consent(self, request_token: str, email: str, password: str, decision: str, csrf: str, csrf_cookie: str) -> RedirectResponse | HTMLResponse:
        if not csrf or not csrf_cookie or not secrets.compare_digest(csrf, csrf_cookie):
            return HTMLResponse("Invalid authorization form. Please start again.", status_code=400, headers=_html_headers())
        normalized_email = email.strip().lower()
        if decision == "allow":
            with contextmanager(connection)() as conn:
                reserve_login_attempt(conn, normalized_email)
                conn.commit()
        with contextmanager(connection)() as conn:
            request_row = conn.execute(
                """SELECT * FROM mcp_oauth_authorization_requests
                   WHERE request_hash = %s AND used_at IS NULL AND expires_at > NOW() FOR UPDATE""",
                (sha256_hex(request_token),),
            ).fetchone()
            if request_row is None:
                return HTMLResponse("Authorization request expired or invalid.", status_code=400, headers=_html_headers())
            if decision != "allow":
                conn.execute("UPDATE mcp_oauth_authorization_requests SET used_at = NOW() WHERE request_hash = %s", (sha256_hex(request_token),))
                conn.commit()
                return RedirectResponse(construct_redirect_uri(request_row["redirect_uri"], error="access_denied", state=request_row["state"], iss=self.issuer_url), status_code=303, headers={"Cache-Control": "no-store"})
            account = conn.execute("SELECT id, password_hash FROM accounts WHERE email = %s", (normalized_email,)).fetchone()
            valid = verify_password(account["password_hash"] if account and account["password_hash"] else DUMMY_PASSWORD_HASH, password)
            if not valid or account is None:
                conn.rollback()
                return self.consent_page(request_token, error="Email or password is incorrect.")
            clear_login_failures(conn, normalized_email)
            code = _token()
            expires_at = datetime.now(timezone.utc) + AUTH_CODE_LIFETIME
            conn.execute("UPDATE mcp_oauth_authorization_requests SET used_at = NOW() WHERE request_hash = %s", (sha256_hex(request_token),))
            conn.execute(
                """INSERT INTO mcp_oauth_authorization_codes
                   (code_hash, client_id, account_id, redirect_uri, redirect_uri_provided_explicitly, scopes, code_challenge, resource, expires_at)
                   VALUES (%s, %s, %s, %s, TRUE, %s, %s, %s, %s)""",
                (sha256_hex(code), request_row["client_id"], account["id"], request_row["redirect_uri"], request_row["scopes"], request_row["code_challenge"], request_row["resource"], expires_at),
            )
            conn.commit()
        return RedirectResponse(construct_redirect_uri(request_row["redirect_uri"], code=code, state=request_row["state"], iss=self.issuer_url), status_code=303, headers={"Cache-Control": "no-store"})


def _html_headers() -> dict[str, str]:
    return {
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
    }


async def consent_get(request: Request, provider: ParkdexOAuthProvider) -> HTMLResponse:
    import anyio
    return await anyio.to_thread.run_sync(provider.consent_page, request.query_params.get("request", ""))


async def consent_post(request: Request, provider: ParkdexOAuthProvider) -> RedirectResponse | HTMLResponse:
    import anyio
    content_length = request.headers.get("content-length")
    if content_length is not None and (not content_length.isdigit() or int(content_length) > MAX_CONSENT_BODY_BYTES):
        return HTMLResponse("Authorization form is too large.", status_code=413, headers=_html_headers())
    body = await request.body()
    if len(body) > MAX_CONSENT_BODY_BYTES:
        return HTMLResponse("Authorization form is too large.", status_code=413, headers=_html_headers())
    form = await request.form()
    response = await anyio.to_thread.run_sync(
        provider.complete_consent, str(form.get("request", "")), str(form.get("email", "")),
        str(form.get("password", "")), str(form.get("decision", "deny")), str(form.get("csrf", "")),
        request.cookies.get("mcp_oauth_csrf", ""),
    )
    if response.status_code in {302, 303}:
        response.delete_cookie("mcp_oauth_csrf", path="/oauth/consent")
    return response

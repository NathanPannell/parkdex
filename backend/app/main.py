from contextlib import asynccontextmanager, contextmanager
import hashlib
import logging
import re
import secrets
from datetime import timedelta
from uuid import UUID

import httpx
from fastapi import BackgroundTasks, Depends, FastAPI, Header, HTTPException, Query, Response
from google.auth.exceptions import GoogleAuthError
from fastapi.middleware.cors import CORSMiddleware
from psycopg import Connection
from psycopg.errors import UniqueViolation

from backend.app.auth import (
    DUMMY_PASSWORD_HASH,
    AccountIdentity,
    authenticate_bearer,
    clear_login_failures,
    consume_action_token,
    create_action_token,
    create_session,
    hash_password,
    reserve_login_attempt,
    reserve_rate_limit,
    record_security_event,
    pkce_challenge,
    require_bearer,
    verify_password,
)
from backend.app.db import close_pool, connection, open_pool
from backend.app.email_delivery import ensure_email_delivery, send_auth_email
from backend.app.google_oauth import authorization_url, exchange_and_verify
from backend.app.mcp_server import build_hosted_mcp_app
from backend.app.schemas import (
    AccountState,
    AuthResult,
    Credentials,
    EmailRequest,
    GoogleCallback,
    GoogleStart,
    Group,
    GroupCreate,
    GroupPlaceMutation,
    GroupRename,
    GuestImportResult,
    PlaceCollection,
    PlaceSearchResult,
    SearchPlace,
    PasswordChange,
    PasswordResetConfirmation,
    TrailResult,
    TrailUpdate,
    TokenConfirmation,
    VisitResult,
    VisitUpdate,
)
from backend.app.settings import get_settings
from backend.app.groups import (
    delete_group_row,
    ensure_wishlist,
    add_group_places,
    remove_group_places,
    list_group_rows,
    group_row,
    create_group_row,
    rename_group_row,
    place_detail_row,
    search_place_rows,
)

COLLECTION_KEY_PATTERN = re.compile(r"^[A-Za-z0-9_-]{43,128}$")
TRAIL_IDS = frozenset({"west_coast_trail", "juan_de_fuca_trail"})
COVERAGE_NOTE = (
    "Official-source v0: two whole national park reserves, designated provincial parks, "
    "and named regional parks from CRD, RDN, CVRD, and Bere Point. Regional coverage is "
    "strongest in those districts; parks without a clean authoritative point, including "
    "China Creek and Kwaksistah, are not guessed. The 24 nearby islands are a curated "
    "collection; Vancouver Island frames the map rather than acting as a collectible. "
    "Pins are representative centres, not entrances or trailheads."
)


def collection_hash(raw_key: str | None, *, required: bool = False) -> str | None:
    if raw_key is None:
        if required:
            raise HTTPException(status_code=401, detail="Collection key required")
        return None
    if not COLLECTION_KEY_PATTERN.fullmatch(raw_key):
        raise HTTPException(status_code=400, detail="Invalid collection key")
    return hashlib.sha256(raw_key.encode("ascii")).hexdigest()


def resolve_identity(
    conn: Connection,
    authorization: str | None,
    collection_key: str | None,
    *,
    required: bool = False,
) -> AccountIdentity | str | None:
    if authorization is not None and collection_key is not None:
        raise HTTPException(
            status_code=400,
            detail="Send either Authorization or X-Collection-Key, not both",
        )
    account = authenticate_bearer(conn, authorization)
    if account is not None:
        return account
    return collection_hash(collection_key, required=required)


def visits_for_account(conn: Connection, account_id: str) -> list[dict]:
    return [
        {"place_id": row["place_id"], "visited_at": row["visited_at"]}
        for row in conn.execute(
            """
            SELECT account_visits.place_id, account_visits.visited_at FROM account_visits
            JOIN places ON places.id = account_visits.place_id AND places.active
            WHERE account_visits.account_id = %s ORDER BY account_visits.visited_at, account_visits.place_id
            """,
            (account_id,),
        ).fetchall()
    ]


def visited_ids(visits: list[dict]) -> list[str]:
    return [visit["place_id"] for visit in visits]


def completed_trails_for_account(conn: Connection, account_id: str) -> list[str]:
    return [row["trail_id"] for row in conn.execute("SELECT trail_id FROM account_trail_completions WHERE account_id = %s ORDER BY trail_id", (account_id,)).fetchall()]


def lock_account_progress(conn: Connection, account_id: str) -> None:
    conn.execute("SELECT id FROM accounts WHERE id = %s FOR UPDATE", (account_id,))


def account_state(conn: Connection, identity: AccountIdentity) -> dict:
    visits = visits_for_account(conn, identity.account_id)
    return {
        "account": {
            "id": identity.account_id,
            "email": identity.email,
            "email_verified": identity.email_verified,
        },
        "visited_ids": visited_ids(visits),
        "visits": visits,
        "completed_trail_ids": completed_trails_for_account(conn, identity.account_id),
    }


settings = get_settings()
logger = logging.getLogger(__name__)
mcp_http_app = build_hosted_mcp_app(
    issuer_url=settings.api_public_url,
    resource_url=settings.mcp_public_url,
    account_url=settings.app_public_url,
)


@asynccontextmanager
async def lifespan(_: FastAPI):
    open_pool()
    try:
        async with mcp_http_app.router.lifespan_context(mcp_http_app):
            yield
    finally:
        close_pool()


def deliver_auth_email(recipient: str, subject: str, text: str, event_type: str) -> None:
    try:
        send_auth_email(settings, recipient, subject, text)
    except Exception as exc:
        logger.error("Auth email delivery failed (%s)", type(exc).__name__)
        try:
            with contextmanager(connection)() as conn:
                record_security_event(conn, event_type, recipient, "delivery_failed")
                conn.commit()
        except Exception:
            logger.error("Could not record auth email delivery failure")
app = FastAPI(title="Parkdex API", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Collection-Key"],
)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/ready")
def ready(conn: Connection = Depends(connection)) -> dict[str, str | int]:
    migration_count = conn.execute(
        "SELECT COUNT(*) AS migration_count FROM schema_migrations"
    ).fetchone()
    return {
        "status": "ready",
        "commit": settings.app_commit_sha,
        "release": settings.app_release_id,
        "migrations": migration_count["migration_count"],
    }


@app.get("/api/auth/config")
def auth_config() -> dict[str, bool]:
    return {
        "googleEnabled": bool(settings.google_client_id and settings.google_client_secret and settings.google_redirect_uri),
        "emailEnabled": bool(settings.smtp_host),
    }


@app.get("/api/places", response_model=PlaceCollection)
def list_places(
    conn: Connection = Depends(connection),
    authorization: str | None = Header(default=None),
    x_collection_key: str | None = Header(default=None),
):
    identity = resolve_identity(conn, authorization, x_collection_key)
    places = conn.execute(
        """
        SELECT id, name, category, latitude, longitude, region, description,
               source_url, source_name, source_id
        FROM places WHERE active ORDER BY name
        """
    ).fetchall()
    visits: list[dict] = []
    completed_trail_ids: list[str] = []
    if isinstance(identity, AccountIdentity):
        visits = visits_for_account(conn, identity.account_id)
        completed_trail_ids = completed_trails_for_account(conn, identity.account_id)
    elif identity:
        visits = [
            {"place_id": row["place_id"], "visited_at": row["visited_at"]}
            for row in conn.execute(
                """
                SELECT visits.place_id, visits.visited_at FROM visits
                JOIN places ON places.id = visits.place_id AND places.active
                WHERE visits.owner_hash = %s ORDER BY visits.visited_at, visits.place_id
                """,
                (identity,),
            ).fetchall()
        ]
        completed_trail_ids = [row["trail_id"] for row in conn.execute("SELECT trail_id FROM guest_trail_completions WHERE owner_hash = %s ORDER BY trail_id", (identity,)).fetchall()]
    return {
        "places": places,
        "visited_ids": visited_ids(visits),
        "visits": visits,
        "completed_trail_ids": completed_trail_ids,
        "coverage_note": COVERAGE_NOTE,
    }


PLACE_CATEGORIES = frozenset({"national", "provincial", "regional", "island"})


def _record_id(value: str, label: str) -> str:
    try:
        return str(UUID(value))
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=f"{label} not found") from exc


def _group_mutation_limit(conn: Connection, account_id: str) -> None:
    reserve_rate_limit(conn, "group_mutation", account_id, 120, timedelta(minutes=15))


def _group_name(value: str, label: str = "Group") -> str:
    name = value.strip()
    if not name:
        raise HTTPException(status_code=422, detail=f"{label} name must not be blank")
    if name.casefold() == "wishlist":
        raise HTTPException(status_code=422, detail="Wishlist is reserved for the protected account group")
    return name


@app.get("/api/places/search", response_model=PlaceSearchResult)
def search_places(
    visited: bool | None = Query(default=None),
    place_type: str | None = Query(default=None, alias="type"),
    category: str | None = Query(default=None),
    query: str | None = Query(default=None, max_length=200),
    latitude: float | None = Query(default=None, ge=-90, le=90),
    longitude: float | None = Query(default=None, ge=-180, le=180),
    radius_km: float | None = Query(default=None, gt=0, le=20000),
    limit: int = Query(default=25, ge=1, le=100),
    offset: int = Query(default=0, ge=0, le=10000),
    conn: Connection = Depends(connection),
    authorization: str | None = Header(default=None),
):
    identity = require_bearer(conn, authorization)
    if place_type and category and place_type != category:
        raise HTTPException(status_code=400, detail="type and category must match when both are provided")
    selected_category = place_type or category
    if selected_category and selected_category not in PLACE_CATEGORIES:
        raise HTTPException(status_code=400, detail="Invalid place type")
    if (latitude is None) != (longitude is None):
        raise HTTPException(status_code=400, detail="latitude and longitude must be provided together")
    if radius_km is not None and latitude is None:
        raise HTTPException(status_code=400, detail="radius_km requires latitude and longitude")
    rows, total = search_place_rows(
        conn,
        identity.account_id,
        visited=visited,
        category=selected_category,
        query=query,
        latitude=latitude,
        longitude=longitude,
        radius_km=radius_km,
        limit=limit,
        offset=offset,
    )
    return {"places": rows, "total": total, "limit": limit, "offset": offset}


@app.get("/api/places/{place_id}", response_model=SearchPlace)
def get_place_details(
    place_id: str,
    conn: Connection = Depends(connection),
    authorization: str | None = Header(default=None),
):
    identity = require_bearer(conn, authorization)
    row = place_detail_row(conn, identity.account_id, place_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Place not found")
    return row


@app.get("/api/groups", response_model=list[Group])
def list_groups(
    conn: Connection = Depends(connection),
    authorization: str | None = Header(default=None),
):
    identity = require_bearer(conn, authorization)
    ensure_wishlist(conn, identity.account_id)
    conn.commit()
    return list_group_rows(conn, identity.account_id)


@app.post("/api/groups", response_model=Group, status_code=201)
def create_group(
    payload: GroupCreate,
    conn: Connection = Depends(connection),
    authorization: str | None = Header(default=None),
):
    identity = require_bearer(conn, authorization)
    name = _group_name(payload.name)
    _group_mutation_limit(conn, identity.account_id)
    try:
        result = create_group_row(conn, identity.account_id, name, payload.placeIds)
    except ValueError as exc:
        conn.rollback()
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    conn.commit()
    return result


@app.get("/api/groups/{group_id}", response_model=Group)
def get_group(
    group_id: str,
    conn: Connection = Depends(connection),
    authorization: str | None = Header(default=None),
):
    identity = require_bearer(conn, authorization)
    result = group_row(conn, identity.account_id, _record_id(group_id, "Group"))
    if result is None:
        raise HTTPException(status_code=404, detail="Group not found")
    return result


@app.patch("/api/groups/{group_id}", response_model=Group)
def rename_group(
    group_id: str,
    payload: GroupRename,
    conn: Connection = Depends(connection),
    authorization: str | None = Header(default=None),
):
    identity = require_bearer(conn, authorization)
    canonical_id = _record_id(group_id, "Group")
    name = _group_name(payload.name)
    current = group_row(conn, identity.account_id, canonical_id)
    if current is None:
        raise HTTPException(status_code=404, detail="Group not found")
    if current["is_wishlist"]:
        raise HTTPException(status_code=409, detail="Wishlist cannot be renamed")
    _group_mutation_limit(conn, identity.account_id)
    if not rename_group_row(conn, identity.account_id, canonical_id, name):
        conn.rollback()
        raise HTTPException(status_code=404, detail="Group not found")
    conn.commit()
    return group_row(conn, identity.account_id, canonical_id)


@app.delete("/api/groups/{group_id}", status_code=204)
def delete_group(
    group_id: str,
    conn: Connection = Depends(connection),
    authorization: str | None = Header(default=None),
) -> Response:
    identity = require_bearer(conn, authorization)
    canonical_id = _record_id(group_id, "Group")
    current = group_row(conn, identity.account_id, canonical_id)
    if current is None:
        raise HTTPException(status_code=404, detail="Group not found")
    if current["is_wishlist"]:
        raise HTTPException(status_code=409, detail="Wishlist cannot be deleted")
    _group_mutation_limit(conn, identity.account_id)
    if not delete_group_row(conn, identity.account_id, canonical_id):
        conn.rollback()
        raise HTTPException(status_code=404, detail="Group not found")
    conn.commit()
    return Response(status_code=204)


@app.post("/api/groups/{group_id}/places", response_model=Group)
def add_group_places_api(
    group_id: str,
    payload: GroupPlaceMutation,
    conn: Connection = Depends(connection),
    authorization: str | None = Header(default=None),
):
    identity = require_bearer(conn, authorization)
    canonical_id = _record_id(group_id, "Group")
    _group_mutation_limit(conn, identity.account_id)
    try:
        exists = add_group_places(conn, identity.account_id, canonical_id, payload.placeIds)
    except ValueError as exc:
        conn.rollback()
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not exists:
        conn.rollback()
        raise HTTPException(status_code=404, detail="Group not found")
    conn.commit()
    return group_row(conn, identity.account_id, canonical_id)


@app.delete("/api/groups/{group_id}/places", response_model=Group)
def remove_group_places_api(
    group_id: str,
    payload: GroupPlaceMutation,
    conn: Connection = Depends(connection),
    authorization: str | None = Header(default=None),
):
    identity = require_bearer(conn, authorization)
    canonical_id = _record_id(group_id, "Group")
    _group_mutation_limit(conn, identity.account_id)
    if not remove_group_places(conn, identity.account_id, canonical_id, payload.placeIds):
        conn.rollback()
        raise HTTPException(status_code=404, detail="Group not found")
    conn.commit()
    return group_row(conn, identity.account_id, canonical_id)


@app.get("/api/wishlist", response_model=Group)
def get_wishlist(
    conn: Connection = Depends(connection),
    authorization: str | None = Header(default=None),
):
    identity = require_bearer(conn, authorization)
    result = ensure_wishlist(conn, identity.account_id)
    conn.commit()
    return result


@app.post("/api/wishlist/places", response_model=Group)
def add_wishlist_places(
    payload: GroupPlaceMutation,
    conn: Connection = Depends(connection),
    authorization: str | None = Header(default=None),
):
    identity = require_bearer(conn, authorization)
    _group_mutation_limit(conn, identity.account_id)
    try:
        wishlist = ensure_wishlist(conn, identity.account_id)
        add_group_places(conn, identity.account_id, wishlist["id"], payload.placeIds)
    except ValueError as exc:
        conn.rollback()
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    conn.commit()
    return group_row(conn, identity.account_id, wishlist["id"])


@app.delete("/api/wishlist/places", response_model=Group)
def remove_wishlist_places(
    payload: GroupPlaceMutation,
    conn: Connection = Depends(connection),
    authorization: str | None = Header(default=None),
):
    identity = require_bearer(conn, authorization)
    _group_mutation_limit(conn, identity.account_id)
    wishlist = ensure_wishlist(conn, identity.account_id)
    remove_group_places(conn, identity.account_id, wishlist["id"], payload.placeIds)
    conn.commit()
    return group_row(conn, identity.account_id, wishlist["id"])


@app.put("/api/visits/{place_id}", response_model=VisitResult)
def update_visit(
    place_id: str,
    payload: VisitUpdate,
    conn: Connection = Depends(connection),
    authorization: str | None = Header(default=None),
    x_collection_key: str | None = Header(default=None),
):
    identity = resolve_identity(
        conn, authorization, x_collection_key, required=True
    )
    if not conn.execute(
        "SELECT 1 FROM places WHERE id = %s AND active", (place_id,)
    ).fetchone():
        raise HTTPException(status_code=404, detail="Place not found")
    if isinstance(identity, AccountIdentity):
        lock_account_progress(conn, identity.account_id)
        if payload.visited:
            conn.execute(
                """
                INSERT INTO account_visits (account_id, place_id)
                VALUES (%s, %s) ON CONFLICT DO NOTHING
                """,
                (identity.account_id, place_id),
            )
        else:
            conn.execute(
                "DELETE FROM account_visits WHERE account_id = %s AND place_id = %s",
                (identity.account_id, place_id),
            )
        count = conn.execute(
            """
            SELECT COUNT(*) AS visited_count FROM account_visits
            JOIN places ON places.id = account_visits.place_id AND places.active
            WHERE account_visits.account_id = %s
            """,
            (identity.account_id,),
        ).fetchone()["visited_count"]
    else:
        if payload.visited:
            conn.execute(
                "INSERT INTO visits (owner_hash, place_id) VALUES (%s, %s) ON CONFLICT DO NOTHING",
                (identity, place_id),
            )
        else:
            conn.execute(
                "DELETE FROM visits WHERE owner_hash = %s AND place_id = %s",
                (identity, place_id),
            )
        count = conn.execute(
            """
            SELECT COUNT(*) AS visited_count FROM visits
            JOIN places ON places.id = visits.place_id AND places.active
            WHERE visits.owner_hash = %s
            """,
            (identity,),
        ).fetchone()["visited_count"]
    visited_at = None
    if payload.visited:
        if isinstance(identity, AccountIdentity):
            row = conn.execute(
                "SELECT visited_at FROM account_visits WHERE account_id = %s AND place_id = %s",
                (identity.account_id, place_id),
            ).fetchone()
        else:
            row = conn.execute(
                "SELECT visited_at FROM visits WHERE owner_hash = %s AND place_id = %s",
                (identity, place_id),
            ).fetchone()
        visited_at = row["visited_at"]
    conn.commit()
    return {
        "place_id": place_id,
        "visited": payload.visited,
        "visited_count": count,
        "visited_at": visited_at,
    }


@app.put("/api/trails/{trail_id}", response_model=TrailResult)
def update_trail(trail_id: str, payload: TrailUpdate, conn: Connection = Depends(connection), authorization: str | None = Header(default=None), x_collection_key: str | None = Header(default=None)):
    if trail_id not in TRAIL_IDS:
        raise HTTPException(status_code=404, detail="Trail not found")
    identity = resolve_identity(conn, authorization, x_collection_key, required=True)
    if isinstance(identity, AccountIdentity):
        lock_account_progress(conn, identity.account_id)
    table, owner, value = ("account_trail_completions", "account_id", identity.account_id) if isinstance(identity, AccountIdentity) else ("guest_trail_completions", "owner_hash", identity)
    if payload.completed:
        conn.execute(f"INSERT INTO {table} ({owner}, trail_id) VALUES (%s, %s) ON CONFLICT DO NOTHING", (value, trail_id))
    else:
        conn.execute(f"DELETE FROM {table} WHERE {owner} = %s AND trail_id = %s", (value, trail_id))
    count = conn.execute(f"SELECT COUNT(*) AS count FROM {table} WHERE {owner} = %s", (value,)).fetchone()["count"]
    conn.commit()
    return {"trail_id": trail_id, "completed": payload.completed, "completed_trail_count": count}


@app.post("/api/auth/register", response_model=AuthResult, status_code=201)
def register(payload: Credentials):
    email = str(payload.email)
    with contextmanager(connection)() as conn:
        reserve_rate_limit(conn, "register_global", "global", 500, timedelta(minutes=15))
        reserve_rate_limit(conn, "register", email, 5, timedelta(hours=1))
        conn.commit()
    password_hash = hash_password(payload.password)
    with contextmanager(connection)() as conn:
        try:
            conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))", (email,))
            account = conn.execute(
                """
                INSERT INTO accounts (email, password_hash) VALUES (%s, %s)
                RETURNING id, email
                """,
                (email, password_hash),
            ).fetchone()
        except UniqueViolation:
            conn.rollback()
            record_security_event(conn, "registration", email, "duplicate")
            conn.commit()
            raise HTTPException(status_code=409, detail="An account with this email already exists")
        token, expires_at = create_session(conn, str(account["id"]))
        verification_token = None
        if settings.smtp_host:
            verification_token, _ = create_action_token(conn, str(account["id"]), "email_verification")
        record_security_event(conn, "registration", email, "created")
        conn.commit()
    if verification_token:
        try:
            send_auth_email(settings, email, "Verify your Parkdex email", f"Verify your email: {settings.app_public_url}/#verificationToken={verification_token}")
        except Exception as exc:
            logger.error("Registration verification email delivery failed (%s)", type(exc).__name__)
    return {
        "token": token,
        "expires_at": expires_at,
        "account": {"id": str(account["id"]), "email": account["email"], "email_verified": False},
        "visited_ids": [],
        "visits": [],
        "completed_trail_ids": [],
    }


@app.post("/api/auth/login", response_model=AuthResult)
def login(payload: Credentials):
    email = str(payload.email)
    with contextmanager(connection)() as conn:
        reserve_login_attempt(conn, email)
        account = conn.execute(
            "SELECT id, email, password_hash, email_verified_at IS NOT NULL AS email_verified FROM accounts WHERE email = %s", (email,)
        ).fetchone()
        conn.commit()
    password_hash = account["password_hash"] if account and account["password_hash"] else DUMMY_PASSWORD_HASH
    if not verify_password(password_hash, payload.password) or account is None:
        raise HTTPException(status_code=401, detail="Invalid email or password")
    with contextmanager(connection)() as conn:
        clear_login_failures(conn, email)
        current = conn.execute("SELECT password_hash FROM accounts WHERE id = %s FOR UPDATE", (account["id"],)).fetchone()
        if not current or current["password_hash"] != password_hash:
            raise HTTPException(status_code=401, detail="Invalid email or password")
        token, expires_at = create_session(conn, str(account["id"]))
        visits = visits_for_account(conn, str(account["id"]))
        completed_trail_ids = completed_trails_for_account(conn, str(account["id"]))
        conn.commit()
    return {
        "token": token,
        "expires_at": expires_at,
        "account": {"id": str(account["id"]), "email": account["email"], "email_verified": account["email_verified"]},
        "visited_ids": visited_ids(visits),
        "visits": visits,
        "completed_trail_ids": completed_trail_ids,
    }


@app.get("/api/auth/me", response_model=AccountState)
def me(
    conn: Connection = Depends(connection),
    authorization: str | None = Header(default=None),
):
    return account_state(conn, require_bearer(conn, authorization))


@app.post("/api/auth/logout", status_code=204)
def logout(
    conn: Connection = Depends(connection),
    authorization: str | None = Header(default=None),
) -> Response:
    identity = require_bearer(conn, authorization)
    conn.execute(
        "UPDATE account_sessions SET revoked_at = NOW() WHERE token_hash = %s",
        (identity.session_hash,),
    )
    conn.commit()
    return Response(status_code=204)


@app.post("/api/auth/password-reset/request", status_code=202)
def request_password_reset(payload: EmailRequest, background_tasks: BackgroundTasks) -> dict[str, str]:
    try:
        ensure_email_delivery(settings)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    email = str(payload.email)
    token = None
    with contextmanager(connection)() as conn:
        reserve_rate_limit(conn, "password_reset", email, 3, timedelta(minutes=15))
        account = conn.execute("SELECT id FROM accounts WHERE email = %s", (email,)).fetchone()
        if account:
            token, _ = create_action_token(conn, str(account["id"]), "password_reset")
        record_security_event(conn, "password_reset_requested", email, "accepted")
        conn.commit()
    if token:
        background_tasks.add_task(deliver_auth_email, email, "Reset your Parkdex password", f"Reset your password: {settings.app_public_url}/#resetToken={token}\n\nIf you did not request this, ignore this email.", "password_reset_email")
    return {"detail": "If an account exists, password reset instructions have been sent."}


@app.post("/api/auth/password-reset/confirm", status_code=204)
def confirm_password_reset(payload: PasswordResetConfirmation) -> Response:
    password_hash = hash_password(payload.newPassword)
    with contextmanager(connection)() as conn:
        row = consume_action_token(conn, payload.token, "password_reset")
        if row is None:
            raise HTTPException(status_code=400, detail="Invalid or expired password reset token")
        conn.execute("UPDATE accounts SET password_hash = %s, email_verified_at = COALESCE(email_verified_at, NOW()) WHERE id = %s", (password_hash, row["account_id"]))
        conn.execute("UPDATE account_sessions SET revoked_at = NOW() WHERE account_id = %s AND revoked_at IS NULL", (row["account_id"],))
        record_security_event(conn, "password_reset_completed", str(row["account_id"]), "success")
        conn.commit()
    return Response(status_code=204)


@app.post("/api/auth/password-change", status_code=204)
def change_password(payload: PasswordChange, authorization: str | None = Header(default=None)) -> Response:
    with contextmanager(connection)() as conn:
        identity = require_bearer(conn, authorization)
        account = conn.execute("SELECT password_hash FROM accounts WHERE id = %s", (identity.account_id,)).fetchone()
        current_hash = account["password_hash"] if account and account["password_hash"] else DUMMY_PASSWORD_HASH
    if not account or not account["password_hash"] or not verify_password(current_hash, payload.currentPassword):
        raise HTTPException(status_code=401, detail="Current password is incorrect")
    new_hash = hash_password(payload.newPassword)
    with contextmanager(connection)() as conn:
        locked = conn.execute("SELECT password_hash FROM accounts WHERE id = %s FOR UPDATE", (identity.account_id,)).fetchone()
        if not locked or locked["password_hash"] != current_hash:
            raise HTTPException(status_code=409, detail="Password changed during this request; try again")
        conn.execute("UPDATE accounts SET password_hash = %s WHERE id = %s", (new_hash, identity.account_id))
        conn.execute("UPDATE account_sessions SET revoked_at = NOW() WHERE account_id = %s AND revoked_at IS NULL", (identity.account_id,))
        record_security_event(conn, "password_changed", identity.account_id, "success")
        conn.commit()
    return Response(status_code=204)


@app.post("/api/auth/email-verification/request", status_code=202)
def request_email_verification(authorization: str | None = Header(default=None)) -> dict[str, str]:
    try:
        ensure_email_delivery(settings)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    with contextmanager(connection)() as conn:
        identity = require_bearer(conn, authorization)
        reserve_rate_limit(conn, "email_verification", identity.account_id, 3, timedelta(minutes=15))
        if identity.email_verified:
            conn.commit()
            return {"detail": "Email is already verified."}
        token, _ = create_action_token(conn, identity.account_id, "email_verification")
        conn.commit()
    try:
        send_auth_email(settings, identity.email, "Verify your Parkdex email", f"Verify your email: {settings.app_public_url}/#verificationToken={token}")
    except Exception as exc:
        logger.error("Verification email delivery failed (%s)", type(exc).__name__)
        raise HTTPException(status_code=503, detail="Email delivery is temporarily unavailable")
    return {"detail": "Verification instructions have been sent."}


@app.post("/api/auth/email-verification/confirm", status_code=204)
def confirm_email_verification(payload: TokenConfirmation) -> Response:
    with contextmanager(connection)() as conn:
        row = consume_action_token(conn, payload.token, "email_verification")
        if row is None:
            raise HTTPException(status_code=400, detail="Invalid or expired email verification token")
        conn.execute("UPDATE accounts SET email_verified_at = COALESCE(email_verified_at, NOW()) WHERE id = %s", (row["account_id"],))
        record_security_event(conn, "email_verified", str(row["account_id"]), "success")
        conn.commit()
    return Response(status_code=204)


@app.get("/api/auth/google/start", response_model=GoogleStart)
def start_google_oauth(code_challenge: str = Query(alias="codeChallenge", min_length=43, max_length=43, pattern=r"^[A-Za-z0-9_-]+$")):
    state = secrets.token_urlsafe(32)
    nonce = secrets.token_urlsafe(32)
    try:
        url = authorization_url(settings, state, nonce, code_challenge)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    with contextmanager(connection)() as conn:
        reserve_rate_limit(conn, "google_start_global", "global", 1000, timedelta(minutes=15))
        conn.execute("INSERT INTO oauth_authorization_states (state_hash, nonce_hash, code_challenge, expires_at) VALUES (%s, %s, %s, NOW() + INTERVAL '10 minutes')", (hashlib.sha256(state.encode()).hexdigest(), hashlib.sha256(nonce.encode()).hexdigest(), code_challenge))
        conn.commit()
    return {"authorization_url": url}


def _gmail_aliases(email: str) -> tuple[str, ...]:
    normalized = email.strip().lower()
    if normalized.endswith("@googlemail.com"):
        return (normalized.removesuffix("@googlemail.com") + "@gmail.com", normalized)
    if normalized.endswith("@gmail.com"):
        return (normalized, normalized.removesuffix("@gmail.com") + "@googlemail.com")
    return (normalized,)


def _google_conflict(conn: Connection, scope: str, outcome: str, detail: str) -> None:
    record_security_event(conn, "google_callback", scope, outcome)
    conn.commit()
    raise HTTPException(status_code=409, detail=detail)


@app.post("/api/auth/google/callback", response_model=AuthResult)
def finish_google_oauth(payload: GoogleCallback):
    state_hash = hashlib.sha256(payload.state.encode()).hexdigest()
    with contextmanager(connection)() as conn:
        state = conn.execute("UPDATE oauth_authorization_states SET used_at = NOW() WHERE state_hash = %s AND used_at IS NULL AND expires_at > NOW() RETURNING nonce_hash, code_challenge", (state_hash,)).fetchone()
        if state is None or not secrets.compare_digest(state["code_challenge"], pkce_challenge(payload.codeVerifier)):
            record_security_event(conn, "google_callback", state_hash, "invalid_state_or_pkce")
            conn.commit()
            raise HTTPException(status_code=400, detail="Invalid or expired Google authorization state")
        conn.commit()
    try:
        claims = exchange_and_verify(settings, payload.code, payload.codeVerifier)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except (httpx.HTTPError, GoogleAuthError, ValueError):
        with contextmanager(connection)() as conn:
            record_security_event(conn, "google_callback", state_hash, "token_exchange_failed")
            conn.commit()
        raise HTTPException(status_code=401, detail="Google authentication failed")
    nonce = claims.get("nonce")
    email = claims.get("email")
    subject = claims.get("sub")
    if not nonce or not secrets.compare_digest(hashlib.sha256(nonce.encode()).hexdigest(), state["nonce_hash"]):
        with contextmanager(connection)() as conn:
            record_security_event(conn, "google_callback", state_hash, "invalid_nonce")
            conn.commit()
        raise HTTPException(status_code=401, detail="Google authentication failed")
    if not subject or not email or claims.get("email_verified") is not True:
        with contextmanager(connection)() as conn:
            record_security_event(conn, "google_callback", state_hash, "unverified_identity")
            conn.commit()
        raise HTTPException(status_code=401, detail="Google did not verify this email address")
    aliases = _gmail_aliases(email)
    canonical_email = aliases[0]
    is_gmail = canonical_email.endswith("@gmail.com")
    with contextmanager(connection)() as conn:
        conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))", (canonical_email,))
        conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s, 1))", (subject,))
        linked = conn.execute("SELECT a.id, a.email FROM account_oauth_identities o JOIN accounts a ON a.id = o.account_id WHERE o.provider = 'google' AND o.subject = %s FOR UPDATE OF a", (subject,)).fetchone()
        if linked:
            if linked["email"] not in aliases:
                _google_conflict(conn, canonical_email, "linked_subject_email_conflict", "Google identity conflicts with an existing account")
            account = linked
        else:
            matches = conn.execute("SELECT id, email, password_hash, email_verified_at FROM accounts WHERE email = ANY(%s) FOR UPDATE", (list(aliases),)).fetchall()
            if len(matches) > 1:
                _google_conflict(conn, canonical_email, "multiple_email_matches", "Multiple accounts conflict with this Google identity")
            if matches:
                account = matches[0]
                if not is_gmail:
                    _google_conflict(conn, canonical_email, "non_gmail_collision", "An account already uses this email. Sign in with email and password.")
                other_identity = conn.execute("SELECT 1 FROM account_oauth_identities WHERE provider = 'google' AND account_id = %s", (account["id"],)).fetchone()
                if other_identity:
                    _google_conflict(conn, canonical_email, "account_identity_conflict", "Account is already linked to another Google identity")
                if account["email_verified_at"] is None:
                    conn.execute("UPDATE accounts SET password_hash = NULL, email_verified_at = NOW() WHERE id = %s", (account["id"],))
                    conn.execute("UPDATE account_sessions SET revoked_at = NOW() WHERE account_id = %s AND revoked_at IS NULL", (account["id"],))
                    conn.execute("UPDATE account_action_tokens SET used_at = NOW() WHERE account_id = %s AND used_at IS NULL", (account["id"],))
                else:
                    conn.execute("UPDATE accounts SET email_verified_at = COALESCE(email_verified_at, NOW()) WHERE id = %s", (account["id"],))
            else:
                account = conn.execute("INSERT INTO accounts (email, password_hash, email_verified_at) VALUES (%s, NULL, NOW()) RETURNING id, email", (canonical_email,)).fetchone()
            conn.execute("INSERT INTO account_oauth_identities (provider, subject, account_id, email_at_link) VALUES ('google', %s, %s, %s)", (subject, account["id"], canonical_email))
        token, expires_at = create_session(conn, str(account["id"]))
        visits = visits_for_account(conn, str(account["id"]))
        trails = completed_trails_for_account(conn, str(account["id"]))
        record_security_event(conn, "google_sign_in", str(account["id"]), "success")
        conn.commit()
    return {"token": token, "expires_at": expires_at, "account": {"id": str(account["id"]), "email": account["email"], "email_verified": True}, "visited_ids": visited_ids(visits), "visits": visits, "completed_trail_ids": trails}


@app.delete("/api/account/progress", status_code=204)
def reset_account_progress(
    conn: Connection = Depends(connection),
    authorization: str | None = Header(default=None),
) -> Response:
    identity = require_bearer(conn, authorization)
    # Serialize the reset with imports and progress writes for this account.
    lock_account_progress(conn, identity.account_id)
    conn.execute(
        "DELETE FROM account_visits WHERE account_id = %s", (identity.account_id,)
    )
    conn.execute(
        "DELETE FROM account_trail_completions WHERE account_id = %s",
        (identity.account_id,),
    )
    conn.commit()
    return Response(status_code=204)


@app.post("/api/account/import-guest", response_model=GuestImportResult)
def import_guest_progress(
    conn: Connection = Depends(connection),
    authorization: str | None = Header(default=None),
    x_collection_key: str | None = Header(default=None),
):
    identity = require_bearer(conn, authorization)
    owner_hash = collection_hash(x_collection_key, required=True)
    lock_account_progress(conn, identity.account_id)
    imported_visits = conn.execute(
        """
        INSERT INTO account_visits (account_id, place_id, visited_at)
        SELECT %s, place_id, visited_at FROM visits WHERE owner_hash = %s
        ON CONFLICT DO NOTHING
        """,
        (identity.account_id, owner_hash),
    ).rowcount
    imported_trails = conn.execute(
        """
        INSERT INTO account_trail_completions (account_id, trail_id, completed_at)
        SELECT %s, trail_id, completed_at FROM guest_trail_completions WHERE owner_hash = %s
        ON CONFLICT DO NOTHING
        """,
        (identity.account_id, owner_hash),
    ).rowcount
    visits = visits_for_account(conn, identity.account_id)
    conn.commit()
    return {
        "imported_visit_count": imported_visits,
        "visited_ids": visited_ids(visits),
        "visits": visits,
        "imported_trail_count": imported_trails,
        "completed_trail_ids": completed_trails_for_account(conn, identity.account_id),
    }


# Mounted last so the API's explicit routes retain precedence. Its lifespan is
# entered by the parent lifespan above because Starlette does not start mounted lifespans.
app.mount("/", mcp_http_app)

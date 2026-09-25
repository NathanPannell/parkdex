from contextlib import asynccontextmanager, contextmanager
import hashlib
import json
import logging
import re
import secrets
from datetime import timedelta
from uuid import UUID
from datetime import datetime, timezone
from threading import Lock

import httpx
from fastapi import BackgroundTasks, Depends, FastAPI, File, Header, HTTPException, Query, Response, UploadFile
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
from backend.app.account_deletion import (
    account_deletion_receipt,
    account_deletion_receipt_hash,
    account_deletion_result,
    delete_account_rows,
    enqueue_photo_object_deletions,
    purge_expired_account_deletion_receipts,
    update_account_deletion_receipt,
)
from backend.app.auth_emails import AuthEmail, password_reset_email, verification_email
from backend.app.db import close_pool, connection, open_pool
from backend.app.email_delivery import email_delivery_configured, ensure_email_delivery, send_auth_email
from backend.app.claim_photos import MAX_UPLOAD_BYTES, PhotoInputError, normalize_photo
from backend.app.claims import (
    ClaimInputError,
    LocationSample,
    create_recommendation_token,
    get_boundary_registry,
    recommendation_token_hash,
    validate_location_sample,
)
from backend.app.offline_claims import (
    OFFLINE_GRANT_VALIDITY,
    create_offline_grant_token,
    offline_request_fingerprint,
    offline_grant_token_hash,
    validate_offline_location_sample,
)
from backend.app.object_storage import (
    ObjectStorage,
    ObjectStorageError,
    ObjectStorageNotFound,
    object_storage_from_settings,
)
from backend.app.request_body_limit import ClaimPhotoBodyLimitMiddleware
from backend.app.staging_field_places import (
    place_visibility_clause,
    place_visibility_params,
    sync_staging_field_places,
)
from backend.app.google_oauth import authorization_url, exchange_and_verify
from backend.app.mcp_server import build_hosted_mcp_app
from backend.app.schemas import (
    AccountState,
    AccountDeletionRequest,
    AccountDeletionResult,
    AuthResult,
    ClaimRecommendationRequest,
    ClaimRecommendationResponse,
    CreateClaimRequest,
    CreateClaimResponse,
    Credentials,
    EmailRequest,
    GoogleCallback,
    GoogleStart,
    Group,
    GroupCreate,
    GroupPlaceMutation,
    GroupRename,
    GuestImportResult,
    OfflineClaimGrantResponse,
    OfflineClaimRequest,
    OfflinePlaceBundle,
    PlaceCollection,
    PlaceSearchResult,
    SearchPlace,
    PasswordResetConfirmation,
    TrailResult,
    TrailUpdate,
    TokenConfirmation,
    VisitResult,
    VisitPhotoResult,
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
    "Official-source British Columbia collection: Parks Canada destinations, designated "
    "provincial parks, selected regional parks, and curated major islands. Regional coverage "
    "varies by authority and is not a complete inventory of municipal or First Nations parks. "
    "Pins are representative centres, not entrances or trailheads."
)
CLAIM_RECOMMENDATION_ACCOUNT_LIMIT = 60
CLAIM_RECOMMENDATION_GLOBAL_LIMIT = 5_000
OFFLINE_CLAIM_GRANT_ACCOUNT_LIMIT = 10
OFFLINE_CLAIM_GRANT_GLOBAL_LIMIT = 5_000
OFFLINE_CLAIM_ACCOUNT_LIMIT = 60
OFFLINE_CLAIM_GLOBAL_LIMIT = 5_000
PHOTO_UPLOAD_ACCOUNT_LIMIT = 30
PHOTO_UPLOAD_GLOBAL_LIMIT = 2_000
CLAIM_ABUSE_WINDOW = timedelta(minutes=15)
PHOTO_DELETION_BATCH_SIZE = 100
PHOTO_DELETION_RETRY_BASE_SECONDS = 30
PHOTO_DELETION_RETRY_MAX_SECONDS = 60 * 60
PHOTO_DELETION_RETRY_MAX_EXPONENT = 7


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


def visit_from_row(row: dict) -> dict:
    claim = None
    if row.get("claimed_at") is not None:
        claim = {
            "claimed_at": row["claimed_at"],
            "captured_at": row["captured_at"],
            "coordinates": {"latitude": row["claim_latitude"], "longitude": row["claim_longitude"]},
            "accuracy_meters": row["accuracy_m"],
            "boundary_version": row["boundary_version"],
            "match_kind": row["match_kind"],
            "distance_meters": row["distance_m"],
            "has_photo": row.get("photo_object_key") is not None,
        }
    return {"place_id": row["place_id"], "visited_at": row["visited_at"], "claim": claim}


def visits_for_account(
    conn: Connection,
    account_id: str,
    *,
    include_staging_field_places: bool = False,
) -> list[dict]:
    return [
        visit_from_row(row)
        for row in conn.execute(
            f"""
            SELECT account_visits.place_id, account_visits.visited_at,
                   account_visit_claims.claimed_at, account_visit_claims.captured_at,
                   account_visit_claims.latitude AS claim_latitude,
                   account_visit_claims.longitude AS claim_longitude,
                   account_visit_claims.accuracy_m, account_visit_claims.boundary_version,
                   account_visit_claims.match_kind, account_visit_claims.distance_m,
                   account_visit_claims.photo_object_key
            FROM account_visits
            JOIN places ON places.id = account_visits.place_id
                AND {place_visibility_clause()}
            LEFT JOIN account_visit_claims USING (account_id, place_id)
            WHERE account_visits.account_id = %s ORDER BY account_visits.visited_at, account_visits.place_id
            """,
            (*place_visibility_params(include_staging_field_places), account_id),
        ).fetchall()
    ]


def visited_ids(visits: list[dict]) -> list[str]:
    return [visit["place_id"] for visit in visits]


def visits_for_guest(
    conn: Connection,
    owner_hash: str,
    *,
    include_staging_field_places: bool = False,
) -> list[dict]:
    return [
        visit_from_row(row)
        for row in conn.execute(
            f"""
            SELECT visits.place_id, visits.visited_at
            FROM visits
            JOIN places ON places.id = visits.place_id
                AND {place_visibility_clause()}
            WHERE visits.owner_hash = %s ORDER BY visits.visited_at, visits.place_id
            """,
            (*place_visibility_params(include_staging_field_places), owner_hash),
        ).fetchall()
    ]


def completed_trails_for_account(conn: Connection, account_id: str) -> list[str]:
    return [row["trail_id"] for row in conn.execute("SELECT trail_id FROM account_trail_completions WHERE account_id = %s ORDER BY trail_id", (account_id,)).fetchall()]


def lock_account_progress(conn: Connection, account_id: str) -> None:
    conn.execute("SELECT id FROM accounts WHERE id = %s FOR UPDATE", (account_id,))


def account_state(conn: Connection, identity: AccountIdentity) -> dict:
    visits = visits_for_account(
        conn,
        identity.account_id,
        include_staging_field_places=settings.staging_field_places_enabled,
    )
    account = conn.execute("SELECT password_hash IS NOT NULL AS has_password FROM accounts WHERE id = %s", (identity.account_id,)).fetchone()
    return {
        "account": {
            "id": identity.account_id,
            "email": identity.email,
            "email_verified": identity.email_verified,
            "has_password": bool(account and account["has_password"]),
        },
        "visited_ids": visited_ids(visits),
        "visits": visits,
        "completed_trail_ids": completed_trails_for_account(conn, identity.account_id),
    }


settings = get_settings()
logger = logging.getLogger(__name__)

_photo_storage: ObjectStorage | None = None
_photo_storage_lock = Lock()


def set_photo_storage(storage: ObjectStorage | None) -> None:
    """Inject a photo store for tests or a local process.

    Passing ``None`` clears both the test override and the lazy production
    instance.  The API never accepts a client-provided storage URL.
    """

    global _photo_storage
    with _photo_storage_lock:
        _photo_storage = storage


def photo_storage() -> ObjectStorage:
    global _photo_storage
    with _photo_storage_lock:
        if _photo_storage is None:
            _photo_storage = object_storage_from_settings(settings)
        return _photo_storage


def photo_storage_error(exc: Exception) -> HTTPException:
    logger.error("Private photo object storage unavailable (%s)", type(exc).__name__)
    return claim_error(
        503,
        "photo_storage_unavailable",
        "Private photo object storage is unavailable; try again later",
    )


def settle_photo_object_deletions(
    keys: list[str], *, outcome_conn: Connection | None = None
) -> int:
    """Attempt queued object deletions now, leaving only failures for retry.

    Callers first enqueue the keys in the same transaction that removes their
    database references.  That preserves the transactional outbox guarantee if
    the process exits after commit.  Successful provider deletes remove their
    tombstones immediately; failures retain the existing exponential retry
    schedule for the manual cleanup command.
    """

    pending_keys = sorted(set(keys))
    if not pending_keys:
        return 0

    deleted_keys: list[str] = []
    failed: dict[str, str] = {}
    try:
        storage = photo_storage()
    except Exception as exc:
        error_type = type(exc).__name__
        failed = {key: error_type for key in pending_keys}
        logger.warning("Private photo cleanup storage unavailable (%s)", error_type)
    else:
        for key in pending_keys:
            try:
                storage.delete(key)
            except ObjectStorageNotFound:
                deleted_keys.append(key)
            except Exception as exc:
                failed[key] = type(exc).__name__
            else:
                deleted_keys.append(key)

    def record_outcomes(conn: Connection) -> None:
        if deleted_keys:
            conn.execute(
                "DELETE FROM photo_object_deletions WHERE object_key = ANY(%s)",
                (deleted_keys,),
            )
        for key, error_type in failed.items():
            conn.execute(
                """
                UPDATE photo_object_deletions
                SET attempt_count = attempt_count + 1,
                    last_attempted_at = NOW(),
                    next_attempt_at = NOW() + make_interval(
                        secs => LEAST(%s, %s * POWER(
                            2, LEAST(attempt_count, %s)
                        ))::INTEGER
                    ),
                    last_error = %s
                WHERE object_key = %s
                """,
                (
                    PHOTO_DELETION_RETRY_MAX_SECONDS,
                    PHOTO_DELETION_RETRY_BASE_SECONDS,
                    PHOTO_DELETION_RETRY_MAX_EXPONENT,
                    error_type,
                    key,
                ),
            )
        conn.commit()

    try:
        if outcome_conn is not None:
            record_outcomes(outcome_conn)
        else:
            with contextmanager(connection)() as conn:
                record_outcomes(conn)
    except Exception as exc:
        # The original tombstones remain durable and due when outcome recording
        # fails, so the manual cleanup command can safely retry every provider operation.
        logger.warning(
            "Could not record private photo deletion outcomes (%s)",
            type(exc).__name__,
        )
    return len(deleted_keys)


def process_photo_deletion_outbox(limit: int = PHOTO_DELETION_BATCH_SIZE) -> int:
    """Best-effort one durable cleanup batch; failures remain queued for retry.

    Claim due rows in one short transaction, release the pool connection before
    touching object storage, then persist the outcomes in another short
    transaction.  Object deletion is idempotent, so a worker crash after the
    provider call is safely retried by a later manual run when the backoff becomes due.
    """

    try:
        with contextmanager(connection)() as conn:
            rows = conn.execute(
                """
                WITH due AS (
                    SELECT object_key
                    FROM photo_object_deletions
                    WHERE next_attempt_at <= NOW()
                    ORDER BY next_attempt_at, enqueued_at, object_key
                    FOR UPDATE SKIP LOCKED
                    LIMIT %s
                )
                UPDATE photo_object_deletions AS deletion
                SET attempt_count = deletion.attempt_count + 1,
                    last_attempted_at = NOW(),
                    next_attempt_at = NOW() + make_interval(
                        secs => LEAST(%s, %s * POWER(
                            2, LEAST(deletion.attempt_count, %s)
                        ))::INTEGER
                    ),
                    last_error = NULL
                FROM due
                WHERE deletion.object_key = due.object_key
                RETURNING deletion.object_key
                """,
                (
                    limit,
                    PHOTO_DELETION_RETRY_MAX_SECONDS,
                    PHOTO_DELETION_RETRY_BASE_SECONDS,
                    PHOTO_DELETION_RETRY_MAX_EXPONENT,
                ),
            ).fetchall()
            if not rows:
                return 0
            conn.commit()

        keys = [row["object_key"] for row in rows]
        deleted_keys: list[str] = []
        failed: dict[str, str] = {}
        try:
            storage = photo_storage()
        except Exception as exc:
            error_type = type(exc).__name__
            failed = {key: error_type for key in keys}
            logger.warning(
                "Private photo cleanup storage unavailable (%s)", error_type
            )
        else:
            for key in keys:
                try:
                    storage.delete(key)
                except ObjectStorageNotFound:
                    deleted_keys.append(key)
                except Exception as exc:
                    failed[key] = type(exc).__name__
                else:
                    deleted_keys.append(key)

        with contextmanager(connection)() as conn:
            if deleted_keys:
                conn.execute(
                    "DELETE FROM photo_object_deletions WHERE object_key = ANY(%s)",
                    (deleted_keys,),
                )
            for key, error_type in failed.items():
                conn.execute(
                    """
                    UPDATE photo_object_deletions
                    SET last_error = %s
                    WHERE object_key = %s
                    """,
                    (error_type, key),
                )
            conn.commit()
        return len(deleted_keys)
    except Exception as exc:
        logger.warning(
            "Could not process private photo deletion outbox (%s)",
            type(exc).__name__,
        )
        return 0


def persist_failed_upload_cleanup(_account_id: str, object_key: str) -> None:
    """Delete an unreferenced upload now, retaining a durable retry on failure.

    The account may have been deleted while the object was being uploaded, so
    this orphan cleanup intent deliberately leaves ``account_id`` NULL.  The
    outbox is designed to survive that account cascade.
    """

    try:
        with contextmanager(connection)() as conn:
            enqueue_photo_object_deletions(conn, None, [object_key])
            conn.commit()
    except Exception as exc:
        # If the database itself is unavailable, a direct idempotent delete is
        # the only remaining cleanup path.
        logger.error(
            "Could not persist failed postcard cleanup (%s)", type(exc).__name__
        )
        try:
            photo_storage().delete(object_key)
        except Exception as cleanup_exc:
            logger.error(
                "Could not clean up failed postcard upload (%s)",
                type(cleanup_exc).__name__,
            )
        return
    settle_photo_object_deletions([object_key])


mcp_http_app = build_hosted_mcp_app(
    issuer_url=settings.api_public_url,
    resource_url=settings.mcp_public_url,
    account_url=settings.app_public_url,
)


@asynccontextmanager
async def lifespan(_: FastAPI):
    try:
        open_pool()
        include_staging_field_places = settings.staging_field_places_enabled
        with contextmanager(connection)() as conn:
            sync_staging_field_places(
                conn,
                enabled=include_staging_field_places,
            )
            registry = get_boundary_registry(include_staging_field_places)
            active_ids = {
                row["id"]
                for row in conn.execute(
                    f"SELECT id FROM places WHERE {place_visibility_clause()} "
                    "AND id = ANY(%s)",
                    (
                        *place_visibility_params(include_staging_field_places),
                        list(registry.place_ids),
                    ),
                ).fetchall()
            }
            missing = registry.place_ids - active_ids
            if missing:
                raise RuntimeError(
                    "Claim boundaries reference inactive or missing places: "
                    f"{sorted(missing)[:5]}"
                )
            conn.commit()
        async with mcp_http_app.lifespan():
            yield
    finally:
        close_pool()


def deliver_auth_email(recipient: str, email: AuthEmail, event_type: str) -> None:
    try:
        send_auth_email(settings, recipient, email.subject, email.text, email.html)
    except Exception as exc:
        logger.error("Auth email delivery failed (%s)", type(exc).__name__)
        try:
            with contextmanager(connection)() as conn:
                record_security_event(conn, event_type, recipient, "delivery_failed")
                conn.commit()
        except Exception:
            logger.error("Could not record auth email delivery failure")


def auth_link(fragment: str) -> str:
    return f"{settings.app_public_url.rstrip('/')}/account#{fragment}"


app = FastAPI(title="Parkdex API", version="1.0.0", lifespan=lifespan)
app.add_middleware(ClaimPhotoBodyLimitMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
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
        "boundaryVersion": get_boundary_registry(
            settings.staging_field_places_enabled
        ).version,
    }


@app.get("/api/auth/config")
def auth_config() -> dict[str, bool]:
    return {
        "googleEnabled": bool(settings.google_client_id and settings.google_client_secret and settings.google_redirect_uri),
        "emailEnabled": email_delivery_configured(settings),
    }


@app.get("/api/guest/progress-state")
def guest_progress_state(
    response: Response,
    conn: Connection = Depends(connection),
    x_collection_key: str | None = Header(default=None),
) -> dict[str, bool]:
    response.headers["Cache-Control"] = "no-store"
    owner_hash = collection_hash(x_collection_key, required=True)
    has_visits = conn.execute(
        "SELECT EXISTS(SELECT 1 FROM visits WHERE owner_hash = %s) AS has_progress",
        (owner_hash,),
    ).fetchone()["has_progress"]
    has_trails = conn.execute(
        "SELECT EXISTS(SELECT 1 FROM guest_trail_completions WHERE owner_hash = %s) AS has_progress",
        (owner_hash,),
    ).fetchone()["has_progress"]
    return {"hasProgress": bool(has_visits or has_trails)}


@app.get("/api/places", response_model=PlaceCollection)
def list_places(
    conn: Connection = Depends(connection),
    authorization: str | None = Header(default=None),
    x_collection_key: str | None = Header(default=None),
    summary: bool = False,
):
    identity = resolve_identity(conn, authorization, x_collection_key)
    include_staging_field_places = settings.staging_field_places_enabled
    summary_columns = (
        "''::text AS description, ''::text AS source_url"
        if summary
        else "description, source_url"
    )
    places = conn.execute(
        f"""
        SELECT id, name, category, latitude, longitude, region,
               {summary_columns},
               source_name, source_id
        FROM places WHERE {place_visibility_clause()} ORDER BY name
        """,
        place_visibility_params(include_staging_field_places),
    ).fetchall()
    visits: list[dict] = []
    completed_trail_ids: list[str] = []
    if isinstance(identity, AccountIdentity):
        visits = visits_for_account(
            conn,
            identity.account_id,
            include_staging_field_places=include_staging_field_places,
        )
        completed_trail_ids = completed_trails_for_account(conn, identity.account_id)
    elif identity:
        visits = visits_for_guest(
            conn,
            identity,
            include_staging_field_places=include_staging_field_places,
        )
        completed_trail_ids = [row["trail_id"] for row in conn.execute("SELECT trail_id FROM guest_trail_completions WHERE owner_hash = %s ORDER BY trail_id", (identity,)).fetchall()]
    return {
        "places": places,
        "visited_ids": visited_ids(visits),
        "visits": visits,
        "completed_trail_ids": completed_trail_ids,
        "coverage_note": COVERAGE_NOTE,
        "visit_claims": {
            "supported": True,
            "enforcement": settings.visit_claim_enforcement,
            "offline_supported": True,
        },
    }


PLACE_CATEGORIES = frozenset({"national", "provincial", "regional", "island"})


def _record_id(value: str, label: str) -> str:
    try:
        return str(UUID(value))
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=f"{label} not found") from exc


def _group_mutation_limit(conn: Connection, account_id: str) -> None:
    reserve_rate_limit(conn, "group_mutation", account_id, 120, timedelta(minutes=15))


def _group_name(value: str, label: str = "Collection") -> str:
    name = value.strip()
    if not name:
        raise HTTPException(status_code=422, detail=f"{label} name must not be blank")
    if name.casefold() == "wishlist":
        raise HTTPException(status_code=422, detail="Wishlist is reserved for the protected account collection")
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
        include_staging_field_places=settings.staging_field_places_enabled,
    )
    return {"places": rows, "total": total, "limit": limit, "offset": offset}


@app.get("/api/places/{place_id}", response_model=SearchPlace)
def get_place_details(
    place_id: str,
    conn: Connection = Depends(connection),
    authorization: str | None = Header(default=None),
):
    identity = require_bearer(conn, authorization)
    row = place_detail_row(
        conn,
        identity.account_id,
        place_id,
        include_staging_field_places=settings.staging_field_places_enabled,
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Place not found")
    return row


@app.get("/api/places/{place_id}/offline-bundle", response_model=OfflinePlaceBundle)
def get_offline_place_bundle(
    place_id: str,
    response: Response,
    conn: Connection = Depends(connection),
):
    response.headers["Cache-Control"] = "public, max-age=300"
    row = conn.execute(
        f"""
        SELECT id, name, category, latitude, longitude, region, description,
               source_url, source_name, source_id
        FROM places WHERE id = %s AND {place_visibility_clause()}
        """,
        (
            place_id,
            *place_visibility_params(settings.staging_field_places_enabled),
        ),
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Place not found")
    registry = get_boundary_registry(settings.staging_field_places_enabled)
    return {
        "place": row,
        "boundary": registry.feature(place_id),
        "boundary_version": registry.offline_version,
    }


@app.get("/api/groups", response_model=list[Group])
def list_groups(
    conn: Connection = Depends(connection),
    authorization: str | None = Header(default=None),
):
    identity = require_bearer(conn, authorization)
    identity = revalidate_locked_account_identity(conn, identity, authorization)
    ensure_wishlist(
        conn,
        identity.account_id,
        include_staging_field_places=settings.staging_field_places_enabled,
    )
    conn.commit()
    return list_group_rows(
        conn,
        identity.account_id,
        include_staging_field_places=settings.staging_field_places_enabled,
    )


@app.post("/api/groups", response_model=Group, status_code=201)
def create_group(
    payload: GroupCreate,
    conn: Connection = Depends(connection),
    authorization: str | None = Header(default=None),
):
    identity = require_bearer(conn, authorization)
    name = _group_name(payload.name)
    identity = revalidate_locked_account_identity(conn, identity, authorization)
    _group_mutation_limit(conn, identity.account_id)
    try:
        result = create_group_row(
            conn,
            identity.account_id,
            name,
            payload.placeIds,
            include_staging_field_places=settings.staging_field_places_enabled,
        )
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
    result = group_row(
        conn,
        identity.account_id,
        _record_id(group_id, "Collection"),
        include_staging_field_places=settings.staging_field_places_enabled,
    )
    if result is None:
        raise HTTPException(status_code=404, detail="Collection not found")
    return result


@app.patch("/api/groups/{group_id}", response_model=Group)
def rename_group(
    group_id: str,
    payload: GroupRename,
    conn: Connection = Depends(connection),
    authorization: str | None = Header(default=None),
):
    identity = require_bearer(conn, authorization)
    canonical_id = _record_id(group_id, "Collection")
    name = _group_name(payload.name)
    identity = revalidate_locked_account_identity(conn, identity, authorization)
    current = group_row(
        conn,
        identity.account_id,
        canonical_id,
        include_staging_field_places=settings.staging_field_places_enabled,
    )
    if current is None:
        raise HTTPException(status_code=404, detail="Collection not found")
    if current["is_wishlist"]:
        raise HTTPException(status_code=409, detail="Wishlist cannot be renamed")
    _group_mutation_limit(conn, identity.account_id)
    if not rename_group_row(conn, identity.account_id, canonical_id, name):
        conn.rollback()
        raise HTTPException(status_code=404, detail="Collection not found")
    conn.commit()
    return group_row(
        conn,
        identity.account_id,
        canonical_id,
        include_staging_field_places=settings.staging_field_places_enabled,
    )


@app.delete("/api/groups/{group_id}", status_code=204)
def delete_group(
    group_id: str,
    conn: Connection = Depends(connection),
    authorization: str | None = Header(default=None),
) -> Response:
    identity = require_bearer(conn, authorization)
    canonical_id = _record_id(group_id, "Collection")
    identity = revalidate_locked_account_identity(conn, identity, authorization)
    current = group_row(
        conn,
        identity.account_id,
        canonical_id,
        include_staging_field_places=settings.staging_field_places_enabled,
    )
    if current is None:
        raise HTTPException(status_code=404, detail="Collection not found")
    if current["is_wishlist"]:
        raise HTTPException(status_code=409, detail="Wishlist cannot be deleted")
    _group_mutation_limit(conn, identity.account_id)
    if not delete_group_row(conn, identity.account_id, canonical_id):
        conn.rollback()
        raise HTTPException(status_code=404, detail="Collection not found")
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
    canonical_id = _record_id(group_id, "Collection")
    identity = revalidate_locked_account_identity(conn, identity, authorization)
    _group_mutation_limit(conn, identity.account_id)
    try:
        exists = add_group_places(
            conn,
            identity.account_id,
            canonical_id,
            payload.placeIds,
            include_staging_field_places=settings.staging_field_places_enabled,
        )
    except ValueError as exc:
        conn.rollback()
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not exists:
        conn.rollback()
        raise HTTPException(status_code=404, detail="Collection not found")
    conn.commit()
    return group_row(
        conn,
        identity.account_id,
        canonical_id,
        include_staging_field_places=settings.staging_field_places_enabled,
    )


@app.delete("/api/groups/{group_id}/places", response_model=Group)
def remove_group_places_api(
    group_id: str,
    payload: GroupPlaceMutation,
    conn: Connection = Depends(connection),
    authorization: str | None = Header(default=None),
):
    identity = require_bearer(conn, authorization)
    canonical_id = _record_id(group_id, "Collection")
    identity = revalidate_locked_account_identity(conn, identity, authorization)
    _group_mutation_limit(conn, identity.account_id)
    if not remove_group_places(conn, identity.account_id, canonical_id, payload.placeIds):
        conn.rollback()
        raise HTTPException(status_code=404, detail="Collection not found")
    conn.commit()
    return group_row(
        conn,
        identity.account_id,
        canonical_id,
        include_staging_field_places=settings.staging_field_places_enabled,
    )


@app.get("/api/wishlist", response_model=Group)
def get_wishlist(
    conn: Connection = Depends(connection),
    authorization: str | None = Header(default=None),
):
    identity = require_bearer(conn, authorization)
    identity = revalidate_locked_account_identity(conn, identity, authorization)
    result = ensure_wishlist(
        conn,
        identity.account_id,
        include_staging_field_places=settings.staging_field_places_enabled,
    )
    conn.commit()
    return result


@app.post("/api/wishlist/places", response_model=Group)
def add_wishlist_places(
    payload: GroupPlaceMutation,
    conn: Connection = Depends(connection),
    authorization: str | None = Header(default=None),
):
    identity = require_bearer(conn, authorization)
    identity = revalidate_locked_account_identity(conn, identity, authorization)
    _group_mutation_limit(conn, identity.account_id)
    try:
        wishlist = ensure_wishlist(
            conn,
            identity.account_id,
            include_staging_field_places=settings.staging_field_places_enabled,
        )
        add_group_places(
            conn,
            identity.account_id,
            wishlist["id"],
            payload.placeIds,
            include_staging_field_places=settings.staging_field_places_enabled,
        )
    except ValueError as exc:
        conn.rollback()
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    conn.commit()
    return group_row(
        conn,
        identity.account_id,
        wishlist["id"],
        include_staging_field_places=settings.staging_field_places_enabled,
    )


@app.delete("/api/wishlist/places", response_model=Group)
def remove_wishlist_places(
    payload: GroupPlaceMutation,
    conn: Connection = Depends(connection),
    authorization: str | None = Header(default=None),
):
    identity = require_bearer(conn, authorization)
    identity = revalidate_locked_account_identity(conn, identity, authorization)
    _group_mutation_limit(conn, identity.account_id)
    wishlist = ensure_wishlist(
        conn,
        identity.account_id,
        include_staging_field_places=settings.staging_field_places_enabled,
    )
    remove_group_places(conn, identity.account_id, wishlist["id"], payload.placeIds)
    conn.commit()
    return group_row(
        conn,
        identity.account_id,
        wishlist["id"],
        include_staging_field_places=settings.staging_field_places_enabled,
    )
CLAIM_TEST_FIXTURES = {
    "inside-goldstream": "provincial-goldstream-park",
    "inside-saltspring": "island-saltspring-island",
}


def claim_error(status_code: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status_code, detail={"code": code, "message": message})


def authenticated_claim_identity(
    conn: Connection,
    authorization: str | None,
    collection_key: str | None,
) -> AccountIdentity:
    """Claims and postcard bytes are account-only, including test fixtures."""

    if collection_key is not None:
        raise claim_error(
            401,
            "authentication_required",
            "Location claims require an authenticated account",
        )
    return require_bearer(conn, authorization)


def revalidate_locked_account_identity(
    conn: Connection,
    expected: AccountIdentity,
    authorization: str | None,
) -> AccountIdentity:
    """Lock account-owned state, then reject a bearer revoked while waiting."""

    lock_account_progress(conn, expected.account_id)
    current = require_bearer(conn, authorization)
    if current.account_id != expected.account_id:
        raise claim_error(401, "authentication_required", "Authentication required")
    return current


def revalidate_locked_claim_identity(
    conn: Connection,
    expected: AccountIdentity,
    authorization: str | None,
    collection_key: str | None,
) -> AccountIdentity:
    """Acquire the account mutation lock, then observe current session state."""

    if collection_key is not None:
        raise claim_error(
            401,
            "authentication_required",
            "Location claims require an authenticated account",
        )
    return revalidate_locked_account_identity(conn, expected, authorization)


def reserve_claim_recommendation_capacity(
    conn: Connection, account_id: str
) -> None:
    reserve_rate_limit(
        conn,
        "claim_recommendation_global",
        "global",
        CLAIM_RECOMMENDATION_GLOBAL_LIMIT,
        CLAIM_ABUSE_WINDOW,
    )
    reserve_rate_limit(
        conn,
        "claim_recommendation",
        account_id,
        CLAIM_RECOMMENDATION_ACCOUNT_LIMIT,
        CLAIM_ABUSE_WINDOW,
    )
    # Capacity reservations must survive invalid samples and downstream errors.
    conn.commit()


def reserve_photo_upload_capacity(conn: Connection, account_id: str) -> None:
    reserve_rate_limit(
        conn,
        "claim_photo_upload_global",
        "global",
        PHOTO_UPLOAD_GLOBAL_LIMIT,
        CLAIM_ABUSE_WINDOW,
    )
    reserve_rate_limit(
        conn,
        "claim_photo_upload",
        account_id,
        PHOTO_UPLOAD_ACCOUNT_LIMIT,
        CLAIM_ABUSE_WINDOW,
    )
    conn.commit()


def owner_visited_ids(conn: Connection, account_id: str) -> list[str]:
    rows = conn.execute(
        "SELECT place_id FROM account_visits WHERE account_id = %s", (account_id,)
    ).fetchall()
    return [row["place_id"] for row in rows]


def claim_response_from_row(row: dict, visited_count: int) -> dict:
    return {
        "place_id": row["place_id"],
        "visited": True,
        "visited_count": visited_count,
        "visited_at": row["visited_at"],
        "claim": {
            "claimed_at": row["claimed_at"],
            "captured_at": row["captured_at"],
            "coordinates": {"latitude": row["latitude"], "longitude": row["longitude"]},
            "accuracy_meters": row["accuracy_m"],
            "boundary_version": row["boundary_version"],
            "match_kind": row["match_kind"],
            "distance_meters": row["distance_m"],
            "has_photo": row.get("photo_object_key") is not None,
        },
    }


def fetch_claim(
    conn: Connection, account_id: str, place_id: str
) -> dict | None:
    return conn.execute(
        """
        SELECT account_visits.place_id, account_visits.visited_at,
               account_visit_claims.claimed_at, account_visit_claims.captured_at,
               account_visit_claims.latitude, account_visit_claims.longitude,
               account_visit_claims.accuracy_m, account_visit_claims.boundary_version,
               account_visit_claims.match_kind, account_visit_claims.distance_m,
               account_visit_claims.photo_object_key
        FROM account_visit_claims
        JOIN account_visits USING (account_id, place_id)
        WHERE account_visit_claims.account_id = %s
          AND account_visit_claims.place_id = %s
        """,
        (account_id, place_id),
    ).fetchone()


def owner_visit_count(
    conn: Connection,
    account_id: str,
    *,
    include_staging_field_places: bool = False,
) -> int:
    return conn.execute(
        f"""SELECT COUNT(*) AS count FROM account_visits
           JOIN places ON places.id = account_visits.place_id
               AND {place_visibility_clause()}
           WHERE account_id = %s""",
        (*place_visibility_params(include_staging_field_places), account_id),
    ).fetchone()["count"]


@app.post(
    "/api/claim-recommendations",
    response_model=ClaimRecommendationResponse,
    response_model_exclude_none=True,
)
def recommend_claim(
    payload: ClaimRecommendationRequest,
    response: Response,
    conn: Connection = Depends(connection),
    authorization: str | None = Header(default=None),
    x_collection_key: str | None = Header(default=None),
):
    response.headers["Cache-Control"] = "no-store"
    identity = authenticated_claim_identity(conn, authorization, x_collection_key)
    identity = revalidate_locked_claim_identity(
        conn, identity, authorization, x_collection_key
    )
    reserve_claim_recommendation_capacity(conn, identity.account_id)
    registry = get_boundary_registry(settings.staging_field_places_enabled)
    now = datetime.now(timezone.utc)
    if payload.testFixtureId is not None:
        if not settings.claim_test_fixtures_enabled:
            raise claim_error(403, "claim_test_mode_disabled", "Claim test fixtures are disabled")
        place_id = CLAIM_TEST_FIXTURES.get(payload.testFixtureId)
        if place_id is None:
            raise claim_error(404, "claim_test_fixture_not_found", "Claim test fixture was not found")
        sample = registry.representative_sample(place_id, now)
    else:
        assert payload.location is not None
        try:
            sample = validate_location_sample(
                payload.location.latitude,
                payload.location.longitude,
                payload.location.accuracy_meters,
                payload.location.captured_at_epoch_ms,
                now,
            )
        except ClaimInputError as exc:
            raise claim_error(422, exc.code, str(exc)) from exc
    candidate = registry.recommend(sample, owner_visited_ids(conn, identity.account_id))
    if candidate is None:
        return {"status": "none"}
    if not conn.execute(
        f"SELECT 1 FROM places WHERE id = %s AND {place_visibility_clause()}",
        (
            candidate.place_id,
            *place_visibility_params(settings.staging_field_places_enabled),
        ),
    ).fetchone():
        raise claim_error(409, "claim_place_unavailable", "The recommended place is no longer available")
    identity = revalidate_locked_claim_identity(
        conn, identity, authorization, x_collection_key
    )
    reject_location_before_place_undo(
        conn,
        identity.account_id,
        candidate.place_id,
        sample.captured_at,
        error_code="claim_location_precedes_place_undo",
    )
    token, token_hash = create_recommendation_token()
    expires_at = sample.captured_at + timedelta(seconds=60)
    conn.execute(
        """
        DELETE FROM claim_recommendations
        WHERE token_hash IN (
            SELECT token_hash FROM claim_recommendations
            WHERE expires_at < NOW() - INTERVAL '1 hour'
            ORDER BY expires_at
            LIMIT 500
        )
        """
    )
    conn.execute(
        """
        INSERT INTO claim_recommendations (
            token_hash, account_id, session_hash, place_id, captured_at, latitude,
            longitude, accuracy_m, boundary_version, match_kind, distance_m, expires_at
        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        """,
        (
            token_hash, identity.account_id, identity.session_hash, candidate.place_id,
            sample.captured_at,
            round(sample.latitude, 5), round(sample.longitude, 5), sample.accuracy_meters,
            registry.version, candidate.match_kind, round(candidate.distance_meters, 3), expires_at,
        ),
    )
    conn.commit()
    return {
        "status": "recommended",
        "recommendation_token": token,
        "expires_at": expires_at,
        "candidate": {
            "place_id": candidate.place_id,
            "match_kind": candidate.match_kind,
            "distance_meters": round(candidate.distance_meters, 3),
        },
    }


@app.post(
    "/api/offline-claim-grants",
    response_model=OfflineClaimGrantResponse,
    status_code=201,
)
def create_offline_claim_grant(
    response: Response,
    conn: Connection = Depends(connection),
    authorization: str | None = Header(default=None),
):
    response.headers["Cache-Control"] = "no-store"
    identity = require_bearer(conn, authorization)
    identity = revalidate_locked_account_identity(conn, identity, authorization)
    reserve_rate_limit(
        conn,
        "offline_claim_grant_global",
        "global",
        OFFLINE_CLAIM_GRANT_GLOBAL_LIMIT,
        CLAIM_ABUSE_WINDOW,
    )
    reserve_rate_limit(
        conn,
        "offline_claim_grant",
        identity.account_id,
        OFFLINE_CLAIM_GRANT_ACCOUNT_LIMIT,
        timedelta(days=1),
    )
    conn.execute(
        "DELETE FROM offline_claim_grants "
        "WHERE account_id = %s AND (expires_at <= NOW() OR revoked_at IS NOT NULL)",
        (identity.account_id,),
    )
    registry = get_boundary_registry(settings.staging_field_places_enabled)
    issued_at = datetime.now(timezone.utc)
    expires_at = issued_at + OFFLINE_GRANT_VALIDITY
    grant_token, token_hash = create_offline_grant_token()
    conn.execute(
        """
        INSERT INTO offline_claim_grants (
            token_hash, account_id, boundary_version, issued_at, expires_at
        ) VALUES (%s, %s, %s, %s, %s)
        """,
        (
            token_hash,
            identity.account_id,
            registry.offline_version,
            issued_at,
            expires_at,
        ),
    )
    conn.commit()
    return {
        "grant_token": grant_token,
        "issued_at": issued_at,
        "expires_at": expires_at,
        "boundary_version": registry.offline_version,
    }


def reserve_offline_claim_capacity(conn: Connection, account_id: str) -> None:
    reserve_rate_limit(
        conn,
        "offline_claim_global",
        "global",
        OFFLINE_CLAIM_GLOBAL_LIMIT,
        CLAIM_ABUSE_WINDOW,
    )
    reserve_rate_limit(
        conn,
        "offline_claim",
        account_id,
        OFFLINE_CLAIM_ACCOUNT_LIMIT,
        CLAIM_ABUSE_WINDOW,
    )
    # Persist this reservation before the exact-geometry and claim writes.
    # The handler re-locks and revalidates account/session state afterward.
    conn.commit()


def reject_location_before_place_undo(
    conn: Connection,
    account_id: str,
    place_id: str,
    captured_at: datetime,
    *,
    error_code: str,
) -> None:
    tombstone = conn.execute(
        """
        SELECT undone_at FROM offline_claim_undo_tombstones
        WHERE account_id = %s AND place_id = %s
        """,
        (account_id, place_id),
    ).fetchone()
    if tombstone is not None and captured_at <= tombstone["undone_at"]:
        raise claim_error(
            410,
            error_code,
            "This saved location was captured before the place was removed",
        )


@app.post("/api/claims", response_model=CreateClaimResponse)
def create_claim(
    payload: CreateClaimRequest,
    response: Response,
    conn: Connection = Depends(connection),
    authorization: str | None = Header(default=None),
    x_collection_key: str | None = Header(default=None),
):
    response.headers["Cache-Control"] = "no-store"
    identity = authenticated_claim_identity(conn, authorization, x_collection_key)
    token_hash = recommendation_token_hash(payload.recommendationToken)
    if token_hash is None:
        raise claim_error(404, "claim_recommendation_not_found", "Claim recommendation was not found")
    identity = revalidate_locked_claim_identity(
        conn, identity, authorization, x_collection_key
    )
    recommendation = conn.execute(
        """
        SELECT * FROM claim_recommendations
        WHERE token_hash = %s
          AND account_id = %s
          AND session_hash = %s
        FOR UPDATE
        """,
        (token_hash, identity.account_id, identity.session_hash),
    ).fetchone()
    if recommendation is None:
        raise claim_error(404, "claim_recommendation_not_found", "Claim recommendation was not found")
    if recommendation["consumed_at"] is not None:
        raise claim_error(409, "claim_recommendation_replayed", "Claim recommendation has already been used")
    if recommendation["place_id"] != payload.expectedPlaceId:
        raise claim_error(409, "claim_recommendation_candidate_mismatch", "The expected place does not match this recommendation")
    if datetime.now(timezone.utc) > recommendation["expires_at"]:
        raise claim_error(410, "claim_recommendation_expired", "Location recommendation expired; check your location again")
    if not conn.execute(
        f"SELECT 1 FROM places WHERE id = %s AND {place_visibility_clause()}",
        (
            recommendation["place_id"],
            *place_visibility_params(settings.staging_field_places_enabled),
        ),
    ).fetchone():
        raise claim_error(409, "claim_place_unavailable", "The recommended place is no longer available")
    existing_claim = conn.execute(
        "SELECT 1 FROM account_visit_claims WHERE account_id = %s AND place_id = %s",
        (identity.account_id, recommendation["place_id"]),
    ).fetchone()
    if existing_claim:
        raise claim_error(409, "claim_place_already_claimed", "This place already has a location claim")
    conn.execute(
        "INSERT INTO account_visits (account_id, place_id) VALUES (%s, %s) ON CONFLICT DO NOTHING",
        (identity.account_id, recommendation["place_id"]),
    )
    conn.execute(
        """
        INSERT INTO account_visit_claims (
            account_id, place_id, recommendation_hash, captured_at, latitude,
            longitude, accuracy_m, boundary_version, match_kind, distance_m
        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        """,
        (identity.account_id, recommendation["place_id"], token_hash, recommendation["captured_at"],
         recommendation["latitude"], recommendation["longitude"], recommendation["accuracy_m"],
         recommendation["boundary_version"], recommendation["match_kind"], recommendation["distance_m"]),
    )
    conn.execute(
        "UPDATE claim_recommendations SET consumed_at = NOW() "
        "WHERE token_hash = %s AND account_id = %s AND session_hash = %s",
        (token_hash, identity.account_id, identity.session_hash),
    )
    created = fetch_claim(conn, identity.account_id, recommendation["place_id"])
    conn.commit()
    return claim_response_from_row(
        created,
        owner_visit_count(
            conn,
            identity.account_id,
            include_staging_field_places=settings.staging_field_places_enabled,
        ),
    )


@app.post("/api/offline-claims", response_model=CreateClaimResponse)
def create_offline_claim(
    payload: OfflineClaimRequest,
    response: Response,
    conn: Connection = Depends(connection),
    authorization: str | None = Header(default=None),
    x_collection_key: str | None = Header(default=None),
):
    response.headers["Cache-Control"] = "no-store"
    identity = authenticated_claim_identity(conn, authorization, x_collection_key)
    identity = revalidate_locked_claim_identity(
        conn, identity, authorization, x_collection_key
    )
    fingerprint = offline_request_fingerprint(
        grant_token=payload.grantToken,
        expected_place_id=payload.expectedPlaceId,
        latitude=payload.location.latitude,
        longitude=payload.location.longitude,
        accuracy_meters=payload.location.accuracy_meters,
        captured_at_epoch_ms=payload.location.captured_at_epoch_ms,
    )
    prior = conn.execute(
        """
        SELECT request_fingerprint, confirmation, invalidated_at
        FROM offline_claim_requests
        WHERE account_id = %s AND request_id = %s
        """,
        (identity.account_id, payload.requestId),
    ).fetchone()
    if prior is not None:
        if prior["request_fingerprint"] != fingerprint:
            raise claim_error(
                409,
                "offline_claim_request_id_conflict",
                "This request ID was already used for a different offline claim",
            )
        if prior["invalidated_at"] is not None:
            raise claim_error(
                410,
                "offline_claim_receipt_invalidated",
                "This offline claim receipt was invalidated after the visit was removed or account progress was reset",
            )
        return prior["confirmation"]

    token_hash = offline_grant_token_hash(payload.grantToken)
    if token_hash is None:
        raise claim_error(
            404,
            "offline_claim_grant_not_found",
            "Offline claim grant was not found",
        )
    grant = conn.execute(
        """
        SELECT account_id, boundary_version, issued_at, expires_at, revoked_at
        FROM offline_claim_grants
        WHERE token_hash = %s AND account_id = %s
        FOR UPDATE
        """,
        (token_hash, identity.account_id),
    ).fetchone()
    if grant is None:
        raise claim_error(
            404,
            "offline_claim_grant_not_found",
            "Offline claim grant was not found",
        )
    now = datetime.now(timezone.utc)
    if grant["revoked_at"] is not None:
        raise claim_error(
            410,
            "offline_claim_grant_revoked",
            "Offline claim grant has been revoked",
        )
    if now > grant["expires_at"]:
        raise claim_error(
            410,
            "offline_claim_grant_expired",
            "Offline claim grant has expired",
        )

    # The grant version scopes client-side offline recommendations. Deferred
    # claims remain eligible across registry updates, but must fit the current
    # canonical boundary below and are recorded against this current version.
    registry = get_boundary_registry(settings.staging_field_places_enabled)
    try:
        sample = validate_offline_location_sample(
            payload.location.latitude,
            payload.location.longitude,
            payload.location.accuracy_meters,
            payload.location.captured_at_epoch_ms,
            grant_issued_at=grant["issued_at"],
            grant_expires_at=grant["expires_at"],
            now=now,
        )
    except ClaimInputError as exc:
        raise claim_error(422, exc.code, str(exc)) from exc
    reject_location_before_place_undo(
        conn,
        identity.account_id,
        payload.expectedPlaceId,
        sample.captured_at,
        error_code="offline_claim_precedes_place_undo",
    )

    reserve_offline_claim_capacity(conn, identity.account_id)
    identity = revalidate_locked_claim_identity(
        conn, identity, authorization, x_collection_key
    )
    prior = conn.execute(
        """
        SELECT request_fingerprint, confirmation, invalidated_at
        FROM offline_claim_requests
        WHERE account_id = %s AND request_id = %s
        """,
        (identity.account_id, payload.requestId),
    ).fetchone()
    if prior is not None:
        if prior["request_fingerprint"] != fingerprint:
            raise claim_error(
                409,
                "offline_claim_request_id_conflict",
                "This request ID was already used for a different offline claim",
            )
        if prior["invalidated_at"] is not None:
            raise claim_error(
                410,
                "offline_claim_receipt_invalidated",
                "This offline claim receipt was invalidated after the visit was removed or account progress was reset",
            )
        return prior["confirmation"]

    grant = conn.execute(
        """
        SELECT account_id, boundary_version, issued_at, expires_at, revoked_at
        FROM offline_claim_grants
        WHERE token_hash = %s AND account_id = %s
        FOR UPDATE
        """,
        (token_hash, identity.account_id),
    ).fetchone()
    if grant is None:
        raise claim_error(
            404,
            "offline_claim_grant_not_found",
            "Offline claim grant was not found",
        )
    now = datetime.now(timezone.utc)
    if grant["revoked_at"] is not None:
        raise claim_error(
            410,
            "offline_claim_grant_revoked",
            "Offline claim grant has been revoked",
        )
    if now > grant["expires_at"]:
        raise claim_error(
            410,
            "offline_claim_grant_expired",
            "Offline claim grant has expired",
        )
    registry = get_boundary_registry(settings.staging_field_places_enabled)
    try:
        sample = validate_offline_location_sample(
            payload.location.latitude,
            payload.location.longitude,
            payload.location.accuracy_meters,
            payload.location.captured_at_epoch_ms,
            grant_issued_at=grant["issued_at"],
            grant_expires_at=grant["expires_at"],
            now=now,
        )
    except ClaimInputError as exc:
        raise claim_error(422, exc.code, str(exc)) from exc
    reject_location_before_place_undo(
        conn,
        identity.account_id,
        payload.expectedPlaceId,
        sample.captured_at,
        error_code="offline_claim_precedes_place_undo",
    )

    if not conn.execute(
        f"SELECT 1 FROM places WHERE id = %s AND {place_visibility_clause()}",
        (
            payload.expectedPlaceId,
            *place_visibility_params(settings.staging_field_places_enabled),
        ),
    ).fetchone():
        raise claim_error(
            409,
            "claim_place_unavailable",
            "The requested place is no longer available",
        )
    if not registry.contains_exact(
        payload.expectedPlaceId, sample.latitude, sample.longitude
    ):
        raise claim_error(
            422,
            "offline_location_outside_boundary",
            "The saved location is outside the requested place boundary",
        )
    existing_claim = conn.execute(
        "SELECT 1 FROM account_visit_claims WHERE account_id = %s AND place_id = %s",
        (identity.account_id, payload.expectedPlaceId),
    ).fetchone()
    if existing_claim:
        raise claim_error(
            409,
            "claim_place_already_claimed",
            "This place already has a location claim",
        )

    claim_key = hashlib.sha256(
        f"parkdex-offline-claim:{identity.account_id}:{payload.requestId}".encode(
            "ascii"
        )
    ).hexdigest()
    conn.execute(
        "INSERT INTO account_visits (account_id, place_id) VALUES (%s, %s) ON CONFLICT DO NOTHING",
        (identity.account_id, payload.expectedPlaceId),
    )
    conn.execute(
        """
        INSERT INTO account_visit_claims (
            account_id, place_id, recommendation_hash, captured_at, latitude,
            longitude, accuracy_m, boundary_version, match_kind, distance_m
        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 'exact', 0)
        """,
        (
            identity.account_id,
            payload.expectedPlaceId,
            claim_key,
            sample.captured_at,
            sample.latitude,
            sample.longitude,
            sample.accuracy_meters,
            registry.offline_version,
        ),
    )
    created = fetch_claim(conn, identity.account_id, payload.expectedPlaceId)
    confirmation = CreateClaimResponse.model_validate(
        claim_response_from_row(
            created,
            owner_visit_count(
                conn,
                identity.account_id,
                include_staging_field_places=settings.staging_field_places_enabled,
            ),
        )
    ).model_dump(mode="json")
    conn.execute(
        """
        INSERT INTO offline_claim_requests (
            account_id, request_id, request_fingerprint, confirmation
        ) VALUES (%s, %s, %s, %s::jsonb)
        """,
        (
            identity.account_id,
            payload.requestId,
            fingerprint,
            json.dumps(confirmation, separators=(",", ":")),
        ),
    )
    conn.commit()
    return confirmation


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
        f"SELECT 1 FROM places WHERE id = %s AND {place_visibility_clause()}",
        (
            place_id,
            *place_visibility_params(settings.staging_field_places_enabled),
        ),
    ).fetchone():
        raise HTTPException(status_code=404, detail="Place not found")
    photo_keys: list[str] = []
    if isinstance(identity, AccountIdentity):
        identity = revalidate_locked_claim_identity(
            conn, identity, authorization, x_collection_key
        )
        if payload.visited:
            existing_visit = conn.execute(
                "SELECT 1 FROM account_visits WHERE account_id = %s AND place_id = %s",
                (identity.account_id, place_id),
            ).fetchone()
            if not existing_visit and settings.visit_claim_enforcement == "required":
                raise claim_error(409, "location_claim_required", "A current location claim is required for a new visit")
            if not existing_visit:
                # Rollout bridge for the immediately previous account client.
                # Claim-aware clients prefer /api/claims because /api/places
                # advertises support even while this compatibility write is on.
                conn.execute(
                    """
                    INSERT INTO account_visits (account_id, place_id)
                    VALUES (%s, %s) ON CONFLICT DO NOTHING
                    """,
                    (identity.account_id, place_id),
                )
        else:
            photo_keys = [
                row["photo_object_key"]
                for row in conn.execute(
                    "SELECT photo_object_key FROM account_visit_claims "
                    "WHERE account_id = %s AND place_id = %s",
                    (identity.account_id, place_id),
                ).fetchall()
                if row["photo_object_key"]
            ]
            enqueue_photo_object_deletions(conn, identity.account_id, photo_keys)
            conn.execute(
                "DELETE FROM account_visits WHERE account_id = %s AND place_id = %s",
                (identity.account_id, place_id),
            )
            conn.execute(
                "DELETE FROM claim_recommendations "
                "WHERE account_id = %s AND place_id = %s AND consumed_at IS NULL",
                (identity.account_id, place_id),
            )
            conn.execute(
                """
                UPDATE offline_claim_requests SET invalidated_at = NOW()
                WHERE account_id = %s AND invalidated_at IS NULL
                  AND COALESCE(
                      confirmation->>'placeId', confirmation->>'place_id'
                  ) = %s
                """,
                (identity.account_id, place_id),
            )
            conn.execute(
                """
                INSERT INTO offline_claim_undo_tombstones (
                    account_id, place_id, undone_at
                ) VALUES (%s, %s, clock_timestamp())
                ON CONFLICT (account_id, place_id) DO UPDATE
                SET undone_at = GREATEST(
                    offline_claim_undo_tombstones.undone_at,
                    EXCLUDED.undone_at
                )
                """,
                (identity.account_id, place_id),
            )
        count = conn.execute(
            f"""
            SELECT COUNT(*) AS visited_count FROM account_visits
            JOIN places ON places.id = account_visits.place_id
                AND {place_visibility_clause()}
            WHERE account_visits.account_id = %s
            """,
            (
                *place_visibility_params(settings.staging_field_places_enabled),
                identity.account_id,
            ),
        ).fetchone()["visited_count"]
    else:
        if payload.visited:
            if not conn.execute(
                "SELECT 1 FROM visits WHERE owner_hash = %s AND place_id = %s",
                (identity, place_id),
            ).fetchone():
                raise claim_error(409, "location_claim_required", "A current location claim is required for a new visit")
        else:
            conn.execute(
                "DELETE FROM visits WHERE owner_hash = %s AND place_id = %s",
                (identity, place_id),
            )
        count = conn.execute(
            f"""
            SELECT COUNT(*) AS visited_count FROM visits
            JOIN places ON places.id = visits.place_id
                AND {place_visibility_clause()}
            WHERE visits.owner_hash = %s
            """,
            (
                *place_visibility_params(settings.staging_field_places_enabled),
                identity,
            ),
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
    if isinstance(identity, AccountIdentity):
        settle_photo_object_deletions(photo_keys, outcome_conn=conn)
    return {
        "place_id": place_id,
        "visited": payload.visited,
        "visited_count": count,
        "visited_at": visited_at,
    }


def claim_photo_row(
    conn: Connection,
    account_id: str,
    place_id: str,
    *,
    lock: bool = False,
    include_staging_field_places: bool = False,
):
    suffix = " FOR UPDATE" if lock else ""
    return conn.execute(
        f"""
        SELECT photo_object_key, photo_mime, photo_width, photo_height,
               photo_byte_length, photo_sha256, photo_updated_at
        FROM account_visit_claims
        JOIN places ON places.id = account_visit_claims.place_id
            AND {place_visibility_clause()}
        WHERE account_visit_claims.account_id = %s
          AND account_visit_claims.place_id = %s
        """ + suffix,
        (
            *place_visibility_params(include_staging_field_places),
            account_id,
            place_id,
        ),
    ).fetchone()


def make_photo_object_key() -> str:
    """Return a non-identifying, non-reusable private object key."""

    return f"postcards/{secrets.token_urlsafe(32)}.jpg"


@app.put("/api/visits/{place_id}/photo", response_model=VisitPhotoResult)
def put_visit_photo(
    place_id: str,
    photo: UploadFile = File(...),
    authorization: str | None = Header(default=None),
    x_collection_key: str | None = Header(default=None),
):
    # Authenticate before doing image work, then authenticate again in the update
    # transaction.  Collection keys are intentionally not accepted for photos.
    with contextmanager(connection)() as conn:
        identity = authenticated_claim_identity(conn, authorization, x_collection_key)
        identity = revalidate_locked_claim_identity(
            conn, identity, authorization, x_collection_key
        )
        reserve_photo_upload_capacity(conn, identity.account_id)
        if claim_photo_row(
            conn,
            identity.account_id,
            place_id,
            include_staging_field_places=settings.staging_field_places_enabled,
        ) is None:
            raise claim_error(404, "claim_not_found", "A location claim is required before adding a photo")
    try:
        storage = photo_storage()
    except ObjectStorageError as exc:
        raise photo_storage_error(exc) from exc
    # FastAPI runs synchronous handlers in its threadpool. Keeping the whole
    # transaction here ensures Pillow, sync psycopg, filesystem fsync, and R2
    # client calls never run on Uvicorn's event-loop thread.
    raw = photo.file.read(MAX_UPLOAD_BYTES + 1)
    try:
        normalized = normalize_photo(raw)
    except PhotoInputError as exc:
        raise claim_error(422, "invalid_claim_photo", str(exc)) from exc
    object_key = make_photo_object_key()
    try:
        storage.put(object_key, normalized.content, normalized.content_type)
    except Exception as exc:
        raise photo_storage_error(exc) from exc
    old_key: str | None = None
    try:
        with contextmanager(connection)() as conn:
            identity = revalidate_locked_claim_identity(
                conn, identity, authorization, x_collection_key
            )
            current = claim_photo_row(
                conn,
                identity.account_id,
                place_id,
                lock=True,
                include_staging_field_places=settings.staging_field_places_enabled,
            )
            if current is None:
                raise claim_error(
                    404,
                    "claim_not_found",
                    "The location claim was removed before the photo was saved",
                )
            old_key = current["photo_object_key"]
            row = conn.execute(
                """
                UPDATE account_visit_claims SET
                    photo_object_key = %s, photo_mime = %s, photo_width = %s,
                    photo_height = %s, photo_byte_length = %s, photo_sha256 = %s,
                    photo_updated_at = NOW(), photo_account_modified = TRUE
                WHERE account_id = %s AND place_id = %s
                RETURNING photo_object_key, photo_mime, photo_width, photo_height,
                          photo_byte_length, photo_sha256, photo_updated_at
                """,
                (
                    object_key,
                    normalized.content_type,
                    normalized.width,
                    normalized.height,
                    len(normalized.content),
                    normalized.sha256_hex,
                    identity.account_id,
                    place_id,
                ),
            ).fetchone()
            if row is None:
                raise claim_error(404, "claim_not_found", "Location claim was not found")
            if old_key and old_key != object_key:
                enqueue_photo_object_deletions(
                    conn, identity.account_id, [old_key]
                )
            conn.commit()
    except Exception:
        # The object must not survive a failed DB write or a concurrent undo.
        persist_failed_upload_cleanup(identity.account_id, object_key)
        raise
    if old_key and old_key != object_key:
        settle_photo_object_deletions([old_key])
    return {
        "place_id": place_id,
        "photo": {
            "content_type": row["photo_mime"],
            "width": row["photo_width"],
            "height": row["photo_height"],
            "byte_length": row["photo_byte_length"],
            "sha256": row["photo_sha256"],
            "updated_at": row["photo_updated_at"],
        },
    }


@app.get("/api/visits/{place_id}/photo")
def get_visit_photo(
    place_id: str,
    authorization: str | None = Header(default=None),
    x_collection_key: str | None = Header(default=None),
) -> Response:
    with contextmanager(connection)() as conn:
        identity = authenticated_claim_identity(conn, authorization, x_collection_key)
        row = claim_photo_row(
            conn,
            identity.account_id,
            place_id,
            include_staging_field_places=settings.staging_field_places_enabled,
        )
        if row is None or row["photo_object_key"] is None:
            raise claim_error(404, "claim_photo_not_found", "Claim photo was not found")
        object_key = row["photo_object_key"]
        content_type = row["photo_mime"]
    try:
        content = photo_storage().get(object_key)
    except ObjectStorageNotFound as exc:
        raise claim_error(404, "claim_photo_not_found", "Claim photo was not found") from exc
    except ObjectStorageError as exc:
        raise photo_storage_error(exc) from exc
    return Response(
        content=content,
        media_type=content_type,
        headers={"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"},
    )


@app.delete("/api/visits/{place_id}/photo", status_code=204)
def delete_visit_photo(
    place_id: str,
    authorization: str | None = Header(default=None),
    x_collection_key: str | None = Header(default=None),
) -> Response:
    with contextmanager(connection)() as conn:
        identity = authenticated_claim_identity(conn, authorization, x_collection_key)
        identity = revalidate_locked_claim_identity(
            conn, identity, authorization, x_collection_key
        )
        row = claim_photo_row(
            conn,
            identity.account_id,
            place_id,
            lock=True,
            include_staging_field_places=settings.staging_field_places_enabled,
        )
        if row is None:
            raise claim_error(404, "claim_not_found", "Location claim was not found")
        object_key = row["photo_object_key"]
        if object_key is None:
            raise claim_error(404, "claim_photo_not_found", "Claim photo was not found")
        conn.execute(
            """
            UPDATE account_visit_claims SET photo_object_key = NULL,
                photo_mime = NULL, photo_width = NULL, photo_height = NULL,
                photo_byte_length = NULL, photo_sha256 = NULL,
                photo_updated_at = NULL, photo_account_modified = TRUE
            WHERE account_id = %s AND place_id = %s
            """,
            (identity.account_id, place_id),
        )
        enqueue_photo_object_deletions(
            conn, identity.account_id, [object_key]
        )
        conn.commit()
    settle_photo_object_deletions([object_key])
    return Response(status_code=204)


@app.put("/api/trails/{trail_id}", response_model=TrailResult)
def update_trail(trail_id: str, payload: TrailUpdate, conn: Connection = Depends(connection), authorization: str | None = Header(default=None), x_collection_key: str | None = Header(default=None)):
    if trail_id not in TRAIL_IDS:
        raise HTTPException(status_code=404, detail="Trail not found")
    identity = resolve_identity(conn, authorization, x_collection_key, required=True)
    if isinstance(identity, AccountIdentity):
        identity = revalidate_locked_account_identity(conn, identity, authorization)
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
        if email_delivery_configured(settings):
            verification_token, _ = create_action_token(conn, str(account["id"]), "email_verification")
        record_security_event(conn, "registration", email, "created")
        conn.commit()
    if verification_token:
        try:
            verification = verification_email(auth_link(f"verificationToken={verification_token}"))
            send_auth_email(settings, email, verification.subject, verification.text, verification.html)
        except Exception as exc:
            logger.error("Registration verification email delivery failed (%s)", type(exc).__name__)
    return {
        "token": token,
        "expires_at": expires_at,
        "account": {"id": str(account["id"]), "email": account["email"], "email_verified": False, "has_password": True},
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
        visits = visits_for_account(
            conn,
            str(account["id"]),
            include_staging_field_places=settings.staging_field_places_enabled,
        )
        completed_trail_ids = completed_trails_for_account(conn, str(account["id"]))
        conn.commit()
    return {
        "token": token,
        "expires_at": expires_at,
        "account": {"id": str(account["id"]), "email": account["email"], "email_verified": account["email_verified"], "has_password": bool(account["password_hash"])},
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
    # Wait for any in-flight account mutation, then re-check this session while
    # holding the same lock. Mutations that authenticated before logout must
    # subsequently observe the revocation before they can commit.
    identity = revalidate_locked_account_identity(conn, identity, authorization)
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
        reset = password_reset_email(auth_link(f"resetToken={token}"))
        background_tasks.add_task(deliver_auth_email, email, reset, "password_reset_email")
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
        conn.execute("UPDATE offline_claim_grants SET revoked_at = NOW() WHERE account_id = %s AND revoked_at IS NULL", (row["account_id"],))
        conn.execute("UPDATE mcp_oauth_authorization_codes SET used_at = NOW() WHERE account_id = %s AND used_at IS NULL", (row["account_id"],))
        conn.execute("UPDATE mcp_oauth_tokens SET revoked_at = NOW() WHERE account_id = %s AND revoked_at IS NULL", (row["account_id"],))
        record_security_event(conn, "password_reset_completed", str(row["account_id"]), "success")
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
        identity = revalidate_locked_account_identity(conn, identity, authorization)
        reserve_rate_limit(conn, "email_verification", identity.account_id, 3, timedelta(minutes=15))
        if identity.email_verified:
            conn.commit()
            return {"detail": "Email is already verified."}
        token, _ = create_action_token(conn, identity.account_id, "email_verification")
        conn.commit()
    try:
        verification = verification_email(auth_link(f"verificationToken={token}"))
        send_auth_email(settings, identity.email, verification.subject, verification.text, verification.html)
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
                    conn.execute("UPDATE mcp_oauth_authorization_codes SET used_at = NOW() WHERE account_id = %s AND used_at IS NULL", (account["id"],))
                    conn.execute("UPDATE mcp_oauth_tokens SET revoked_at = NOW() WHERE account_id = %s AND revoked_at IS NULL", (account["id"],))
                    conn.execute("UPDATE account_action_tokens SET used_at = NOW() WHERE account_id = %s AND used_at IS NULL", (account["id"],))
                else:
                    conn.execute("UPDATE accounts SET email_verified_at = COALESCE(email_verified_at, NOW()) WHERE id = %s", (account["id"],))
            else:
                account = conn.execute("INSERT INTO accounts (email, password_hash, email_verified_at) VALUES (%s, NULL, NOW()) RETURNING id, email", (canonical_email,)).fetchone()
            conn.execute("INSERT INTO account_oauth_identities (provider, subject, account_id, email_at_link) VALUES ('google', %s, %s, %s)", (subject, account["id"], canonical_email))
        token, expires_at = create_session(conn, str(account["id"]))
        visits = visits_for_account(
            conn,
            str(account["id"]),
            include_staging_field_places=settings.staging_field_places_enabled,
        )
        trails = completed_trails_for_account(conn, str(account["id"]))
        record_security_event(conn, "google_sign_in", str(account["id"]), "success")
        conn.commit()
    with contextmanager(connection)() as conn:
        account = conn.execute("SELECT id, email, password_hash FROM accounts WHERE id = %s", (account["id"],)).fetchone()
    return {"token": token, "expires_at": expires_at, "account": {"id": str(account["id"]), "email": account["email"], "email_verified": True, "has_password": bool(account.get("password_hash"))}, "visited_ids": visited_ids(visits), "visits": visits, "completed_trail_ids": trails}


@app.delete("/api/account", response_model=AccountDeletionResult)
def delete_account(
    payload: AccountDeletionRequest,
    conn: Connection = Depends(connection),
    authorization: str | None = Header(default=None),
) -> dict[str, object]:
    """Delete the authenticated account and retain only a retry receipt.

    The receipt lookup happens before bearer validation so a client can safely
    retry an otherwise successful delete after losing its response.  It is
    keyed by a one-way combination of the exact bearer and request id, so a
    different or malformed bearer still receives the normal authentication
    error.
    """

    purged = purge_expired_account_deletion_receipts(conn)
    if purged:
        conn.commit()

    request_hash = account_deletion_receipt_hash(authorization, payload.request_id)
    receipt = account_deletion_receipt(conn, request_hash)
    if receipt is not None:
        return account_deletion_result(
            photo_cleanup_pending=bool(receipt["photo_cleanup_pending"])
        )

    identity = require_bearer(conn, authorization)
    try:
        identity = revalidate_locked_account_identity(conn, identity, authorization)
    except HTTPException:
        # A concurrent delete can revoke the session before this request
        # reaches the account lock.  Only the exact private receipt can turn
        # that lost-response race into a successful retry.
        receipt = account_deletion_receipt(conn, request_hash)
        if receipt is not None:
            return account_deletion_result(
                photo_cleanup_pending=bool(receipt["photo_cleanup_pending"])
            )
        raise

    # Recheck after waiting for the account lock in case another request
    # committed a receipt while this request was queued.
    receipt = account_deletion_receipt(conn, request_hash)
    if receipt is not None:
        return account_deletion_result(
            photo_cleanup_pending=bool(receipt["photo_cleanup_pending"])
        )

    try:
        deleted = delete_account_rows(
            conn,
            identity.account_id,
            request_hash=request_hash,
        )
    except LookupError:
        # The account lock/revalidation normally makes this unreachable.  If a
        # database failover races the request, preserve the idempotent retry
        # behavior when the committed receipt is available.
        conn.rollback()
        receipt = account_deletion_receipt(conn, request_hash)
        if receipt is not None:
            return account_deletion_result(
                photo_cleanup_pending=bool(receipt["photo_cleanup_pending"])
            )
        raise HTTPException(status_code=401, detail="Authentication required")

    conn.commit()
    photo_cleanup_pending = bool(deleted.photo_keys)
    if deleted.photo_keys:
        try:
            settle_photo_object_deletions(list(deleted.photo_keys), outcome_conn=conn)
            remaining = conn.execute(
                """
                SELECT COUNT(*) AS count
                FROM photo_object_deletions
                WHERE object_key = ANY(%s)
                """,
                (list(deleted.photo_keys),),
            ).fetchone()
            photo_cleanup_pending = bool(remaining and remaining["count"])
            update_account_deletion_receipt(
                conn,
                request_hash,
                photo_cleanup_pending=photo_cleanup_pending,
            )
            conn.commit()
        except Exception as exc:
            # The database deletion and outbox commit already succeeded.  Keep
            # the conservative pending state if immediate object cleanup or
            # receipt refinement cannot complete in this request.
            logger.warning(
                "Could not finalize account deletion photo state (%s)",
                type(exc).__name__,
            )
            try:
                conn.rollback()
            except Exception:
                pass
            photo_cleanup_pending = True

    return account_deletion_result(photo_cleanup_pending=photo_cleanup_pending)


@app.delete("/api/account/progress", status_code=204)
def reset_account_progress(
    conn: Connection = Depends(connection),
    authorization: str | None = Header(default=None),
) -> Response:
    identity = require_bearer(conn, authorization)
    # Serialize the reset with imports and progress writes for this account.
    identity = revalidate_locked_account_identity(conn, identity, authorization)
    photo_keys = [
        row["photo_object_key"]
        for row in conn.execute(
            "SELECT photo_object_key FROM account_visit_claims "
            "WHERE account_id = %s AND photo_object_key IS NOT NULL",
            (identity.account_id,),
        ).fetchall()
    ]
    enqueue_photo_object_deletions(conn, identity.account_id, photo_keys)
    conn.execute(
        "DELETE FROM claim_recommendations WHERE account_id = %s",
        (identity.account_id,),
    )
    conn.execute(
        "UPDATE offline_claim_grants SET revoked_at = NOW() "
        "WHERE account_id = %s AND revoked_at IS NULL",
        (identity.account_id,),
    )
    conn.execute(
        "UPDATE offline_claim_requests SET invalidated_at = NOW() "
        "WHERE account_id = %s AND invalidated_at IS NULL",
        (identity.account_id,),
    )
    conn.execute(
        "DELETE FROM account_visits WHERE account_id = %s", (identity.account_id,)
    )
    conn.execute(
        "DELETE FROM account_trail_completions WHERE account_id = %s",
        (identity.account_id,),
    )
    # Groups are progress too. Deleting the account-owned rows clears all memberships
    # through the foreign key, then recreates the protected singleton in this transaction.
    conn.execute("DELETE FROM account_groups WHERE account_id = %s", (identity.account_id,))
    ensure_wishlist(conn, identity.account_id)
    conn.commit()
    settle_photo_object_deletions(photo_keys, outcome_conn=conn)
    return Response(status_code=204)


@app.post("/api/account/import-guest", response_model=GuestImportResult)
def import_guest_progress(
    conn: Connection = Depends(connection),
    authorization: str | None = Header(default=None),
    x_collection_key: str | None = Header(default=None),
):
    identity = require_bearer(conn, authorization)
    owner_hash = collection_hash(x_collection_key, required=True)
    identity = revalidate_locked_account_identity(conn, identity, authorization)
    imported_visits = conn.execute(
        f"""
        INSERT INTO account_visits (account_id, place_id, visited_at)
        SELECT %s, visits.place_id, visits.visited_at
        FROM visits
        JOIN places ON places.id = visits.place_id
            AND {place_visibility_clause()}
        WHERE owner_hash = %s
        ON CONFLICT DO NOTHING
        """,
        (
            identity.account_id,
            *place_visibility_params(settings.staging_field_places_enabled),
            owner_hash,
        ),
    ).rowcount
    conn.execute(
        f"""
        UPDATE account_visits AS destination
        SET visited_at = LEAST(destination.visited_at, source.visited_at)
        FROM visits AS source
        JOIN places ON places.id = source.place_id
            AND {place_visibility_clause()}
        WHERE destination.account_id = %s
          AND source.owner_hash = %s
          AND destination.place_id = source.place_id
        """,
        (
            *place_visibility_params(settings.staging_field_places_enabled),
            identity.account_id,
            owner_hash,
        ),
    )
    imported_trails = conn.execute(
        """
        INSERT INTO account_trail_completions (account_id, trail_id, completed_at)
        SELECT %s, trail_id, completed_at FROM guest_trail_completions WHERE owner_hash = %s
        ON CONFLICT DO NOTHING
        """,
        (identity.account_id, owner_hash),
    ).rowcount
    visits = visits_for_account(
        conn,
        identity.account_id,
        include_staging_field_places=settings.staging_field_places_enabled,
    )
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

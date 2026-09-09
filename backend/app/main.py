from contextlib import asynccontextmanager, contextmanager
import hashlib
import logging
import re
import secrets
from datetime import datetime, timedelta, timezone

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
from backend.app.db import close_pool, connection, open_pool
from backend.app.claim_photos import MAX_UPLOAD_BYTES, PhotoInputError, normalize_photo
from backend.app.claims import (
    ClaimInputError,
    LocationSample,
    create_recommendation_token,
    get_boundary_registry,
    recommendation_token_hash,
    validate_location_sample,
)
from backend.app.email_delivery import ensure_email_delivery, send_auth_email
from backend.app.google_oauth import authorization_url, exchange_and_verify
from backend.app.schemas import (
    AccountState,
    AuthResult,
    ClaimRecommendationRequest,
    ClaimRecommendationResponse,
    CreateClaimRequest,
    CreateClaimResponse,
    Credentials,
    EmailRequest,
    GoogleCallback,
    GoogleStart,
    GuestImportResult,
    PlaceCollection,
    PasswordChange,
    PasswordResetConfirmation,
    TrailResult,
    TrailUpdate,
    TokenConfirmation,
    VisitResult,
    VisitPhotoResult,
    VisitUpdate,
)
from backend.app.settings import get_settings

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
            "has_photo": row["photo_bytes"] is not None,
        }
    return {"place_id": row["place_id"], "visited_at": row["visited_at"], "claim": claim}


def visits_for_account(conn: Connection, account_id: str) -> list[dict]:
    return [
        visit_from_row(row)
        for row in conn.execute(
            """
            SELECT account_visits.place_id, account_visits.visited_at,
                   account_visit_claims.claimed_at, account_visit_claims.captured_at,
                   account_visit_claims.latitude AS claim_latitude,
                   account_visit_claims.longitude AS claim_longitude,
                   account_visit_claims.accuracy_m, account_visit_claims.boundary_version,
                   account_visit_claims.match_kind, account_visit_claims.distance_m,
                   account_visit_claims.photo_bytes
            FROM account_visits
            JOIN places ON places.id = account_visits.place_id AND places.active
            LEFT JOIN account_visit_claims USING (account_id, place_id)
            WHERE account_visits.account_id = %s ORDER BY account_visits.visited_at, account_visits.place_id
            """,
            (account_id,),
        ).fetchall()
    ]


def visited_ids(visits: list[dict]) -> list[str]:
    return [visit["place_id"] for visit in visits]


def visits_for_guest(conn: Connection, owner_hash: str) -> list[dict]:
    return [
        visit_from_row(row)
        for row in conn.execute(
            """
            SELECT visits.place_id, visits.visited_at,
                   guest_visit_claims.claimed_at, guest_visit_claims.captured_at,
                   guest_visit_claims.latitude AS claim_latitude,
                   guest_visit_claims.longitude AS claim_longitude,
                   guest_visit_claims.accuracy_m, guest_visit_claims.boundary_version,
                   guest_visit_claims.match_kind, guest_visit_claims.distance_m,
                   guest_visit_claims.photo_bytes
            FROM visits
            JOIN places ON places.id = visits.place_id AND places.active
            LEFT JOIN guest_visit_claims USING (owner_hash, place_id)
            WHERE visits.owner_hash = %s ORDER BY visits.visited_at, visits.place_id
            """,
            (owner_hash,),
        ).fetchall()
    ]


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


@asynccontextmanager
async def lifespan(_: FastAPI):
    registry = get_boundary_registry()
    open_pool()
    try:
        with contextmanager(connection)() as conn:
            active_ids = {row["id"] for row in conn.execute(
                "SELECT id FROM places WHERE active AND id = ANY(%s)", (list(registry.place_ids),)
            ).fetchall()}
            missing = registry.place_ids - active_ids
            if missing:
                raise RuntimeError(f"Canonical claim boundaries reference inactive or missing places: {sorted(missing)[:5]}")
        yield
    finally:
        close_pool()


settings = get_settings()
logger = logging.getLogger(__name__)


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
        "migrations": migration_count["migration_count"],
        "boundaryVersion": get_boundary_registry().version,
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
        visits = visits_for_guest(conn, identity)
        completed_trail_ids = [row["trail_id"] for row in conn.execute("SELECT trail_id FROM guest_trail_completions WHERE owner_hash = %s ORDER BY trail_id", (identity,)).fetchall()]
    return {
        "places": places,
        "visited_ids": visited_ids(visits),
        "visits": visits,
        "completed_trail_ids": completed_trail_ids,
        "coverage_note": COVERAGE_NOTE,
    }


CLAIM_TEST_FIXTURES = {
    "inside-goldstream": "provincial-goldstream-park",
    "inside-saltspring": "island-saltspring-island",
}


def claim_error(status_code: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status_code, detail={"code": code, "message": message})


def identity_columns(identity: AccountIdentity | str) -> tuple[str | None, str | None]:
    return (identity.account_id, None) if isinstance(identity, AccountIdentity) else (None, identity)


def owner_visited_ids(conn: Connection, identity: AccountIdentity | str) -> list[str]:
    if isinstance(identity, AccountIdentity):
        rows = conn.execute("SELECT place_id FROM account_visits WHERE account_id = %s", (identity.account_id,)).fetchall()
    else:
        rows = conn.execute("SELECT place_id FROM visits WHERE owner_hash = %s", (identity,)).fetchall()
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
            "has_photo": row["photo_bytes"] is not None,
        },
    }


def fetch_claim_by_recommendation(conn: Connection, identity: AccountIdentity | str, token_hash: str):
    if isinstance(identity, AccountIdentity):
        return conn.execute(
            """
            SELECT account_visits.place_id, account_visits.visited_at,
                   account_visit_claims.claimed_at, account_visit_claims.captured_at,
                   account_visit_claims.latitude, account_visit_claims.longitude,
                   account_visit_claims.accuracy_m, account_visit_claims.boundary_version,
                   account_visit_claims.match_kind, account_visit_claims.distance_m,
                   account_visit_claims.photo_bytes
            FROM account_visit_claims
            JOIN account_visits USING (account_id, place_id)
            WHERE account_visit_claims.account_id = %s AND recommendation_hash = %s
            """,
            (identity.account_id, token_hash),
        ).fetchone()
    return conn.execute(
        """
        SELECT visits.place_id, visits.visited_at,
               guest_visit_claims.claimed_at, guest_visit_claims.captured_at,
               guest_visit_claims.latitude, guest_visit_claims.longitude,
               guest_visit_claims.accuracy_m, guest_visit_claims.boundary_version,
               guest_visit_claims.match_kind, guest_visit_claims.distance_m,
               guest_visit_claims.photo_bytes
        FROM guest_visit_claims
        JOIN visits USING (owner_hash, place_id)
        WHERE guest_visit_claims.owner_hash = %s AND recommendation_hash = %s
        """,
        (identity, token_hash),
    ).fetchone()


def owner_visit_count(conn: Connection, identity: AccountIdentity | str) -> int:
    if isinstance(identity, AccountIdentity):
        return conn.execute(
            """SELECT COUNT(*) AS count FROM account_visits JOIN places ON places.id = account_visits.place_id AND places.active WHERE account_id = %s""",
            (identity.account_id,),
        ).fetchone()["count"]
    return conn.execute(
        """SELECT COUNT(*) AS count FROM visits JOIN places ON places.id = visits.place_id AND places.active WHERE owner_hash = %s""",
        (identity,),
    ).fetchone()["count"]


@app.post("/api/claim-recommendations", response_model=ClaimRecommendationResponse, response_model_exclude_none=True)
def recommend_claim(
    payload: ClaimRecommendationRequest,
    response: Response,
    conn: Connection = Depends(connection),
    authorization: str | None = Header(default=None),
    x_collection_key: str | None = Header(default=None),
):
    response.headers["Cache-Control"] = "no-store"
    identity = resolve_identity(conn, authorization, x_collection_key, required=True)
    registry = get_boundary_registry()
    now = datetime.now(timezone.utc)
    if payload.testFixtureId is not None:
        if not settings.claim_test_mode or settings.app_environment == "production":
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
    candidate = registry.recommend(sample, owner_visited_ids(conn, identity))
    if candidate is None:
        return {"status": "none"}
    if not conn.execute("SELECT 1 FROM places WHERE id = %s AND active", (candidate.place_id,)).fetchone():
        raise claim_error(409, "claim_place_unavailable", "The recommended place is no longer available")
    token, token_hash = create_recommendation_token()
    account_id, owner_hash = identity_columns(identity)
    expires_at = sample.captured_at + timedelta(seconds=60)
    conn.execute("DELETE FROM claim_recommendations WHERE expires_at < NOW() - INTERVAL '1 hour'")
    conn.execute(
        """
        INSERT INTO claim_recommendations (
            token_hash, account_id, owner_hash, place_id, captured_at, latitude,
            longitude, accuracy_m, boundary_version, match_kind, distance_m, expires_at
        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        """,
        (
            token_hash, account_id, owner_hash, candidate.place_id, sample.captured_at,
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


@app.post("/api/claims", response_model=CreateClaimResponse)
def create_claim(
    payload: CreateClaimRequest,
    response: Response,
    conn: Connection = Depends(connection),
    authorization: str | None = Header(default=None),
    x_collection_key: str | None = Header(default=None),
):
    response.headers["Cache-Control"] = "no-store"
    identity = resolve_identity(conn, authorization, x_collection_key, required=True)
    token_hash = recommendation_token_hash(payload.recommendationToken)
    if token_hash is None:
        raise claim_error(404, "claim_recommendation_not_found", "Claim recommendation was not found")
    if isinstance(identity, AccountIdentity):
        lock_account_progress(conn, identity.account_id)
    account_id, owner_hash = identity_columns(identity)
    existing = fetch_claim_by_recommendation(conn, identity, token_hash)
    if existing is not None:
        return claim_response_from_row(existing, owner_visit_count(conn, identity))
    recommendation = conn.execute(
        """
        SELECT * FROM claim_recommendations
        WHERE token_hash = %s
          AND account_id IS NOT DISTINCT FROM %s
          AND owner_hash IS NOT DISTINCT FROM %s
        FOR UPDATE
        """,
        (token_hash, account_id, owner_hash),
    ).fetchone()
    if recommendation is None:
        existing = fetch_claim_by_recommendation(conn, identity, token_hash)
        if existing is not None:
            return claim_response_from_row(existing, owner_visit_count(conn, identity))
        raise claim_error(404, "claim_recommendation_not_found", "Claim recommendation was not found")
    if recommendation["place_id"] != payload.expectedPlaceId:
        raise claim_error(409, "claim_recommendation_candidate_mismatch", "The expected place does not match this recommendation")
    if datetime.now(timezone.utc) > recommendation["expires_at"]:
        raise claim_error(410, "claim_recommendation_expired", "Location recommendation expired; check your location again")
    if not conn.execute("SELECT 1 FROM places WHERE id = %s AND active", (recommendation["place_id"],)).fetchone():
        raise claim_error(409, "claim_place_unavailable", "The recommended place is no longer available")
    if isinstance(identity, AccountIdentity):
        conn.execute(
            "INSERT INTO account_visits (account_id, place_id) VALUES (%s, %s) ON CONFLICT DO NOTHING",
            (identity.account_id, recommendation["place_id"]),
        )
        existing_claim = conn.execute(
            "SELECT 1 FROM account_visit_claims WHERE account_id = %s AND place_id = %s",
            (identity.account_id, recommendation["place_id"]),
        ).fetchone()
        if existing_claim:
            raise claim_error(409, "claim_place_already_claimed", "This place already has a location claim")
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
    else:
        # Distinct valid recommendation tokens can target the same guest/place.
        # Serialize that pair so the loser receives the controlled existing-claim
        # response instead of surfacing the child table's unique constraint.
        conn.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))",
            (f"guest-claim:{identity}:{recommendation['place_id']}",),
        )
        conn.execute(
            "INSERT INTO visits (owner_hash, place_id) VALUES (%s, %s) ON CONFLICT DO NOTHING",
            (identity, recommendation["place_id"]),
        )
        existing_claim = conn.execute(
            "SELECT 1 FROM guest_visit_claims WHERE owner_hash = %s AND place_id = %s",
            (identity, recommendation["place_id"]),
        ).fetchone()
        if existing_claim:
            raise claim_error(409, "claim_place_already_claimed", "This place already has a location claim")
        conn.execute(
            """
            INSERT INTO guest_visit_claims (
                owner_hash, place_id, recommendation_hash, captured_at, latitude,
                longitude, accuracy_m, boundary_version, match_kind, distance_m
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (identity, recommendation["place_id"], token_hash, recommendation["captured_at"],
             recommendation["latitude"], recommendation["longitude"], recommendation["accuracy_m"],
             recommendation["boundary_version"], recommendation["match_kind"], recommendation["distance_m"]),
        )
    created = fetch_claim_by_recommendation(conn, identity, token_hash)
    conn.execute("DELETE FROM claim_recommendations WHERE token_hash = %s", (token_hash,))
    conn.commit()
    return claim_response_from_row(created, owner_visit_count(conn, identity))


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
            if not conn.execute(
                "SELECT 1 FROM account_visits WHERE account_id = %s AND place_id = %s",
                (identity.account_id, place_id),
            ).fetchone():
                raise claim_error(409, "location_claim_required", "A current location claim is required for a new visit")
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


def claim_photo_row(conn: Connection, identity: AccountIdentity | str, place_id: str, *, lock: bool = False):
    suffix = " FOR UPDATE" if lock else ""
    if isinstance(identity, AccountIdentity):
        return conn.execute(
            """
            SELECT photo_bytes, photo_mime, photo_width, photo_height, photo_sha256, photo_updated_at
            FROM account_visit_claims WHERE account_id = %s AND place_id = %s
            """ + suffix,
            (identity.account_id, place_id),
        ).fetchone()
    return conn.execute(
        """
        SELECT photo_bytes, photo_mime, photo_width, photo_height, photo_sha256, photo_updated_at
        FROM guest_visit_claims WHERE owner_hash = %s AND place_id = %s
        """ + suffix,
        (identity, place_id),
    ).fetchone()


@app.put("/api/visits/{place_id}/photo", response_model=VisitPhotoResult)
async def put_visit_photo(
    place_id: str,
    photo: UploadFile = File(...),
    authorization: str | None = Header(default=None),
    x_collection_key: str | None = Header(default=None),
):
    # Authenticate before doing image work, then authenticate again in the update transaction.
    with contextmanager(connection)() as conn:
        identity = resolve_identity(conn, authorization, x_collection_key, required=True)
        if claim_photo_row(conn, identity, place_id) is None:
            raise claim_error(404, "claim_not_found", "A location claim is required before adding a photo")
    raw = await photo.read(MAX_UPLOAD_BYTES + 1)
    try:
        normalized = normalize_photo(raw)
    except PhotoInputError as exc:
        raise claim_error(422, "invalid_claim_photo", str(exc)) from exc
    with contextmanager(connection)() as conn:
        identity = resolve_identity(conn, authorization, x_collection_key, required=True)
        if isinstance(identity, AccountIdentity):
            lock_account_progress(conn, identity.account_id)
        if claim_photo_row(conn, identity, place_id, lock=True) is None:
            raise claim_error(404, "claim_not_found", "The location claim was removed before the photo was saved")
        if isinstance(identity, AccountIdentity):
            row = conn.execute(
                """
                UPDATE account_visit_claims SET
                    photo_bytes = %s, photo_mime = %s, photo_width = %s, photo_height = %s,
                    photo_sha256 = %s, photo_updated_at = NOW(), photo_account_modified = TRUE
                WHERE account_id = %s AND place_id = %s
                RETURNING photo_mime, photo_width, photo_height, OCTET_LENGTH(photo_bytes) AS byte_length,
                          photo_sha256, photo_updated_at
                """,
                (normalized.content, normalized.content_type, normalized.width, normalized.height,
                 normalized.sha256_hex, identity.account_id, place_id),
            ).fetchone()
        else:
            row = conn.execute(
                """
                UPDATE guest_visit_claims SET
                    photo_bytes = %s, photo_mime = %s, photo_width = %s, photo_height = %s,
                    photo_sha256 = %s, photo_updated_at = NOW()
                WHERE owner_hash = %s AND place_id = %s
                RETURNING photo_mime, photo_width, photo_height, OCTET_LENGTH(photo_bytes) AS byte_length,
                          photo_sha256, photo_updated_at
                """,
                (normalized.content, normalized.content_type, normalized.width, normalized.height,
                 normalized.sha256_hex, identity, place_id),
            ).fetchone()
        conn.commit()
    return {
        "place_id": place_id,
        "photo": {
            "content_type": row["photo_mime"], "width": row["photo_width"], "height": row["photo_height"],
            "byte_length": row["byte_length"], "sha256": row["photo_sha256"], "updated_at": row["photo_updated_at"],
        },
    }


@app.get("/api/visits/{place_id}/photo")
def get_visit_photo(
    place_id: str,
    conn: Connection = Depends(connection),
    authorization: str | None = Header(default=None),
    x_collection_key: str | None = Header(default=None),
) -> Response:
    identity = resolve_identity(conn, authorization, x_collection_key, required=True)
    row = claim_photo_row(conn, identity, place_id)
    if row is None or row["photo_bytes"] is None:
        raise claim_error(404, "claim_photo_not_found", "Claim photo was not found")
    return Response(
        content=bytes(row["photo_bytes"]),
        media_type=row["photo_mime"],
        headers={"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"},
    )


@app.delete("/api/visits/{place_id}/photo", status_code=204)
def delete_visit_photo(
    place_id: str,
    conn: Connection = Depends(connection),
    authorization: str | None = Header(default=None),
    x_collection_key: str | None = Header(default=None),
) -> Response:
    identity = resolve_identity(conn, authorization, x_collection_key, required=True)
    if isinstance(identity, AccountIdentity):
        lock_account_progress(conn, identity.account_id)
        row = conn.execute(
            """
            UPDATE account_visit_claims SET photo_bytes = NULL, photo_mime = NULL,
                photo_width = NULL, photo_height = NULL, photo_sha256 = NULL,
                photo_updated_at = NOW(), photo_account_modified = TRUE
            WHERE account_id = %s AND place_id = %s RETURNING 1
            """,
            (identity.account_id, place_id),
        ).fetchone()
    else:
        row = conn.execute(
            """
            UPDATE guest_visit_claims SET photo_bytes = NULL, photo_mime = NULL,
                photo_width = NULL, photo_height = NULL, photo_sha256 = NULL, photo_updated_at = NOW()
            WHERE owner_hash = %s AND place_id = %s RETURNING 1
            """,
            (identity, place_id),
        ).fetchone()
    if row is None:
        raise claim_error(404, "claim_not_found", "Location claim was not found")
    conn.commit()
    return Response(status_code=204)


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
        "DELETE FROM claim_recommendations WHERE account_id = %s",
        (identity.account_id,),
    )
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
    conn.execute(
        """
        UPDATE account_visits AS destination
        SET visited_at = LEAST(destination.visited_at, source.visited_at)
        FROM visits AS source
        WHERE destination.account_id = %s
          AND source.owner_hash = %s
          AND destination.place_id = source.place_id
        """,
        (identity.account_id, owner_hash),
    )
    guest_claims = conn.execute(
        """
        SELECT guest.* FROM guest_visit_claims AS guest
        JOIN account_visits ON account_visits.account_id = %s AND account_visits.place_id = guest.place_id
        WHERE guest.owner_hash = %s
        """,
        (identity.account_id, owner_hash),
    ).fetchall()
    for guest_claim in guest_claims:
        # Imported claims get an account-scoped replay hash. Possession of the old
        # guest recommendation token must never authorize an account operation.
        imported_hash = hashlib.sha256(
            f"import:{identity.account_id}:{guest_claim['recommendation_hash']}".encode("ascii")
        ).hexdigest()
        conn.execute(
            """
            INSERT INTO account_visit_claims (
                account_id, place_id, recommendation_hash, claimed_at, captured_at,
                latitude, longitude, accuracy_m, boundary_version, match_kind, distance_m,
                photo_bytes, photo_mime, photo_width, photo_height, photo_sha256, photo_updated_at
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (account_id, place_id) DO UPDATE SET
                photo_bytes = EXCLUDED.photo_bytes,
                photo_mime = EXCLUDED.photo_mime,
                photo_width = EXCLUDED.photo_width,
                photo_height = EXCLUDED.photo_height,
                photo_sha256 = EXCLUDED.photo_sha256,
                photo_updated_at = EXCLUDED.photo_updated_at
            WHERE account_visit_claims.recommendation_hash = EXCLUDED.recommendation_hash
              AND NOT account_visit_claims.photo_account_modified
              AND EXCLUDED.photo_updated_at IS NOT NULL
              AND (
                  account_visit_claims.photo_updated_at IS NULL
                  OR EXCLUDED.photo_updated_at > account_visit_claims.photo_updated_at
              )
            """,
            (
                identity.account_id, guest_claim["place_id"], imported_hash, guest_claim["claimed_at"],
                guest_claim["captured_at"], guest_claim["latitude"], guest_claim["longitude"],
                guest_claim["accuracy_m"], guest_claim["boundary_version"], guest_claim["match_kind"],
                guest_claim["distance_m"], guest_claim["photo_bytes"], guest_claim["photo_mime"],
                guest_claim["photo_width"], guest_claim["photo_height"], guest_claim["photo_sha256"],
                guest_claim["photo_updated_at"],
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
    visits = visits_for_account(conn, identity.account_id)
    conn.commit()
    return {
        "imported_visit_count": imported_visits,
        "visited_ids": visited_ids(visits),
        "visits": visits,
        "imported_trail_count": imported_trails,
        "completed_trail_ids": completed_trails_for_account(conn, identity.account_id),
    }

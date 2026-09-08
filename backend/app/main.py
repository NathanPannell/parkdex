from contextlib import asynccontextmanager, contextmanager
import hashlib
import re

from fastapi import Depends, FastAPI, Header, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from psycopg import Connection
from psycopg.errors import UniqueViolation

from backend.app.auth import (
    DUMMY_PASSWORD_HASH,
    AccountIdentity,
    authenticate_bearer,
    clear_login_failures,
    create_session,
    hash_password,
    reserve_login_attempt,
    require_bearer,
    verify_password,
)
from backend.app.db import close_pool, connection, open_pool
from backend.app.schemas import (
    AccountState,
    AuthResult,
    Credentials,
    GuestImportResult,
    PlaceCollection,
    TrailResult,
    TrailUpdate,
    VisitResult,
    VisitUpdate,
)
from backend.app.settings import get_settings

COLLECTION_KEY_PATTERN = re.compile(r"^[A-Za-z0-9_-]{43,128}$")
TRAIL_IDS = frozenset({"west_coast_trail", "juan_de_fuca_trail"})
COVERAGE_NOTE = (
    "Official-source v0: two whole national park reserves, designated provincial parks, "
    "and named regional parks from CRD, RDN, CVRD, and Bere Point. Regional coverage is "
    "strongest in those districts; parks without a clean authoritative point, including "
    "China Creek and Kwaksistah, are not guessed. The 25 islands are a curated collection, "
    "not every islet. Pins are representative centres, not entrances or trailheads."
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


def account_state(conn: Connection, identity: AccountIdentity) -> dict:
    visits = visits_for_account(conn, identity.account_id)
    return {
        "account": {"id": identity.account_id, "email": identity.email},
        "visited_ids": visited_ids(visits),
        "visits": visits,
        "completed_trail_ids": completed_trails_for_account(conn, identity.account_id),
    }


@asynccontextmanager
async def lifespan(_: FastAPI):
    open_pool()
    yield
    close_pool()


settings = get_settings()
app = FastAPI(title="Parkdex API", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_methods=["GET", "POST", "PUT", "OPTIONS"],
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
    password_hash = hash_password(payload.password)
    with contextmanager(connection)() as conn:
        try:
            account = conn.execute(
                """
                INSERT INTO accounts (email, password_hash) VALUES (%s, %s)
                RETURNING id, email
                """,
                (str(payload.email), password_hash),
            ).fetchone()
        except UniqueViolation:
            conn.rollback()
            raise HTTPException(status_code=409, detail="An account with this email already exists")
        token, expires_at = create_session(conn, str(account["id"]))
        conn.commit()
    return {
        "token": token,
        "expires_at": expires_at,
        "account": {"id": str(account["id"]), "email": account["email"]},
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
            "SELECT id, email, password_hash FROM accounts WHERE email = %s", (email,)
        ).fetchone()
        conn.commit()
    password_hash = account["password_hash"] if account else DUMMY_PASSWORD_HASH
    if not verify_password(password_hash, payload.password) or account is None:
        raise HTTPException(status_code=401, detail="Invalid email or password")
    with contextmanager(connection)() as conn:
        clear_login_failures(conn, email)
        token, expires_at = create_session(conn, str(account["id"]))
        visits = visits_for_account(conn, str(account["id"]))
        completed_trail_ids = completed_trails_for_account(conn, str(account["id"]))
        conn.commit()
    return {
        "token": token,
        "expires_at": expires_at,
        "account": {"id": str(account["id"]), "email": account["email"]},
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


@app.post("/api/account/import-guest", response_model=GuestImportResult)
def import_guest_progress(
    conn: Connection = Depends(connection),
    authorization: str | None = Header(default=None),
    x_collection_key: str | None = Header(default=None),
):
    identity = require_bearer(conn, authorization)
    owner_hash = collection_hash(x_collection_key, required=True)
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

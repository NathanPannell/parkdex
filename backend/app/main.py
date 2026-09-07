from contextlib import asynccontextmanager
import hashlib
import re

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from psycopg import Connection

from backend.app.db import close_pool, connection, open_pool
from backend.app.schemas import PlaceCollection, VisitResult, VisitUpdate
from backend.app.settings import get_settings

COLLECTION_KEY_PATTERN = re.compile(r"^[A-Za-z0-9_-]{43,128}$")
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


@asynccontextmanager
async def lifespan(_: FastAPI):
    open_pool()
    yield
    close_pool()


settings = get_settings()
app = FastAPI(title="Every Park API", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_methods=["GET", "PUT", "OPTIONS"],
    allow_headers=["Content-Type", "X-Collection-Key"],
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
    x_collection_key: str | None = Header(default=None),
):
    owner_hash = collection_hash(x_collection_key)
    places = conn.execute(
        """
        SELECT id, name, category, latitude, longitude, region, description,
               source_url, source_name, source_id
        FROM places WHERE active ORDER BY name
        """
    ).fetchall()
    visited_ids: list[str] = []
    if owner_hash:
        visited_ids = [
            row["place_id"]
            for row in conn.execute(
                """
                SELECT visits.place_id FROM visits
                JOIN places ON places.id = visits.place_id AND places.active
                WHERE visits.owner_hash = %s ORDER BY visits.place_id
                """,
                (owner_hash,),
            ).fetchall()
        ]
    return {"places": places, "visited_ids": visited_ids, "coverage_note": COVERAGE_NOTE}


@app.put("/api/visits/{place_id}", response_model=VisitResult)
def update_visit(
    place_id: str,
    payload: VisitUpdate,
    conn: Connection = Depends(connection),
    x_collection_key: str | None = Header(default=None),
):
    owner_hash = collection_hash(x_collection_key, required=True)
    if not conn.execute(
        "SELECT 1 FROM places WHERE id = %s AND active", (place_id,)
    ).fetchone():
        raise HTTPException(status_code=404, detail="Place not found")
    if payload.visited:
        conn.execute(
            "INSERT INTO visits (owner_hash, place_id) VALUES (%s, %s) ON CONFLICT DO NOTHING",
            (owner_hash, place_id),
        )
    else:
        conn.execute(
            "DELETE FROM visits WHERE owner_hash = %s AND place_id = %s",
            (owner_hash, place_id),
        )
    count = conn.execute(
        """
        SELECT COUNT(*) AS visited_count FROM visits
        JOIN places ON places.id = visits.place_id AND places.active
        WHERE visits.owner_hash = %s
        """,
        (owner_hash,),
    ).fetchone()["visited_count"]
    conn.commit()
    return {"place_id": place_id, "visited": payload.visited, "visited_count": count}

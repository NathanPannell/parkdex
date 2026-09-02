from contextlib import asynccontextmanager
from uuid import UUID, uuid4

from fastapi import Depends, FastAPI, HTTPException, Response, status
from fastapi.middleware.cors import CORSMiddleware
from psycopg import Connection
from psycopg.errors import UniqueViolation

from backend.app.db import close_pool, connection, open_pool
from backend.app.schemas import Monitor, MonitorCreate
from backend.app.settings import get_settings


@asynccontextmanager
async def lifespan(_: FastAPI):
    open_pool()
    yield
    close_pool()


settings = get_settings()
app = FastAPI(title="__APP_NAME__ API", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["Content-Type"],
)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/ready")
def ready(conn: Connection = Depends(connection)) -> dict[str, str | int]:
    migration_count = conn.execute("SELECT COUNT(*) FROM schema_migrations").fetchone()
    return {
        "status": "ready",
        "commit": settings.app_commit_sha,
        "migrations": migration_count[0],
    }


@app.get("/api/monitors", response_model=list[Monitor])
def list_monitors(conn: Connection = Depends(connection)):
    result = conn.execute(
        """
        SELECT id, name, url, status, http_status, response_time_ms, checked_at, created_at
        FROM monitors
        ORDER BY created_at DESC
        """
    )
    return result.fetchall()


@app.post("/api/monitors", response_model=Monitor, status_code=status.HTTP_201_CREATED)
def create_monitor(
    payload: MonitorCreate, conn: Connection = Depends(connection)
):
    normalized_url = str(payload.url)
    try:
        result = conn.execute(
            """
            INSERT INTO monitors (id, name, url)
            VALUES (%s, %s, %s)
            RETURNING id, name, url, status, http_status, response_time_ms, checked_at, created_at
            """,
            (uuid4(), payload.name, normalized_url),
        )
        monitor = result.fetchone()
        conn.commit()
    except UniqueViolation as exc:
        conn.rollback()
        raise HTTPException(status_code=409, detail="That URL is already monitored") from exc
    return monitor


@app.delete("/api/monitors/{monitor_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_monitor(
    monitor_id: UUID, conn: Connection = Depends(connection)
) -> Response:
    result = conn.execute("DELETE FROM monitors WHERE id = %s", (monitor_id,))
    conn.commit()
    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="Monitor not found")
    return Response(status_code=status.HTTP_204_NO_CONTENT)

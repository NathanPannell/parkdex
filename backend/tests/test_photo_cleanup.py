import asyncio
import inspect
import os
from threading import Event, get_ident

import psycopg
from fastapi.testclient import TestClient

from backend.app.object_storage import (
    MemoryObjectStorage,
    ObjectStorageError,
    ObjectStorageNotFound,
)

import backend.app.main as api


class Result:
    def __init__(self, rows=None):
        self.rows = rows or []

    def fetchall(self):
        return self.rows


class FakeConnection:
    def __init__(self, rows):
        self.rows = rows
        self.statements = []
        self.commits = 0

    def execute(self, sql, params=()):
        normalized = " ".join(sql.split())
        self.statements.append((normalized, params))
        if normalized.startswith("WITH due AS"):
            return Result(self.rows)
        return Result()

    def commit(self):
        self.commits += 1


def connection_factory(conn):
    def connection():
        yield conn

    return connection


def outbox_claim(conn: FakeConnection):
    return next(
        statement
        for statement in conn.statements
        if statement[0].startswith("WITH due AS")
    )


def outcome_updates(conn: FakeConnection):
    return [
        statement
        for statement in conn.statements
        if statement[0].startswith("UPDATE photo_object_deletions")
        and "SET last_error" in statement[0]
    ]


def test_enqueue_photo_deletions_is_deduplicated_and_idempotent():
    conn = FakeConnection([])
    api.enqueue_photo_object_deletions(
        conn,
        "00000000-0000-0000-0000-000000000001",
        ["postcards/same.jpg", "postcards/same.jpg"],
    )
    inserts = [
        statement
        for statement in conn.statements
        if statement[0].startswith("INSERT INTO photo_object_deletions")
    ]
    assert len(inserts) == 1
    assert "ON CONFLICT (object_key) DO NOTHING" in inserts[0][0]


def test_photo_deletion_worker_selects_only_due_work_in_fair_order(monkeypatch):
    events = []
    conn = FakeConnection([{"object_key": "postcards/opaque.jpg"}])

    class Storage:
        def delete(self, key):
            events.append(("object", key))

    monkeypatch.setattr(api, "connection", connection_factory(conn))
    monkeypatch.setattr(api, "photo_storage", lambda: Storage())
    assert api.process_photo_deletion_outbox() == 1

    claim_sql, claim_params = outbox_claim(conn)
    assert "WHERE next_attempt_at <= NOW()" in claim_sql
    assert (
        "ORDER BY next_attempt_at, enqueued_at, object_key "
        "FOR UPDATE SKIP LOCKED" in claim_sql
    )
    assert "attempt_count = deletion.attempt_count + 1" in claim_sql
    assert "next_attempt_at = NOW() + make_interval" in claim_sql
    assert claim_params == (
        api.PHOTO_DELETION_BATCH_SIZE,
        api.PHOTO_DELETION_RETRY_MAX_SECONDS,
        api.PHOTO_DELETION_RETRY_BASE_SECONDS,
        api.PHOTO_DELETION_RETRY_MAX_EXPONENT,
    )
    tombstone_deletes = [
        statement
        for statement in conn.statements
        if statement[0].startswith("DELETE FROM photo_object_deletions")
    ]
    assert events == [("object", "postcards/opaque.jpg")]
    assert len(tombstone_deletes) == 1
    assert tombstone_deletes[0][1] == (["postcards/opaque.jpg"],)
    assert conn.commits == 2


def test_photo_deletion_worker_treats_missing_object_as_success(monkeypatch):
    conn = FakeConnection([{"object_key": "postcards/missing.jpg"}])

    class Storage:
        def delete(self, key):
            raise ObjectStorageNotFound(key)

    monkeypatch.setattr(api, "connection", connection_factory(conn))
    monkeypatch.setattr(api, "photo_storage", lambda: Storage())
    assert api.process_photo_deletion_outbox() == 1
    assert len(
        [
            statement
            for statement in conn.statements
            if statement[0].startswith("DELETE FROM photo_object_deletions")
        ]
    ) == 1
    assert conn.commits == 2


def test_photo_deletion_worker_retains_and_backs_off_failed_tombstone(monkeypatch):
    conn = FakeConnection([{"object_key": "postcards/opaque.jpg"}])

    class Storage:
        def delete(self, key):
            raise ObjectStorageError("provider unavailable")

    monkeypatch.setattr(api, "connection", connection_factory(conn))
    monkeypatch.setattr(api, "photo_storage", lambda: Storage())
    assert api.process_photo_deletion_outbox() == 0
    assert not any(
        statement[0].startswith("DELETE FROM photo_object_deletions")
        for statement in conn.statements
    )
    claim_sql, _ = outbox_claim(conn)
    assert "attempt_count = deletion.attempt_count + 1" in claim_sql
    assert "next_attempt_at = NOW() + make_interval" in claim_sql
    outcomes = outcome_updates(conn)
    assert len(outcomes) == 1
    outcome_sql, outcome_params = outcomes[0]
    assert "SET last_error = %s" in outcome_sql
    assert outcome_params == (
        "ObjectStorageError",
        "postcards/opaque.jpg",
    )
    assert conn.commits == 2


def test_photo_deletion_worker_backs_off_batch_when_storage_is_unavailable(
    monkeypatch,
):
    keys = ["postcards/one.jpg", "postcards/two.jpg"]
    conn = FakeConnection([{"object_key": key} for key in keys])

    def unavailable_storage():
        raise ObjectStorageError("configuration unavailable")

    monkeypatch.setattr(api, "connection", connection_factory(conn))
    monkeypatch.setattr(api, "photo_storage", unavailable_storage)
    assert api.process_photo_deletion_outbox() == 0
    claim_sql, _ = outbox_claim(conn)
    assert "next_attempt_at = NOW() + make_interval" in claim_sql
    outcomes = outcome_updates(conn)
    assert [params for _, params in outcomes] == [
        ("ObjectStorageError", key) for key in keys
    ]
    assert conn.commits == 2


def test_failed_oldest_deletion_yields_to_new_due_work():
    if not os.environ.get("DATABASE_URL"):
        return
    poison_key = "postcards/starvation-poison.jpg"
    fresh_key = "postcards/starvation-fresh.jpg"

    class SelectiveFailureStorage(MemoryObjectStorage):
        fail_poison = True

        def __init__(self):
            super().__init__()
            self.calls = []

        def delete(self, key: str) -> None:
            self.calls.append(key)
            if key == poison_key and self.fail_poison:
                raise ObjectStorageError("poison object unavailable")
            super().delete(key)

    storage = SelectiveFailureStorage()
    storage.put(poison_key, b"poison", "image/jpeg")
    storage.put(fresh_key, b"fresh", "image/jpeg")
    api.set_photo_storage(storage)
    try:
        with TestClient(api.app):
            with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
                conn.execute(
                    "DELETE FROM photo_object_deletions WHERE object_key = ANY(%s)",
                    ([poison_key, fresh_key],),
                )
                conn.execute(
                    "INSERT INTO photo_object_deletions "
                    "(object_key, enqueued_at, next_attempt_at) "
                    "VALUES (%s, NOW() - INTERVAL '1 hour', NOW())",
                    (poison_key,),
                )
                conn.commit()

            assert api.process_photo_deletion_outbox(limit=1) == 0
            with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
                poison_retry = conn.execute(
                    "SELECT next_attempt_at FROM photo_object_deletions "
                    "WHERE object_key = %s",
                    (poison_key,),
                ).fetchone()[0]
                database_now = conn.execute("SELECT NOW()").fetchone()[0]
                conn.execute(
                    "INSERT INTO photo_object_deletions (object_key) VALUES (%s)",
                    (fresh_key,),
                )
                conn.commit()
            assert poison_retry > database_now

            # The old poison row is no longer due, so the newly queued object
            # cannot be starved by it even with a one-row worker batch.
            assert api.process_photo_deletion_outbox(limit=1) == 1
            assert storage.calls == [poison_key, fresh_key]
            with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
                assert conn.execute(
                    "SELECT 1 FROM photo_object_deletions WHERE object_key = %s",
                    (fresh_key,),
                ).fetchone() is None
                assert conn.execute(
                    "SELECT 1 FROM photo_object_deletions WHERE object_key = %s",
                    (poison_key,),
                ).fetchone() is not None
                conn.execute(
                    "UPDATE photo_object_deletions SET next_attempt_at = NOW() "
                    "WHERE object_key = %s",
                    (poison_key,),
                )
                conn.commit()

            storage.fail_poison = False
            assert api.process_photo_deletion_outbox(limit=1) == 1
    finally:
        api.set_photo_storage(None)
        if os.environ.get("DATABASE_URL"):
            with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
                conn.execute(
                    "DELETE FROM photo_object_deletions WHERE object_key = ANY(%s)",
                    ([poison_key, fresh_key],),
                )
                conn.commit()


def test_failed_upload_cleanup_only_persists_work_for_background_worker(monkeypatch):
    conn = FakeConnection([])
    process_calls = []
    monkeypatch.setattr(api, "connection", connection_factory(conn))
    monkeypatch.setattr(
        api,
        "process_photo_deletion_outbox",
        lambda: process_calls.append("unexpected request-path drain"),
    )
    api.persist_failed_upload_cleanup(
        "00000000-0000-0000-0000-000000000001", "postcards/new.jpg"
    )
    assert any(
        statement[0].startswith("INSERT INTO photo_object_deletions")
        for statement in conn.statements
    )
    assert conn.commits == 1
    assert process_calls == []


def test_user_facing_mutations_never_drain_global_deletion_work_inline():
    for handler in (
        api.update_visit,
        api.put_visit_photo,
        api.delete_visit_photo,
        api.reset_account_progress,
    ):
        assert "process_photo_deletion_outbox" not in inspect.getsource(handler)


def test_photo_upload_handler_uses_fastapi_sync_threadpool():
    assert not inspect.iscoroutinefunction(api.put_visit_photo)
    source = inspect.getsource(api.put_visit_photo)
    assert "photo.file.read" in source
    assert "normalize_photo(raw)" in source
    assert "storage.put" in source


def test_photo_deletion_worker_runs_off_loop_survives_error_and_stops(monkeypatch):
    first_call = Event()
    second_call = Event()
    worker_threads = []

    def process():
        worker_threads.append(get_ident())
        if len(worker_threads) == 1:
            first_call.set()
            raise RuntimeError("unexpected iteration failure")
        second_call.set()
        return 0

    monkeypatch.setattr(api, "process_photo_deletion_outbox", process)
    monkeypatch.setattr(api, "PHOTO_DELETION_RETRY_INTERVAL_SECONDS", 0.01)

    async def exercise():
        event_loop_thread = get_ident()
        stop_event = asyncio.Event()
        worker = asyncio.create_task(api.photo_deletion_worker(stop_event))
        for event in (first_call, second_call):
            while not event.is_set():
                await asyncio.sleep(0.005)
        stop_event.set()
        await asyncio.wait_for(worker, timeout=1)
        return event_loop_thread

    event_loop_thread = asyncio.run(exercise())
    assert len(worker_threads) >= 2
    assert all(thread != event_loop_thread for thread in worker_threads)


def test_photo_deletion_worker_waits_for_inflight_thread_before_stopping(monkeypatch):
    started = Event()
    release = Event()
    finished = Event()

    def process():
        started.set()
        assert release.wait(timeout=1)
        finished.set()
        return 0

    monkeypatch.setattr(api, "process_photo_deletion_outbox", process)

    async def exercise():
        stop_event = asyncio.Event()
        worker = asyncio.create_task(api.photo_deletion_worker(stop_event))
        while not started.is_set():
            await asyncio.sleep(0.005)
        stop_event.set()
        await asyncio.sleep(0)
        assert not worker.done()
        release.set()
        await asyncio.wait_for(worker, timeout=1)

    try:
        asyncio.run(exercise())
    finally:
        release.set()
    assert finished.is_set()

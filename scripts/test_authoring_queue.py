#!/usr/bin/env python3
"""Focused unit and opt-in local PostgreSQL tests for the authoring queue."""

from __future__ import annotations

import hashlib
import json
import os
import re
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import tempfile
import time
import unittest
from urllib.parse import urlsplit
from uuid import uuid4

if __package__:
    from . import authoring_queue as queue
else:
    import authoring_queue as queue

WORKSPACE = queue.WORKSPACE_ROOT
BEACON_DIR = WORKSPACE / ".codex" / "outputs" / "parkdex-100-rollout" / "beacon-hill"
BEACON_RECORD = BEACON_DIR / "generation-record.json"
BEACON_RESEARCH = BEACON_DIR / "research.json"
BEACON_SELECTED_ART = BEACON_DIR / "selected-art.json"


def _research_fixture(directory: Path, park_id: str = "test-park") -> dict:
    refs = []
    for index in range(1, 6):
        path = directory / f"photo-{index}.jpg"
        content = f"photo {index}".encode("ascii")
        path.write_bytes(content)
        refs.append(
            {
                "google_search_url": f"https://www.google.com/search?tbm=isch&q=park+{index}",
                "image_url": f"https://images.example.test/{index}.jpg",
                "source_url": f"https://parks.example.test/{index}",
                "local_path": str(path),
                "sha256": hashlib.sha256(content).hexdigest(),
            }
        )
    dossier = directory / "dossier.md"
    dossier.write_text("Verified park dossier.\n", encoding="utf-8")
    return {
        "park_id": park_id,
        "google_image_refs": refs,
        "fact_urls": ["https://parks.example.test/facts"],
        "dossier_path": str(dossier),
        "dossier_sha256": hashlib.sha256(dossier.read_bytes()).hexdigest(),
        "prompts": {"image_generation": "Create a park badge using the verified landmark."},
    }


class AuthoringQueueUnitTests(unittest.TestCase):
    def test_cloned_staging_receipt_allows_only_current_staging_endpoint(self) -> None:
        class Cursor:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def execute(self, _sql):
                pass

            def fetchone(self):
                return ("staging", None, queue.CLONED_STAGING_SOURCE_HOST)

        class Connection:
            def cursor(self):
                return Cursor()

        staging_url = f"postgresql://parkdex_kip_owner:secret@{queue.CLONED_STAGING_HOST}/parkdex_kip?sslmode=require"
        queue.verify_target(Connection(), "staging", None, queue.CLONED_STAGING_HOST, staging_url)
        old_main_url = f"postgresql://parkdex_kip_owner:secret@{queue.CLONED_STAGING_SOURCE_HOST}/parkdex_kip?sslmode=require"
        with self.assertRaisesRegex(queue.QueueError, "current Neon staging endpoint"):
            queue.verify_target(Connection(), "staging", None, queue.CLONED_STAGING_SOURCE_HOST, old_main_url)

    def test_database_identity_requires_expected_target_host_and_role(self) -> None:
        identity = queue.parse_database_identity(
            "postgresql://parkdex_kip_owner:secret@db.example.test/parkdex_kip",
            "staging",
            None,
            "db.example.test",
        )
        self.assertEqual(identity["host"], "db.example.test")
        for database_url, target, target_id, host in (
            ("postgresql://parkdex_kip_owner:secret@db.example.test/parkdex_kip", "staging", None, "elsewhere.test"),
            ("postgresql://wrong:secret@db.example.test/parkdex_kip", "staging", None, "db.example.test"),
            ("postgresql://kip_pr_17_abcd:secret@db.example.test/kip_preview_18_abcd", "owned-preview", "18", "db.example.test"),
        ):
            with self.subTest(database_url=database_url.split("@")[1]):
                with self.assertRaises(queue.QueueError):
                    queue.parse_database_identity(database_url, target, target_id, host)

    def test_research_requires_five_distinct_locally_verified_images(self) -> None:
        with tempfile.TemporaryDirectory(prefix="parkdex-queue-unit-") as temporary:
            directory = Path(temporary)
            research = queue.validate_research(_research_fixture(directory))
            self.assertEqual(len(research["google_image_refs"]), 5)
            duplicate = dict(research)
            duplicate["google_image_refs"] = list(research["google_image_refs"])
            duplicate["google_image_refs"][4] = dict(duplicate["google_image_refs"][0])
            with self.assertRaisesRegex(queue.QueueError, "five distinct"):
                queue.validate_research(duplicate)

    def test_render_manifest_requires_exact_rank_call_and_ordered_inputs(self) -> None:
        with tempfile.TemporaryDirectory(prefix="parkdex-queue-unit-") as temporary:
            directory = Path(temporary)
            image = directory / "identity.jpg"
            image.write_bytes(b"identity photo")
            call = {
                "rank": 7,
                "park_id": "park-seven",
                "call_index": 1,
                "phase": "initial",
                "prompt": "Render the real park landmark as a flat cartoon.",
                "image_inputs": [{"order": 1, "role": "identity photo", "local_path": str(image)}],
            }
            path = queue.render_manifest_for(7, 1)
            original_root = queue.WORK_ROOT
            try:
                queue.WORK_ROOT = directory / "work"
                path = queue.render_manifest_for(7, 1)
                path.parent.mkdir(parents=True)
                path.write_text(json.dumps(call), encoding="utf-8")
                normalized, resolved, digest = queue._read_render_call(path, 7, "park-seven", 1)
                self.assertEqual(normalized["image_inputs"][0]["order"], 1)
                self.assertEqual(resolved, path.resolve())
                self.assertEqual(len(digest), 64)
                call["image_inputs"].append({"order": 3, "role": "extra", "local_path": str(image)})
                path.write_text(json.dumps(call), encoding="utf-8")
                with self.assertRaisesRegex(queue.QueueError, "ordered from 1"):
                    queue._read_render_call(path, 7, "park-seven", 1)
            finally:
                queue.WORK_ROOT = original_root

    def test_art_review_waits_for_all_three_initial_compositions(self) -> None:
        with self.assertRaisesRegex(queue.QueueError, "three initial"):
            queue._require_initial_compositions(2)
        queue._require_initial_compositions(3)
        queue._require_initial_compositions(5)

    @unittest.skipUnless(BEACON_RECORD.is_file(), "prepared Beacon Hill artifacts are not present")
    def test_beacon_prepared_record_hashes_all_five_calls_and_selected_webp(self) -> None:
        record, record_sha, calls, selected = queue._prepared_generation_records(BEACON_RECORD, 1, "municipal-city-of-victoria-1442")
        self.assertEqual(record["origin"], "prequeue-prepared")
        self.assertEqual(record_sha, hashlib.sha256(BEACON_RECORD.read_bytes()).hexdigest())
        self.assertEqual(len(calls), 5)
        self.assertEqual([item["call_index"] for item in calls], [1, 2, 3, 4, 5])
        self.assertEqual(calls[-1]["composition_id"], "B")
        self.assertEqual(selected["sha256"], "969e4155e0fc1acf46bdbce48472093fe13d18469608f7f9f3ac69d05405e6dc")
        self.assertEqual(selected["byte_size"], 162738)


LOCAL_DATABASE_URL = os.environ.get("AUTHORING_QUEUE_TEST_DATABASE_URL")


@unittest.skipUnless(LOCAL_DATABASE_URL, "set AUTHORING_QUEUE_TEST_DATABASE_URL for isolated local PostgreSQL QA")
class AuthoringQueuePostgresTests(unittest.TestCase):
    """Uses an explicit loopback QA database and restores queue state after integration checks."""

    @classmethod
    def setUpClass(cls) -> None:
        parsed = urlsplit(LOCAL_DATABASE_URL or "")
        if parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
            raise RuntimeError("AUTHORING_QUEUE_TEST_DATABASE_URL must point to loopback")
        database_name = parsed.path.lstrip("/")
        if not re.fullmatch(r"kip_qa_content_sync_[0-9a-f]{32}", database_name):
            raise RuntimeError("AUTHORING_QUEUE_TEST_DATABASE_URL must name a unique content-sync QA database")
        try:
            import psycopg
        except ImportError:
            raise RuntimeError("psycopg is required for local PostgreSQL QA") from None
        try:
            cls.conn = psycopg.connect(LOCAL_DATABASE_URL)
        except Exception as exc:
            raise RuntimeError(f"local PostgreSQL QA connection failed ({type(exc).__name__})") from None
        cls.conn.execute("SELECT 1")
        cls.conn.commit()

    @classmethod
    def tearDownClass(cls) -> None:
        connection = getattr(cls, "conn", None)
        if connection is not None:
            connection.rollback()
            connection.close()

    def test_adoption_checkpoint_recovery_publish_reconcile_and_failure_budget(self) -> None:
        if not all(path.is_file() for path in (BEACON_RECORD, BEACON_RESEARCH, BEACON_SELECTED_ART)):
            self.skipTest("prepared Beacon Hill audit files are not present")
        original_root = queue.WORK_ROOT
        with tempfile.TemporaryDirectory(prefix="parkdex-queue-pg-") as temporary:
            queue.WORK_ROOT = Path(temporary) / "park-enrichment"
            try:
                with self.conn.cursor() as cursor:
                    cursor.execute("SELECT id FROM public.parks WHERE id = %s", ("municipal-city-of-victoria-1442",))
                    beacon = cursor.fetchone()
                    cursor.execute("SELECT id FROM public.parks WHERE id <> %s ORDER BY id LIMIT 1", ("municipal-city-of-victoria-1442",))
                    second = cursor.fetchone()
                    if beacon is None or second is None:
                        self.skipTest("local QA database must contain Beacon Hill and one other park")
                    cursor.execute("SELECT singleton FROM public.park_enrichment_rollout WHERE singleton = true")
                    if cursor.fetchone() is None:
                        self.skipTest("local QA database must have the rollout marker")
                    cursor.execute("DELETE FROM public.park_enrichment_jobs")
                    cursor.execute(
                        "INSERT INTO public.park_enrichment_jobs (rank, park_id) VALUES (1, %s), (2, %s)",
                        (beacon[0], second[0]),
                    )
                    cursor.execute("SELECT revision FROM public.content_clock WHERE singleton = true")
                    revision_before_queue = cursor.fetchone()[0]

                claim = queue.claim_one(self.conn)
                self.assertEqual(claim["outcome"], "claimed")
                self.assertEqual(claim["job"]["rank"], 1)
                token = claim["job"]["lease_token"]
                busy = queue.claim_one(self.conn)
                self.assertEqual(busy["outcome"], "busy")
                self.assertEqual(busy["job"]["rank"], 1)

                research = queue._read_validated_research(BEACON_RESEARCH)
                art = queue._read_validated_selected_art(BEACON_SELECTED_ART)
                adopted = queue.adopt_prepared(self.conn, 1, token, BEACON_RECORD, research, art)
                self.assertEqual(adopted["outcome"], "adopted")
                self.assertEqual(adopted["job"]["render_calls_started"], 5)
                self.assertEqual(len(adopted["job"]["render_call_log"]), 5)
                self.assertTrue(all(item["origin"] == "prequeue-prepared" for item in adopted["job"]["render_call_log"]))
                with self.conn.cursor() as cursor:
                    cursor.execute("SELECT revision FROM public.content_clock WHERE singleton = true")
                    self.assertEqual(cursor.fetchone()[0], revision_before_queue)

                    expected_asset = queue._expected_asset(art)
                    cursor.execute(
                        "SELECT logical_path, object_key, url, sha256, byte_size, content_type FROM public.r2_objects WHERE logical_path=%s",
                        (expected_asset["logical_path"],),
                    )
                    existing = cursor.fetchone()
                    if existing is None:
                        cursor.execute(
                            """INSERT INTO public.r2_objects (logical_path, object_key, url, sha256, byte_size, content_type)
                               VALUES (%s, %s, %s, %s, %s, %s)""",
                            tuple(expected_asset[key] for key in ("logical_path", "object_key", "url", "sha256", "byte_size", "content_type")),
                        )
                    else:
                        self.assertEqual(dict(zip(expected_asset.keys(), existing, strict=True)), expected_asset)
                    cursor.execute(
                        "UPDATE public.parks SET blurb=%s, rarity=%s, scene=%s WHERE id=%s",
                        (art["desired"]["blurb"], art["desired"]["rarity"], art["desired"]["scene"], beacon[0]),
                    )
                    cursor.execute(
                        "UPDATE public.park_enrichment_jobs SET state='publishing', lease_expires_at=clock_timestamp()-interval '1 second' WHERE rank=1"
                    )
                    cursor.execute("SELECT revision FROM public.content_clock WHERE singleton = true")
                    after_simulated_publisher = cursor.fetchone()[0]

                recovered = queue.claim_one(self.conn)
                self.assertEqual(recovered["outcome"], "recovered_published")
                self.assertEqual(recovered["job"]["state"], "published")
                with self.conn.cursor() as cursor:
                    cursor.execute("SELECT revision FROM public.content_clock WHERE singleton = true")
                    self.assertEqual(cursor.fetchone()[0], after_simulated_publisher)

                second_claim = queue.claim_one(self.conn)
                self.assertEqual(second_claim["outcome"], "claimed")
                self.assertEqual(second_claim["job"]["rank"], 2)
                second_token = second_claim["job"]["lease_token"]
                with tempfile.TemporaryDirectory(prefix="parkdex-queue-inputs-") as inputs_dir:
                    inputs_path = Path(inputs_dir)
                    second_research = queue.validate_research(_research_fixture(inputs_path, second[0]))
                    frozen = queue.freeze_research(self.conn, 2, second_token, second_research)
                    self.assertEqual(frozen["outcome"], "frozen")
                    image_path = inputs_path / "photo-1.jpg"
                    image_sha = hashlib.sha256(image_path.read_bytes()).hexdigest()
                    for call_index in (1, 2):
                        phase = "initial" if call_index <= 3 else "correction"
                        manifest = queue.render_manifest_for(2, call_index)
                        manifest.parent.mkdir(parents=True, exist_ok=True)
                        manifest.write_text(
                            json.dumps(
                                {
                                    "rank": 2,
                                    "park_id": second[0],
                                    "call_index": call_index,
                                    "phase": phase,
                                    "prompt": f"Exact test prompt for call {call_index}.",
                                    "image_inputs": [{"order": 1, "role": "identity photo", "local_path": str(image_path), "sha256": image_sha}],
                                }
                            ),
                            encoding="utf-8",
                        )
                        checkpoint = queue.checkpoint_render(self.conn, 2, second_token, manifest)
                        self.assertEqual(checkpoint["outcome"], "checkpointed")
                        self.assertEqual(checkpoint["render_calls_started"], call_index)
                    call_two_hash = checkpoint["run_manifest_sha256"]

                    stale = str(uuid4())
                    with self.assertRaises(queue.QueueError):
                        queue.freeze_research(self.conn, 2, stale, second_research)
                    with self.conn.cursor() as cursor:
                        cursor.execute("UPDATE public.park_enrichment_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE rank=2")
                    reclaimed = queue.claim_one(self.conn)
                    self.assertEqual(reclaimed["outcome"], "reclaimed")
                    self.assertEqual(reclaimed["job"]["rank"], 2)
                    self.assertEqual(reclaimed["job"]["attempt_count"], 2)
                    self.assertEqual(reclaimed["job"]["render_calls_started"], 2)
                    self.assertEqual(reclaimed["job"]["run_manifest_sha256"], call_two_hash)
                    with self.conn.cursor() as cursor:
                        cursor.execute("SELECT frozen_research FROM public.park_enrichment_jobs WHERE rank=2")
                        self.assertEqual(queue._json_value(cursor.fetchone()[0]), second_research)

                    failed_retry = queue.fail_job(self.conn, 2, reclaimed["job"]["lease_token"], "transient test failure", permanent=False)
                    self.assertEqual(failed_retry["state"], "queued")
                    third_attempt = queue.claim_one(self.conn)
                    self.assertEqual(third_attempt["job"]["rank"], 2)
                    self.assertEqual(third_attempt["job"]["attempt_count"], 3)
                    exhausted = queue.fail_job(self.conn, 2, third_attempt["job"]["lease_token"], "third test failure", permanent=False)
                    self.assertEqual(exhausted["state"], "needs_attention")
                    self.assertEqual(exhausted["render_calls_started"], 2)
                    self.assertEqual(exhausted["run_manifest_sha256"], call_two_hash)
            finally:
                queue.WORK_ROOT = original_root
                self.conn.rollback()

    def test_expired_lease_renewal_cannot_overlap_a_new_claim(self) -> None:
        """A renewal crossing expiry must serialize with the next single-flight claim."""
        import psycopg

        with self.conn.cursor() as cursor:
            cursor.execute("SELECT id FROM public.parks ORDER BY id LIMIT 2")
            parks = cursor.fetchall()
            cursor.execute("SELECT singleton FROM public.park_enrichment_rollout WHERE singleton = true")
            marker = cursor.fetchone()
        if len(parks) < 2:
            self.fail("local QA database must contain at least two parks")
        if marker is None:
            with self.conn.cursor() as cursor:
                cursor.execute("SELECT revision FROM public.content_clock WHERE singleton = true")
                clock = cursor.fetchone()
                if clock is None:
                    self.fail("local QA database must contain the content clock")
                cursor.execute(
                    """INSERT INTO public.park_enrichment_rollout
                           (singleton, source_bundle_sha256, ranked_list_sha256, expected_count,
                            target_environment, target_id, database_host, applied_content_revision)
                       VALUES (true, %s, %s, 100, 'staging', NULL, %s, %s)""",
                    ("a" * 64, "b" * 64, urlsplit(LOCAL_DATABASE_URL or "").hostname, clock[0]),
                )
            self.conn.commit()

        snapshot_created = False
        snapshot_name = f"authoring_queue_snapshot_{uuid4().hex}"
        trigger_name = f"authoring_queue_slow_renew_{uuid4().hex}"
        function_name = f"authoring_queue_slow_renew_{uuid4().hex}"
        renewal_app = f"parkdex-queue-renew-{uuid4().hex}"
        claim_app = f"{renewal_app}-claim"
        advisory_key = uuid4().int & ((1 << 63) - 1)
        token = str(uuid4())
        advisory_locked = False
        try:
            with self.conn.cursor() as cursor:
                cursor.execute(f'CREATE TEMP TABLE "{snapshot_name}" ON COMMIT PRESERVE ROWS AS SELECT * FROM public.park_enrichment_jobs')
            self.conn.commit()
            snapshot_created = True

            with self.conn.cursor() as cursor:
                cursor.execute("DELETE FROM public.park_enrichment_jobs")
                cursor.execute(
                    """INSERT INTO public.park_enrichment_jobs
                           (rank, park_id, state, lease_token, lease_expires_at, attempt_count)
                       VALUES (1, %s, 'leased', %s::uuid, clock_timestamp() + interval '5 seconds', 1),
                              (2, %s, 'queued', NULL, NULL, 0)""",
                    (parks[0][0], token, parks[1][0]),
                )
                cursor.execute(
                    f"""
                    CREATE FUNCTION public."{function_name}"() RETURNS trigger
                    LANGUAGE plpgsql AS $$
                    BEGIN
                        IF OLD.rank = 1 AND NEW.lease_expires_at > OLD.lease_expires_at THEN
                            PERFORM pg_advisory_xact_lock({advisory_key});
                        END IF;
                        RETURN NEW;
                    END
                    $$
                    """
                )
                cursor.execute(
                    f"""
                    CREATE TRIGGER "{trigger_name}"
                    BEFORE UPDATE ON public.park_enrichment_jobs
                    FOR EACH ROW EXECUTE FUNCTION public."{function_name}"()
                    """
                )
            self.conn.commit()

            def renew() -> dict:
                with psycopg.connect(
                    LOCAL_DATABASE_URL,
                    application_name=renewal_app,
                    options="-c lock_timeout=10000 -c statement_timeout=20000",
                ) as conn:
                    return queue.renew_lease(conn, 1, token)

            def claim() -> dict:
                with psycopg.connect(
                    LOCAL_DATABASE_URL,
                    application_name=claim_app,
                    options="-c lock_timeout=10000 -c statement_timeout=20000",
                ) as conn:
                    return queue.claim_one(conn)

            with self.conn.cursor() as cursor:
                cursor.execute("SELECT pg_advisory_lock(%s)", (advisory_key,))
            self.conn.commit()
            advisory_locked = True

            with ThreadPoolExecutor(max_workers=2) as pool:
                renew_future = pool.submit(renew)
                try:
                    deadline = time.monotonic() + 15
                    while time.monotonic() < deadline:
                        with self.conn.cursor() as cursor:
                            cursor.execute(
                                "SELECT EXISTS (SELECT 1 FROM pg_stat_activity "
                                "WHERE application_name = %s AND state = 'active' "
                                "AND wait_event_type = 'Lock' AND wait_event = 'advisory')",
                                (renewal_app,),
                            )
                            renewal_waiting = cursor.fetchone()[0]
                            cursor.execute("SELECT lease_expires_at <= clock_timestamp() FROM public.park_enrichment_jobs WHERE rank = 1")
                            expired = cursor.fetchone()[0]
                        self.conn.commit()
                        if renewal_waiting and expired:
                            break
                        if renew_future.done():
                            self.fail("renewal finished before the test reached its expiry window")
                        time.sleep(0.01)
                    else:
                        self.fail("renewal did not remain blocked in its database trigger across lease expiry")

                    claim_future = pool.submit(claim)
                    claim_deadline = time.monotonic() + 10
                    while time.monotonic() < claim_deadline:
                        with self.conn.cursor() as cursor:
                            cursor.execute(
                                "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = %s AND state = 'active' AND wait_event_type = 'Lock')",
                                (claim_app,),
                            )
                            claim_waiting = cursor.fetchone()[0]
                        self.conn.commit()
                        if claim_waiting:
                            break
                        if claim_future.done():
                            self.fail("claim finished before waiting for the renewal transaction")
                        time.sleep(0.01)
                    else:
                        self.fail("claim did not wait behind the renewal transaction")
                finally:
                    with self.conn.cursor() as cursor:
                        cursor.execute("SELECT pg_advisory_unlock(%s)", (advisory_key,))
                        unlocked = cursor.fetchone()[0]
                    self.conn.commit()
                    advisory_locked = False
                    self.assertTrue(unlocked)

                claim_result = claim_future.result(timeout=10)
                renew_result = renew_future.result(timeout=10)

            self.assertEqual(renew_result["outcome"], "renewed")
            self.assertEqual(claim_result["outcome"], "busy")
            self.assertEqual(claim_result["job"]["rank"], 1)
            with self.conn.cursor() as cursor:
                cursor.execute(
                    """SELECT count(*) FROM public.park_enrichment_jobs
                         WHERE state IN ('leased', 'ready', 'publishing')
                           AND lease_token IS NOT NULL AND lease_expires_at > clock_timestamp()"""
                )
                self.assertEqual(cursor.fetchone()[0], 1)
                cursor.execute("SELECT state, lease_token IS NOT NULL FROM public.park_enrichment_jobs WHERE rank = 2")
                self.assertEqual(cursor.fetchone(), ("queued", False))
            self.conn.commit()
        finally:
            if advisory_locked:
                self.conn.rollback()
                with self.conn.cursor() as cursor:
                    cursor.execute("SELECT pg_advisory_unlock(%s)", (advisory_key,))
                self.conn.commit()
            if snapshot_created:
                self.conn.rollback()
                with self.conn.cursor() as cursor:
                    cursor.execute(f'DROP TRIGGER IF EXISTS "{trigger_name}" ON public.park_enrichment_jobs')
                    cursor.execute(f'DROP FUNCTION IF EXISTS public."{function_name}"()')
                    cursor.execute("DELETE FROM public.park_enrichment_jobs")
                    cursor.execute(f'INSERT INTO public.park_enrichment_jobs SELECT * FROM "{snapshot_name}"')
                    cursor.execute(f'DROP TABLE "{snapshot_name}"')
                self.conn.commit()


if __name__ == "__main__":
    unittest.main(verbosity=2)

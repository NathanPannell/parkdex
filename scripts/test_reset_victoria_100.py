from __future__ import annotations

from contextlib import contextmanager
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest


sys.dont_write_bytecode = True
_SCRIPT_PATH = Path(__file__).with_name("reset_victoria_100.py")
_SPEC = importlib.util.spec_from_file_location("reset_victoria_100", _SCRIPT_PATH)
assert _SPEC and _SPEC.loader
reset = importlib.util.module_from_spec(_SPEC)
sys.modules[_SPEC.name] = reset
_SPEC.loader.exec_module(reset)


class FakeCursor:
    def __init__(self, connection: "FakeConnection") -> None:
        self.connection = connection
        self.result = None
        self.calls: list[tuple[str, object]] = []
        self.closed = False

    def execute(self, sql: str, params=None) -> None:
        compact = " ".join(sql.split())
        self.calls.append((compact, params))
        self.connection.calls.append((compact, params))
        if compact == "SELECT revision FROM public.content_clock WHERE singleton = true":
            self.result = (self.connection.revision + 1,)
        elif compact.startswith("DELETE FROM public.parks"):
            self.connection.deleted_ids = list(params[0])
        elif compact.startswith("INSERT INTO public.park_enrichment_jobs"):
            self.connection.jobs.append(params)
        elif compact.startswith("INSERT INTO public.park_enrichment_rollout"):
            self.connection.marker_params = params

    def fetchone(self):
        result, self.result = self.result, None
        return result

    def close(self) -> None:
        self.closed = True


class FakeConnection:
    def __init__(self, revision: int) -> None:
        self.revision = revision
        self.transaction_count = 0
        self.calls: list[tuple[str, object]] = []
        self.deleted_ids: list[str] = []
        self.jobs: list[tuple[int, str]] = []
        self.marker_params = None
        self.cursor_value = FakeCursor(self)

    def cursor(self) -> FakeCursor:
        return self.cursor_value

    @contextmanager
    def transaction(self):
        self.transaction_count += 1
        yield


def make_fixture(base: Path):
    original_dir = base / "original"
    corrected_dir = base / "corrected"
    original_dir.mkdir()
    corrected_dir.mkdir()
    original_path = original_dir / reset.RANKED_SOURCE_NAME
    corrected_path = corrected_dir / reset.RANKED_SOURCE_NAME

    legacy_parks, _, _, _, _ = reset._legacy_source()
    legacy_ids = list(legacy_parks)
    ranked: list[dict] = []
    for rank in range(1, 101):
        if rank <= 26:
            source = legacy_parks[legacy_ids[rank - 1]]
            park_id = source["id"]
            name, category, region = source["name"], source["category"], source["region"]
        else:
            park_id = f"test-victoria-park-{rank:03d}"
            name, category, region = f"Test Victoria Park {rank}", "municipal", "Southern Vancouver Island"
        ranked.append({
            "rank": rank, "id": park_id, "name": name,
            "current_official_name": name, "category": category, "region": region,
            "feature_source_url": f"https://parks.example.test/{rank}",
        })
    historical = json.dumps(ranked, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    corrected_records = json.loads(historical)
    corrected_records[68]["corrected_note"] = "Identity verified from the source records."
    original_path.write_bytes(historical)
    corrected_path.write_bytes(json.dumps(corrected_records, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
    corrected_sha = hashlib.sha256(corrected_path.read_bytes()).hexdigest()
    original_sha = hashlib.sha256(original_path.read_bytes()).hexdigest()

    parks = []
    for rank, ranked_park in enumerate(corrected_records, start=1):
        source = legacy_parks.get(ranked_park["id"])
        if source:
            park = dict(source)
            park.update({"name": ranked_park["name"], "category": ranked_park["category"], "region": ranked_park["region"]})
        else:
            park = {
                "id": ranked_park["id"], "name": ranked_park["name"], "short": ranked_park["name"][:40],
                "category": ranked_park["category"], "region": ranked_park["region"],
                "lat": 48.4 + rank / 10000, "lng": -123.3 - rank / 10000,
                "biome": "forest", "shape": "circle", "rarity": "common", "seed": rank,
                "blurb": reset.SKELETON_BLURB,
            }
        park["scene"] = None
        park["blurb"] = reset.SKELETON_BLURB
        park["rank"] = rank
        park["sourceMetadata"] = {"sourceName": "fixture"}
        parks.append(park)

    boundaries = []
    for rank, park in enumerate(parks, start=1):
        x = -123.5 + rank / 10000
        y = 48.3 + rank / 10000
        boundaries.append({
            "type": "Feature",
            "properties": {"id": park["id"], "biome": park["biome"]},
            "geometry": {"type": "MultiPolygon", "coordinates": [[[[x, y], [x + 0.001, y], [x + 0.001, y + 0.001], [x, y]]]]},
        })

    hubs = [{"name": f"Hub {position}", "lng": -123.4 + position / 100, "lat": 48.4 + position / 100} for position in range(8)]
    settings = [{"parkId": park["id"], "walkM": float(rank)} for rank, park in enumerate(parks, start=1)]
    routes = [
        {"parkId": park["id"], "hubPosition": position,
         "distanceKm": None if rank == 100 and position == 7 else rank / 10,
         "durationMin": None if rank == 100 and position == 7 else rank / 5}
        for rank, park in enumerate(parks, start=1)
        for position in range(8)
    ]
    source_attribution = {
        "rankedList": {"path": f".codex/kip-100-rollout-qa/{reset.RANKED_SOURCE_NAME}", "sha256": corrected_sha},
        "originalRankedList": {"path": f".codex/outputs/{reset.RANKED_SOURCE_NAME}", "sha256": original_sha},
        "geometry": [
            {"parkId": park["id"], "sourceUrl": f"https://parks.example.test/geometry/{rank}",
             "sourceId": f"fixture-{rank}", "sha256": "a" * 64}
            for rank, park in enumerate(parks, start=1)
        ],
        "drive": {
            "hubs": {"sourceUrl": "https://routes.example.test/hubs", "sha256": "b" * 64},
            "routes": {"sourceUrl": "https://routes.example.test/table", "sha256": "c" * 64},
        },
        "rank69": {"decision": "Verified identity fixture.", "sources": [
            "https://parks.example.test/rank69-a", "https://parks.example.test/rank69-b",
        ]},
    }
    bundle = {
        "schema": reset.BUNDLE_SCHEMA,
        "rankedListSha256": corrected_sha,
        "parks": parks,
        "boundaries": boundaries,
        "drive": {"hubs": hubs, "settings": settings, "routes": routes},
        "sourceAttribution": source_attribution,
    }
    bundle_path = base / "victoria-100-seed-v1.json"
    bundle_path.write_text(json.dumps(bundle, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    seed = reset.load_seed(bundle_path, corrected_path, original_path)
    return seed, corrected_path, original_path, bundle_path


def make_marker(seed, target, revision):
    return {
        "source_bundle_sha256": seed.bundle_sha256,
        "ranked_list_sha256": seed.ranked_sha256,
        "expected_count": 100,
        "applied_content_revision": revision,
        "target_environment": target.environment,
        "target_id": target.target_id,
        "database_host": target.database_host,
    }


def make_queued_jobs(seed):
    return {
        rank: {
            "park_id": park["id"], "state": "queued", "lease_token": None,
            "lease_expires_at": None, "attempt_count": 0, "frozen_research": None,
            "selected_art": None, "publication_result": None, "published_at": None,
            "last_error": None, "render_calls_started": 0, "run_manifest_path": None,
            "run_manifest_sha256": None, "render_call_log": [],
        }
        for rank, park in enumerate(seed.parks, start=1)
    }


def make_public_export(state, target):
    tables = {name: [] for name in reset.BACKUP_TABLES}
    tables["parks"] = list(state.parks.values())
    tables["boundaries"] = [{"park_id": park_id, "feature": feature} for park_id, feature in state.boundaries.items()]
    tables["drive_hubs"] = [{"position": position, "name": row[0], "lng": row[1], "lat": row[2]} for position, row in state.hubs.items()]
    tables["park_drive_settings"] = [{"park_id": park_id, "walk_m": walk_m} for park_id, walk_m in state.settings.items()]
    tables["park_drive"] = [
        {"park_id": park_id, "hub_position": position, "distance_km": route[0], "duration_min": route[1]}
        for (park_id, position), route in state.routes.items()
    ]
    tables["content_clock"] = [{"singleton": True, "revision": state.revision, "retention_floor": 0, "last_transaction_id": None}]
    tables["content_map"] = [] if state.map_pointer is None else [state.map_pointer]
    if state.public_table_counts is None:
        state.public_table_counts = {name: len(rows) for name, rows in tables.items()}
    value = {
        "schema": reset.BACKUP_SCHEMA,
        "createdAt": "2026-09-27T12:00:00Z",
        "target": {"environment": target.environment, "targetId": target.target_id},
        "database": {"host": target.database_host, "name": target.database_name, "role": target.database_user},
        "revision": state.revision,
        "privateTableCounts": state.account_table_counts or {},
        "tables": tables,
    }
    raw = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return raw, hashlib.sha256(raw).hexdigest()


class ResetVictoria100Tests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.seed, self.ranked_path, self.original_ranked_path, self.bundle_path = make_fixture(self.root)
        self.target = reset.Target("staging", None, "staging.neon.tech", "parkdex_kip", "parkdex_kip_owner")

    def legacy_state(self, revision: int = 10):
        return reset.DatabaseState(revision, *reset._legacy_source(), {}, None, None, (), {})

    def seed_state(self, revision: int = 10):
        parks, boundaries, hubs, settings, routes = reset._seed_rows(self.seed)
        return reset.DatabaseState(revision, parks, boundaries, hubs, settings, routes, {}, None, None, (), {})

    def test_loads_exact_ranked_seed_matrix_and_scene_null_skeletons(self) -> None:
        self.assertEqual(len(self.seed.parks), 100)
        self.assertEqual(len(self.seed.boundaries), 100)
        self.assertEqual(len(self.seed.hubs), 8)
        self.assertEqual(len(self.seed.settings), 100)
        self.assertEqual(len(self.seed.routes), 800)
        self.assertTrue(all(park["scene"] is None and park["blurb"] == reset.SKELETON_BLURB for park in self.seed.parks))

    def test_rejects_incomplete_routes_and_source_hash_mismatch(self) -> None:
        bundle = json.loads(self.bundle_path.read_text(encoding="utf-8"))
        bundle["drive"]["routes"].pop()
        broken = self.root / "missing-route.json"
        broken.write_text(json.dumps(bundle), encoding="utf-8")
        with self.assertRaisesRegex(reset.ResetError, "exactly 800"):
            reset.load_seed(broken, self.ranked_path, self.original_ranked_path)
        with self.assertRaisesRegex(reset.ResetError, "rankedListSha256"):
            bundle["drive"]["routes"].append({"parkId": self.seed.park_ids[-1], "hubPosition": 7, "distanceKm": 10, "durationMin": 5})
            bundle["rankedListSha256"] = "0" * 64
            broken.write_text(json.dumps(bundle), encoding="utf-8")
            reset.load_seed(broken, self.ranked_path, self.original_ranked_path)

    def test_rejects_rank_69_stale_cy_hampson_identity(self) -> None:
        records = json.loads(self.ranked_path.read_text(encoding="utf-8"))
        original = json.loads(self.original_ranked_path.read_text(encoding="utf-8"))
        records[68].update({
            "id": reset.UNRESOLVED_RANK_69_ID,
            "name": "Bazan Bay Park",
            "current_official_name": "Cy Hampson Park",
        })
        original[68]["id"] = reset.UNRESOLVED_RANK_69_ID
        original[68]["name"] = "Bazan Bay Park"
        original[68]["current_official_name"] = "Cy Hampson Park"
        self.ranked_path.write_text(json.dumps(records), encoding="utf-8")
        self.original_ranked_path.write_text(json.dumps(original), encoding="utf-8")
        with self.assertRaisesRegex(reset.ResetError, "rank 69 still labels OID 1850"):
            reset._validate_ranked_list(self.ranked_path, self.original_ranked_path)

    def test_target_guard_binds_host_database_role_and_pr18_suffix(self) -> None:
        staging_url = "postgresql://parkdex_kip_owner:secret@staging.neon.tech/parkdex_kip?sslmode=require"
        target = reset.parse_target(staging_url, "staging", None, "STAGING.NEON.TECH")
        self.assertEqual(target.database_host, "staging.neon.tech")
        with self.assertRaisesRegex(reset.ResetError, "host does not match"):
            reset.parse_target(staging_url, "staging", None, "production.neon.tech")
        with self.assertRaisesRegex(reset.ResetError, "database parkdex_kip"):
            reset.parse_target(staging_url.replace("parkdex_kip", "parkdex_prod"), "staging", None, "staging.neon.tech")
        preview = "postgresql://kip_pr_18_0123456789:secret@preview.neon.tech/kip_preview_18_0123456789"
        preview_target = reset.parse_target(preview, "owned-preview", "18", "preview.neon.tech")
        self.assertEqual(preview_target.target_id, "18")
        with self.assertRaisesRegex(reset.ResetError, "restricted to PR 18"):
            reset.parse_target(preview, "owned-preview", "19", "preview.neon.tech")

    def test_initial_state_must_match_legacy_sources_and_retires_96(self) -> None:
        state = self.legacy_state()
        self.assertEqual(reset.classify_state(state, self.seed, self.target), "reset")
        self.assertEqual(len(set(state.parks) - set(self.seed.park_ids)), 96)
        state.parks[next(iter(state.parks))]["name"] = "Unexpected drift"
        with self.assertRaisesRegex(reset.ResetError, "differs from tracked legacy sources"):
            reset.classify_state(state, self.seed, self.target)

    def test_exact_replay_and_progress_replay_are_noops_and_divergence_fails(self) -> None:
        state = self.seed_state(revision=11)
        state.marker = make_marker(self.seed, self.target, 11)
        state.jobs = make_queued_jobs(self.seed)
        self.assertEqual(reset.classify_state(state, self.seed, self.target), "exact-replay")
        state.jobs[1]["state"] = "leased"
        state.jobs[1]["lease_token"] = "9f8d2d3c-3c35-4e17-9d85-a9c9699ce82a"
        self.assertEqual(reset.classify_state(state, self.seed, self.target), "in-progress-replay")
        state.boundaries[self.seed.park_ids[0]]["geometry"]["coordinates"][0][0][0][0] += 0.01
        with self.assertRaisesRegex(reset.ResetError, "skeletons have diverged"):
            reset.classify_state(state, self.seed, self.target)

    def test_published_replay_preserves_scene_only_when_selected_art_matches(self) -> None:
        state = self.seed_state(revision=13)
        state.marker = make_marker(self.seed, self.target, 11)
        state.jobs = make_queued_jobs(self.seed)
        park_id = state.jobs[1]["park_id"]
        state.jobs[1].update({
            "state": "published",
            "published_at": "2026-09-27T12:00:00Z",
            "publication_result": {"revision": 13},
            "selected_art": {
                "local_path": "runs/beacon-hill.webp", "sha256": "d" * 64, "byte_size": 128,
                "scene_slug": "beacon-hill-park",
                "expected": {"blurb": reset.SKELETON_BLURB, "rarity": "common", "scene": None},
                "desired": {"blurb": "A completed park story.", "rarity": "rare", "scene": "beacon-hill-park"},
            },
        })
        state.parks[park_id]["scene"] = "beacon-hill-park"
        state.parks[park_id]["blurb"] = "A completed park story."
        self.assertEqual(reset.classify_state(state, self.seed, self.target), "published-replay")
        state.parks[park_id]["scene"] = "wrong-scene"
        with self.assertRaisesRegex(reset.ResetError, "differs from selected art"):
            reset.classify_state(state, self.seed, self.target)

    def test_public_export_binds_exact_revision_target_rows_and_private_counts_only(self) -> None:
        state = self.legacy_state(revision=27)
        state.account_tables = ("accounts", "claim_photos")
        state.account_table_counts = {"accounts": 3, "claim_photos": 2}
        raw, digest = make_public_export(state, self.target)
        path = self.root / "public-export.json"
        path.write_bytes(raw)
        result = reset.validate_public_export(path, digest, self.target, state)
        self.assertEqual(result["revision"], 27)
        with self.assertRaisesRegex(reset.ResetError, "do not match --backup-sha256"):
            reset.validate_public_export(path, "0" * 64, self.target, state)
        state.public_table_counts["r2_objects"] = 1
        with self.assertRaisesRegex(reset.ResetError, "row count for r2_objects does not match"):
            reset.validate_public_export(path, digest, self.target, state)
        state.public_table_counts["r2_objects"] = 0
        state.revision += 1
        with self.assertRaisesRegex(reset.ResetError, "does not match database revision"):
            reset.validate_public_export(path, digest, self.target, state)

    def test_wire_size_gate_covers_snapshot_and_unsplittable_revision(self) -> None:
        snapshot_size, batch_size = reset.estimate_wire_sizes(self.legacy_state(), self.seed)
        self.assertLess(snapshot_size, reset.MAX_SYNC_RESPONSE_BYTES)
        self.assertLess(batch_size, reset.MAX_SYNC_RESPONSE_BYTES)
        with self.assertRaisesRegex(reset.ResetError, "above the 4 MiB sync limit"):
            reset.validate_wire_sizes(reset.MAX_SYNC_RESPONSE_BYTES + 1, batch_size)
        with self.assertRaisesRegex(reset.ResetError, "above the 4 MiB sync limit"):
            reset.validate_wire_sizes(snapshot_size, reset.MAX_SYNC_RESPONSE_BYTES + 1)

    def test_apply_reset_uses_one_transaction_tracked_rows_and_rollout_marker(self) -> None:
        state = self.legacy_state(revision=40)
        conn = FakeConnection(state.revision)
        with conn.transaction():
            revision = reset.apply_reset(conn, self.seed, state, self.target, lambda value: value)
        self.assertEqual(conn.transaction_count, 1)
        self.assertEqual(revision, 41)
        self.assertEqual(len(conn.deleted_ids), 96)
        self.assertEqual(len(conn.jobs), 100)
        self.assertEqual(conn.jobs[0], (1, self.seed.park_ids[0]))
        self.assertEqual(conn.marker_params, (self.seed.bundle_sha256, self.seed.ranked_sha256, 41, "staging", None, "staging.neon.tech"))
        sql = [statement for statement, _ in conn.calls]
        self.assertEqual(sum(statement.startswith("INSERT INTO public.park_drive (") for statement in sql), 800)
        self.assertTrue(all(statement.startswith(("SET CONSTRAINTS", "DELETE FROM public.", "INSERT INTO public."))
                            or statement.startswith("SELECT revision FROM public.content_clock") for statement in sql))
        touched_tables = {match for statement in sql for match in (
            re_search_table(statement),
        ) if match}
        self.assertEqual(touched_tables, {
            "parks", "boundaries", "park_drive", "park_drive_settings", "drive_hubs",
            "park_enrichment_jobs", "park_enrichment_rollout", "content_clock",
        })


def re_search_table(statement: str):
    import re
    match = re.match(r"(?:DELETE FROM|INSERT INTO) public\.([a-z_]+)", statement)
    if match:
        return match.group(1)
    if statement.startswith("SELECT revision FROM public.content_clock"):
        return "content_clock"
    return None


if __name__ == "__main__":
    unittest.main()
